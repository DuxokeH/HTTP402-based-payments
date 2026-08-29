# 05 — Website, direct topology (a)

A single server process serves a website with **three tabs** — one-time payment, machine
payments per transaction, and a metered prepaid session — all at one address and with a live
log of the flow. The purpose of this folder is to **show all three payment flows in one system**
(demonstration, screenshot proof, Wireshark capture), not to collect measurement samples.

> **Architecture (a) — direct.** The merchant verifies payments **itself**, directly on chain
> through its own RPC provider; there is no third party on the payment path. The comparison
> variant with a **facilitator** (topology (b)) lives in
> [`../04_website_facilitator/`](../04_website_facilitator/); folders 04 and 05 form the
> measurement pair for comparing the two topologies.

**No smart contracts** — the metered mode is built on off-chain EIP-191 signatures (smart
contracts are future work).

## What the experiment measures

Folder 05 **runs no measurements and produces no result files at all** (no CSV, no JSON summary,
no figures). The timings and events of the tabs are shown live over SSE in the browser only and
are never exported anywhere; in SQLite under `server/data/` the server keeps only the
operational state the flow needs (payment requests, proof tokens, sessions and debits). What the
experiment does show:

| Tab | Classic card (native ETH flow) | x402 v2 card |
|---|---|---|
| **1 · One-time payment** | a human pays ~0.0000001 ETH through MetaMask → access to the service; in mock mode the JS adds a **Demo (mock, no MetaMask)** button | MetaMask signs an EIP-3009 authorisation, the server settles it itself |
| **2 · Machine payments (20 tx)** | the **Run** button: for every IoT reading the built-in M2M agent performs **one on-chain transaction**, events live (SSE) | the **Run (x402)** button: one x402 settlement per query |
| **3 · Metered session** | the **Run** button: **1 top-up** + N EIP-191 signatures with no new transactions; shows credit, budget and validity | the **Run (x402)** button: 1 top-up + N local signatures; the events tell an ON-CHAIN TOP-UP apart from OFF-CHAIN DEBITS through the `chain` flag |

For **precise measurements and charts** use folders 01–03 (separate measurement clients and
analyses) and folder 04 for the topology comparison. This website duplicates the logic of those
folders into one hosted server for a live demonstration.

So what can be shown here: the complete protocol flow (402 → payment → proof → 200) in a single
browser, a side-by-side comparison of the classic flow and x402 on the same page, the behaviour
of a session across a network switch, and a Wireshark capture of the messages over plain HTTP.

## Requirements

- **Node.js ≥ 20** and **npm** (`better-sqlite3` is compiled from source; on a bare system you
  also need `python3`, `make` and `g++`).
- **A browser with internet access** — `public/app.js` (the entire classic part of the page)
  imports the `viem` library from the `https://esm.sh` CDN. Without internet access that module
  never loads at all, so tab switching, both classic M2M cards and the “Session and identity”
  section stop working too. The x402 cards use the local `public/x402-browser.js` bundle and need
  no CDN.
- The **MetaMask** extension: for the classic card of tab 1 in real mode (a funded wallet on
  Ethereum Sepolia), and for the **x402 v2** card of tab 1 always — that one has no Demo button
  and MetaMask signs the EIP-3009 authorisation even in mock mode.
- For real mode: a **funded test wallet** on the Ethereum Sepolia network (test ETH from a public
  faucet). The repository contains no keys — you create the wallet yourself.
- Optional for a remote deployment: **Docker** and **Docker Compose** (a `Dockerfile` and a
  `docker-compose.yml` with Caddy for TLS are included).
- Python is **not** needed — this folder has no analysis.

## Folder structure

```
server/                        the only component — a single Node process (port 8080)
  server.js                    merged server (all three flows + SSE + session cookie + static page)
  runner.js                    built-in M2M agent (real HTTP over loopback + SSE events)
  auth.js                      admin login (password + machine token + CSRF protection) — see ../README.md
  db.js                        SQLite for all three classic flows (+ browser session correlation)
  x402.js                      x402 v2 — self-facilitated verification and settlement
  db_x402.js                   separate SQLite database for x402 payments and sessions
  x402-client.js               x402 payer for the built-in agent (server side)
  public/
    index.html                 three tabs, each with two cards (classic + x402)
    app.js                     classic cards (MetaMask via viem from esm.sh) + SSE + session view
    x402-ui.js                 x402 cards (requires `window.X402Klient`)
    x402-browser.js            BUILT browser bundle (esbuild output, do not edit)
    styles.css
  src/
    x402-browser.src.js        the source esbuild builds public/x402-browser.js from
  package.json  package-lock.json  .env.example  wallet.example.json
  Dockerfile  docker-compose.yml  Caddyfile  .dockerignore
```

