# syntax=docker/dockerfile:1
FROM node:20-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++ \
 && ln -sf python3 /usr/bin/python
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

FROM node:20-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache curl tini \
 && addgroup -S x402 && adduser -S x402 -G x402

ENV NODE_ENV=production \
    MERCHANT_PORT=3000 \
    DB_PATH=/app/data/x402.db

COPY --from=deps /app/node_modules ./node_modules
COPY server.js db.js package.json ./
COPY public ./public

RUN mkdir -p /app/data \
 && chown -R x402:x402 /app
USER x402

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://localhost:3000/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
