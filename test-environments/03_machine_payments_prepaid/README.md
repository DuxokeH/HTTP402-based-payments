# 03 — Metered prepaid session with credit

**Scenario:** the same IoT setup as folder `02`, except that the agent performs **a single on-chain
top-up** which opens a **prepaid session**, and from then on pays for every reading with an
**EIP-191 cryptographic signature** — with no further transactions. **20 readings = 1 transaction
+ 20 signatures.**

Folder `02` is deliberately an expensive baseline (cumulative gas grows linearly with N). This
folder is its opposite: the chain cost is constant, no matter how many readings are taken.
Together the two form the key comparison that `../comparison/` brings together.

## What the experiment measures

For every signed debit the following are measured:

- `t_sign_ms` — time to produce the EIP-191 signature on the client,
- `t_request_ms` — network and server time (the HTTP round trip),
- `server_ms` — processing time on the device side (the `X-Server-Ms` header),
- `price_wei` — the price charged (the `X-Charged-Wei` header),
- `credit_wei` and `budget_remaining_wei` — the credit and budget left after the debit.

The first row of the measurements is the **top-up** — the only row that can carry `gas_units` and
`fee_eth`; both are filled in only in real mode and stay empty in mock mode.
The point of the experiment: **there is exactly one on-chain transaction**, and the latency of an
individual debit contains no waiting for on-chain confirmation (the actual values depend on your
hardware and network — measure them by running it yourself).

The session enforces three constraints — limited credit, a budget and a validity window:

| Constraint | In the code |
|---|---|
| limited **credit** | `deposit_wei` (remaining = `deposit − spent`) |
| **budget** | `budget_wei` (spending must never exceed it) |
| **validity window** | `expires_at` (debits after expiry are rejected) |

The signed message binds all the elements together:

```
x402-debit:{payer}:{session}:{nonce}:{path}:{maxWei}
```

It unambiguously ties together the payer, the session, the one-time code (nonce), the resource and
the price ceiling. The request carries the headers `X-Payer`, `X-Session`, `X-Nonce`,
`X-Signature` and `X-Max-Wei`; the response returns `X-Charged-Wei`, `X-Balance-Wei`,
`X-Budget-Remaining-Wei`, `X-Session-Expires`, `X-Server-Ms` and `X-Request-Id`. The
`X-Chain-Read-Ms` header (chain read time) is added only by the response to
`POST /session/open`, and even then only in real mode, when the top-up really is verified over RPC.

## Requirements

- **Node.js ≥ 20** and **npm** (for `iot_device/` and `agent/`).
- **Python ≥ 3.9** for the analysis (`matplotlib`, `pandas`, `numpy`).
- For **real mode**: a funded wallet on the **Ethereum Sepolia** network with some test ETH (from a
  public faucet). It is needed only for the **single** top-up and its gas — the debits are free.
- For capturing traffic in Wireshark: access to the interface the HTTP traffic flows over (see
  `../README.md`).

The repository **contains no private keys or credentials whatsoever** — you create the wallets
yourself.

## Folder structure

```
iot_device/    Express IoT provider with sessions (port 3200)
               server.js, auth.js, db.js, db_x402.js, x402.js,
               .env.example, wallet.example.json
agent/         agent.js (1 top-up + N signed debits, security tests),
               x402-client.js, generate-wallet.js, config.json, wallet.example.json
analysis/      credit_analysis.py, style.py, requirements.txt
measurements/  output CSVs and JSON summaries — the scripts create the folder themselves
```

The `measurements/` folder is empty in the repository and will not be there after `git clone`; the
agent creates it on its first run. The same goes for `analysis/figures/`, which the analysis script
creates. The results (`measurements/*.csv`, `measurements/*_summary.json`) and the figures are
listed in the root `.gitignore` and never reach git. The exception is the simulated samples in
`measurements/_sample/` — `.gitignore` does not cover those, so if you have generated them, do not
add them to git.

## Installation

```bash
cd iot_device
npm ci                                  # or npm install
cp wallet.example.json wallet.json      # MANDATORY — without it the server stops immediately
cp .env.example .env                    # optional; the values match the defaults in the code
                                        # (exception: LOG_LEVEL, `debug` in the code, `info` in .env)
```

In `iot_device/wallet.json` enter **only the address** of the wallet that is to receive the top-ups
(the same role as in folder `02`). No private key is needed here, so do not enter one.

```bash
cd ../agent
npm ci
```

For **real mode** the agent needs the payer's wallet, private key included:

```bash
cd agent
npm run gen-wallet         # creates agent/wallet.json (never overwrites an existing one)
```

