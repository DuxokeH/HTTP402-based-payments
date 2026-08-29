# 06 — Merged exchange: 4 messages instead of 6

A variant of the [`01_one_time_payments`](../01_one_time_payments) scenario built around a
**merged exchange**: on-chain payment verification and delivery of the paid content happen in the
**same** request and the same response. The complete paid flow therefore takes
**2 exchanges / 4 HTTP messages** instead of 3 / 6. There is **no** `POST /verify-payment` route
in this folder — its absence is the whole point of the variant.

Everything else is deliberately identical to folder 01: the same verification pipeline, the same
price, the same network (Ethereum Sepolia), the same measurement instrumentation. Comparing the
two folders therefore isolates **a single variable** — whether the proof token gets an exchange
of its own or not.

## What the experiment measures

- **The latency of the merged phase** `t_zdruzeno` (`POST /service`: verification + delivery)
  against the sum of `t_preverjanje + t_dostop` from folder 01. Expected:
  `t_zdruzeno ≈ t_preverjanje + t_dostop − 1 × RTT`.
- **The number of messages on the wire.** The paid flow has exactly **two** request/response
  pairs (folder 01 has three). In a Wireshark capture they are preceded by one more request,
  `GET /health`, which the measurement client uses at startup to check that the server is
  reachable — it is not part of the payment flow.
- **The latency breakdown by phase** (402 challenge, transaction submission, waiting for
  confirmation, merged phase) in mock and real mode.
- **The server's share of the latency** via the measurement headers `X-Server-Ms`,
  `X-Chain-Read-Ms` (non-mock only) and `X-Downstream-Ms`.
- **The protocol's resilience** to typical attacks and errors (10 security tests).

## Why a merged exchange

The custom protocol in folder 01 performs **3 exchanges / 6 messages**:

```
1→ GET /service                        ←2  402 (challenge: requestId, address, amount)
        (on-chain payment + waiting for confirmation — outside HTTP)
3→ POST /verify-payment {txHash}       ←4  200 {proofToken}
5→ POST /service (X-Payment: proof)    ←6  200 {content}
```

The moment the server receives confirmation of the transaction from the chain (step 4), it
**already has everything** it needs to deliver the content. Separating step 4 from steps 5–6 was
a **design decision** (fault isolation, repeatable verification, reuse of the same pipeline for
the credit flow in folder 03), not a technical necessity. This folder tests the merged variant:

```
1→ GET /service  (X-Payer)             ←2  402 (challenge: requestId, address, amount, TTL)
        (the client or MetaMask pays on chain, waits for confirmation, gets txHash)
3→ POST /service {requestId, txHash,   ←4  200 {response, proofToken, payment{txHash, blockNumber}}
         network, payerAddress, prompt}
```

- Message 3 carries both the **payment proof** (`txHash`) and the **order** (`prompt`).
- The server runs the same verification pipeline as folder 01 (the transaction exists, number of
  confirmations, status, recipient, payer, amount, `txHash` replay protection) and then returns
  the content and the proof token in the **same response**.
- The client stores the token (browser: `sessionStorage`). A later `GET /service` carrying the
  `X-Payment: proof_…` header returns **200 with an acknowledgement** that the payment has
  already been made (`authorized`, `consumed`, `expiresAt`) — with no new payment.
- In the browser demo the client sends the `txHash` (message 3) **automatically** once MetaMask
  confirms; the user does not have to click through an extra step.

### Edge cases

- **The external API fails after successful verification:** the payment has already been
  redeemed, so the server returns **502 together with a `proofToken`** — the payment proof stays
  with the client.
- **The daily AI cap is reached:** **503 with an UNSPENT `proofToken`**; the token is redeemed
  later through the **fallback path** `POST /service` with the `X-Payment` header (folder 01's
  semantics are kept as a fallback path for exactly these cases).
- **Replay of the same `txHash`:** the `redeemed_tx_hashes` table (the same protection as in 01)
  → **400**.
- **Reuse of a token:** the token is single-use and is consumed *before* the downstream call, so
  a second attempt returns **403**.

### Comparison with the two protocols

