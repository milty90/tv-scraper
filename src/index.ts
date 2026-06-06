import express from "express";
import cors from "cors";
import * as cheerio from "cheerio";
import { chromium } from "playwright";

const app = express();
const PORT = Number(process.env.PORT) || 3000;

interface Broadcast {
  Sendung: string;
  Beginn: string;
  Ende: string;
  Kategorie: string;
  Link: string;
  Thumbnail: string;
}

interface Channel {
  Kanal: string;
  KanalLogo: string;
  now: Broadcast | null;
  after: Broadcast | null;
}

let uniqueChannels: Channel[] = [];
let lastScrapeTime = 0;
const SCRAPE_INTERVAL = 10 * 10 * 1000;

async function scrapeTvMovie() {
  console.log("Starte Scraping von TV Movie...");

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-blink-features=AutomationControlled",
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 25000 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    extraHTTPHeaders: {
      "Accept-Language": "de-DE,de;q=0.9",
    },
  });

  const page = await context.newPage();

  // Képek és fontok blokkolása - gyorsabb betöltés
  await page.route("**/*.{png,jpg,jpeg,gif,svg,woff,woff2,pdf}", (route) =>
    route.abort(),
  );

  try {
    await page.goto("https://www.tvmovie.de/tv/programm-jetzt", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    await page.waitForTimeout(3000);

    // Cookie banner elfogadása
    try {
      const iframe = page.frameLocator('iframe[title="SP Consent Message"]');
      await iframe
        .getByRole("button", { name: "Akzeptieren" })
        .click({ timeout: 8000 });
      await page.waitForTimeout(3000);
      console.log("Cookie akzeptiert.");
    } catch {
      // Banner eltávolítása JS-sel ha az iframe nem működik
      await page.evaluate(() => {
        document.documentElement.classList.remove("sp-message-open");
        document.body.style.overflow = "auto";
        const overlays = document.querySelectorAll(
          '[id*="sp_message"], [class*="sp-message"], iframe[title="SP Consent Message"]',
        );
        overlays.forEach((el) => el.remove());
      });
      console.log("Banner JS-sel entfernt.");
    }

    await page.waitForTimeout(2000);

    // "Mehr laden" knopf so lange klicken, bis er nicht mehr sichtbar ist oder max 12 Klicks erreicht sind
    let loadMoreCount = 0;
    while (true) {
      const mehrLadenBtn = page
        .locator(
          'button:has-text("Mehr laden"), button:has-text("mehr laden"), [class*="load-more"]',
        )
        .first();

      if (!(await mehrLadenBtn.isVisible())) {
        console.log(
          `"Mehr laden" nicht mehr sichtbar nach ${loadMoreCount} Klicks.`,
        );
        break;
      }

      await mehrLadenBtn.scrollIntoViewIfNeeded();
      await mehrLadenBtn.click();
      loadMoreCount++;
      console.log(`"Mehr laden" geklickt: ${loadMoreCount}x`);
      await page.waitForTimeout(2000);

      // Max 12 clicks nach dem es wahrscheinlich keine neuen Inhalte mehr gibt
      if (loadMoreCount >= 12) {
        console.log("Maximale Klick-Anzahl erreicht.");
        break;
      }
    }

    // Teljes HTML kinyerése
    const html = await page.content();
    const $ = cheerio.load(html);

    let currentKanal = "N/A";
    let currentKanalLogo = ""; // ← új változó a logó URL-jének tárolására

    const channelMap = new Map<string, Channel>();

    $("a").each((_, el) => {
      const href = $(el).attr("href") || "";

      // Csatorna
      if ($(el).hasClass("bx-epg-channel")) {
        currentKanal = $(el).find("span").first().text().trim();
        currentKanalLogo = $(el).find("img").attr("src") || "";

        if (currentKanal && !channelMap.has(currentKanal)) {
          channelMap.set(currentKanal, {
            Kanal: currentKanal,
            KanalLogo: currentKanalLogo,
            now: null,
            after: null,
          });
        }
        return;
      }

      // Műsor
      if ($(el).hasClass("bx-epg-broadcast")) {
        const thumbnail = $(el).find("img").attr("src") || "";
        const title = $(el).attr("aria-label") || "";

        const spans = $(el).find("div").first().find("span");
        const genre = $(spans[0]).text().trim();
        const kategorie = $(spans[1]).text().trim();

        const timeText = $(el)
          .find("span")
          .filter((_, s) => /\d{2}:\d{2}-\d{2}:\d{2}/.test($(s).text()))
          .first()
          .text()
          .trim();

        const timeMatch = timeText.match(/(\d{2}:\d{2})-(\d{2}:\d{2})/);
        if (!timeMatch || !title) return;

        const broadcast: Broadcast = {
          Sendung: title,
          Beginn: timeMatch[1],
          Ende: timeMatch[2],
          Kategorie: kategorie || genre,
          Link: `https://www.tvmovie.de${href}`,
          Thumbnail: thumbnail.replace(",w=60,", ",w=500,"),
        };

        const channel = channelMap.get(currentKanal);
        if (channel) {
          if (!channel.now) {
            channel.now = broadcast; // első műsor = now
          } else if (!channel.after) {
            channel.after = broadcast; // második műsor = after
          }
        }
      }
    });

    // Map -> Array
    const results = Array.from(channelMap.values());
    console.log(`Gefunden: ${results.length} Kanäle`);
    return results;
  } catch (err) {
    console.error("Fehler:", err);
    return [];
  } finally {
    await context.close();
    await browser.close();
  }
}

app.use(cors());

app.get("/", async (req, res) => {
  if (!uniqueChannels.length || Date.now() - lastScrapeTime > SCRAPE_INTERVAL) {
    uniqueChannels = await scrapeTvMovie();
    lastScrapeTime = Date.now();
  }

  const q = (req.query.q || "").toString().toLowerCase();

  if (!q) {
    return res.json({
      info:
        "Letzte Aktualisierung: " +
        new Date(lastScrapeTime).toLocaleTimeString() +
        ". Erneute Aktualisierung möglich ab: " +
        new Date(lastScrapeTime + SCRAPE_INTERVAL).toLocaleTimeString(),
      data: uniqueChannels,
    });
  }

  const results = uniqueChannels.filter((item) =>
    Object.values(item).some(
      (val) => typeof val === "string" && val.toLowerCase().includes(q),
    ),
  );

  res.json(results);
});

app.listen(PORT, "0.0.0.0", () =>
  console.log(`Server läuft auf http://localhost:${PORT}`),
);
