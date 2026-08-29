# 02 — Machine payments: one transaction per reading

**Scenario (roles reversed).** A mock **IoT device** (a temperature and humidity sensor) is the
**provider** and **receives** payments into its own wallet. The **agent** — the machine that was the
provider in folder `01` — is now the **user, i.e. the payer**, and pays **one separate on-chain
transaction** for **every** reading. So: **20 queries = 20 transactions.** There is no human between
the two machines; the whole flow runs automatically.

The protocol flow of a single query:
`GET /reading` → **402** (`requestId`, `to`, `priceWei`) → payment on the Ethereum Sepolia network →
`POST /verify-payment` → **proof token** → `GET /reading` with the `X-Payment` header → **200** + the reading.
The proof token is single-use (spending it invalidates it).

This is deliberately an **expensive baseline**: the cumulative gas cost grows **linearly with the
number of queries N**. It is meant to be compared against folder `03` (the same service, but with a
single credit top-up). Only the two together reveal the amortisation of the payment layer's cost.

## What the experiment measures

For every query the same latency phases as in folder `01` are recorded, extended with cost data:

- **phases (ms):** `t_challenge_ms` (402), `t_submit_ms` (submitting the transaction),
  `t_confirm_ms` (waiting for the block), `t_verify_ms` (`POST /verify-payment`), `t_reading_ms`
  (`GET /reading` with the token), `t_total_ms`;
- **cost:** `gas_units`, `gas_price_wei`, `fee_wei`, `fee_eth`, `value_wei` and
  **`cumulative_fee_eth`** (the running total — the central variable of this experiment);
- **purchased content:** `temperature_c`, `humidity_pct` (proof that the service really was delivered).

The device also adds the measurement headers `X-Server-Ms`, `X-Request-Id` and — only under real
on-chain verification — `X-Chain-Read-Ms` to every response, so that server time can be separated
from network time and from read calls to the RPC node. These headers are visible in a Wireshark
capture, but in this folder's CSV they are **not** written as columns of their own (unlike folder `01`).

The focus of the measurement: **the number of on-chain transactions = N** and **cumulative gas ∝ N**.

## Requirements

- **Node.js ≥ 20** and **npm** (the code uses the global `fetch`; the `better-sqlite3` dependency is
  a native module that is compiled or downloaded during installation).
- **Python ≥ 3.9** for the analysis (`analysis/requirements.txt`).
- For **real mode**: a **funded wallet on the Ethereum Sepolia network** (test ETH from a public
  faucet). Twenty transactions require 20 × (the reading price + the gas fee).
- In **mock** mode no funds are needed and no payer wallet is needed.

The repository **contains no keys, passwords or tokens** — you create all of them yourself on the
first run.

## Folder structure

```
iot_device/    Express IoT provider (402 → verify → reading), port 3100
agent/         the agent that runs the whole flow N times and records cumulative gas
analysis/      Python script for the two figures (cumulative gas, query latency)
measurements/  output CSV — the folder is not tracked in the repository and does not
               exist after cloning; the agent creates it on its first successful run
```

This folder has no `Dockerfile`, `docker-compose.yml` or `Caddyfile` — on the server the device is
started directly with Node.js.

## Installation

```bash
cd iot_device
npm ci                                  # or: npm install
cp .env.example .env                    # optional for mock, recommended for a real run
cp wallet.example.json wallet.json      # MANDATORY — without this file the server stops
```

In `iot_device/wallet.json` enter **only the address** of the wallet that should **receive** payments
(the `address` field). For this folder's flow — and for x402 in mock mode — the device needs no
private key; leave the template's `x402Address` and `x402SettlerPrivateKey` fields empty.

```bash
cd agent
npm ci                                  # or: npm install
```

A payer wallet is required **only for `--real`**:

```bash
cd agent
npm run gen-wallet                      # creates wallet.json with 0600 permissions
```

The script does not overwrite an existing file. Fund the address it prints from a public Sepolia
faucet. Alternatively, enter the private key of an already funded wallet by hand in
`agent/wallet.json` (template: `agent/wallet.example.json`). `wallet.json` and
`data/admin-credentials.txt` are covered by `.gitignore` and must never end up in git.