| | messages (client) | how the payment travels | who settles |
|---|---|---|---|
| 01 custom | 6 | outside HTTP (native ETH) | client |
| **06 merged** | **4** | outside HTTP (native ETH) | client |
| official x402 v2 | 4 | in a header (EIP-3009 signature) | server / facilitator |

On **message count** the merged variant draws level with official x402, yet it remains a custom
protocol: the payment is settled out of band (native ETH has no `transferWithAuthorization`) and
the server only reads the chain.

## Requirements

- **Node.js ≥ 20** and **npm** (server and client).
- **Python ≥ 3.9** for the analysis (`matplotlib`, `pandas`, `numpy`).
- For **real mode**: a funded wallet on the **Ethereum Sepolia** network (test ETH from a public
  faucet) to cover the payment amount and gas. The repository **contains no keys** — you create
  the wallet yourself.
- Mock mode works **without a wallet, without funds and without chain access**.

## Folder structure

```
server/    Express server (provider), port 3300, MetaMask demo at /
  server.js        merged flow: GET /service (402 / acknowledgement), POST /service (verification + delivery)
  db.js            SQLite: payment_requests, payment_proofs, redeemed_tx_hashes, openai_usage
  x402.js          parallel official x402 v2 protocol (off by default)
  db_x402.js       separate database for x402 v2
  public/          browser demo (index.html, app.js, x402-browser.js, x402-ui.js, styles.css)
  .env.example     settings template
  wallet.example.json  template: recipient ADDRESS only

client/      headless measurement client
  measurement_client.js    per-phase latency measurement + security tests
  x402-client.js    client for the parallel x402 v2 mode
  generate-wallet.js   creates a new client/wallet.json
  config.json          MERCHANT_URL, ENDPOINT, NETWORK, RPC_URL, CONFIRMATIONS
  wallet.example.json  template: payer private key (for --real only)

analysis/     latency_analysis.py, style.py, requirements.txt
```

The `measurements/`, `server/data/`, `analysis/figures/` and `node_modules/` folders and the
`wallet.json` and `.env` files **do not exist** in the repository and are gitignored: the folders
are created on startup, while `wallet.json` and the (optional) `.env` you create yourself,
following the instructions below.

## Installation

```bash
# server
cd server
npm ci                                   # or: npm install
cp .env.example .env                     # optional — every default is in the code
cp wallet.example.json wallet.json       # REQUIRED: enter the recipient address

# client
cd ../client
npm ci                                   # or: npm install
```

**The server's `wallet.json` is required even in mock mode.** If the file is missing, `server.js`
logs `fatal` and exits with code 1. It holds **only the address** of the recipient — never a
private key:

```json
{ "address": "0xYourRecipientAddress" }
```

For mock, any valid address will do; for a real run, enter the address on which you want to see
the payments arrive.

**The client's wallet** is needed **only for `--real`**. Create it yourself:

```bash
cd client
npm run gen-wallet     # creates client/wallet.json (mode 0600, never overwrites an existing one)
```

Fund the printed address from a public Sepolia faucet. Alternatively, copy `wallet.example.json`
to `wallet.json` and enter the private key of an already funded wallet. **Never commit**
`wallet.json` or `.env` to git (`.gitignore` covers both).

## Local run — mock (no funds)

Mock skips reading the chain: the server assembles the transaction from the request body. What
gets measured is therefore **pure protocol latency**, repeatably and free of charge.

**Terminal 1 — server:**

```bash
cd server
npm run mock            # NODE_ENV=development MOCK_VERIFY=true, port 3300
```

**Terminal 2 — client:**

```bash
cd client
npm run mock            # 50 runs → ../measurements/merged_mock.csv
# or: npm start        # 30 runs, same output file
```

The browser demo is at `http://localhost:3300/`, server health at `http://localhost:3300/health`,
settings at `http://localhost:3300/config`.

**Rate limiting:** `POST /service` accepts **60 requests per minute** from the same IP address
(`RATE_VERIFY_PER_MIN`), while `GET /service` accepts 120 (`RATE_SERVICE_PER_MIN`). Two
consecutive `npm run mock` invocations (2 × 50 POST requests) within the same minute therefore
hit **429**. Wait a minute between runs, or raise `RATE_VERIFY_PER_MIN` (the variable is not in
`.env.example` — add the line to `.env` or pass it on the command line:
`RATE_VERIFY_PER_MIN=300 npm run mock`).

