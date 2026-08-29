# Test environments

Seven self-contained environments for paying over the x402 protocol on top of HTTP 402, plus a
tool for comparing their results. Each environment has its own server, its own client or agent,
its measurement instrumentation and its analysis scripts, and can be run independently of the rest.

The simplest one is [`00_demo`](00_demo) — if you don't know the protocol yet, start there.

Everything runs on the **Ethereum Sepolia** testnet; every scenario also has a **mock mode** that
works without a wallet and without chain access, which makes it repeatable and free.

This file is the shared overview. **The exact commands, ports and quirks live in each folder's own
README** — that is also where you find the instructions for running against a remote server, for
the analysis and for troubleshooting.

## What each environment shows

| Folder | Environment | What it shows |
|---|---|---|
| [`00_demo`](00_demo) | The simplest demonstration: a server, a command-line client and a browser page with MetaMask. Not a measurement environment. | The whole flow in two exchanges — a good entry point and the easiest thing to capture with Wireshark. |
| [`01_one_time_payments`](01_one_time_payments) | A one-time payment for access to a service (an external API). The payer is a human with MetaMask **or** a headless measurement client. | Latency by phase (402 → transaction → confirmation → verification → access), gas consumption, security tests. |
| [`02_machine_payments_per_request`](02_machine_payments_per_request) | M2M: the agent pays the IoT device **one on-chain transaction for every query**. 20 queries = 20 transactions. | The expensive baseline: cumulative cost grows linearly with N. |
| [`03_machine_payments_prepaid`](03_machine_payments_prepaid) | M2M: **a single top-up** opens a prepaid session with a credit, a budget and an expiry; then 20 debits signed under EIP-191, with no further transactions. | Amortisation: one transaction for N readings, latency of a few ms, budget and expiry enforcement. |
| [`04_website_facilitator`](04_website_facilitator) | The website in **topology (b)**: the merchant has no chain access, a separate **facilitator** verifies everything. | The effect of a facilitator architecture on latency and message count. |
| [`05_website_direct`](05_website_direct) | The same website in **topology (a)**: the merchant reads the chain itself. All three flows at one address. | A live view of all three flows (SSE). |
| [`06_x402`](06_x402) | Folder 01 rebuilt with a **merged exchange**: verification and content delivery in the same `POST /service` → **2 exchanges / 4 messages**. | How much latency and how many messages a separate proof-token exchange costs. |
| [`comparison`](comparison) | Merges the results of folders 02 and 03. | The key comparison: N transactions against a single top-up; amortisation; on-chain against off-chain latency. |

Folders **04 and 05 are the measurement pair for topology**: the same page, the same three flows.
The only difference is whether the merchant reads the chain itself (05) or a separate facilitator
does it on its behalf (04). In this setup the facilitator is **local and self-hosted**, so the
measured overhead does not include any network distance — it is a **lower bound** for a real,
remote facilitator.

## Requirements

- **Node.js ≥ 20** and npm (developed on v20 and v22)
- **Python ≥ 3.9** for the analysis (`matplotlib`, `pandas`, `numpy`)
- optionally **Docker** and Docker Compose (folders 04 and 05)
- optionally **Wireshark** for capturing the flow
- for **real** measurements: a wallet on the Sepolia network with test ETH from a public faucet

## Quick start (mock — no wallet, no funds)

```bash
# 1) server (first terminal)
cd 01_one_time_payments/server
npm ci
cp .env.example .env
cp wallet.example.json wallet.json      # enter the recipient address (the default is fine for mock)
npm run mock                            # MOCK_VERIFY=true → no chain access

# 2) measurement (second terminal)
cd 01_one_time_payments/client
npm ci
npm run mock                            # 50 repetitions of the protocol latency → CSV

# 3) figures
cd 01_one_time_payments/analysis
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python3 latency_analysis.py              # figures in analysis/figures/
```

## Wallets — four roles, three of which need funding

**The repository deliberately contains no keys.** You create them yourself with `npm run gen-wallet`
(or `node generate-wallet.js`) in the payer's folder. The recipient **never** needs a private key
and never needs funds.