## Local run — mock (no funds)

Mock mode measures protocol latency without the chain and without spending test ETH; the
transactions are synthetic, so the `fee_eth` column is empty.

**Terminal 1 — IoT device:**

```bash
cd iot_device
npm run mock          # NODE_ENV=development MOCK_VERIFY=true, port 3100
```

On the first start the device creates admin credentials and stores them in
`iot_device/data/admin.json`; a human-readable copy is in `iot_device/data/admin-credentials.txt`
(0600 permissions, fields `USERNAME=`, `PASSWORD=`, `TOKEN=`). The device rewrites that file on
**every** start, but the values stay the same — to get new ones, delete `data/admin.json` and restart
the device. The device is closed by default: only `GET /health`, `/login` and `/logout` are public;
everything else requires a session or an `Authorization: Bearer <TOKEN>` header.

**Terminal 2 — agent:**

```bash
cd agent
export ADMIN_TOKEN=$(grep '^TOKEN=' ../iot_device/data/admin-credentials.txt | cut -d= -f2)
npm run mock          # = node agent.js --mock --queries 20
```

Without a valid token the agent receives a `401` on `GET /config`, prints the exact `grep` command
and exits. In a browser you log in at `http://127.0.0.1:3100/login` (username and password from the
same file); after logging in you are redirected to `/config`.

> `npm start` in the `agent` folder performs the **same mock run** as `npm run mock`. A real run
> requires the explicit `--real` flag (or `npm run real`).

Parameters the agent understands: `--real`, `--queries <N>` (default 20), `--pause-ms <ms>`
(default 1000 in real mode, 0 in mock mode), `--x402`, `--security`, `--out <path>`.

## Local run — real measurements (Sepolia)

Before this, edit `iot_device/.env`: leave `MOCK_VERIFY=false` and, if necessary, set your own
`RPC_URL` and `MIN_CONFIRMATIONS`. The agent must have a funded `agent/wallet.json`.

**Terminal 1 — IoT device:**

```bash
cd iot_device
npm start             # real on-chain verification
```

**Terminal 2 — agent:**

```bash
cd agent
export ADMIN_TOKEN=$(grep '^TOKEN=' ../iot_device/data/admin-credentials.txt | cut -d= -f2)
npm run real          # = node agent.js --real --queries 20 --pause-ms 1500
```

The 1500 ms pause between queries prevents rate limiting at the public RPC node and ensures that each
transaction gets its own `nonce` in the correct order. For a smaller trial use fewer queries, e.g.
`node agent.js --real --queries 5 --pause-ms 1500`.

Before the run the agent prints the reading price, the recipient address and the payer's balance, and
at the end the total gas fee. **Every query spends test ETH** — 20 queries means 20 transactions.

## Running on a remote server

Division of roles: **the IoT device runs on the server**, **the agent on your local machine**. That
way the traffic between them is genuine network traffic, suitable for a Wireshark capture (see
`../README.md`).

On the server:

```bash
ssh <USER>@<SERVER_IP>
git clone <REPO_URL>
cd <REPO_NAME>/test-environments/02_machine_payments_per_request/iot_device
npm ci
cp .env.example .env
cp wallet.example.json wallet.json      # enter the recipient address
sudo ufw allow 3100/tcp                 # open the device port
npm run mock                            # or: npm start for a real run
```

Read the token on the server:

```bash
grep TOKEN ~/<REPO_NAME>/test-environments/02_machine_payments_per_request/iot_device/data/admin-credentials.txt
```

On your local machine, start the agent and point it at the server with the `IOT_URL` variable (which
takes precedence over `agent/config.json`):

```bash
cd agent
IOT_URL=http://<SERVER_IP>:3100 ADMIN_TOKEN=<TOKEN> npm run mock
IOT_URL=http://<SERVER_IP>:3100 ADMIN_TOKEN=<TOKEN> npm run real
```

A hostname is preferable to a bare IP address (e.g. `http://iot.your-domain.example:3100`), so that
the settings need not change when the address does.