Useful client flags:

| flag | default | meaning |
|---|---|---|
| `--real` | absent = mock | real run (requires `client/wallet.json` with `privateKey`) |
| `--runs N` | 30 | number of runs |
| `--pause-ms N` | 1000 (real), 0 (mock) | pause between phases and between runs |
| `--prompt "…"` | test prompt | content of the order in message 3 |
| `--out PATH` | see *Expected outputs* | explicitly chosen CSV output file |
| `--security` | off | security tests instead of measurements |
| `--x402` | off | parallel official x402 v2 mode |

## Local run — real measurements (Sepolia)

Every run sends a **real transaction** to Sepolia and spends test ETH (default price
`SERVICE_PRICE_ETH=0.0000001` + gas). Before a real run, **delete the mock results** — CSV files
are **appended to**, so otherwise the runs end up mixed in the same file:

```bash
rm -f ../measurements/merged_mock.csv ../measurements/merged_mock_povzetek.json
```

**Terminal 1 — server:**

```bash
cd server
npm start                                     # no MOCK_VERIFY, real chain reads
curl -s localhost:3300/config | grep -o '"mockVerify":[a-z]*'   # must be false
```

**Terminal 2 — client:**

```bash
cd client
npm run real            # = node measurement_client.js --real --runs 5 --pause-ms 1500
```

Result: `../measurements/merged_real.csv` (with the actual gas consumption and block numbers) and
`merged_real_povzetek.json`.

