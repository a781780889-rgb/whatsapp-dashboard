FROM node:20
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update && apt-get install -y \
    python3 make g++ libsqlite3-dev \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

COPY backend/package*.json ./
RUN npm ci --omit=dev
RUN npm rebuild sqlite3 --build-from-source

COPY backend/ ./
COPY frontend/dist ./public
RUN mkdir -p /databases /backups

EXPOSE 8080
CMD ["node", "index.js"]
