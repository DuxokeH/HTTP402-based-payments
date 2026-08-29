# Deployment on a remote server

Instructions for deploying the demo environment publicly on **any Linux server** — a rented
virtual server (VPS), your own machine on the network, or a device at home. Nothing in this
procedure is tied to a particular provider.

You do not need these instructions for a local run — see [`../README.md`](../README.md).

> **When you actually need this.** A local run is enough to try the protocol out. A remote
> deployment makes sense when you want to pay with MetaMask from your phone, show the environment
> to someone else, or capture traffic that travels across a real network.

## What you need

- a server with **Ubuntu 22.04 or newer** (1 vCPU and 1 GB of memory is enough), with ssh access
  and a public IP address
- a **domain**, if you want HTTPS (without one, only access over IP and plain HTTP works)
- a wallet on the **Ethereum Sepolia** network holding test ETH (real mode only)
- optionally an **OpenAI key**, if you want real answers instead of stub ones

## 1. Prepare the server

```bash
ssh <USER>@<SERVER_IP>

# updates
sudo apt update && sudo apt upgrade -y

# Docker (official install script)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
exit          # log out and back in so that the group membership takes effect
```

### Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status
```

If the server runs at a cloud provider, that provider has **its own firewall in front of the
server** — you have to open the same ports there as well, or `ufw` alone will not help. The
tell-tale sign that this is the problem: the connection times out with no answer, instead of the
server refusing it.

> **Restrict ssh access to your own IP address** if you have a static one:
> `sudo ufw allow from <YOUR_IP> to any port 22 proto tcp`, followed by `sudo ufw delete allow OpenSSH`.

## 2. Domain and DNS (optional, but recommended)

At your domain registrar, add an **A** record pointing to the server's public address:

| Type | Name | Value | Proxy |
|---|---|---|---|
| A | `x402` (or `@`) | `<SERVER_IP>` | off |

If your DNS provider offers a proxying mode ("proxy", "cloud"), **turn it off** — Caddy has to
obtain the Let's Encrypt certificate itself, and for that ports 80 and 443 must reach it directly.

Check that the name resolves:

```bash
dig +short x402.your-domain.example
```

## 3. Create the wallets

Create the wallets **on your own computer, not on the server**, and copy over only what the
server genuinely needs:

```bash
# locally
cd test-environments/00_demo
npm ci
node generate-wallet.js        # creates server/wallet.json and client/wallet.json
```

The server needs **only the merchant wallet** (the recipient), which never needs any funds:

```bash
scp server/wallet.json <USER>@<SERVER_IP>:~/wallet.json
```

> The file carries `0600` permissions. The client wallet (`client/wallet.json`) stays with you —
> it is the only one that holds funds. Use a dedicated test wallet and nothing else.

## 4. Clone and configure the project

```bash
ssh <USER>@<SERVER_IP>
git clone <repo-url> ~/x402-repo
cd ~/x402-repo/test-environments/00_demo/server
cp .env.example .env
nano .env
```

Settings worth thinking about:

| Variable | Recommended for a public deployment |
|---|---|
| `NODE_ENV` | `production` — turns on strict CORS and turns off development logging |
| `ALLOWED_ORIGINS` | `https://x402.your-domain.example` (comma-separated origins) |
| `RPC_URL` | the public node works; for heavier traffic enter your own JSON-RPC provider |
| `MIN_CONFIRMATIONS` | `1` on Sepolia |
| `SERVICE_PRICE_ETH` | price of a single service call |
| `OPENAI_API_KEY` | empty → stub response; filled in → real calls |
| `OPENAI_DAILY_USD_CAP` | soft daily limit |

> **If you do enter an OpenAI key**, also set a **hard monthly spending cap with the key's
> provider.** `OPENAI_DAILY_USD_CAP` is only a soft safeguard inside this application and will not
> prevent costs if the key leaks.

Move the merchant wallet into place:

```bash
mv ~/wallet.json ~/x402-repo/test-environments/00_demo/server/wallet.json
chmod 600 ~/x402-repo/test-environments/00_demo/server/wallet.json
```

## 5. Run it

### Option A — Docker and Caddy (with HTTPS)

