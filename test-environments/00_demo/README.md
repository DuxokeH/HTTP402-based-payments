# x402 web test environment

A self-contained environment that demonstrates a payment made with the **x402** protocol on top
of the **HTTP 402 Payment Required** status code. The server offers a paid service, the client
pays on the **Ethereum Sepolia** testnet, and the payment is verified directly on the chain — with
no facilitator and no smart contracts.

The point of this environment is that you can **run the protocol yourself and watch it happen**.
Traffic goes over plain HTTP (no TLS) so that every message is readable in Wireshark. For the
measurement experiments, see the neighbouring scenarios in [`..`](..).

## Protocol flow

Payment and content delivery are **merged into two exchanges, that is four messages**: verifying
the transaction and delivering the content happen in the same `POST /service`.

```
 client                           server                          Sepolia
    │                                │                               │
 1  │──── GET /service ─────────────►│                               │
    │                                │                               │
 2  │◄─── 402 Payment Required ──────│  {requestId, recipient, amount, network}
    │                                │                               │
    │──── payment transaction ───────┼──────────────────────────────►│
    │◄─── txHash ────────────────────┼───────────────────────────────│
    │                                │                               │
 3  │──── POST /service ────────────►│  {requestId, txHash, payerAddress, prompt}
    │                                │──── getTransaction ──────────►│
    │                                │◄─── confirmation ─────────────│
 4  │◄─── 200 OK ────────────────────│  {content, proofToken}
```

At step 3 the server checks that the recipient, the amount and the payer all match, that the
transaction is confirmed to the required block depth, and that the same `txHash` **has not been
redeemed before**. The proof token (`proofToken`) is single-use, has a limited lifetime and is
bound to the resource; with it the client can afterwards only confirm that the payment was made
(optional `--ack` flag).

## Requirements

- **Node.js ≥ 20** and npm
- for **real** mode: a wallet on the Ethereum Sepolia network holding test ETH from a public
  faucet (not needed for mock mode)
- optional: a browser with the **MetaMask** extension for the web client
- optional: **Wireshark** to capture the flow

## Installation

### 1. Create the test wallets

The repository deliberately **contains no wallets and no keys**. You create them yourself:

```bash
npm ci                     # install ethers for the generator
node generate-wallet.js
```

The script creates two independent wallets and writes them with `0600` permissions:

| File | Role | Needs funds |
|---|---|---|
| `server/wallet.json` | merchant — **receives** payments | no |
| `client/wallet.json` | client — **sends** payments | yes, for real mode |

If the files already exist, the script stops and does not overwrite them. Both are in
`.gitignore`.

> **Use a dedicated test wallet and nothing else.** Never enter the key of a wallet that holds
> real funds. Test ETH for Sepolia is free from a public faucet and has no value.

### 2. Install the dependencies

```bash
cd server && npm ci && cp .env.example .env
cd ../client && npm ci
```

## Local run — mock (no funds needed)

In mock mode the server never reads the chain and the client never sends a real transaction. The
sequence of HTTP messages is identical to the real one, which makes this mode well suited to a
Wireshark capture.

```bash
# terminal 1 — server
cd server
npm run mock            # MOCK_VERIFY=true, listens on port 3000

# terminal 2 — client
cd client
npm run mock
```

Expected client output: `402 Payment Required`, then `200 OK` with the content and the proof
token. With no `OPENAI_API_KEY` set, the server returns a clearly marked stub response
(`[DEMO MODE]`) — the HTTP flow is the same either way.

## Local run — real payment on Sepolia

Requires a funded `client/wallet.json`.

```bash
# terminal 1 — server
cd server && npm start

# terminal 2 — client
cd client
node run.js --pause-ms 1500 --prompt "What is the x402 protocol?"
```

The client sends a real transaction and waits for it to be confirmed, so the whole flow takes a
few tens of seconds. You can look the transaction up in a block explorer for the Sepolia network.

### Client arguments

| Argument | Meaning |
|---|---|
| `--mock` | does not send a real transaction; uses a fabricated `txHash` |
| `--prompt <text>` | the question sent to the service |
| `--pause-ms <n>` | pause between the two exchanges (a more readable Wireshark capture) |
| `--ack` | adds an optional third exchange: `GET /service` with an `X-Payment` header |

## Web client (MetaMask)

With the server running, open `http://127.0.0.1:3000`. The page performs the same flow through
MetaMask. It needs internet access (the `viem` library is loaded from the network) and MetaMask
switched to the Sepolia network.

## Running on a remote server

```bash
ssh <USER>@<SERVER_IP>
git clone <repo-url>
cd <repo-name>/test-environments/00_demo

npm ci && node generate-wallet.js     # create the wallets ON the server, or transfer them securely
cd server && npm ci && cp .env.example .env
npm start
```

Open the port and restrict access:

```bash
sudo ufw allow 3000/tcp
```

You then run the client locally against the remote server — set the address in
`client/config.json` (`MERCHANT_URL`).