The `server/data/` folder does not exist in the repository — the server creates it on first start.
There are no `analysis/` or `measurements/` folders in this scenario.

## Installation

```bash
cd server
npm ci                                  # or npm install; includes the esbuild devDependency
npm run build:client                    # only after changing src/ (see the note)
cp .env.example .env
cp wallet.example.json wallet.json
```

**The `npm run build:client` step is specific to this folder.** The command has esbuild build
`public/x402-browser.js` from `src/x402-browser.src.js`:

```
esbuild src/x402-browser.src.js --bundle --minify --format=iife --outfile=public/x402-browser.js
```

`index.html` loads the bundle unconditionally (`<script src="/x402-browser.js">`), so without it
the x402 cards do not work. The built bundle is committed to the repository, so the first run
works even without building; re-run the command only when you change
`src/x402-browser.src.js` or delete the file. **The Docker image does not run esbuild and does
not copy the `src/` folder** (the `Dockerfile` copies only `public/`), so the bundle must be
present on the host **before** `docker compose build`.

**Wallet.** You create `wallet.json` yourself; the repository contains no keys and `.gitignore`
excludes the file. The server reads:

| key | meaning |
|---|---|
| `address` | **required** — the address that receives payments. In mock mode any valid address will do. |
| `payerPrivateKey` | the private key of a **funded** wallet the built-in agent pays from in tabs 2 and 3 (real mode only). |
| `x402PayerPrivateKey` | the payer for the x402 cards in tabs 2 and 3 — required **only in real mode**; with `X402_MOCK=true` the built-in agent creates a single-use random wallet for every run. |
| `x402Address` | optional x402 recipient (`payTo`); without it `address` is used. |
| `x402SettlerPrivateKey` | the server's settlement key for x402 (needs ETH for gas); not needed in mock mode — a deterministic dummy account is used there. |

Never share a private key and never commit one to git.

> **Configuration trap: `NODE_ENV`.** Leave `NODE_ENV=development`. With `production` the server
> **ignores** `MOCK_VERIFY=true` and `X402_MOCK=true` (unless `FORCE_MOCK=1` is set), and `helmet`
> adds `upgrade-insecure-requests`, which breaks access over plain HTTP — precisely what the
> Wireshark capture needs. Likewise leave `COOKIE_SECURE=false`: the `Secure` flag is added
> automatically once a request arrives over HTTPS (including from behind Caddy via
> `X-Forwarded-Proto`).

## Running locally — mock (no funds)

A single terminal:

```bash
cd server
npm run mock                            # NODE_ENV=development MOCK_VERIFY=true, port 8080
```

Then open `http://localhost:8080` in a browser. Because the whole website is locked down, you are
redirected to `/login`; read the password from `data/admin-credentials.txt` (see the login section
below).

In mock mode both M2M tabs work immediately and without funds, and in tab 1 JavaScript adds a
**Demo (mock, no MetaMask)** button — that button exists only when `/config` returns
`mockVerify: true`.

The parallel x402 mode (likewise without funds):

```bash
X402_MODE=self X402_MOCK=true npm run mock
```

The `npm start` (`node server.js`) and `npm run dev` (`NODE_ENV=development node server.js`)
commands start the same server, except that they do not set `MOCK_VERIFY` themselves — they take
the value from `.env`. Since `.env.example` defaults to `MOCK_VERIFY=true`, `npm start` after
`cp .env.example .env` also runs in mock mode; for a real run you have to set
`MOCK_VERIFY=false` in `.env` yourself.

## Running locally — real measurements (Sepolia)

1. In `wallet.json` enter `address` (the recipient) and the `payerPrivateKey` of a funded wallet
   on Ethereum Sepolia.
2. In `.env` set `MOCK_VERIFY=false` and, if needed, your own `RPC_URL`. Leave `NODE_ENV` at
   `development`.
3. Run `npm start` and open `http://localhost:8080`.
4. Pay **tab 1** with MetaMask (the browser wallet must be funded on Sepolia). **Tabs 2 and 3**
   you start with the **Run** button; the M2M agent pays from `payerPrivateKey`.

