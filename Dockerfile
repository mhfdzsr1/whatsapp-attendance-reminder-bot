# Base image Node.js 20 slim (sangat ringan, cepat di-build)
FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production \
    PORT=10000

# Salin package.json dan install dependensi produksi
COPY package*.json ./
RUN npm install --omit=dev

# Salin seluruh kode sumber bot
COPY . .

# Buka port 10000 untuk Render
EXPOSE 10000

# Jalankan aplikasi
CMD ["node", "index.js"]
