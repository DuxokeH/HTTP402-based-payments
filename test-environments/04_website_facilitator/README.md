# 04 — Website with a facilitator, topology (b)

The same flows and the same client interface as in [`../05_website_direct`](../05_website_direct), except
that **the merchant has no access to the chain**. All payment state and every verification is
handled by a separate process — the **facilitator**.

The two merchant code bases are not literally identical — in this folder every chain call is
replaced by a call to the facilitator (see [`server/facilitator.js`](server/facilitator.js)) — but what
the measurement compares is identical: the paths and headers the client sees, the prices and
the verification procedure. The controlled variable is therefore the topology, subject to the
limitations listed below.

The folder holds **three processes**: `facilitator/` (port 4000, the only one with chain access),
`server/` (the merchant, port 8081) and `agent/` (the measurement client). The facilitator has to
start first, because the merchant picks up its machine token at startup.

```
        topology (a) — folder 05                  topology (b) — this folder
   ┌──────────┐        ┌──────────┐     ┌───────────┐   ┌───────────┐   ┌─────────────┐
   │  payer   │◄──────►│ merchant │     │   payer   │◄─►│ merchant  │◄─►│ facilitator │
   └────┬─────┘        └────┬─────┘     └─────┬─────┘   └───────────┘   └──────┬──────┘
        │  chain (RPC)      │                 │  POST /submit-payment (HTTP)   │
        └───────────────────┘                 │  and chain (RPC): the payer    │
                                              │  writes, the facilitator reads │
   2 relationships · 3 exchanges              └────────────────────────────────┘
                                              3 relationships · 5 exchanges
```