> **Spending funds.** In real mode tab 2 performs as many real transactions as the number of
> queries you configure (20 by default), each with its own gas. The duration is tied to the
> Sepolia block time (on the order of ten seconds per transaction) — that is an **estimate, not a
> measurement from this folder**. For a quick demonstration reduce the number of queries or stay
> in mock mode.

> **Metered session limit.** Classic card of tab 3: the defaults are `TOPUP_WEI=2500000000000` and
> `PRICE_WEI_PER_CALL=100000000000`, which gives **at most 25 debits per session**. The input
> field does allow up to 200; above 25 the run stops with `insufficient_balance` (“Insufficient
> credit”) — `budget_exceeded` appears only if you send a `budgetWei` lower than the deposit
> yourself when opening the session. In **real** mode you raise the limit by increasing
> `TOPUP_WEI`; in **mock** mode `TOPUP_WEI` has no effect — there the server computes the deposit
> as `PRICE_WEI_PER_CALL × 25` (`server.js`, `/metered/session/open`), so mock always allows
> exactly 25 debits. The **x402** card of tab 3 has its own limit:
> `X402_SESSION_DEPOSIT_ATOMIC=2000000000000` divided by `X402_PRICE_ATOMIC=100000000000` gives
> **20 debits per session**.

> **x402 in real mode.** With the default test configuration (native ETH, which has no EIP-3009
> contract) a real (non-mock) x402 run is not possible: if `X402_MODE=self` is set without
> `X402_MOCK=true` and the asset address stays at zero, the server stops at startup with an error
> (`x402.js`). x402 settlement here is therefore always synthetic (a hash with the
> `0x6d6f636b6d6f636b` prefix). For a real x402 flow use the folder
> [`../06_x402/`](../06_x402/).

## Running on a remote server

The server runs on a remote host while the browser runs locally on your machine — this folder has
no separate client, the M2M agent runs in the same process and calls `http://127.0.0.1:<PORT>`.

```bash
ssh <USER>@<SERVER_IP>
git clone <repository-url> x402
cd x402/test-environments/05_website_direct/server

npm ci
npm run build:client                    # only after changing src/; the bundle is always built on the host
cp .env.example .env
nano .env                               # NODE_ENV=development (LEAVE IT!), COOKIE_SECURE=false
cp wallet.example.json wallet.json
nano wallet.json                        # address + payerPrivateKey if needed

sudo ufw allow 8080/tcp                 # the application
npm start                               # or npm run mock
```

Then open `http://<SERVER_IP>:8080`.

### The Docker and Caddy variant

A `Dockerfile` and a `docker-compose.yml` (application + Caddy with TLS) are included. The order
matters, because the image runs as an unprivileged user and needs a writable `data/`:

```bash
cp .env.example .env  &&  nano .env
cp wallet.example.json wallet.json  &&  nano wallet.json
npm ci && npm run build:client           # the bundle must exist BEFORE the image build
                                         # (it is committed; rebuild it only after changing src/)

docker compose build
UID_V=$(docker run --rm --entrypoint id x402-website-direct:latest -u)
GID_V=$(docker run --rm --entrypoint id x402-website-direct:latest -g)
mkdir -p data && sudo chown -R "$UID_V":"$GID_V" data

nano Caddyfile                           # replace your-domain.example with your own domain
nano docker-compose.yml                  # for the capture, uncomment  ports: - "8080:8080"
sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
docker compose up -d
docker compose ps                        # both services "running"
```

The `Caddyfile` obtains a Let's Encrypt certificate on its own (ports 80 and 443 must be open) and
sets `flush_interval -1` so the live view (SSE) is not buffered. In `docker-compose.yml` the
application is `expose: 8080` only by default and is not published to the host; the port
publication is commented out and you uncomment it yourself for an HTTP capture.

The image sets `NODE_ENV=production` in the `Dockerfile`; the value from `env_file: .env`
overrides it, so `NODE_ENV=development` in `.env` is mandatory if you want mock mode or access
over plain HTTP.

> **Exposure warning.** Screenshot proof of the flow (402, `X-Payment`, `X-Signature`) requires
> **plain HTTP**, because Wireshark cannot see the content under TLS. So restrict access on port
> 8080 to the LAN, loopback or your own IP address (`sudo ufw allow from <YOUR_IP> to any port
> 8080 proto tcp`) and close it again after the capture. Do the capture at
> `http://<SERVER_IP>:8080`, **not** at the domain: the HSTS from the `Caddyfile` forbids the
> browser from using `http://` on that domain for a year.