Then fund the address from `agent/wallet.json` from a public Sepolia faucet. In **mock** mode no
wallet is needed — the agent signs with an ephemeral wallet that holds no funds.

## Local run — mock (no funds)

The device is protected by an **admin login** (see `../README.md`). The credentials are generated on
the **first** run and stored in `iot_device/data/admin.json`; a human-readable copy is refreshed on
every start in `iot_device/data/admin-credentials.txt` (permissions 0600), so read the token
**after** the server has started. The token and password do **not** change on subsequent runs — to
get a new pair, delete `data/admin.json` and restart the server.

**Terminal 1 — IoT device:**

```bash
cd iot_device
npm run mock          # NODE_ENV=development MOCK_VERIFY=true node server.js
```

The device listens on port **3200** (`IOT_PORT`), on all interfaces.

**Terminal 2 — agent:**

```bash
cd agent
export ADMIN_TOKEN=$(grep '^TOKEN=' ../iot_device/data/admin-credentials.txt | cut -d= -f2)
npm run mock          # node agent.js --mock --debits 20
```

This produces `measurements/credit_mock.csv` and `measurements/credit_mock_summary.json`.

In mock mode the session deposit is fixed at `PRICE_WEI_PER_CALL × 25`, i.e. **at most 25 debits**;
with `--debits 30` the last five would return `402 insufficient_balance`. The `--topup-wei` flag has
no effect in mock mode (it is only used for the actual transaction in real mode).

In a browser you can log in at `http://127.0.0.1:3200/login` (the username and password are in the
same file, in the `USERNAME=` and `PASSWORD=` fields) and inspect, for example, `/config`. The
plaintext password is written into the `PASSWORD=` field only on the run that created it; on later
runs there is just a note saying it is unchanged. Without a token the agent immediately reports
`401` and prints the exact `grep` command to use.

## Local run — real measurements (Sepolia)

Prerequisites: `agent/wallet.json` with a funded wallet, and `iot_device/wallet.json` with the
recipient address. In `iot_device/.env` set `MOCK_VERIFY=false` (the default in `.env.example`).

**Terminal 1:**

```bash
cd iot_device
npm start             # node server.js — the top-up is verified on chain via RPC_URL
```

**Terminal 2:**

```bash
cd agent
export ADMIN_TOKEN=$(grep '^TOKEN=' ../iot_device/data/admin-credentials.txt | cut -d= -f2)
npm run real          # node agent.js --real --debits 20 --pause-ms 200
```

This produces `measurements/credit_real.csv` and `measurements/credit_real_summary.json`.

The default top-up is `--topup-wei 2500000000000` (0.0000025 ETH), which at a price of
`100000000000 wei` per reading is enough for **exactly 25 debits**. For more debits, raise the
top-up proportionally, otherwise the server rejects them with `402 insufficient_balance`:

```bash
node agent.js --real --debits 40 --pause-ms 200 --topup-wei 5000000000000
```

The flags the agent reads: `--real` (mock otherwise), `--debits <N>` (default 20),
`--pause-ms <ms>` (default 0), `--topup-wei <wei>`, `--security`, `--x402`, `--out <path>`.

## Running on a remote server

The setup: **the IoT device runs on the server**, **the agent runs locally** (that way the payment
traffic crosses the network and can be captured with Wireshark). Details are in `../README.md`.

```bash
ssh <USER>@<SERVER_IP>
git clone <REPO_URL>
cd HTTP402-based-payments/test-environments/03_machine_payments_prepaid/iot_device
npm ci
cp wallet.example.json wallet.json     # enter the recipient address
cp .env.example .env
sudo ufw allow 3200/tcp                # open the device port
npm run mock                           # or npm start for real mode
```

Then run the agent **locally** and point it at the server with the `IOT_URL` environment variable
(which takes precedence over `agent/config.json`); read the token on the server:

```bash
# on the server:
grep '^TOKEN=' iot_device/data/admin-credentials.txt | cut -d= -f2

# locally:
cd agent
export IOT_URL=http://<SERVER_IP>:3200
export ADMIN_TOKEN=<TOKEN_FROM_SERVER>
npm run mock
```

This folder has neither a Dockerfile nor a Caddyfile — the device is started directly with `npm`.
For a containerised variant with HTTPS, see folders `04` and `05`.

