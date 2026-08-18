FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NODE_ENV=development

COPY package.json ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json vitest.config.ts prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src

RUN npm run prisma:generate
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist

USER node
EXPOSE 8000
CMD ["node", "dist/server.js"]