> **⚠ Wallet spending.** The *Run* buttons in tabs 2 and 3 trigger the built-in agent through the
> `/run/tx` and `/run/metered` paths. In **real** mode (`MOCK_VERIFY=false` + `payerPrivateKey`)
> this spends a real wallet. The admin login locks these paths down, so an anonymous visitor
> cannot trigger them — **keep the password safe** and leave `MOCK_VERIFY=true` for a publicly
> reachable demonstration.

## Admin login (the whole website is locked down)

Only the `GET /health`, `GET|POST /login` and `POST /logout` paths stay public — everything else
requires a login. The server **creates the credentials itself on first start** and refreshes them
into a file with 0600 permissions on **every** start:

```bash
grep PASSWORD data/admin-credentials.txt   # for logging in via the browser
grep TOKEN data/admin-credentials.txt      # machine token (Authorization: Bearer)
```

Open the website → you are redirected to `/login` → enter the username and password. The
**Logout** button is at the top. The built-in M2M agent obtains the token itself, so tabs 2 and 3
work with no extra configuration. If you set `ADMIN_USER`, `ADMIN_PASSWORD` and `ADMIN_TOKEN` in
`.env`, `admin.json` is not written and the password never reaches the disk in the clear (in
`admin-credentials.txt` there is a note `(from the ADMIN_PASSWORD environment variable)` in its
place). Even so, `admin-credentials.txt` is rewritten on every start and contains `USERNAME=` and
`TOKEN=`.

Because the `/run/*` launchers spend a wallet, on top of the login they also require the CSRF
token of the current session (`GET /run/token`), which the page appends to the `EventSource` URL,
and they reject requests that look like navigation (`Sec-Fetch-Mode: navigate`) or come from
another site (`Sec-Fetch-Site` other than `same-origin`). This prevents a foreign page from
triggering payments on behalf of a logged-in admin (CSRF). Machine access with the
`Authorization: Bearer <TOKEN>` header is exempt from CSRF.