If you want to record the flow with Wireshark, start the capture **before** the client and use
plain `http://` (see [Wireshark capture](../README.md#wireshark-capture)). The paid flow must
have exactly **two** request/response pairs — that is the measurable difference from the three
pairs in folder 01. The measurement client's opening `GET /health` does not count towards the
total; filter it out in Wireshark with `http.request.uri != "/health"`.

The external API (OpenAI) is **optional**. Without `OPENAI_API_KEY` the server returns a
deterministic demo response, which is desirable for latency measurement because it removes the
noise of a third-party service.

## Running on a remote server

Typical setup: **server on a remote machine (VM), client locally.**

```bash
# on the VM
ssh <USER>@<SERVER_IP>
git clone <REPOSITORY_URL> x402
cd x402/test-environments/06_x402/server
npm ci
cp .env.example .env
cp wallet.example.json wallet.json      # enter the recipient address
sudo ufw allow 3300/tcp                 # open the port
npm run mock                            # or: npm start for a real run
```

The client runs locally; the only variable it needs is **`MERCHANT_URL`**:

```bash
cd client
MERCHANT_URL=http://<SERVER_IP>:3300 npm run mock
MERCHANT_URL=http://<SERVER_IP>:3300 node measurement_client.js --real --runs 5 --pause-ms 1500
```

Instead of the environment variable you can write `MERCHANT_URL` permanently into
`client/config.json` (default `http://127.0.0.1:3300`). The environment variable takes precedence
over the file. The same applies to `ENDPOINT`, `NETWORK`, `RPC_URL` and `CONFIRMATIONS`.

A **hostname** is preferable to an IP address: if the server's address changes, the configuration
does not have to be touched.

> **Warning.** The server deliberately runs over plain **HTTP without TLS**, so that the 402
> response and the `X-Payment` header are visible in a Wireshark capture. This is a measurement
> setup, not a production one: restrict access to port 3300 to your own IP address (e.g.
> `sudo ufw allow from <YOUR_IP> to any port 3300 proto tcp`) and do not leave the server exposed
> for longer than the measurement lasts. This folder has no Dockerfile and no reverse proxy — the
> server is started directly with `npm`.

This folder **has no admin login** and does not use `ADMIN_TOKEN` — both are needed by scenarios
02–05 (see [admin login](../README.md#admin-login)).

## Measured phases

| phase | meaning |
|---|---|
| `t_izziv` | `GET /service` → 402 (messages 1 + 2) |
| `t_oddaja` | signing and submitting the transaction (up to `txHash`); in mock mode **local signing only** of a dummy transaction, with no submission |
| `t_potrditev` | waiting for a block (real; always 0 in mock mode) |
| `t_zdruzeno` | `POST /service` → 200 (messages 3 + 4: verification + delivery) |
| `t_skupaj` | from the start to the end of the flow |

The server returns `X-Server-Ms` and `X-Request-Id` with **every** response. The
`X-Chain-Read-Ms` header is added only by `POST /service` in non-mock mode, and `X-Downstream-Ms`
only by the response that actually delivers the content (it is absent on 402, 400, 403 and 502).
All four are exposed through CORS, so they are readable in the browser demo as well.

## Analysing the results

```bash
cd analysis
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python3 latency_analysis.py
```

Without an argument the script looks for its input file in this order:
`../measurements/merged_real.csv` → `../measurements/merged_mock.csv` →
`../measurements/_sample/merged_real.csv` → `../measurements/_sample/merged_mock.csv` — **real
measurements take precedence over mock ones**. So before a new mock run, delete the old
`merged_real.csv` if you want a chart of the mock measurements, or name the file explicitly:

```bash
python3 latency_analysis.py ../measurements/merged_mock.csv
python3 latency_analysis.py ../measurements/merged_real.csv --out figures
```

If the script finds no CSV file at all, it prints instructions and exits with code 1.

The script also understands the `--sample` flag, which stamps the charts with the watermark
"SIMULATED EXAMPLE — NOT REAL MEASUREMENTS". The watermark is also added automatically whenever
`_sample` appears in the input file's path. The `../measurements/_sample/` folder **does not
exist** in the repository, and the generator in
[`../comparison/generate_sample.py`](../comparison/generate_sample.py) **does not create it** for
scenario 06 (it only knows scenarios 01–03) — you produce the input data with an actual run.

The `x402_zdruzena_*.csv` files (parallel x402 v2 mode) have a **different header**; automatic
discovery does not pick them up, and `latency_analysis.py` cannot process them.

## Expected outputs

All measurement files are created in `06_x402/measurements/` (the folder creates itself):

| command | CSV | JSON summary |
|---|---|---|
| `npm run mock` / `npm start` (client) | `merged_mock.csv` | `merged_mock_povzetek.json` |
| `npm run real` | `merged_real.csv` | `merged_real_povzetek.json` |
| `node measurement_client.js --x402` | `x402_zdruzena_mock.csv` | `x402_zdruzena_mock_povzetek.json` |
| `npm run security` | `security_tests_mock.csv` | — |
| `node measurement_client.js --security --real` | `security_tests_real.csv` | — |
| `node measurement_client.js --x402 --security` | `security_tests_x402_mock.csv` | — |

Measurement CSVs are **appended to** (the header is written only when the file is first created),
while security CSVs are overwritten. For a clean run, delete the previous file.

The `merged_*.csv` header (18 columns):
`seq, timestamp_iso, mode, t_challenge_ms, t_submit_ms, t_confirm_ms, t_merged_ms, t_total_ms,
server_merged_ms, chain_read_ms, external_api_ms, gas_units, gas_price_wei, fee_wei,
fee_eth, block, tx_hash, status`

The analysis writes to `analysis/figures/`:

- `01_latency_boxplot.png` — box plot by phase (automatic logarithmic scale if the range exceeds
  50×)
- `02_phase_breakdown.png` — median composition of the flow (stacked horizontal bar)
- `03_summary_table.png` — table of min / median / mean / p95 / max
- `latency_summary.csv` — the same table in CSV form

Only phases whose sum exceeds 0 are plotted, so in mock mode `t_potrditev` (always 0) is dropped
automatically.

Signs of success: on startup the server prints the port and the mode (`mockVerify`); during the
run the client prints each successive run and, at the end, a summary with per-phase statistics
and the path to the CSV. The `server/data/x402_merged.db` database is created on first startup.

## Security tests

```bash
cd client
npm run security        # 10 tests in mock mode → ../measurements/security_tests_mock.csv
```

The checks are: T1 access without payment → 402 · T2 malformed `txHash` → 400 · T3 non-existent
`requestId` → 400 · T4 forged token on `POST /service` → 403 · T5 forged token on
`GET /service` → 403 · T6 malformed JSON → 400 (and not 500) · T7 merged exchange → 200 with a
token · T8 replay of the same `txHash` → 400 · T9 payment acknowledgement via `GET /service` →
200 (`authorized`, `consumed`) · T10 token reuse → 403.

The variant against the real chain:

```bash
node measurement_client.js --security --real     # → ../measurements/security_tests_real.csv
```

It writes 9 rows: tests T1–T6 actually run, while the last three (wrong recipient, amount too
low, payer mismatch) are recorded as **`preskočeno`** ("skipped") and count as passed — in that
CSV they are therefore not real measurements.

Before every run the client calls `GET /health`. If the server is unreachable, it prints
"Je strežnik zagnan?" and exits with code 1.

## x402 v2 (parallel mode)

Alongside the custom protocol, the server offers a **parallel implementation of the official x402
v2 protocol** on the separate routes `GET /x402/config`, `GET /x402/service` and
`GET /x402/payment/:id`. They are mounted only when `X402_MODE` is not `off`. The files
`x402.js`, `db_x402.js`, `x402-client.js` and `x402-browser.js` are identical to the ones in
folder 01 (the parallel-mode convention). Details:
[official x402 v2 protocol](../README.md#official-x402-v2-protocol).

```bash
# server
cd server
X402_MODE=self X402_MOCK=true npm run mock

# client
cd ../client
node measurement_client.js --x402 --runs 30       # → ../measurements/x402_zdruzena_mock.csv
node measurement_client.js --x402 --security      # → ../measurements/security_tests_x402_mock.csv
```

Two limitations worth knowing about:

- **A real (non-mock) x402 run is locked.** With `X402_MODE≠off` and `X402_MOCK≠true` the server
  deliberately exits with an error at startup for as long as `X402_USDC_ADDRESS` is the zero
  address: native ETH has no `transferWithAuthorization`, so x402 in this folder runs **mock
  only** (settlements are synthetic, and `tx_hash` carries the prefix `0x6d6f636b6d6f636b`). A
  real run would require an EIP-3009 token (e.g. USDC) and the `X402_ASSET_*` settings.
- **Tests T11 and T12** of the 14 x402 security tests additionally require
  `X402_MOCK_FAULTS=true` on the server; without it they fail and the process exits with code 1:

  ```bash
  X402_MODE=self X402_MOCK=true X402_MOCK_FAULTS=true npm run mock
  ```

The combination `--x402 --security --real` exits immediately with code 1 (the x402 security tests
are mock-only). The combination `--x402 --real` (a measurement run) exits with code 1 until
`client/wallet.json` contains an `x402PayerPrivateKey` key — and a real run is locked on the
server side anyway (see the first limitation above).

Official x402 v2 likewise puts **4 messages** on the wire — the difference lies in **what**
travels in the second pair: with x402 it is a signed EIP-3009 authorisation (settled by the
server), here it is proof of an already settled transaction (settled by the client).

## Troubleshooting

| symptom | cause and fix |
|---|---|
| the server exits immediately (`fatal … wallet.json`) | `server/wallet.json` is missing — `cp wallet.example.json wallet.json` and enter the address |
| client: "Je strežnik zagnan?" | the server is not running, or `MERCHANT_URL` is wrong; check `curl http://<SERVER_IP>:3300/health` |
| response **429** | the limit of 60 `POST /service` requests per minute was exceeded — wait a minute or raise `RATE_VERIFY_PER_MIN` |
| the charts show the wrong run | `latency_analysis.py` gives precedence to `merged_real.csv`; name the file explicitly or delete the old one |
| several runs mixed into one CSV | measurement CSVs are appended to — delete the file before a new run |
| `--real` exits immediately | `client/wallet.json` with `privateKey` is missing — `npm run gen-wallet`, then fund the wallet from a faucet |
| the server with `X402_MODE` does not start | expected: a real x402 run is locked, add `X402_MOCK=true` |

The general instructions live in the shared
[`test-environments/README.md`](../README.md) — installation, remote-server deployment and the
command sequence for every scenario. Individual sections:
[Wireshark capture](../README.md#wireshark-capture),
[official x402 v2 protocol](../README.md#official-x402-v2-protocol) and
[admin login](../README.md#admin-login) (applies to scenarios 02–05, not to this one).