| # | Role | Lives on | Contents of `wallet.json` | Fund it |
|---|---|---|---|---|
| **W1** | recipient (merchant / IoT device / website) | server | `address` only | **no** |
| **W2** | payer for experiments 01, 02, 03 and 06 | laptop | `address` + `privateKey` | yes |
| **W3** | MetaMask (human, the website's first tab) | browser | an existing one | yes, a little |
| **W4** | website payer (folders 04 and 05) | server | `payerPrivateKey` | yes, a little |

**W2 is a single wallet for four experiments** — you create it once and copy it into `01/client`,
`02/agent`, `03/agent` and `06/client`; the `{address, privateKey}` shape is the same everywhere.
Because you run the experiments one after another, there are no overlapping transactions.

**W4 is deliberately kept separate from W2**: it lives in a permanently running service on the
server, so its exposure must not compromise the measurement wallet as well.

The payments themselves are worth next to nothing (`1e-7` ETH by default) — **gas dominates**:
21 000 units per transfer, which at 20 gwei comes to roughly `0,00042` ETH. A single top-up from a
public Sepolia faucet is enough for many runs.

> Use **a dedicated test wallet and nothing else**. Never enter the key of a wallet that holds real
> funds. The `wallet.json` and `.env` files are in `.gitignore`.

## Two-device setup

The role is set by the program, not by the device: the **payer** (`client/`, `agent/`) runs on the
**laptop**, the **provider** (`server/`, `iot_device/`, `facilitator/`) on the **server**. The
reason is not cosmetic: the payer always opens the connection, so only the provider has to be
reachable — and a laptop behind a home NAT is not. This way the payment traffic crosses a real
network and can be captured.

| Folder | On the server | On the laptop | Port | Port variable | Address for the client | Login |
|---|---|---|---|---|---|---|
| **00** demo | `server/` | `client/` | 3000 | `MERCHANT_PORT` | `MERCHANT_URL` | none |
| **01** one-time payment | `server/` | `client/` | 3000 | `MERCHANT_PORT` | `MERCHANT_URL` | none |
| **02** per-transaction M2M | `iot_device/` | `agent/` | 3100 | `IOT_PORT` | `IOT_URL` | admin |
| **03** metered session | `iot_device/` | `agent/` | 3200 | `IOT_PORT` | `IOT_URL` | admin |
| **04** website with a facilitator | `facilitator/` **and** `server/` | `agent/` | 4000 and 8081 | `FACILITATOR_PORT`, `PORT` | `--merchant-url`, `--facilitator-url` | **two** admin logins |
| **05** website | everything (Docker + Caddy) | browser only | 8080 / 443 | `PORT` | — | admin |
| **06** merged exchange | `server/` | `client/` | 3300 | `MERCHANT_PORT` | `MERCHANT_URL` | none |

> **Watch out for the two different address variables:** folders 01 and 06 use `MERCHANT_URL`,
> while folders 02 and 03 use `IOT_URL`. All the servers already listen on `0.0.0.0`.

You can also run everything on a single machine — the addresses then stay `127.0.0.1`, and you
capture on the loopback interface.

### Opening ports — `ufw` is often not enough

```bash
# on the server
sudo ufw allow 3000/tcp && sudo ufw allow 3100/tcp && sudo ufw allow 3200/tcp
sudo ufw allow 3300/tcp && sudo ufw allow 4000/tcp && sudo ufw allow 8081/tcp
sudo ufw allow 8080/tcp && sudo ufw allow 80/tcp   && sudo ufw allow 443/tcp
```

If the server runs at a cloud provider, that provider normally has **its own firewall in front of
the server**, and it does not configure itself — you have to open the same ports in its console or
command-line tool as well, otherwise `ufw` will not help.

**Diagnosis:** the client dies with `timeout of 90000ms exceeded` while Wireshark shows nothing but
SYN retransmissions → the request never reaches the server at all, so a rule is missing in the
firewall in front of it. An immediate `Connection refused` means the opposite: the port is open,
but the server is not running.

> The servers run over **plain HTTP without TLS** (see the Wireshark section), so restrict access to
> your own IP — e.g. `sudo ufw allow from <YOUR_IP> to any port 3000 proto tcp` — and stop them once
> you are done measuring. For a public deployment, use the bundled Caddy configuration with TLS
> (folders 04, 05).

## Recommended experiment order

**01 → 02 → 03 → 05 → 04 → the analyses → comparison.** Folder **04 comes after 02 and 03**,
because its analysis compares its own results against their CSV files. Folder **06** is a twin of
folder 01 (same server, same price, same wallet, only a merged exchange), so you can run it at any
point after 01.

**Sequentially, one experiment at a time.** Every folder is a self-contained environment (its own
`node_modules`, its own database, its own wallet, its own port): start → measure → stop → next one.
With real payments this is also the safer approach, because the payer wallet cannot tangle itself
up in its own transaction sequence numbers (nonces).

## Admin login

The servers that spend a real wallet in real mode are closed off behind an admin login (the shared
`auth.js` module).

| Scenario | Login | Always-open routes |
|---|---|---|
| **01** one-time payments | no — deliberately open (the cleanest baseline measurement) | all |
| **02** transactions | yes | `/health`, `/login`, `/logout` |
| **03** credit | yes | `/health`, `/login`, `/logout` |
| **04** merchant (`server/`) | yes | `/health`, `/login`, `/logout` |
| **04** facilitator (`facilitator/`) | yes — **a separate, second login** | `/health`, `/config`, `/submit-payment`, `/x402/supported`, `/login`, `/logout` |
| **05** website | yes | `/health`, `/login`, `/logout` |
| **06** merged exchange | no — open | all |

**The credentials create themselves on the first start** — nothing has to be configured in advance.
The server writes a password digest (scrypt) and a machine token to `data/admin.json`, and a
human-readable copy to `data/admin-credentials.txt` (mode `0600`; the `data/` folder is in
`.gitignore`). They **do not change on subsequent starts** — new ones are generated only if
`admin.json` is missing or corrupt.

```bash
grep GESLO data/admin-credentials.txt      # browser login at /login
grep TOKEN data/admin-credentials.txt      # machine token for the measurement agents
```

The plaintext password appears in the `PASSWORD=` field **only on the run that created it**; later
it holds nothing but a note saying it is unchanged. So save it straight away. `TOKEN=` is always
valid.

**The machine (the measurement agent)** does not log in through a form; it sends the header
`Authorization: Bearer <TOKEN>`, which it reads from `ADMIN_TOKEN`:

```bash
cd 03_machine_payments_prepaid/agent
export ADMIN_TOKEN=$(grep '^TOKEN=' ../iot_device/data/admin-credentials.txt | cut -d= -f2)
npm run mock
```

If the server runs on another device, you can pull the token over ssh in a single step:

```bash
export ADMIN_TOKEN=$(ssh <USER>@<SERVER_IP> \
  "grep '^TOKEN=' <path-to-repository>/test-environments/02_machine_payments_per_request/iot_device/data/admin-credentials.txt | cut -d= -f2")
echo "$ADMIN_TOKEN"    # it must not be empty!
```

Folder **04 has two logins**: the agent identifies itself to the *merchant* with the merchant's
`ADMIN_TOKEN`, and the merchant identifies itself to the *facilitator* with `FACILITATOR_TOKEN`; if
that is not set, the merchant simply reads it from `../facilitator/data/admin-credentials.txt`.

**A new password and token:** delete `data/admin.json` and restart the server. You can also force
the credentials in from the environment (`ADMIN_USER`, `ADMIN_PASSWORD`, `ADMIN_TOKEN`) — those
always take precedence, and a password coming from the environment is never written to disk. Leave
`COOKIE_SECURE` at `false`, otherwise logging in over plain HTTP (which is what you do when
capturing with Wireshark) will not work.

> **CSRF.** The `admin_sid` cookie is `SameSite=Lax`, so a foreign page could trigger
> `/run/tx?queries=200` with a simple navigation and drain the wallet. On top of the login, the
> `/run/*` routes in folders 04 and 05 therefore also require a one-time session token
> (`GET /run/token` → `?token=…`), and they reject requests carrying `Sec-Fetch-Mode: navigate` or
> coming from a foreign origin. Machine access with `Authorization: Bearer` is exempt — there is no
> ambient credential there.

## Wireshark capture

For visual evidence of the flow (402, the `X-Payment` header, signed debits, x402 v2 headers) you
need **unencrypted traffic**. Wireshark cannot see the content under TLS, which is why every
measurement server runs over **plain HTTP**. A production deployment behind Caddy (HTTPS) is
useless for capture.

**Interface:** `Loopback: lo` when the server and the client run on the same machine; otherwise
`wlan0` / `eth0`.

**A mandatory step — "Decode As…".** By default Wireshark only dissects the usual ports
(80, 8080 and so on) as HTTP. Without this, every other port stays plain TCP and the `http` filter
shows **nothing**. Right-click a packet → **Decode As…** → the *TCP port* field → enter the port →
set the *Current* column to **HTTP** → *OK*. For `tshark`: `-d tcp.port==3000,http`.

| Scenario | Port | "Decode As" needed |
|---|---|---|
| 00 demo | 3000 | yes |
| 01 | 3000 | yes |
| 02 | 3100 | yes |
| 03 | 3200 | yes |
| 04 facilitator | 4000 | yes |
| 04 merchant | 8081 | yes |
| 05 | 8080 | no (default) |
| 06 | 3300 | yes |

**Capture filter** (set it before you start the capture, when you are measuring against a remote
server):

```
host <SERVER_IP> and (tcp port 3000 or tcp port 3100 or tcp port 3200 or tcp port 3300
                         or tcp port 4000 or tcp port 8080 or tcp port 8081)
```

**Display filters:**

```
http.response.code == 402            # payment challenge (all scenarios)
http contains "X-Payment"            # access with a proof token (custom protocol)
http contains "proof_"               # proof token
http contains "X-Signature"          # signed EIP-191 debit (folder 03)
http contains "X-Charged-Wei"        # amount charged, in the response (folder 03)
http contains "PAYMENT-SIGNATURE"    # official x402 v2 (the /x402/* routes)
http.authorization                   # request carrying a machine token (folders 02–05)
http.response.code == 401            # rejected: not logged in
```

**What a correct capture must contain:** a `402 Payment Required` pair with a dissected JSON body
(`requestId`, `to`, `amount`), followed by a request with the header `X-Payment: proof_…` →
`200 OK`. With x402 v2 you get a `402` with the `PAYMENT-REQUIRED` header instead, then a request
with `PAYMENT-SIGNATURE` → `200` with `PAYMENT-RESPONSE`.

**Always start the capture before the client** and stop it after it. For more cleanly separated
phases, run the client with a small number of repetitions and a pause (`--runs 1 --pause-ms 1500`).
For the cleanest baseline flow, without an `Authorization` header, use **folder 01**, which has no
login.

> **Before you publish a capture:** the machine token and the password travel in cleartext over
> plain HTTP. In screenshots, mask the `Authorization: Bearer …` header, the body of the
> `POST /login` request (it contains **the password in the clear**) and the `admin_sid` cookie — or
> generate new credentials once you have finished measuring (`rm data/admin.json` + a restart).

## Official x402 v2 protocol

Alongside the custom protocol (402 → ETH transaction → `/verify-payment` → `proof_<uuid>` →
`X-Payment`), every scenario also supports the **official x402 v2 protocol** as a **parallel** mode.
Not one existing route, CSV column or topology changes: without `X402_MODE`, nothing happens at all.

- **Protocol headers:** the server describes the challenge in the `PAYMENT-REQUIRED` header of the
  `402` response, the client sends a signed **EIP-3009** authorisation in `PAYMENT-SIGNATURE`, and
  the settlement outcome comes back in `PAYMENT-RESPONSE`.
- **The routes** live under `/x402/*`: `GET /x402/config` everywhere, then `GET /x402/service`
  (01, 06), `GET /x402/reading` (02), `POST /x402/session/open` and `/x402/reading-metered` (03),
  `GET /x402/single/service` and `/x402/tx/reading` (04 merchant), and the facilitator routes
  `POST /x402/verify`, `POST /x402/settle`, `GET /x402/supported` (04 facilitator).
- **The clients** get a **`--x402`** flag; folder 05 is triggered from the web page.

```bash
X402_MODE=self X402_MOCK=true npm run mock      # 01, 02, 03, 05, 06 and the facilitator in 04
X402_MODE=facilitated npm start                 # merchant in 04 (its chain access is taken away)
```

`X402_MOCK=true` uses the **real** facilitator SDK, but with a stub in place of the chain: the
signature, the recipient, the amount, the validity window and the EIP-712 domain are all verified
**for real** (offline), while settlement returns a synthetic hash prefixed with
`0x6d6f636b6d6f636b` ("mockmock"). Every CSV row produced this way carries `synthetic_tx=1`.

> **Why mock is mandatory.** The asset here is test ETH on Ethereum Sepolia, and native ETH has no
> **EIP-3009** contract, which the `exact` scheme needs for real settlement. If `X402_MODE` is on
> but `X402_MOCK` is not, the server **deliberately aborts at startup** — rather than failing only
> at settlement and writing rows labelled "real" in the meantime. A real run requires an
> EIP-3009-capable token (`X402_USDC_ADDRESS`, `X402_ASSET_*`) and a funded settlement wallet.

The results go into **separate files** `x402_*.csv`; they are processed by
`comparison/comparison_x402.py`, not by the individual folders' analysis scripts (x402 CSVs are in
atomic units, not in wei).