Details: [admin login](../README.md#admin-login).

## Server routes

| access | paths |
|---|---|
| public | `GET /health`, `GET\|POST /login`, `POST /logout` |
| logged in | `/`, `/config`, `/session`, `/single/config`, `/single/service` (GET, POST), `/single/verify`, `/tx/reading`, `/tx/verify`, `/metered/session/open`, `/metered/session/:id`, `/metered/reading-metered` |
| logged in (CSRF token source) | `GET /run/token` |
| launchers (login + CSRF token) | `/run/tx`, `/run/metered`, `/run/x402-tx`, `/run/x402-metered` |
| only with `X402_MODE=self` | `/x402/config`, `/x402/single/service`, `/x402/tx/reading`, `/x402/metered/session/open`, `/x402/metered/session/:id`, `/x402/metered/reading-metered`, `/x402/payment/:id` |

## Session and identity (resilience to IP changes)

On the first visit the server stores a short-lived `sid` token in a cookie
(`HttpOnly; SameSite=Lax`, 30 min by default) and later reads it **only to correlate** the events
of one session: payment request (402) → proof token → access → metered session.

**`sid` is not authorisation.** A missing, invalid or altered cookie never causes a rejection —
access is decided by the wallet (the signature, or the sender of the transaction) and the one-time
token. Because the token travels with the browser and not with the network, the flow **survives an
IP change** (wifi ↔ mobile internet, NAT). The **“Session and identity”** section at the bottom of
the page shows this live; `GET /session` returns the same view as JSON (only with a truncated
`sid`, and no IP addresses).

Two settings: `WEB_SESSION_TTL_SECONDS` (1800 by default) and `COOKIE_SECURE` (leave it at `false`
— `Secure` is added automatically under HTTPS, including from behind Caddy; forcing it to `true`
makes login over plain HTTP impossible, which is exactly the Wireshark capture case).

The principle and the test procedure: [`../docs/IDENTITY.md`](../docs/IDENTITY.md).

## Wireshark

The website runs over **plain HTTP** by default, so Wireshark sees the 402 status response, the
`X-Payment` and `X-Signature` headers and the `X-Server-Ms` timing header. The filters are in
[Wireshark capture](../README.md#wireshark-capture). Under TLS (Caddy) Wireshark cannot see the
content, so use HTTP access on port 8080 for proof.

## Analysing the results

This folder **has no analysis** — there is no Python script, no `requirements.txt`, and no figure
is produced. The results of the tabs exist only as SSE events in the browser. For charts and
tables use the analyses in [`../01_one_time_payments/`](../01_one_time_payments/),
[`../02_machine_payments_per_request/`](../02_machine_payments_per_request/) and
[`../03_machine_payments_prepaid/`](../03_machine_payments_prepaid/), and for the topology
comparison [`../04_website_facilitator/`](../04_website_facilitator/).

## Expected outputs

**No CSV, JSON summary or PNG is produced.** On startup only the following are created in
`server/data/`:

| file | when |
|---|---|
| `website_direct.db` (+ `-wal`, `-shm`) | always; the path can be changed with `DB_PATH` |
| `x402_payments.db` (+ `-wal`, `-shm`) | only with `X402_MODE=self`; the path can be changed with `X402_DB_PATH` |
| `admin.json` (0600) | username, salt, password digest and token |
| `admin-credentials.txt` (0600) | rewritten on **every** start; contains `USERNAME=`, `PASSWORD=`, `TOKEN=` |

The root `.gitignore` excludes all of this.

**Signs of success:**

- `Wallet loaded` with the recipient address in the server log, followed by listening on port 8080;
- `curl -fsS http://localhost:8080/health` returns a 200 response (without a login);
- after logging in, the browser shows the page with three tabs;
- tab 2 prints one line per query live and finishes with an `end` event;
- tab 3, classic card: the line `Session opened (1 on-chain transaction)` and then one line per debit
  with a decreasing `credit=… wei`;
- tab 3, x402 card (only with `X402_MODE=self`): the line `⛓ ON-CHAIN TOP-UP` and then N
  `✎ OFF-CHAIN debit …` lines with a decreasing remainder (the log prints the newest entries at
  the top).

## x402 v2 (parallel mode — self-facilitated)

Alongside the classic one, all three tabs also have an x402 card (ETH, Ethereum Sepolia — test;
settlement is synthetic/mock). The server verifies and settles **itself** — there is no call to a
facilitator anywhere in this folder. The signatures really are verified (off-chain), while in
`X402_MOCK=true` mode the settlement is done by a built-in stub and `X402_RPC_URL` is never
called; in real mode settlement would go through `X402_RPC_URL` (see the note on real mode above):

- tab 1: the “x402 v2” card — MetaMask signs an EIP-3009 authorisation;
- tabs 2 and 3: the **Run (x402)** buttons (SSE over `/run/x402-tx` and `/run/x402-metered`); the
  metered events tell an ON-CHAIN TOP-UP apart from OFF-CHAIN DEBITS through the `chain` flag.

Startup: `X402_MODE=self X402_MOCK=true npm run mock`. You build the browser bundle with
`npm run build:client`.

Two hard guards in the code (`server.js`, inside `if (x402.enabled)`): if x402 is enabled with a
value other than `X402_MODE=self`, or if `X402_FACILITATOR_URL` is set at the same time, the
process deliberately terminates at startup — folder 05 is facilitator-free by definition. With the
default `X402_MODE=off` neither guard fires. Protocol details:
[official x402 v2 protocol](../README.md#official-x402-v2-protocol).

## Troubleshooting

| symptom | cause and fix |
|---|---|
| the page loads but the x402 cards do not work | `public/x402-browser.js` is missing → `npm ci && npm run build:client` |
| the page is unresponsive (tabs do not switch), the console reports an import error | no access to `https://esm.sh` (the CDN for `viem`); without it the whole of `app.js` fails, i.e. all classic cards and the session section |
| there is no **Demo (mock, no MetaMask)** button | the server is not running in mock mode — `/config` has to return `mockVerify: true` |
| `MOCK_VERIFY=true` has no effect | `NODE_ENV=production` cancels mock; set `NODE_ENV=development` |
| the browser insists on `https://` on port 8080 | `NODE_ENV=production` adds `upgrade-insecure-requests`; set `development` |
| the login goes round in circles over plain HTTP | `COOKIE_SECURE=true` — set it to `false` |
| tab 3 stops with `insufficient_balance` | the session deposit is exceeded (classic card 25, x402 card 20 debits); reduce the number of debits or — in real mode — increase `TOPUP_WEI` |
| the process terminates immediately at startup | x402 is enabled (`X402_MODE` is not `off`) with a value other than `self`, or `X402_FACILITATOR_URL` is set while x402 is enabled; with `X402_MODE=off` (the default) both guards stay dormant |
| there is no `data/admin-credentials.txt` in Docker | the `data/` folder is not writable by the user in the image — fix the ownership (see above) |

General instructions and step-by-step commands: [`test-environments/README.md`](../README.md) ·
login and credentials: [admin login](../README.md#admin-login).