> **Warning.** By default the server runs over plain HTTP, because the traffic has to stay
> readable for capture. The proof token is a bearer credential — anyone who intercepts it gets
> access to the content. On a public address, therefore, either restrict access to your own IP
> or put TLS in front.

For a production deployment with TLS, a container and the Caddy reverse proxy, `server/Dockerfile`
and `server/docker-compose.yml` are included:

```bash
cd server
cp .env.example .env                     # without this file Compose will not start
# server/wallet.json must exist (node ../generate-wallet.js) — otherwise Docker
# creates an empty FOLDER in its place and the server will not start
# enter your own domain in the Caddyfile instead of your-domain.example
docker compose up -d
```

The detailed procedure for deploying to a remote server (including spending limits, firewall,
HTTPS and backups) is in [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## Configuration

Every setting lives in `server/.env` (template: `server/.env.example`).

| Variable | Default | Meaning |
|---|---|---|
| `MERCHANT_PORT` | `3000` | server port |
| `NETWORK` | `sepolia` | network |
| `RPC_URL` | public Sepolia node | JSON-RPC endpoint |
| `MIN_CONFIRMATIONS` | `1` | required confirmation depth |
| `SERVICE_PRICE_ETH` | `0.0001` | price of a single service call |
| `PROOF_TOKEN_TTL_SECONDS` | `600` | proof token lifetime |
| `PAYMENT_REQUEST_TTL_SECONDS` | `1800` | payment request lifetime |
| `ALLOWED_ORIGINS` | empty | origins allowed by CORS |
| `OPENAI_API_KEY` | empty | without it the server returns a stub response |
| `OPENAI_DAILY_USD_CAP` | `5` | daily spending ceiling |
| `MOCK_VERIFY` | — | `true` = do not read the chain (development only) |

## Wireshark capture

1. **Interface:** `lo` (Loopback) if the server and the client run on the same machine;
   `wlan0` or `eth0` if the client is on another machine on the network.
2. **Decode As (required):** Wireshark does not recognise port 3000 as HTTP by default.
   Right-click a packet → *Decode As…* → TCP port 3000 → HTTP.
   For `tshark`: `-d tcp.port==3000,http`.
3. **Display filter:**
   ```
   tcp.port == 3000 && http
   ```
   Also useful: `http.response.code == 402`, `http contains "proof_"`, `http contains "txHash"`.
4. Start the capture first, then the client with a pause, so that the messages are cleanly
   separated:
   ```bash
   node run.js --mock --pause-ms 1500
   ```
5. The capture contains exactly the **four HTTP messages** from the diagram above. `--ack` adds
   the optional `GET` + `X-Payment` → `200` pair.

A quick check without the graphical interface:

```bash
sudo tshark -i lo -f "tcp port 3000" -d tcp.port==3000,http -Y http
```

## HTTP interface

| Method | Path | Description |
|---|---|---|
| `GET` | `/service` | with no proof, returns **402** together with a payment request; with a valid `X-Payment` header, confirms that the payment was made |
| `POST` | `/service` | verifies the transaction **and** delivers the content (merged exchange) |
| `GET` | `/config` | public configuration for the web client (network, price, recipient address) |
| `GET` | `/health` | status of the server, the database and the connection to the chain |

## Structure

```
generate-wallet.js     test wallet generator (merchant + client)
server/
  server.js            Express server: 402, payment verification, content delivery
  db.js                SQLite: payment requests, proof tokens, redeemed transactions, spending
  public/              web client (MetaMask)
  Dockerfile           container for a production deployment
  docker-compose.yml   application + Caddy (TLS)
  Caddyfile            reverse proxy — enter your own domain
  systemd/x402.service alternative to Docker
client/
  run.js               CLI client (mock and real mode)
  config.json          server address
docs/PROTOCOL_SPEC.md       formal protocol specification
docs/DEPLOYMENT.md          step-by-step deployment to a remote server
```

## Security mechanisms

- **Replay prevention** — each `txHash` can be redeemed only once; a second attempt returns
  `400 Transaction already redeemed`. Verification and proof issuance form a single database
  transaction, so not even two concurrent requests can both succeed.
- **Single-use proof token** — the "not yet spent" condition is part of the SQL statement, with a
  limited lifetime and a binding to the resource.
- **Match checking** — the recipient, the amount and the payer are checked against the payment
  request; addresses are normalised and `txHash` is compared in lower case.
- **Rate limiting**, `helmet`, input validation with `zod`, and a daily spending ceiling for the
  external API.

## Troubleshooting

| Problem | Fix |
|---|---|
| `wallet.json not found` at startup | run `node generate-wallet.js` in the root of this folder |
| The client reports insufficient funds | top up `client/wallet.json` from a Sepolia faucet (for a quick trial `npm run mock` is enough) |
| Wireshark shows no HTTP messages | *Decode As* for port 3000 is missing (see above) |
| `429 Too Many Requests` | rate limiter — wait a minute or lengthen the pause with `--pause-ms` |
| `/health` returns 503 | no connection to the JSON-RPC node; check `RPC_URL` and internet access |

## License

MIT — see [LICENSE](LICENSE).