> **Warning:** the device deliberately runs over **plain HTTP** (no TLS) so that the payment flow is
> visible in Wireshark. Restrict access to port 3200 to your own IP (e.g. `sudo ufw allow from
> <YOUR_IP> to any port 3200 proto tcp`), and once the measurements are done, stop the server and
> close the port. The admin token and password travel over HTTP in the clear and stay the same
> across restarts, so discard them after measuring: delete `data/admin.json` and
> `data/admin-credentials.txt`.

## Results analysis

```bash
cd analysis
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python3 credit_analysis.py
```

With no argument, the script looks for the first file that exists, in the order
`../measurements/credit_real.csv`, `../measurements/credit_mock.csv`, then the same two variants in
`../measurements/_sample/`. You can also name the file explicitly:

```bash
python3 credit_analysis.py ../measurements/credit_real.csv
python3 credit_analysis.py --out /path/to/figures --sample
```

`--out` sets the target folder (default `analysis/figures`), and `--sample` stamps a red diagonal
watermark reading "SIMULATED EXAMPLE — NOT REAL MEASUREMENTS" across the figure. If you have no
measurements yet, you can generate simulated input CSVs with `../comparison/generate_sample.py`,
which writes them into `measurements/_sample/`; the resulting figures are then marked as samples
automatically and are **not** the result of a measurement.

The `credit_analysis.py` script processes only the rows with `kind=debit` and reads the columns of
the native flow (`t_sign_ms`, `t_request_ms`, `server_ms`, `price_wei`, `credit_wei`,
`budget_remaining_wei`, `mode`). It does not process the `x402_dobroimetje_*.csv` files (they carry
atomic-unit columns instead of wei) — those are handled by `../comparison/comparison_x402.py`. For
the combined comparison with folder `02` (amortisation, on/off-chain latency), see
`../comparison/`.

Note: `analysis/style.py` is duplicated in every `analysis/` folder on purpose, so that each folder
stands on its own.

## Expected outputs

In `measurements/`:

| File | Produced by |
|---|---|
| `credit_mock.csv` + `credit_mock_summary.json` | `npm run mock` (agent) |
| `credit_real.csv` + `credit_real_summary.json` | `npm run real` |
| `security_tests_mock.csv` | `npm run security` |
| `x402_dobroimetje_mock.csv` / `_real.csv` | `node agent.js --x402` |
| `security_tests_x402_mock.csv` | `node agent.js --x402 --security` |

The native-flow CSV has 17 columns: `event, timestamp_iso, mode, kind, t_sign_ms, t_request_ms,
server_ms, t_total_ms, price_wei, credit_wei, budget_remaining_wei, gas_units,
fee_eth, temperature_c, humidity_pct, nonce, session`. The first row is the top-up (`topup`),
followed by `debit_1 … debit_N` with `kind=debit`.
The security-test CSV has the columns `test, expected, actual, passed, note`; in `passed` the native
suite writes `da`/`ne`, while the x402 suite writes `1`/`0`.

In `analysis/figures/`:

- `01_debit_latency.png` — the latency of an individual debit (signature + request) with the median,
- `02_credit_consumption.png` — how the credit drains over the session. The remaining-budget curve
  is only drawn when it differs from the credit; on a default run the budget equals the deposit, so
  there is a single curve (a separate budget is used by security tests T7 and T9).

**Success signal:** on opening the session the agent prints its identifier (`session=sess_…`), and
at the end a line reading `N/N succeeded`, a latency summary (`t_sign`, `t_request`) and the final
session state; the analysis script prints the lines `Debit latency [ms]: min=… median=…` and
`On-chain transactions in the session: 1 (top-up) for N readings`, and finally `Done.`

## Security tests

These check the session's protection mechanisms. They run **in mock mode only** — with `--real` they
refuse to run:

```bash
cd agent
export ADMIN_TOKEN=$(grep '^TOKEN=' ../iot_device/data/admin-credentials.txt | cut -d= -f2)
npm run security          # node agent.js --security
```

**9 tests** are run:

| # | Test | Expected |
|---|---|---|
| T1 | missing signature headers | `402` |
| T2 | valid debit | `200` |
| T3 | nonce reuse (replay) | `403` |
| T4 | forged signature (a different wallet) | `403` |
| T5 | price above the signed maximum `X-Max-Wei` | `400` |
| T6 | stale nonce (outside `DEBIT_MAX_AGE_MS`) | `400` |
| T7 | budget exceeded (`budgetWei = 2 × price`) | `402` |
| T8 | insufficient credit (deposit of `2 × price`) | `402` |
| T9 | expired session (`ttlSeconds: 1`) | `403` |

