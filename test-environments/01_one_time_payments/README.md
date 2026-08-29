# 01 — A one-time micropayment for service access

The server is the **provider** of a protected service (a demo response or an external API). For
**one** use of the service the user makes **one** on-chain transaction on the Ethereum Sepolia
network, and that unlocks access. The payer can be a human with **MetaMask** in the browser or a
**headless measurement client** (an M2M agent) — the protocol flow is identical in both cases.

Protocol flow — **3 exchanges / 6 HTTP messages** (every line with a method is a request +
response pair; the line in between is an on-chain transaction, not an HTTP message):

```
GET  /service                    → 402 Payment Required  (payment.requestId, amount, recipient)
     payment on Sepolia          → txHash
POST /verify-payment             → 200 { proofToken }     (the server reads the chain)
POST /service  (X-Payment)       → 200 + content
```

The proof token is bound to the resource (`resource`), so it cannot be used for a different
resource; every `txHash` is spent at most once. This folder is also the baseline for the
comparison against the merged exchange (folder [`06_x402`](../06_x402)) and against the official
x402 v2 protocol (section [x402 v2](#x402-v2)).

## What the experiment measures

Latency is measured per phase (in ms) for every run:

| Column | Phase |
|---|---|
| `t_challenge_ms` | `GET /service` → **402** response |
| `t_submit_ms` | submitting the transaction to the network (in mock mode only a local signature of a dummy transaction, with no submission) |
| `t_confirm_ms` | waiting for confirmation in a block (always `0` in mock mode — the chain is not used) |
| `t_verify_ms` | `POST /verify-payment` → proof token |
| `t_access_ms` | `POST /service` → content |
| `t_total_ms` | total time of one run, measured continuously from the challenge to the received content (not the sum of the phases above) |

> `t_total_ms` is measured continuously, so it **also includes the `--pause-ms` delays**: the
> client waits `--pause-ms` after each of the three exchanges within a run, and once more between
> runs. With `npm run real` (`--pause-ms 1500`), `t_total_ms` is therefore ≈ 4.5 s longer than the
> actual flow; for comparisons use the sum of the phases, or run with `--pause-ms 0`.

The server adds measurement headers to its responses, which makes it possible to separate
**server time**, **chain reads (RPC)** and **the external API call** from network latency:

| Header | Where it originates |
|---|---|
| `X-Request-Id` | in every response |
| `X-Server-Ms` | in every response on the `/service`, `/verify-payment`, `/config` and `/health` paths |
| `X-Chain-Read-Ms` | only `POST /verify-payment`, and only when the chain is actually read (so **not** with `MOCK_VERIFY=true`) |
| `X-Downstream-Ms` | only `POST /service` (demo response or external API call) |

In `--real` mode, `gas_units`, `gas_price_wei`, `fee_wei`, `fee_eth` and the block number are
recorded as well.

The experiment therefore shows which part of the total latency belongs to the HTTP 402 protocol
(a few ms) and which to the chain (block confirmation, typically most of the total time), and
what a single transaction costs.

## Requirements

- **Node.js ≥ 20** and **npm** (server and client).
- **Python ≥ 3.9** for the analysis (`analysis/`).
- For **real mode**: a funded wallet on the **Ethereum Sepolia** network (test ETH from a public
  faucet) and access to a public RPC provider. The repository **contains no keys at all** — create
  the wallet yourself (see [Installation](#installation)).
- Mock mode needs neither funds nor chain access.

## Folder structure

```
01_one_time_payments/
├─ server/        Express server (provider) + web UI for MetaMask
│  ├─ server.js              /config, /health, /service, /verify-payment routes
│  ├─ x402.js                parallel x402 v2 mode (/x402/* routes)
│  ├─ db.js, db_x402.js      storage for requests, tokens and spent txHashes (SQLite)
│  ├─ .env.example           settings template
│  ├─ wallet.example.json    template for the recipient address (no key)
│  └─ public/                static page: index.html, app.js, styles.css,
│                            x402-ui.js, x402-browser.js
├─ client/        headless measurement client
│  ├─ measurement_client.js  latency measurements and security tests
│  ├─ x402-client.js         client for x402 v2
│  ├─ generate-wallet.js     creates client/wallet.json
│  ├─ config.json            default server address and network
│  └─ wallet.example.json    template for the payer's wallet
├─ analysis/      latency_analysis.py, style.py, requirements.txt
└─ measurements/  output CSV/JSON files (the folder is created on the client's first
                  run; the results are not part of the repository)
```

Note: `server/public/x402-browser.js` is a **prebuilt bundle (~420 kB)**, shipped so that no
browser-side build step is needed. `public/app.js`, on the other hand, imports the `viem` library
straight from `https://esm.sh` (the CSP policy explicitly allows this), so the demo needs internet
access **in the browser**. The headless measurement client does not — every measurement runs
without it.

## Installation

```bash
cd server && npm ci     # or: npm install
cd ../client  && npm ci
```

Server settings:

```bash
cp server/.env.example server/.env
```

For mock mode `.env` is not required (`npm run mock` sets `MOCK_VERIFY=true` by itself), but for a
real run check at least `RPC_URL`, `MIN_CONFIRMATIONS` and `SERVICE_PRICE_ETH`.

### Wallets (a mandatory step before the first run)

- **Server — the recipient address only, never a private key:**

  ```bash
  cp server/wallet.example.json server/wallet.json
  # in wallet.json fill in the "address" field: the address that receives payments
  ```

  Without `server/wallet.json` the server **exits immediately at startup** with an error.

- **Client — only for `--real`:**

  ```bash
  cd client && npm run gen-wallet     # creates wallet.json with 0600 permissions
  ```

  The script never overwrites an existing file. Alternatively you can copy `wallet.example.json`
  to `wallet.json` and enter the private key of a **funded** Sepolia wallet (it needs test ETH for
  both the amount and gas). In **mock** mode the client wallet is not needed.

Both `wallet.json` files are excluded by `.gitignore` and are never published.

### Key settings in `server/.env`

| Variable | Default | Meaning |
|---|---|---|
| `MERCHANT_PORT` | `3000` | server port (listens on `0.0.0.0`) |
| `NETWORK` | `sepolia` | network |
| `RPC_URL` | public Sepolia RPC | provider for reading the chain |
| `MIN_CONFIRMATIONS` | `1` | required number of confirmations |
| `MOCK_VERIFY` | `false` | `true` skips reading the chain |
| `SERVICE_PRICE_ETH` | `0.0000001` | price of one use of the service |
| `ETH_EUR_RATE` | `2500` | exchange rate **for display in EUR only** |
| `PROOF_TOKEN_TTL_SECONDS` | `600` | proof token validity |
| `PAYMENT_REQUEST_TTL_SECONDS` | `1800` | payment request validity (lower it to test expiry) |
| `OPENAI_API_KEY` | empty | empty = deterministic demo response; setting a key enables a real external call and increases `t_access_ms` |
| `RATE_VERIFY_PER_MIN` | `60` | request limit on `POST /verify-payment` (per IP address, 60 s window) |
| `RATE_SERVICE_PER_MIN` | `120` | request limit on `/service` (per IP address, 60 s window) |

Those last two limits cap the number of runs per minute directly: one run consumes **one**
`verify-payment` request and **two** `/service` requests. With the settings unchanged, a mock run
without pauses therefore sustains at most **60 runs per minute**; for more runs, raise
`RATE_VERIFY_PER_MIN` and `RATE_SERVICE_PER_MIN`, or use `--pause-ms`.

At `ETH_EUR_RATE=2500` the default price of `0.0000001` ETH works out to ≈ **0.00025 EUR**
(0.025 cents). This is **test** ETH with no monetary value; the EUR conversion is purely for
reporting.

## Local run — mock (no funds)

Mock mode measures **protocol latency** without reading the chain, so it is reproducible and
spends no funds.

**Terminal 1 — server:**

```bash
cd server
npm run mock          # NODE_ENV=development MOCK_VERIFY=true, port 3000
```

**Terminal 2 — measurement client:**

```bash
cd client
npm run mock          # 50 runs
# or: npm start       # 30 runs
# or: node measurement_client.js --mock --runs 50 --out ../measurements/one_time_mock.csv
```

Browser (MetaMask demo): `http://127.0.0.1:3000` — the "Measurements" panel shows the timing of
each phase.

## Local run — real measurements (Sepolia)

Requires a funded wallet in `client/wallet.json` and a recipient address in `server/wallet.json`.

**Terminal 1 — server:**

```bash
cd server
npm start             # without MOCK_VERIFY: every payment is verified on the chain
# development output:  npm run dev
```

**Terminal 2 — client:**

```bash
cd client
npm run real          # = node measurement_client.js --real --runs 5 --pause-ms 1500
```

Keep the number of runs low (5–10): every run is a real transaction, spends test ETH and waits for
a block confirmation. The `--pause-ms` delay avoids `nonce` ordering problems (and counts towards
`t_total_ms` — see the note under the phase table).

For a Wireshark capture, use **plain HTTP** (no TLS); otherwise the `X-Payment` and `X-Server-Ms`
headers and the body of the **402** response are not visible in the capture. The capture procedure
is described in `../README.md`.

### Measurement client arguments

| Argument | Default | Meaning |
|---|---|---|
| `--mock` / `--real` | `--mock` | operating mode |
| `--runs N` | `30` | number of runs |
| `--pause-ms N` | `1000` (real), `0` (mock) | delay **between the exchanges within a run (3×) and between runs**; counts towards `t_total_ms` |
| `--prompt "…"` | demo text | the request content sent to the service |
| `--x402` | off | use the x402 v2 routes |
| `--security` | off | run the security tests instead of the measurements |
| `--out <path>` | default name in `measurements/` | path of the output CSV |

## Running on a remote server

The provider (`server/`) runs on the server and the payer (`client/`) on the local machine — the
payer always opens the connection, so only the server has to be reachable.

**On the server:**

```bash
ssh <USER>@<SERVER_IP>
git clone <repository-url>
cd <repository>/test-environments/01_one_time_payments/server
npm ci
cp .env.example .env
cp wallet.example.json wallet.json     # fill in the recipient address
sudo ufw allow 3000/tcp                # open the server port
npm run mock                           # or: npm start (real mode)
```

Check from the local machine: `curl http://<SERVER_IP>:3000/health`.

**Locally — the client measures against the remote server.** A single environment variable,
`MERCHANT_URL`, is enough (it takes precedence over `client/config.json`):

```bash
cd client
MERCHANT_URL=http://<SERVER_IP>:3000 npm run mock
MERCHANT_URL=http://<SERVER_IP>:3000 npm run real
```

This folder has no admin login, so no extra tokens are needed. Using a hostname instead of an IP
address is recommended — the configuration then survives a change of address.

> **Warning.** The server runs over **plain HTTP** (deliberately, so that the traffic is visible in
> Wireshark), so restrict access to your own IP address (e.g. `sudo ufw allow from <YOUR_IP> to
> any port 3000 proto tcp`) and shut the server down once the measurements are finished. Do not
> expose it publicly for longer than necessary, and do not use real funds.

## Analysing the results

```bash
cd analysis
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python3 latency_analysis.py
```

With no argument the script finds a CSV in `../measurements/` by itself, in the order
**`one_time_real.csv`, then `one_time_mock.csv`** (real measurements take precedence). You can
also name the file explicitly:

```bash
python3 latency_analysis.py ../measurements/one_time_mock.csv
python3 latency_analysis.py ../measurements/one_time_real.csv --out figures
```

The `--sample` flag stamps a "SIMULATED EXAMPLE" watermark on the figures (for figures built from
synthetic data). The default output directory is `analysis/figures/`.

The script processes **only** the CSVs of this project's own protocol. `x402_one_time_*.csv` files
are analysed by `../comparison/comparison_x402.py`.

## Expected outputs

Every measurement file is created in `01_one_time_payments/measurements/`:

| File | Created by |
|---|---|
| `one_time_mock.csv` + `one_time_mock_summary.json` | `npm run mock` / `npm start` (client) |
| `one_time_real.csv` + `one_time_real_summary.json` | `npm run real` |
| `x402_one_time_mock.csv` + `x402_one_time_mock_summary.json` | `--x402` |
| `security_tests_mock.csv` / `security_tests_real.csv` | `--security` |
| `security_tests_x402_mock.csv` | `--x402 --security` |

The client **appends** rows to an existing CSV (it writes the header only when the file is first
created), while it overwrites `_summary.json` every time. Delete the old file before a new
measurement series (`rm ../measurements/one_time_mock.csv`), otherwise the runs accumulate while
the JSON summary still describes only the last one.

The standard CSV has 20 columns:

```
seq,timestamp_iso,mode,t_challenge_ms,t_submit_ms,t_confirm_ms,t_verify_ms,t_access_ms,
t_total_ms,server_verify_ms,chain_read_ms,server_access_ms,external_api_ms,
gas_units,gas_price_wei,fee_wei,fee_eth,block,tx_hash,status
```

The x402 CSV has 25 columns (`protocol`, `topology`, `network`, `asset`, `gas_payer`,
`t_402_ms`, `t_sign_ms`, `t_payment_http_ms`, `verify_ms`, `settle_ms`, `idempotency`,
`synthetic_tx` and others).

The analysis writes to `analysis/figures/`: `01_latency_boxplot.png`, `02_phase_breakdown.png`,
`03_summary_table.png` and `latency_summary.csv`.

**Success signal.** The client prints one line per run as it goes, and a summary at the end
(`min / median / mean / p95 / max` per phase) together with the path to the CSV and JSON it wrote.
The `status` column carries the HTTP status code of the last step, so `200` for successful runs; a
failed run is **not** written to the CSV (it is reported as `✗ RUN <n> error: …`), which makes the
`SUMMARY · succeeded <n>/<runs>` line the measure of success. At startup the server prints the port
it listens on and the recipient address. The analysis script prints `✓` for every file it creates.

On its first start the server creates the `server/data/x402_one_time.db` database (and
`x402_payments.db` when `X402_MODE=self`); the `data/` folder is excluded by `.gitignore`.

## Security tests

These check that the protocol rejects malformed, replayed and forged inputs.

**This project's own protocol:**

```bash
# the server for the mock set must run with MOCK_VERIFY=true:
cd server && npm run mock
# client:
cd client
npm run security                             # mock (7 tests)
node measurement_client.js --security --real     # real mode (server: npm start)
```

The mock set runs 7 tests: access without payment → **402**, malformed `txHash` → **400**,
non-existent `requestId` → **400**, forged proof token → **403**, reuse of the same `txHash`
(replay) → **400**, first use of a token → **200**, second use of the same token → **403**.
In `--real` mode the last three are replaced by tests for a wrong recipient, an insufficient
amount and a payer mismatch; these are marked **skipped** in the output (running them would
require deliberately incorrect transactions), but they count as passed.

Output: `measurements/security_tests_{mock,real}.csv` with the columns
`test,expected,actual,passed,note`.

**x402 v2 (14 tests, T1–T14, mock only):**

```bash
# server:
cd server && X402_MODE=self X402_MOCK=true X402_MOCK_FAULTS=true npm run mock
# client:
cd client && node measurement_client.js --x402 --security
```

`X402_MOCK_FAULTS=true` is **mandatory** — tests T11 and T12 (forced settlement failures) fail
without it. The client exits with code `1` unless all 14 tests pass.
Output: `measurements/security_tests_x402_mock.csv`.

## x402 v2

Alongside this project's own flow (A1, native ETH), the folder supports the **official x402 v2
protocol** (A2) as a parallel mode: `GET /x402/service` in a **self-facilitated** topology — the
server verifies **and** settles the payment itself, while the client only signs an **EIP-3009**
authorization. Instead of a separate exchange for the proof token, the payment travels in the
x402 v2 protocol headers: the server describes the challenge in the `PAYMENT-REQUIRED` header of
the 402 response, the client sends the signed authorization in `PAYMENT-SIGNATURE`, and the server
returns the settlement outcome in `PAYMENT-RESPONSE`. The flow therefore takes **2 exchanges /
4 messages** (the `X-Payment` header from this project's own flow is not used here).

```bash
# server (mock — no funds):
cd server && X402_MODE=self X402_MOCK=true npm run mock
# client:
cd client && node measurement_client.js --x402 --runs 30     # → measurements/x402_one_time_mock.csv
```

With `X402_MODE=self` the routes `GET /x402/config`, `GET /x402/service` and
`GET /x402/payment/:id` are mounted; their responses carry the extra headers `X-Verify-Ms`,
`X-Settle-Ms` and `X-X402-Idempotent-Replay`.

> **Limitation of the test configuration.** In this setup the amounts are denominated in **ETH on
> Ethereum Sepolia**, and native ETH has no **EIP-3009** contract. Only a **mock/synthetic** run is
> therefore possible: a server started with `X402_MODE=self` but **without** `X402_MOCK=true` and
> without the address of a real EIP-3009 contract deliberately **throws an error** at startup. A
> real run requires a token with EIP-3009 support (the `X402_USDC_ADDRESS` and `X402_ASSET_*`
> settings) and a funded settlement wallet.

In the browser the page carries an "x402 v2" card (MetaMask signs the authorization; it uses the
`public/x402-browser.js` bundle). For a detailed explanation of the protocol and of every `X402_*`
variable, see `../README.md`.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| The server exits immediately | `server/wallet.json` is missing — create it from `wallet.example.json` |
| The client reports a missing wallet | `--real` without `client/wallet.json` — run `npm run gen-wallet` **inside the `client/` folder** |
| The client measures `127.0.0.1` instead of the server | set `MERCHANT_URL=http://<SERVER_IP>:3000` |
| `EADDRINUSE` on port 3000 | another process holds the port — change `MERCHANT_PORT` in `.env` |
| Runs fail with **429** | the `RATE_VERIFY_PER_MIN` (60) or `RATE_SERVICE_PER_MIN` (120) limit was reached — lower `--runs`, add `--pause-ms`, or raise the limits |
| A real run stalls or times out | a slow or throttled public RPC — change `RPC_URL`, increase `--pause-ms` |
| Insufficient funds | the wallet needs test ETH for both the amount **and** gas (public Sepolia faucet) |
| The analysis reports "No CSV found" | run a measurement first: `cd ../client && npm run mock` |
| x402 security tests T11/T12 fail | `X402_MOCK_FAULTS=true` is missing from the server startup |

General instructions: [`test-environments/README.md`](../README.md) — installation, server
deployment and an overview of every command; [Wireshark capture](../README.md#wireshark-capture)
(capturing traffic); [official x402 v2 protocol](../README.md#official-x402-v2-protocol);
[admin login](../README.md#admin-login) (applies to folders 02–05, not to this one).
