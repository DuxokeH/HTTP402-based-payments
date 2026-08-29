# X402 Hosting Server

Production-ready Express server implementing the HTTP 402 payment flow on Sepolia testnet, with a browser frontend (MetaMask), OpenAI behind the paywall, SQLite persistence, security hardening, and a Docker/Caddy deployment story.

The CLI client at [../client](../client) is an **optional** developer demo. The server runs fine without it — public users pay through the included web UI.

---

## Quick start (local development)

```bash
# 1. Install dependencies
npm install

# 2. Generate the merchant wallet (run once, at the repo root)
cd .. && node generate-wallet.js && cd server

# 3. Configure
cp .env.example .env
# Edit .env — at minimum set OPENAI_API_KEY (or leave empty for demo mode)

# 4. Run
npm run dev
```

Then open <http://localhost:3000>, connect MetaMask on Sepolia, fund the **client** wallet via <https://sepoliafaucet.com>, and click "Pay & Send".

---

## Endpoints

| Method | Path              | Auth                  | Purpose |
|--------|-------------------|-----------------------|---------|
| GET    | `/config`         | public                | Network, merchant address, price, model |
| GET    | `/health`         | public                | DB + RPC + AI status; returns 503 if degraded |
| GET    | `/service`        | none → 402            | Issues a payment challenge; returns auth state if `X-Payment` header is valid |
| POST   | `/service`        | none                  | Merged exchange: verifies the on-chain tx **and** delivers the content in one request/response pair, returning a proof token alongside the answer |
| GET    | `/` and `/*`      | public static         | Browser frontend (`public/`) |

---

## Environment variables

See [.env.example](.env.example) for the full list. The ones you must think about for a public deploy:

| Var | Purpose |
|-----|---------|
| `NODE_ENV` | `production` flips CORS into strict mode and disables `pino-pretty` |
| `ALLOWED_ORIGINS` | Comma-separated origins allowed to call the API in prod |
| `OPENAI_API_KEY` | Empty → demo mode (stub response); set → real OpenAI calls |
| `OPENAI_DAILY_USD_CAP` | Soft USD ceiling. **Always also set a HARD monthly cap in OpenAI billing.** |
| `RPC_URL` | Default is a public Sepolia node; for production set an Alchemy/Infura URL |
| `MIN_CONFIRMATIONS` | 1 on Sepolia, 2+ recommended if you ever flip to mainnet |
| `PROOF_TOKEN_TTL_SECONDS` | How long a paid session stays valid (default 600 = 10 min) |

---

## Persistence

State lives in `./data/x402.db` (SQLite, WAL mode). Four tables:

- `payment_requests` — issued 402 challenges, with TTL
- `payment_proofs` — minted proof tokens, with TTL and `consumed_at`
- `redeemed_tx_hashes` — replay protection
- `openai_usage` — daily token + cost tracking for the spend cap

A background sweeper drops expired rows every 60 seconds.

---

## Security model

What the server enforces:

- **CORS** — strict origin allowlist in production (`ALLOWED_ORIGINS`)
- **Helmet** — secure default headers, CSP allows the viem CDN
- **Rate limit** — `POST /service` 10/min/IP, `GET /service` 30/min/IP
- **Input validation** — `zod` schemas reject malformed tx hashes / addresses / UUIDs before any RPC call
- **Replay protection** — `redeemed_tx_hashes` rejects a tx that already minted a token
- **Payer binding** — `POST /service` requires `tx.from === payerAddress` claimed by the client; if the original challenge captured a `payerAddress`, the verifier must match it too
- **Proof TTL** — tokens expire (default 10 min); a background sweeper deletes expired rows
- **One-shot tokens** — a paid token unlocks one AI call (`consumed_at`); refresh-spam is impossible
- **Daily AI spend cap** — server refuses further AI calls after `OPENAI_DAILY_USD_CAP` is exceeded today

What the deployer must still do:

- Run behind **HTTPS** (the included Caddyfile handles this)
- Set a **hard monthly cap** in OpenAI's billing UI
- Keep `wallet.json` permissions at `0600` and back up the mnemonic
- Restrict the SSH/firewall surface on the host

---

## Deployment (VPS with Docker)

```bash
# On the VPS, as a non-root user:
git clone <your-fork> ~/x402-repo
cd ~/x402-repo/test-environments/00_demo/server
cp .env.example .env
# fill in: ALLOWED_ORIGINS, OPENAI_API_KEY, OPENAI_DAILY_USD_CAP
# place wallet.json in this directory (generated offline on your laptop!)
# edit Caddyfile and replace `your-domain.example` with your real domain
docker compose up -d --build
```

Caddy provisions a Let's Encrypt cert automatically the first time. The full step-by-step (DNS, OpenAI key, backups, monitoring) is in [docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md).

### Upgrades

```bash
cd ~/x402-repo && git pull && cd test-environments/00_demo/server && docker compose up -d --build
```

SQLite state survives because `./data` is a bind-mounted volume.

---

## Without Docker (systemd)

The repository ships a hardened systemd unit at [systemd/x402.service](systemd/x402.service). To use it:

```bash
sudo cp systemd/x402.service /etc/systemd/system/x402.service
sudo useradd --system --home /opt/x402 --shell /usr/sbin/nologin x402
sudo install -o x402 -g x402 -m 750 -d /opt/x402 /etc/x402
sudo cp -r ./* /opt/x402/server/
sudo cp .env /etc/x402/.env
sudo chmod 600 /etc/x402/.env
sudo systemctl daemon-reload
sudo systemctl enable --now x402
```

You'll still want Caddy or Nginx in front for TLS.
