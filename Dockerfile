FROM mcr.microsoft.com/playwright:v1.60.0-jammy

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

EXPOSE 3000

CMD ["node", "dist/index.js"]