> **Warning.** The device deliberately runs over plain **HTTP without TLS**, because only then can
> the protocol be captured and dissected in Wireshark. So restrict access to port 3100 to your own IP
> address (e.g. `sudo ufw allow from <YOUR_IP> to any port 3100 proto tcp`), do not leave the device
> exposed to the internet for longer than the measurement takes, and close the port afterwards
> (`sudo ufw delete allow 3100/tcp`). The admin token travels in the `Authorization` header in
> cleartext.

## Analysing the results

```bash
cd analysis
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python3 transaction_analysis.py
```

With no argument the script looks for the input CSV in this order: `../measurements/transactions_real.csv`,
`../measurements/transactions_mock.csv`, and then the sample variants in `../measurements/_sample/` (that
folder is not in the repository — it appears only once you create it with the generator, see below).
You can also pass the path explicitly as a positional argument. If there is no CSV, it prints
instructions for running a measurement and exits with code 1.

Flags: `--out <folder>` (default `figures`), `--gas-price-gwei` (2.0), `--gas-per-tx` (21000),
`--sample` (the “SIMULATED EXAMPLE” watermark; switches on automatically if `_sample` is in the path).

If the `fee_eth` column is empty — that is, in mock mode — the script **models** the cost from
`--gas-price-gwei × --gas-per-tx` and marks the figure with the note “cost MODELLED”. A real run
yields measured values.

**Sample data without funds.** If you want to see the figure without a funded wallet,
`../comparison/generate_sample.py` creates simulated data in
`measurements/_sample/transactions_real.csv`; the analysis recognises it automatically and labels it
as simulated.

**`transaction_analysis.py` does not process x402 CSVs.** Those are handled by
`../comparison/comparison_x402.py`. The combined comparison of folders `02` and `03` (the amortisation
chart) is drawn by `../comparison/comparison.py`.

## Expected outputs

Paths are relative to this folder.

| Command | Produces |
|---|---|
| `agent: npm run mock` | `measurements/transactions_mock.csv` |
| `agent: npm run real` | `measurements/transactions_real.csv` |
| `agent: node agent.js --x402` | `measurements/x402_transactions_mock.csv` (with `--real`: `_real.csv`) |
| `agent: node agent.js --x402 --security` | `measurements/security_tests_x402_mock.csv` (the name is fixed) |
| `analysis: python3 transaction_analysis.py` | `analysis/figures/01_cumulative_gas.png`, `analysis/figures/02_query_latency.png` |
| the device at start-up | `iot_device/data/admin-credentials.txt`, `data/admin.json`, `data/iot_transactions.db` (with x402 also `data/x402_payments.db`) |

The `transactions_*.csv` file has 19 columns:
`query, timestamp_iso, mode, t_challenge_ms, t_submit_ms, t_confirm_ms, t_verify_ms, t_reading_ms,
t_total_ms, gas_units, gas_price_wei, fee_wei, fee_eth, value_wei,
cumulative_fee_eth, temperature_c, humidity_pct, block, tx_hash`.

**Success signal.** Every query prints a line `✓ query NN · T=…°C RH=…% · t_total=… ms`, and at the
end a banner `SUMMARY · successful 20/20 · … · CSV: …` together with the line
`Total on-chain transactions paid for 20 readings: 20 (= N)`. The CSV is created **only after a
successful login** (`GET /config`), so that a failed run does not leave behind a header-only file.
Rows are **appended** — a repeat run extends the existing CSV; if you want a clean measurement,
delete the old file first.

This folder does **not** create any `*_summary.json` file.

## Tuning

- **Reading price:** `PRICE_WEI_PER_READING` in `iot_device/.env` — default `100000000000` wei
  = 1 × 10⁻⁷ ETH, which at `ETH_EUR_RATE=2500` is roughly 2.5 × 10⁻⁴ € (≈ 0.025 cents).
  The value is **the same as the default price in folder `03`**, so that the comparison is fair — the
  difference between the two scenarios lies purely in the settlement model, not in the price of the
  service.
