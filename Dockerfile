# ─────────────────────────────────────────────────────────────────────────────
# Stage 1: Build the React frontend
# Using node:20-alpine for a lighter builder image
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS frontend-builder
WORKDIR /frontend

# Install frontend dependencies (includes devDependencies for building)
COPY frontend/package*.json ./
RUN npm ci

# Copy source files and build
COPY frontend/ ./
RUN npm run build

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2: Production backend server
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20
WORKDIR /app
ENV NODE_ENV=production

# Build tools for native npm modules (baileys / canvas / etc.)
RUN apt-get update && apt-get install -y \
    python3 make g++ \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# Install ONLY production backend dependencies
COPY backend/package*.json ./
RUN npm install --omit=dev

# Copy backend source
COPY backend/ ./

# Copy the compiled frontend from Stage 1
COPY --from=frontend-builder /frontend/dist ./public

EXPOSE 8080
CMD ["node", "index.js"]
