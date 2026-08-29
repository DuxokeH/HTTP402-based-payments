# Micropayments over HTTP 402

Working implementations of paying for web services with the **HTTP 402 Payment Required** status
code and the **x402** protocol: the server demands payment for access, the client pays on the
blockchain, the server verifies the payment, and only then serves the content.

The repository contains **seven self-contained environments** — from the simplest demonstration
to measurement setups that compare different payment models and architectures. Each environment
comes with its own instructions and its own dependencies, and can be run independently of the rest.

Everything runs on the **Ethereum Sepolia testnet**, never with real funds, and every environment
has a **mock mode** that works entirely without a wallet and without any chain access.

## What HTTP 402 is

The `402 Payment Required` status code has been reserved in the HTTP standard since 1997, yet was
never standardised — until cryptocurrencies took off there was no generally usable means of
payment to put behind it. The basic flow is simple:

```
 client                                   server
    │                                        │
    │──── GET /service ─────────────────────►│   request without payment
    │◄─── 402 Payment Required ──────────────│   "pay this much, to this address"
    │                                        │
    │──── payment on the blockchain ─────────┼──► ...
    │                                        │
    │──── GET /service + proof ─────────────►│   server verifies the payment on-chain
    │◄─── 200 OK + content ──────────────────│
```

The interesting questions only begin after that. How do you **unambiguously tie** a payment to the
exact request that triggered it? How do you stop the same payment from being redeemed twice? What
happens once there are thousands of payments and the cost of a transaction exceeds the service
itself? And who checks the chain at all — the provider itself, or a facilitator? These are the
questions the environments in this repository answer.

## Where to start

**If you just want to see it work**, run
[`test-environments/00_demo`](test-environments/00_demo). It is the simplest environment: a server,
a command-line client and a browser page driven by MetaMask. No wallet required, two terminals:

```bash
git clone <url-of-this-repository>
cd HTTP402-based-payments/test-environments/00_demo

# terminal 1 — server
cd server && npm ci && cp .env.example .env && npm run mock

# terminal 2 — client
cd client && npm ci && npm run mock
```

The client prints the whole flow: `402 Payment Required` → payment → `200 OK` with the content.

**If what you are after is a comparison of payment models**, head to
[`test-environments/`](test-environments) — that is where the shared overview lives, with one
environment per scenario.

## Environments

| Environment | Question it answers | Port |
|---|---|---|
| [`00_demo`](test-environments/00_demo) | What does the shortest possible flow look like? Payment and content delivery in two exchanges. | 3000 |
| [`01_one_time_payments`](test-environments/01_one_time_payments) | How long does each phase of a payment take, and where is the time actually spent? | 3000 |
| [`02_machine_payments_per_request`](test-environments/02_machine_payments_per_request) | What happens if a machine pays for **every** sensor reading with a transaction of its own? | 3100 |
| [`03_machine_payments_prepaid`](test-environments/03_machine_payments_prepaid) | How much does a model save where **one** top-up covers N signed debits? | 3200 |
| [`04_website_facilitator`](test-environments/04_website_facilitator) | What does an architecture cost in which the provider has no chain access and a **facilitator** does the verifying? | 4000 + 8081 |
| [`05_website_direct`](test-environments/05_website_direct) | The same website, but the provider reads the chain itself — the comparison setup for environment 04. | 8080 |
| [`06_x402`](test-environments/06_x402) | How much latency and how many messages does **merging** verification and delivery into a single exchange save? | 3300 |
| [`comparison`](test-environments/comparison) | Tooling that combines the results of environments 02 and 03 into comparison figures. | — |

Environments **04 and 05** form a pair: the same page and the same flows, differing only in whether
the provider reads the chain itself or a separate facilitator does it on its behalf. Environments
**02 and 03** form a pair along a different axis: one transaction per use versus one transaction
per N uses.

## What else is in the repository

- [`test-environments/README.md`](test-environments/README.md) — shared instructions covering every
  environment: wallet roles, the two-device setup, admin login, traffic capture with Wireshark, and
  the parallel mode that follows the official x402 v2 protocol.
- [`test-environments/docs/`](test-environments/docs) — two in-depth discussions:
  [`IDENTITY.md`](test-environments/docs/IDENTITY.md) (why session identity is not tied to an IP
  address, and how to test that) and [`NETWORKS.md`](test-environments/docs/NETWORKS.md) (what it
  would take for this to work on other chains, on Bitcoin, or with USDC).

## Requirements

- **Node.js ≥ 20** and npm — for every environment
- **Python ≥ 3.9** (`matplotlib`, `pandas`, `numpy`) — only for analysing the results
- optional **Docker** and Docker Compose — for environments 04 and 05, and for public deployment
- optional **Wireshark** — for watching the protocol on the wire
- to run with **real** payments: a wallet on the Ethereum Sepolia network holding test ETH from a
  public faucet

## Security and test wallets

**The repository contains no wallets, no private keys and no credentials.** Everyone creates their
own:

```bash
node generate-wallet.js        # in the client's or agent's folder
```

The resulting `wallet.json` and `.env` files are listed in [`.gitignore`](.gitignore) and must never
end up in the repository. The same goes for the admin credentials that the servers generate for
themselves on first start in `data/admin-credentials.txt`.

- **Use a dedicated test wallet and nothing else.** Never enter the key of a wallet that holds real
  funds. Test ETH has no value and costs you nothing.
- By default the environments run over **plain HTTP without TLS**, so that the traffic stays
  readable in Wireshark. Do not expose them to the public internet without restricting access; a
  Caddy configuration with TLS is included for public deployment.
- Routes that spend funds in real mode are protected by an admin login — see the
  [shared instructions](test-environments/README.md#admin-login).

## Results

The repository holds **code only**. Every CSV file and figure is produced when you run the
environments yourself, and all of them are excluded from git — so the results are always your own
and reproducible. If you want to see what the figures look like without real measurements, you can
generate simulated input data with `test-environments/comparison/generate_sample.py`; figures built
that way carry a "SIMULATED EXAMPLE" watermark.

## Automated checks

On every push, [`.github/workflows/ci.yml`](.github/workflows/ci.yml) installs the dependencies,
creates the two test wallets, starts the server and verifies that `GET /service` returns **402**,
that the full mock flow reaches **200 OK**, and that the security tests pass — which makes it clear
whether the repository really works straight after checkout.

Verified manually: the mock flow of every environment, the security tests, the Python analyses and
the comparison figures. Runs with real payments, deployment with Docker and TLS, and Wireshark
captures all require funds or infrastructure, so they are documented rather than checked
automatically.

## License

MIT — see [LICENSE](LICENSE).
