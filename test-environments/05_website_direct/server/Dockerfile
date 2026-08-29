# syntax=docker/dockerfile:1
# Slika za mapo 05_spletisce (vzorec je enak kot testna-okolja/00_demo/server/Dockerfile).
FROM node:20-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++ \
 && ln -sf python3 /usr/bin/python
COPY package.json package-lock.json* ./
# better-sqlite3 se prevede iz izvorne kode, zato zgornji build paketi.
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

FROM node:20-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache curl tini \
 && addgroup -S x402 && adduser -S x402 -G x402

ENV NODE_ENV=production \
    PORT=8080 \
    DB_PATH=/app/data/spletisce_neposredno.db

COPY --from=deps /app/node_modules ./node_modules
COPY server.js runner.js db.js auth.js x402.js db_x402.js x402-odjemalec.js package.json ./
COPY public ./public

RUN mkdir -p /app/data \
 && chown -R x402:x402 /app
USER x402

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://localhost:8080/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
