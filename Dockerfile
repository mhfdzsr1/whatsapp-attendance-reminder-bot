# Gunakan base image Debian Bookworm yang stabil dan mutakhir
FROM node:20-bookworm-slim

# Pasang Chromium resmi dan font pendukung langsung dari repositori Debian
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-thai-tlwg \
    fonts-kacst \
    fonts-freefont-ttf \
    libxss1 \
    procps \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Konfigurasi Environment Puppeteer untuk Chromium Debian
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production

WORKDIR /app

# Salin package.json & install production dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Salin seluruh source code proyek
COPY . .

# Buka port (Render otomatis meneruskan traffic ke port ini)
EXPOSE 3000

# Jalankan bot
CMD ["node", "index.js"]
