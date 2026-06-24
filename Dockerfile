# ─────────────────────────────────────────────────────────────────────────────
# Stage 1: Build the React frontend
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS frontend-builder
WORKDIR /frontend

COPY frontend/package*.json ./
RUN npm install

COPY frontend/ ./
RUN npm run build

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2: Production backend server
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20
WORKDIR /app
ENV NODE_ENV=production

# Build tools for native npm modules (baileys's sharp peer dep / canvas / etc.)
# pkg-config + libvips-dev are a fallback in case no prebuilt sharp/libvips
# binary matches the build architecture and it has to compile from source.
RUN apt-get update && apt-get install -y \
    python3 make g++ pkg-config libvips-dev \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# Install ONLY production backend dependencies.
# npm ci (not npm install) — requires package-lock.json to be committed,
# installs exactly what's locked instead of re-resolving ranges against the
# registry on every build. This matters here because @whiskeysockets/baileys
# is pinned to a release-candidate (7.0.0-rc13) with an unpinned peer
# dependency on "sharp"; without a lockfile, every fresh build re-resolves
# those versions and can silently pick up a new/broken prerelease.
COPY backend/package*.json ./
RUN npm ci --omit=dev

# Copy backend source
COPY backend/ ./

# Copy the compiled frontend from Stage 1
COPY --from=frontend-builder /frontend/dist ./public

# ─────────────────────────────────────────────────────────────────────────────
# FIX: لا نُحدِّد EXPOSE بشكل ثابت لأن Railway يُعيِّن PORT ديناميكياً.
# process.env.PORT هو المرجع الوحيد — انظر StartupValidator.js
# القيمة الافتراضية 5000 للتطوير المحلي فقط.
# ─────────────────────────────────────────────────────────────────────────────
EXPOSE 5000

# Health check — يستخدم PORT المتغير ديناميكياً
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD node -e "const http=require('http');const p=process.env.PORT||5000;http.get('http://localhost:'+p+'/health',r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

CMD ["node", "index.js"]
