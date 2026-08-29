# syntax=docker/dockerfile:1
# Image for the FACILITATOR in the 04_website_facilitator folder.
# The only component of this branch with a connection to the chain (JSON-RPC).
FROM node:20-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++ \
 && ln -sf python3 /usr/bin/python
COPY package.json package-lock.json* ./
# better-sqlite3 is compiled from source, hence the build packages above.
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

FROM node:20-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache curl tini \
 && addgroup -S x402 && adduser -S x402 -G x402

ENV NODE_ENV=production \
    FACILITATOR_PORT=4000 \
    DB_PATH=/app/data/facilitator.db

COPY --from=deps /app/node_modules ./node_modules
COPY server.js db.js auth.js x402.js db_x402.js package.json ./

RUN mkdir -p /app/data \
 && chown -R x402:x402 /app
USER x402

EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://localhost:4000/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
