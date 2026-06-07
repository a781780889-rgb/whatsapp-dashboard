FROM node:20
WORKDIR /app
ENV NODE_ENV=production

# Build tools for native npm modules (baileys/canvas etc.)
RUN apt-get update && apt-get install -y \
    python3 make g++ \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

COPY backend/package*.json ./
RUN npm install --omit=dev

COPY backend/ ./
COPY frontend/dist ./public

EXPOSE 8080
CMD ["node", "index.js"]