In the `Caddyfile`, replace `your-domain.example` with your own domain, then:

```bash
cd ~/x402-repo/test-environments/00_demo/server
docker compose up -d
docker compose logs -f          # Ctrl-C stops the log stream; the services keep running
```

Caddy obtains the certificate by itself on the first visit. Check:

```bash
curl -s http://localhost:3000/health             # from the host itself
curl -s https://x402.your-domain.example/health  # from outside
# expect {"status":"ok","db":"ok","rpc":"ok",…}
```

### Option B — without Docker (systemd)

```bash
cd ~/x402-repo/test-environments/00_demo/server
npm ci
sudo cp systemd/x402.service /etc/systemd/system/
sudo nano /etc/systemd/system/x402.service    # fix User= and WorkingDirectory=
sudo systemctl daemon-reload
sudo systemctl enable --now x402
sudo systemctl status x402
journalctl -u x402 -f
```

### Option C — plain HTTP, for a Wireshark capture

To observe the protocol you need **unencrypted** traffic, which means running without Caddy:

```bash
sudo ufw allow from <YOUR_IP> to any port 3000 proto tcp
cd ~/x402-repo/test-environments/00_demo/server && npm ci && npm start
```

> A server set up this way **must not be left publicly reachable**. The proof token is a bearer
> credential — anyone who intercepts it on the unencrypted connection gets access to the content.
> When you are done capturing, stop the server and close the port.

## 6. Verify end to end

From a browser, open `https://x402.your-domain.example`, connect MetaMask (Sepolia network) and
make a payment. A line about the verified transaction must appear in the server log, followed by
the content delivery.

With the CLI client from your own computer:

```bash
cd test-environments/00_demo/client
# in config.json set MERCHANT_URL to https://x402.your-domain.example
npm ci && node run.js --pause-ms 1500
```

## 7. Maintenance

**Updating:**

```bash
cd ~/x402-repo && git pull
cd test-environments/00_demo/server && docker compose up -d --build
```

**Backups.** Only two things matter: `server/wallet.json` (the merchant wallet) and
`server/data/x402.db` (payment requests, proofs, spending). Keep the copy **off** the server:

```bash
# from your own computer
scp <USER>@<SERVER_IP>:~/x402-repo/test-environments/00_demo/server/wallet.json ./backup/
scp <USER>@<SERVER_IP>:~/x402-repo/test-environments/00_demo/server/data/x402.db ./backup/
```

The database is SQLite in WAL mode; for a consistent copy, stop the service before transferring it
(`docker compose stop` or `sudo systemctl stop x402`).

**Monitoring.** The `/health` path returns `200` when the database, the connection to the chain
and the external API are all healthy, and `503` otherwise. It suits any uptime monitoring service,
or a simple cron job:

```bash
*/5 * * * * curl -fsS https://x402.your-domain.example/health >/dev/null || echo "x402 not responding" | mail -s "x402" you@your-domain.example
```

## 8. Think it through before going public

- **Cost.** The server runs continuously and is billed by time. If you only need it for a
  demonstration, stop it between uses.
- **The external API key.** Without a hard cap at the provider, abuse can run up real costs.
  Without a key the environment behaves exactly the same, it merely returns a stub response.
- **Legal text.** If you publish the site to a wider audience, add terms of use and a privacy
  statement; the server records wallet addresses and transaction hashes.
- **Testnet only.** The default configuration is Ethereum Sepolia. Moving to a network with real
  value would require an audit, a greater confirmation depth and care in key storage — this
  environment is not intended for that.

## Troubleshooting

| Symptom | Cause |
|---|---|
| the connection times out with no answer | port closed in the firewall (often at the provider, not in `ufw`) |
| `Connection refused` | the port is open but the server is not running |
| Caddy does not obtain a certificate | DNS has not propagated yet, proxying mode is not turned off, or port 80 is closed |
| `/health` returns 503 | no reachable JSON-RPC node — check `RPC_URL` |
| `wallet.json not found` | the merchant wallet is not on the server, or is at the wrong path |
| `429 Too Many Requests` | rate limiter; lengthen the pause between requests |