- **Device port:** `IOT_PORT` (default 3100); the device listens on `0.0.0.0`.
- **Rate limiting:** `RATE_PER_MIN` (default 240 requests/min) — not listed in `.env.example`.
- **Database path:** `DB_PATH` (default `iot_device/data/iot_transactions.db`).
- **Token lifetimes:** `PROOF_TOKEN_TTL_SECONDS` (600), `PAYMENT_REQUEST_TTL_SECONDS` (1800).
- **Custom credentials:** `ADMIN_USER`, `ADMIN_PASSWORD`, `ADMIN_TOKEN` — values from the environment
  always take precedence, and in that case are **not written to disk**.

## Security tests

Security tests exist only for the x402 branch and run exclusively in mock mode.

```bash
# Terminal 1 — device
cd iot_device && X402_MODE=self X402_MOCK=true npm run mock

# Terminal 2 — agent
cd agent && ADMIN_TOKEN=<TOKEN> node agent.js --x402 --security
```

Without `X402_MOCK=true` the script refuses to run. It performs six tests:

| Test | Expected |
|---|---|
| T1 | request without login → `401` |
| T2 | logged in but unpaid → `402` |
| T3 | valid payment → `200` |
| T4 | three readings → three separate settlements |
| T5 | replaying the same payment headers → idempotent replay |
| T6 | malformed JSON on `POST /verify-payment` → `400` (not `500`) |

The output is `measurements/security_tests_x402_mock.csv` with the columns
`test,expected,actual,passed,note`. If any test fails, the agent exits with a non-zero exit code.

## x402 v2 (parallel mode)

Alongside its own flow, the device supports the **official x402 v2 protocol** as a parallel path. It
is enabled with `X402_MODE=self X402_MOCK=true` and adds the endpoints `GET /x402/config`,
`GET /x402/reading` and `GET /x402/payment/:id`. `X402_MODE=self` on its own (without
`X402_MOCK=true`) **will not start** the device in this test configuration: the asset is native ETH
with no EIP-3009 contract, so the code refuses a real run right at start-up.

The semantics are deliberately identical to this folder's baseline flow: **N readings = N x402
`exact` settlements** (ETH, Ethereum Sepolia network), with no batching and no credit. The key
difference is **who pays the gas**: with x402 the **device (the provider)** pays it, and the client
merely signs an EIP-3009 authorisation. The `Authorization: Bearer` header remains authentication and
stays separate from payment. The protocol headers are `PAYMENT-REQUIRED` (in the 402 response) and
`PAYMENT-RESPONSE` (on settlement); the measurement and status headers are `X-Verify-Ms`,
`X-Settle-Ms` and `X-X402-Idempotent-Replay`.

```bash
# Terminal 1 — device
cd iot_device && X402_MODE=self X402_MOCK=true npm run mock

# Terminal 2 — agent
cd agent && ADMIN_TOKEN=<TOKEN> node agent.js --x402 --queries 20
#   → measurements/x402_transactions_mock.csv (28 columns)
```

With `X402_MOCK=true` the signatures and verifications are genuine, but the settlements are
**synthetic** (the `synthetic_tx` column). A fully real run would require a token with EIP-3009
support, which the native-ETH test configuration cannot provide — which is why this branch is marked
as experimental. There is no npm script for the x402 branch; run it directly with
`node agent.js --x402`.

A detailed description of the protocol is in `../README.md`.

## Troubleshooting

- **The server stops immediately.** `iot_device/wallet.json` is missing — see the Installation section.
- **The agent reports `401`.** `ADMIN_TOKEN` is missing or wrong. The token is created once and stays
  stored in `iot_device/data/admin.json`, so it is the same after a restart; get a new one by
  deleting `data/admin.json`, or force one on the device with the `ADMIN_TOKEN` variable.
- **The agent targets the wrong address.** Without `IOT_URL` it uses the address from
  `agent/config.json` (default `http://127.0.0.1:3100`).
- **`Fatal error … Is the IoT device running?`** The device is not running, or port 3100 is closed
  (firewall, `sudo ufw allow 3100/tcp`).
- **The analysis reports `No CSV found`.** Run a measurement first (`cd ../agent && npm run mock`) or
  create sample data with `../comparison/generate_sample.py`.
- More detailed instructions are in `../README.md`, in the sections “Two-device setup”, “Admin login”
  and “Wireshark capture”.