> **A methodological caveat.** The custom-protocol branch and the x402 branch share a network
> (Ethereum Sepolia) and a denomination (ETH), so those two factors are not confounding variables.
> One key difference remains: **in this configuration x402 settlement is synthetic and never reaches
> the chain**, whereas custom-protocol measurements taken with `--real` include a genuine broadcast
> and a wait for block confirmation. The measured x402 latencies therefore **exclude on-chain
> settlement time**, and latency differences must not be attributed to the x402 protocol itself.

## Measurement hygiene

- **CSV files are appended to, not overwritten.** Before every real measurement, delete the old CSV
  in that folder — including the one from the dry run — otherwise two runs merge into one and the
  JSON summary then describes only the last of them.
- **A dry run before every real measurement.** If a mock run against the server succeeds, then the
  network, the port, the token and the configuration are all in order; only then spend funds.
  Afterwards, delete the mock CSV.
- **Do not mix modes across folders.** The analysis scripts look for `*_real.csv` → `*_mock.csv`
  → `_sample/*`, in that order. If folder 02 is in *mock* mode while folder 03 is in *real* (or the
  other way round), `comparison.py` mixes the two **without any warning** — so always read the
  `Folder 02: …` and `Folder 03: …` lines that it prints.
- **Run the analyses where the CSV files are.** If you measured against a remote server, the results
  are on the laptop where the client ran.

