# =========================
# Build Stage
# =========================
FROM node:22-bookworm-slim AS build

WORKDIR /app

ENV NODE_ENV=development

# Copy dependency files first for better Docker cache
COPY package.json package-lock.json ./

# Install dependencies from package.json.
# npm install is used here because the committed lockfile is currently out of sync.
# --include=dev keeps tsup/prisma available during the build stage.
RUN npm install --include=dev --no-audit --no-fund

# Copy build/config files
COPY tsconfig.json vitest.config.ts prisma.config.ts ./

# Copy Prisma schema
COPY prisma ./prisma

# Copy source
COPY src ./src

# Generate Prisma Client.
# Prisma 7 loads prisma.config.ts, which requires DATABASE_URL even though generate does not connect.
RUN DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build" npm run prisma:generate

# Build API + Worker
RUN npm run build


# =========================
# Production Runtime Stage
# =========================
FROM node:22-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8000

# dumb-init handles shutdown signals. curl is required by Coolify healthchecks.
RUN apt-get update \
    && apt-get install -y --no-install-recommends dumb-init curl \
    && rm -rf /var/lib/apt/lists/*

# Install production dependencies only
COPY package.json package-lock.json ./

RUN npm install \
    --omit=dev \
    --no-audit \
    --no-fund \
    && npm cache clean --force

# Copy compiled application
COPY --from=build /app/dist ./dist

# Run as non-root user
USER node

EXPOSE 8000

# Same probe for API (PORT 8000) and worker (PORT 8000 in production, 8001 locally).
HEALTHCHECK \
    --interval=30s \
    --timeout=5s \
    --start-period=20s \
    --retries=5 \
    CMD curl -fsS http://127.0.0.1:8000/api/v1/health/live || curl -fsS http://127.0.0.1:8001/api/v1/health/live || exit 1

ENTRYPOINT ["dumb-init", "--"]

CMD ["node", "dist/server.js"]