Output: `measurements/security_tests_mock.csv` (the `passed` column holds `da`/`ne`); the console
prints a count of the tests that passed. A non-zero exit code on failure is set only by the x402
variant of the tests (`--x402 --security`), so for this suite check the result in the console output
or in the CSV.

## x402 v2 (parallel mode — session funding only)

In this mode the x402 protocol is used **for the top-up only**: paying for the
`POST /x402/session/open` request (a single settlement of the *exact* scheme in ETH) opens the
session, and all N debits then run locally with EIP-191 signatures over the **v2 message**:

```
metered-debit-v2:{payer}:{session}:{nonce}:{path}:{maxAtomic}:{network}:{asset}
```

The headers are `X-Max-Atomic`, `X-Charged-Atomic`, `X-Balance-Atomic` and
`X-Budget-Remaining-Atomic` — the values are **atomic units of the asset** (test ETH), never "wei".
The readings involve **no additional on-chain settlement at all**. The legacy flow and its
`x402-debit:…:{maxWei}` message are unchanged; the two formats reject each other (test T3 below).
Local metering is **not** x402 in itself — the accurate description is "x402 session funding + our
own local metering".

In this configuration the settlement is **synthetic (mock)**: a real run would require a token with
EIP-3009 support, which native ETH does not have.

**Terminal 1 — device with x402 enabled:**

```bash
cd iot_device
X402_MODE=self X402_MOCK=true npm run mock
```

**Terminal 2 — agent:**

```bash
cd agent
export ADMIN_TOKEN=$(grep '^TOKEN=' ../iot_device/data/admin-credentials.txt | cut -d= -f2)
node agent.js --x402 --debits 20      # → measurements/x402_dobroimetje_mock.csv
node agent.js --x402 --security       # → measurements/security_tests_x402_mock.csv
```

The x402 security tests require a device running with **both** variables, `X402_MODE=self` **and**
`X402_MOCK=true` — otherwise they stop immediately. They run 9 tests:
T1 the top-up opens a session; T2 five debits with no further settlement; T3 a v1 signature on a v2
path → `403`; T4 a v2 signature for a different asset → `403`; T5 nonce reuse → `403`; T6 price
above the maximum → `400`; T7 credit exhausted → `402`; T8 replaying the same top-up returns the
same session (idempotent replay); T9 malformed JSON → `400`.

The default x402 session deposit is `X402_SESSION_DEPOSIT_ATOMIC=2000000000000` = 20 payments at a
price of `X402_PRICE_ATOMIC=100000000000`. The collected x402 measurements are processed by
`../comparison/comparison_x402.py`. A broader description of the protocol is in `../README.md`.

## Customisation

- **Price per reading:** `PRICE_WEI_PER_CALL` (default `100000000000` wei = 0.0000001 ETH — the same
  as in folder `02`, which makes a direct comparison possible). Optionally also
  `PRICE_WEI_PER_BYTE` (default 0) and the floor `MIN_PRICE_WEI`.
- **Session budget and validity:** the agent can request both at top-up time (`budgetWei`,
  `ttlSeconds`). The server caps the budget at the deposit (by default it equals the deposit), and
  the validity window at `SESSION_TTL_DEFAULT` (the default) and `SESSION_TTL_MAX` (the upper
  limit). Tests T7 and T9 exploit this. A default agent run sends neither.
- **Nonce freshness:** `DEBIT_MAX_AGE_MS` (default 120000 ms).
- All the variables are documented in `iot_device/.env.example`. The two SQLite databases are
  created in `iot_device/data/` (`iot_credit.db`, `x402_payments.db`).

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| The server stops immediately | `iot_device/wallet.json` is missing — `cp wallet.example.json wallet.json` and enter the address. |
| The agent reports `401` | `ADMIN_TOKEN` is missing or wrong. Read it from `data/admin-credentials.txt` on the device; for a new pair, delete `data/admin.json` and restart. |
| `402 insufficient_balance` | The deposit does not cover all the debits: in mock mode the limit is 25; in real mode, raise `--topup-wei`. |
| The agent connects to `127.0.0.1` | For a remote device, set `export IOT_URL=http://<SERVER_IP>:3200`. |
| `No CSV found. Run a measurement first…` | The analysis cannot find an input file — run `cd ../agent && npm run mock` first. |

More detailed instructions are in [`test-environments/README.md`](../README.md):
[two-device setup](../README.md#two-device-setup),
[recommended experiment order](../README.md#recommended-experiment-order),
[admin login and tokens](../README.md#admin-login),
[Wireshark capture](../README.md#wireshark-capture) and
[the official x402 v2 protocol](../README.md#official-x402-v2-protocol).