In (b) the third relationship is **direct**: the payer sends `POST /submit-payment` to the
facilitator, bypassing the merchant (this is the facilitator's only public payment path), while the
payer and the facilitator each use the chain on their own — the payer submits the transaction, the
facilitator reads it.

## What the experiment measures

| Experiment | What it measures | Compared with |
|---|---|---|
| **payment per reading — mock** | facilitator branch, mock, payment per reading | folder 02 (the same measurement without a facilitator) |
| **payment per reading — real** | facilitator branch, real Ethereum Sepolia | folder 02, real run |
| **metered session** | **facilitator × metered session** | folder 03 (direct metered debit) |
| **message counting** | number of messages per payment flow, both branches | the 3-versus-5 exchanges claim |

Every CSV row separates three times: what the client measures, `X-Server-Ms` (the merchant's own
work) and `X-Downstream-Ms` (time spent waiting on the facilitator). The last is always 0 in the
direct branch — the difference is the measured cost of the topology. The
**facilitator × metered session** cell is the most telling one: a metered debit never waits for a
block confirmation (there is no new transaction), so the extra process hop is not drowned out
there by waiting on the chain.

### What the experiment does not measure

The facilitator here is **local and self-hosted** — on the same host as the merchant, under the
same administrator. The three costs the literature attributes to facilitators (dependence on
**availability**, dependence on **correctness**, and the **privileged observer**) all presuppose a
*third-party, hosted* service and do not arise with a facilitator of your own.

That makes the experiment **narrower but stricter**: because trust is held constant, the only
variable left is the process boundary. Two things must be kept in mind when reading the numbers:

1. the numbers are **not** a measure of the trust costs of the hosted x402 ecosystem;
2. because both processes sit on the same host, the numbers contain **no network distance** — the
   measured overhead is therefore a **lower bound** for a real, remote facilitator.

### Implemented protocol

Two different protocols go by the name "facilitator". This folder implements its own facilitator
flow, described below, and not the official x402 flow:

| | **implemented here** | official x402 — not implemented |
|---|---|---|
| paths | `payment-request` → `submit-payment` → `verify-proof` | `verify` + `settle` |
| who pays the gas | the **payer**, for their own transaction | the **facilitator**, which submits an EIP-3009 authorisation |
| the facilitator's role on chain | **reads** only | **writes** — submits the authorisation |
| asset / network | native ETH on Ethereum Sepolia | EIP-3009 token (e.g. USDC/EURC) |

This facilitator flow was chosen because it stays comparable with the direct branch, because it
runs on a network the project already uses, and because this folder's comparative claims are made
against exactly that. EIP-3009 (and with it the official flow with a hosted facilitator) remains
future work; a partial implementation is in the [x402 v2](#x402-v2) section below.

Flow (5 exchanges / 10 messages / 3 relationships):

```
C → M   GET /tx/reading                        M → F   POST /payment-request
F → M   201 {requestId, paymentInfo}           M → C   402 {…, facilitatorUrl}
C → B   payment transaction                    C → F   POST /submit-payment {requestId, txHash}
F → B   getTransaction + getTransactionReceipt F → C   200 {proof.token}
C → M   GET /tx/reading + X-Payment            M → F   POST /verify-proof {token}
F → M   200 {verified:true}                    M → C   200 content
```

Metered sessions are not covered by the flow above (they are an extension), so they follow its
principle — the facilitator "checks the signature, the payer's credit and the match with the
stated requirements":

- `POST /session/open` — the merchant forwards the top-up; the facilitator confirms it on chain and
  opens a session (holding the credit, the budget and the validity);
- `POST /debit` — the merchant forwards a signed debit; the facilitator checks the EIP-191
  signature, the freshness of the nonce, the budget and the signed maximum, and approves it.

Throughout this the client interface stays **unchanged** (the same paths, the same headers as in
folder 05) — which is exactly why the metered-session experiment isolates the topology instead of
comparing two different APIs.

### Fixes relative to an earlier facilitator implementation

An earlier facilitator implementation (not part of this repository) had five bugs, each of which
would on its own have spoiled the comparison. All of them are fixed in this folder:

| # | Bug | Fix here |
|---|---|---|
| 1 | the proof token was **never consumed** — `/verify-proof` was a bare read, so a single token unlocked the resource without limit | single use, the `consumed_at IS NULL` condition lives in the SQL (safe under concurrency too), TTL 600 s — the same as in the direct branch |
| 2 | **no `txHash` replay check** — one transaction could satisfy N different `requestId`s | `redeemed_tx_hashes` with a PRIMARY KEY; redemption and proof issuance in the same database transaction |
| 3 | **floating-point comparison** (`parseFloat(formatUnits(...)) >= parseFloat(amount)`) | integer `BigInt` wei only |
| 4 | `MIN_CONFIRMATIONS` **documented but not enforced** — the mere existence of a receipt counted as enough | the depth is genuinely computed (`latest − blockNumber + 1`) and too shallow an entry is rejected |
| 5 | **no authentication, no rate limiting, a hard-coded port, state in memory** | a machine token for the merchant, a cap on concurrent chain reads, `FACILITATOR_PORT`, SQLite instead of in-memory structures |

Fixes 1, 2, 3 and 5 are covered by `node agent.js --security`; fix 4 you verify by hand
(see [Security tests](#security-tests)).

## Requirements

- **Node.js ≥ 20** and npm (facilitator, merchant, agent).
- **Python ≥ 3.9** for the analysis (`matplotlib`, `pandas`, `numpy`).
- For mock mode: nothing else — no funds, no chain.
- For real mode (real transactions): **a funded wallet on the Ethereum Sepolia network** and a
  reachable JSON-RPC endpoint. Test ETH comes from a public Sepolia faucet. The repository holds
  no keys and no wallet — you create those yourself.
- For the Docker variant: Docker and `docker compose`.

## Folder structure

```
04_website_facilitator/
├─ facilitator/        THE ONLY one with chain access (port 4000)
│  ├─ server.js · db.js · auth.js · x402.js · db_x402.js
│  ├─ Dockerfile · .env.example · wallet.example.json · package.json
│  └─ data/            created at startup: facilitator.db, admin-credentials.txt
├─ server/             the merchant — website WITHOUT the chain (port 8081)
│  ├─ server.js · facilitator.js · runner.js · db.js · auth.js · x402.js · db_x402.js
│  ├─ public/          index.html · app.js · styles.css
│  ├─ Dockerfile · .env.example · wallet.example.json · package.json
│  └─ data/            created at startup: website_facilitator.db, admin-credentials.txt
├─ agent/              the measurement client
│  ├─ agent.js         payment per reading / metered session / security tests / x402
│  ├─ count-proxy.js   counting proxy (message counting)
│  └─ x402-client.js · config.json · wallet.example.json · package.json
├─ analysis/           facilitator_analysis.py · style.py · requirements.txt
│  └─ figures/         created only when the analysis runs
├─ measurements/       CSV and JSON results (created only when you measure) + README.md
├─ docker-compose.yml  three services: facilitator · merchant · caddy
├─ Caddyfile
└─ README.md           (this file)
```

The key file for understanding the topology is [`server/facilitator.js`](server/facilitator.js):
it is exactly the mapping "every chain call → a call to the facilitator", and nothing else.

## Installation

```bash
cd test-environments/04_website_facilitator

# facilitator
cd facilitator && npm ci && cp .env.example .env && cd ..

# merchant
cd server && npm ci && cp .env.example .env
cp wallet.example.json wallet.json      # enter YOUR OWN receiver address
cd ..

# measurement agent
cd agent && npm ci && cd ..
```

`npm ci` uses the bundled `package-lock.json`; if that does not work out for any reason, use
`npm install`.

Wallets:

- the **merchant** needs `server/wallet.json` with the receiver address, otherwise it will not
  start; no private key is needed there (do not put one in for mock mode).
- the **facilitator has no wallet** — it only reads the chain. `facilitator/wallet.example.json` is
  needed only for the settlement key of the parallel x402 mode.
- the **agent** needs `agent/wallet.json` only for `--real`; in mock mode it creates a
  single-use wallet with no funds.

You create the keys yourself. The repository does not contain them, and `.gitignore` deliberately
excludes `wallet.json` and `.env`.

## Local run — mock (no funds)

Three terminals. **Start the facilitator first**, because at startup the merchant reads its machine
token from `../facilitator/data/admin-credentials.txt`. (If you reverse the order, the merchant
reads the token later, on the first 401/403 rejection — but only when the facilitator's `data/`
folder is on the same host and reachable. That does not hold under Docker, where
`FACILITATOR_TOKEN` is mandatory.)

```bash
# 1) facilitator
cd test-environments/04_website_facilitator/facilitator
npm run mock                       # → http://localhost:4000

# 2) merchant
cd test-environments/04_website_facilitator/server
npm run mock                       # → http://localhost:8081
```

If you split the processes (another host, Docker), transfer the token by hand:

```bash
grep TOKEN facilitator/data/admin-credentials.txt   # → FACILITATOR_TOKEN in server/.env
```

The website's admin password (the two components have **separate** logins):

```bash
grep GESLO server/data/admin-credentials.txt    # login to the merchant website
grep GESLO facilitator/data/admin-credentials.txt   # the facilitator's separate login
```

Check that the branch is consistent:

```bash
curl -s localhost:8081/health | python3 -m json.tool
#   "chain": "no access (facilitator only)"
#   "facilitator": "ok",  "mockMismatch": false
```

Both mock measurements in the third terminal:

```bash
cd test-environments/04_website_facilitator/agent
export ADMIN_TOKEN=$(grep '^TOKEN=' ../server/data/admin-credentials.txt | cut -d= -f2)

npm run mock            # payment per reading through the facilitator (20 queries)
npm run mock-metered    # metered session through the facilitator (20 debits)
```

`ADMIN_TOKEN` is the **merchant's** token (the website is closed behind an admin login). The
facilitator's `/submit-payment` path is public and needs no token.

Agent flags (the CLI overrides the environment variable, which in turn overrides
`agent/config.json`): `--mock` / `--real`, `--tx` / `--metered`, `--queries N` (20), `--debits N` (20),
`--pause-ms N`, `--topup-wei`, `--merchant-url`, `--facilitator-url`, `--rpc-url`,
`--confirmations`, `--out <path.csv>`, `--security`, `--x402`.

### Message counting

The facilitator branch needs **two** counters, because it has three relationships. The merchant has
to be run **through** the facilitator's counter, otherwise the `payment-request` and `verify-proof`
exchanges are not counted at all and we end up counting three exchanges instead of five.

```bash
# 1) the counters (two windows)
cd test-environments/04_website_facilitator/agent
node count-proxy.js --listen=3101 --target=http://127.0.0.1:8081 --tag=merchant
node count-proxy.js --listen=3102 --target=http://127.0.0.1:4000 --tag=facilitator

# 2) restart the merchant SO THAT it calls the facilitator through counter 3102
cd ../server && FACILITATOR_URL=http://127.0.0.1:3102 npm run mock

# 3) a single payment flow through both counters
cd ../agent && node agent.js --mock --tx --queries 1 \
    --merchant-url http://127.0.0.1:3101 --facilitator-url http://127.0.0.1:3102

# 4) Ctrl+C in both counters → prints the summary and measurements/e9_<tag>.csv
```

For the direct branch, do the same with a single counter in front of folder 05 (its server has to be
running there on 8080):

```bash
node count-proxy.js --listen=3101 --target=http://127.0.0.1:8080 --tag=neposredno
```

Expected: **5 exchanges / 10 messages for the facilitator branch**, **3 / 6 for the direct one**. The
counter listens on `127.0.0.1` only. Setup paths (`/config`, `/health`, `/login`, `/logout`,
`/session`, `/run/*`, `/favicon*`) and long-lived SSE streams are recorded in the CSV with the
column `payment=0` and do not count towards the payment flow.

### Wireshark capture

This branch has **two** traffic pairs, so capture both: port **8081** (client ↔ merchant) and
**4000** (client ↔ facilitator, and merchant ↔ facilitator). Only the two together show all five
exchanges. General capture instructions (interface, login, session cookie) are in
[Wireshark capture](../README.md#wireshark-capture); the filters for this branch are below. Because
Wireshark by default dissects only well-known ports as HTTP, use **Decode As → HTTP** on 4000
and 8081.

```
tcp.port == 8081 || tcp.port == 4000
http.request.uri contains "submit-payment"    # the payer → facilitator arrow
http.request.uri contains "verify-proof"      # the merchant → facilitator arrow
```

### Verification: the merchant really has no chain

The sharpest test that topology (b) is more than just a label. Give the merchant a **broken**
`RPC_URL` and the agent a working one — payments must keep going through, because the merchant
never calls the chain. The proof is convincing only in real mode: in mock mode the agent does not
use the chain at all, so `--rpc-url` proves nothing there.

`MOCK_VERIFY=false` has to be set in **both** `.env` files (the facilitator really does have to read
the chain). If the modes differ, the agent refuses the measurement with "Mode mismatch" and
proves nothing.

```bash
# the merchant with a nonsense RPC (the facilitator runs normally)
cd server && RPC_URL=http://127.0.0.1:1 npm start

# the agent with a working RPC and a funded wallet
cd agent
export ADMIN_TOKEN=$(grep '^TOKEN=' ../server/data/admin-credentials.txt | cut -d= -f2)
node agent.js --real --tx --queries 5 --rpc-url https://ethereum-sepolia-rpc.publicnode.com
```

A static check that costs nothing shows the same thing:

```bash
grep -n "JsonRpcProvider" server/server.js    # in comments only
grep -n "JsonRpcProvider" facilitator/server.js   # the only real one is here
```

One exception worth stating honestly: `server/runner.js` **does** have a `JsonRpcProvider`. That is
not the merchant's role but the built-in payer behind the `/run/tx` and `/run/metered` buttons (the
C→B arrow on the diagram) — the same job as the external agent, only running in the same process.
The merchant's request path (`server.js`, `facilitator.js`) never reaches the chain; the external
agent therefore proves more than `grep` does.

## Local run — real measurements (Sepolia)

A real run requires **a funded test wallet**; without one it cannot be carried out.

1. Put the private key of a funded Sepolia wallet into `agent/wallet.json`
   (`cp wallet.example.json wallet.json`). Test ETH comes from a public faucet.
2. Put the receiver address into `server/wallet.json` (it can be another wallet of yours).
3. Set `MOCK_VERIFY=false` and a working `RPC_URL` in **both** `.env` files
   (`facilitator/.env` is the only place where `RPC_URL` is actually used; the merchant's is only a
   hint that it passes on to the payer).
4. Start the facilitator and the merchant with `npm start` (instead of `npm run mock`), then the agent:

```bash
cd test-environments/04_website_facilitator/facilitator && npm start     # → :4000
cd test-environments/04_website_facilitator/server  && npm start     # → :8081

cd test-environments/04_website_facilitator/agent
export ADMIN_TOKEN=$(grep '^TOKEN=' ../server/data/admin-credentials.txt | cut -d= -f2)
npm run real            # payment per reading · real transactions on Sepolia
npm run real-metered    # metered session with a real top-up
```

Every query in `--real` waits for a block confirmation, so a run of 20 queries takes a few
minutes and spends test ETH (gas + `PRICE_WEI_PER_READING`). By default the agent takes the
confirmation depth from the facilitator; `--confirmations N` lets you force it.

The security tests **do not work** in real mode (`--real --security` exits with an error) —
deliberately, because the attack scenarios would spend real funds.

## Running on a remote server

Both server processes (facilitator and merchant) listen on `0.0.0.0` and run over **plain
HTTP** — that is so the traffic is readable in Wireshark. Restrict access to your own IP, or use
the Docker + Caddy variant with TLS below.

```bash
ssh <USER>@<SERVER_IP>
git clone <repository-url> x402
cd x402/test-environments/04_website_facilitator

# installation is the same as locally (npm ci + .env + wallet.json)

sudo ufw allow 4000/tcp    # facilitator — the payer sends /submit-payment STRAIGHT here
sudo ufw allow 8081/tcp    # merchant
```

One setting in `server/.env` is **mandatory** for a remote payer:

```bash
FACILITATOR_PUBLIC_URL=http://<SERVER_IP>:4000   # what the merchant writes into the 402 response
FACILITATOR_URL=http://127.0.0.1:4000            # where the merchant itself calls
```

Without `FACILITATOR_PUBLIC_URL` an external agent or browser gets the address
`http://127.0.0.1:4000` in the 402 response and cannot submit `POST /submit-payment`.

The servers run on the VM, **you run the agent locally** with the matching addresses:

```bash
export ADMIN_TOKEN=<TOKEN from server/data/admin-credentials.txt on the server>
node agent.js --mock --tx --queries 20 \
    --merchant-url http://<SERVER_IP>:8081 \
    --facilitator-url http://<SERVER_IP>:4000
```

### Docker and Caddy (with TLS)

`docker-compose.yml` sits in **the root of this folder** (not in `server/`), because there are two
application services. The project name is set explicitly to `x402-facilitator`: otherwise Compose
would derive it from the folder name and this branch would quietly share its network and volumes
with folder 05.

```bash
cp facilitator/.env.example facilitator/.env
cp server/.env.example  server/.env
cp server/wallet.example.json server/wallet.json   # enter the receiver address
# put your own domain into the Caddyfile (it is written as your-domain.example by default)

docker compose up -d facilitator
grep TOKEN facilitator/data/admin-credentials.txt        # → FACILITATOR_TOKEN in server/.env
docker compose up -d
```

Inside containers the merchant cannot read the facilitator's `data/` folder, so
`FACILITATOR_TOKEN` is **mandatory** there. `FACILITATOR_URL=http://facilitator:4000` is set by
Compose itself.

Caddy exposes the facilitator under the `/facilitator` prefix (`handle_path` strips it, so the
facilitator's own paths stay unchanged), because the payer sends `POST /submit-payment` straight to
it. In `server/.env` therefore set
`FACILITATOR_PUBLIC_URL=https://<your-domain>/facilitator` and `COOKIE_SECURE=true`.

The ports of both application services are **commented out** in `docker-compose.yml`: uncomment
them only for a plain-HTTP capture (Wireshark, LAN). Under TLS the content is not visible, so do
the capture against `<SERVER_IP>:8081` and `<SERVER_IP>:4000`, not against the domain.

The `/run/tx` and `/run/metered` paths trigger the built-in agent and spend real funds in real
mode. The application closes them behind the admin login; the `Caddyfile` also has a commented-out
`basic_auth` for `/run/*` ready to go.

## Result analysis

```bash
cd test-environments/04_website_facilitator/analysis
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python3 facilitator_analysis.py             # → analysis/figures/
```

Two arguments: `--mode mock|real` (by default it tries both, whichever it finds) and `--out <folder>`
(default `analysis/figures`, the folder is created automatically). The permutation test is a local
implementation (20 000 repetitions, fixed seed), so `scipy` is not required.

**Inputs.** The script reads its own `measurements/facilitator_tx_*.csv`,
`measurements/facilitator_metered_*.csv` and `measurements/e9_*.csv`, and for the **two comparison
figures** also CSV files from the neighbouring folders:

- payment per reading → `../../02_machine_payments_per_request/measurements/transactions_*.csv`
- metered session → `../../03_machine_payments_prepaid/measurements/credit_*.csv`

If those are missing, only `e7_phases_<mode>.png` is produced (plus `e9_messages.png`, if message
counting was run), but no comparison figures — the output says so with the line
"no direct measurement (folder 02/03)".
Substitute sample data for folders 01–03 can be generated with
`../../comparison/generate_sample.py`; figures drawn from it carry a watermark. There is no sample
data for folder 04 — you produce that with a run of your own.

If there is no measurement at all, the script prints instructions and exits with code 1.

## Expected outputs

CSV and JSON in `measurements/` (on checkout the folder holds no results — only `README.md`):

| File | Created by |
|---|---|
| `facilitator_tx_mock.csv` / `facilitator_tx_real.csv` | `agent.js --tx` (payment per reading, mock / real) |
| `facilitator_metered_mock.csv` / `facilitator_metered_real.csv` | `agent.js --metered` (metered session) |
| `facilitator_tx_*_summary.json`, `facilitator_metered_*_summary.json` | the same — condensed run statistics |
| `facilitator_security.csv` | `agent.js --security` (columns `test,expected,actual,passed`) |
| `e9_merchant.csv`, `e9_facilitator.csv`, `e9_neposredno.csv` | `count-proxy.js --tag=<tag>` → `e9_<tag>.csv` |
| `x402_facilitator_tx_mock.csv` | `agent.js --x402` (no `_summary.json`) |
| `x402_facilitator_varnost.csv` | `agent.js --x402 --security` |

> **Measurement CSVs are APPENDED TO, not overwritten.** Delete the old file before repeating the
> same experiment, otherwise two runs merge into one and the analysis treats them as a single
> sample. The security CSVs are overwritten on every run.

Figures in `analysis/figures/` (150 dpi; the folder is created on the first analysis run):
`e7_phases_<mock|real>.png`, `e7_topology_<mode>.png`, `e8_metered_topology_<mode>.png`,
`e9_messages.png`, plus the summary table `facilitator_summary.csv`.

Signs of success:

- the merchant's `/health` returns `"chain": "no access (facilitator only)"`, `"facilitator": "ok"`
  and `"mockMismatch": false`;
- at the end of a run the agent prints a summary and the path to the CSV it wrote;
- every security test prints `✓` and the exit code is 0;
- the analysis prints a `✓ figure: …` line for every figure.

## Security tests

```bash
cd test-environments/04_website_facilitator/agent
export ADMIN_TOKEN=$(grep '^TOKEN=' ../server/data/admin-credentials.txt | cut -d= -f2)
npm run security          # = node agent.js --security
```

Requirements: both server processes are running, the merchant's `ADMIN_TOKEN` is set, and the
branch is in **mock** mode — `--real --security` deliberately exits with an error. The suite has
**20 tests**: the merchant without a chain, `/tx/verify` returning 404, single use of the proof
(bug 1), `txHash` reuse (bug 2), integer wei comparison (bug 3), facilitator authentication
(bug 5), `/health` staying public, and the metered session (missing signature → 402, nonce replay
→ 403, forged signature → 403, stale nonce → 400, budget exceeded → 402, credit exhausted → 402,
signature for another session → 403). If any test fails, the exit code is 1.

The fix for bug 4 (`MIN_CONFIRMATIONS`) is not in the suite, because it needs a doctored RPC.
Verify it by hand: the depth check only fires at `MIN_CONFIRMATIONS > 1`, so in the `facilitator`
folder run `MOCK_VERIFY=false MIN_CONFIRMATIONS=3 RPC_URL=<doctored> npm start` — an entry in a
shallow block must return the message `Too few confirmations (N < M)`.

The separation of privileges is deliberately strict, and the tests check it:

- **facilitator** — only `/health`, `/config`, `/submit-payment`, `/x402/supported`,
  `/login` and `/logout` are public; everything else (`/payment-request`, `/verify-proof`,
  `/session/*`, `/debit`, `/x402/verify`, `/x402/settle`, `/x402/reconcile`, `/x402/payment/:id`)
  requires `Authorization: Bearer <TOKEN>`;
- **merchant** — everything is closed except `/health`, `/login` and `/logout`.

## x402 v2

Alongside its own protocol (untouched; the basis for every measurement in this folder), the
facilitator also implements the **real x402 facilitator paths**: `POST /x402/verify`,
`POST /x402/settle` (both with the machine token), the public `GET /x402/supported` and the
additional `POST /x402/reconcile`. The facilitator holds the settlement key and the sole chain
access. The merchant (`X402_MODE=facilitated`) serves `GET /x402/single/service` and
`GET /x402/tx/reading`, and at startup it **rejects** `X402_RPC_URL` and any mode other than
`facilitated` — it stays chainless in both modes. The metered flow remains exclusively on the
project's own protocol.

```bash
# facilitator:  X402_MODE=self X402_MOCK=true npm run mock
# merchant:    X402_MODE=facilitated npm run mock

cd agent
export ADMIN_TOKEN=$(grep '^TOKEN=' ../server/data/admin-credentials.txt | cut -d= -f2)
node agent.js --x402 --queries 20     # → measurements/x402_facilitator_tx_mock.csv
node agent.js --x402 --security       # 11 tests (T1–T11)
```

The configuration is a **test** one: denominated in native ETH on Ethereum Sepolia, with synthetic
(mock) settlement. A real, non-mock run is locked deliberately — native ETH has no EIP-3009
contract, so it would first have to be wired up to a token (USDC/EURC). Details are in
[the official x402 v2 protocol](../README.md#official-x402-v2-protocol).

## Portability to other networks

Whether this branch would run on Sepolia, on production Ethereum, on Bitcoin or with USDC/EURC
tokens — and what would have to change for that — is described in
[`../docs/NETWORKS.md`](../docs/NETWORKS.md). In short: the facilitator branch is the
**shortest path** to a switch to tokens, because the transition changes only the facilitator and
leaves the merchant untouched.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| the merchant stops at startup with `Copy wallet.example.json -> wallet.json` | `server/wallet.json` with the receiver address is missing |
| `/health` returns `"facilitator": "down"` | the facilitator is not running, or `FACILITATOR_URL` is wrong — **start the facilitator first** |
| `/health` returns `"mockMismatch": true` | `MOCK_VERIFY` differs between the merchant and the facilitator; make both `.env` files agree |
| the merchant returns 401 on everything except `/health`, `/login` and `/logout` | the agent is missing the merchant's `ADMIN_TOKEN` (not the facilitator's) |
| the facilitator returns 401 on `/payment-request` | the merchant is missing `FACILITATOR_TOKEN` (mandatory whenever it cannot read the facilitator's `data/` folder) |
| an external payer cannot submit `/submit-payment` | `FACILITATOR_PUBLIC_URL=http://<SERVER_IP>:4000` is missing from `server/.env` |
| the counter counts 3 exchanges instead of 5 | the merchant was not run through the counter — `FACILITATOR_URL=http://127.0.0.1:3102 npm run mock` |
| the merchant stops with an error about `X402_RPC_URL` | in topology (b) the merchant must not have a chain; remove the variable |
| the analysis draws only `e7_phases_*.png` | the CSV files from folders 02 and 03 are missing (see [Result analysis](#result-analysis)) |
| the analysis exits with code 1 | there is no CSV in `measurements/` — run a measurement first |

General instructions: [`test-environments/README.md`](../README.md) — the
[What each environment shows](../README.md#what-each-environment-shows) and
[Recommended experiment order](../README.md#recommended-experiment-order) sections;
[admin login](../README.md#admin-login) (admin logins and tokens);
[`../docs/IDENTITY.md`](../docs/IDENTITY.md) (sessions and rate limiting). The recipe for message
counting is in the [Message counting](#message-counting) section above.
