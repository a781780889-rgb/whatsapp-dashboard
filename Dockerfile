# Stage 1: Build Frontend (TypeScript + Tailwind v4)
FROM node:20 AS frontend-build
WORKDIR /build/frontend
COPY frontend/package.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# Stage 2: Production
FROM node:20
WORKDIR /app

ENV NODE_ENV=production

# أدوات البناء لإعادة تجميع sqlite3 من المصدر
RUN apt-get update && apt-get install -y \
    python3 make g++ libsqlite3-dev \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

COPY backend/package*.json ./
RUN npm ci --omit=dev
RUN npm rebuild sqlite3 --build-from-source

COPY backend/ ./
COPY --from=frontend-build /build/frontend/dist ./public
RUN mkdir -p /databases /backups

EXPOSE 8080
CMD ["node", "index.js"]