## Results

The repository contains **code only**. The CSV files and figures appear only once you run the
experiments yourself, and they are excluded from git — so the results are always yours and
reproducible.

If you want to see what the figures look like without real measurements, you can generate simulated
input data with `comparison/generate_sample.py`. Figures like that carry a red
"SIMULATED EXAMPLE — NOT REAL MEASUREMENTS" watermark, and you must not use them as a result.

## Session identity and switching networks

Identity in this system **is not tied to an IP address**: recognition rests on the wallet (the
signature, or the sender of the transaction) and on one-time tokens (`requestId`, `proofToken`,
`sessionId`) that travel with the client. The flow therefore survives a change of network
(mobile ↔ wifi, NAT). The two websites (folders 04 and 05) additionally issue a correlation cookie
`sid`, which is however **never a condition for access**. The principle, the implementation and the
test are in [`docs/IDENTITY.md`](docs/IDENTITY.md).

## Structure

```
test-environments/
├─ README.md                          (this file — the shared overview)
├─ docs/
│   ├─ IDENTITY.md                    session identity and independence from the IP address
│   └─ NETWORKS.md                    would this work on Sepolia, mainnet, Bitcoin, USDC/EURC?
├─ 00_demo/                           server/ · client/ · docs/                     ← entry point
├─ 01_one_time_payments/              server/ · client/ · analysis/
├─ 02_machine_payments_per_request/   iot_device/ · agent/ · analysis/
├─ 03_machine_payments_prepaid/       iot_device/ · agent/ · analysis/
├─ 04_website_facilitator/            facilitator/ · server/ · agent/ · analysis/   ← topology (b)
├─ 05_website_direct/                 server/                                       ← topology (a)
├─ 06_x402/                           server/ · client/ · analysis/                 ← merged flow
└─ comparison/                        comparison.py · comparison_x402.py · generate_sample.py
```

The files `x402.js`, `db_x402.js`, `auth.js`, `x402-client.js` and `style.py` are deliberately
duplicated across several folders, so that each folder can be run on its own without any shared
dependencies.

## Further reading

- [`docs/IDENTITY.md`](docs/IDENTITY.md) — why identity is not tied to an IP, and how that is tested
- [`docs/NETWORKS.md`](docs/NETWORKS.md) — portability to other chains, mainnet, Bitcoin, USDC/EURC
- [`00_demo`](00_demo) — the simplest environment for demonstrating the protocol, a good entry point
