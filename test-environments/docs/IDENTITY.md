# Session identity and independence from the IP address — implementation

> This document describes **what is built into the code**, why it was designed that way and how
> to test it.
>
> **Related:** folders 02, 03 and 04 are additionally closed off behind an admin login — see
> [admin login](../README.md#admin-login). The login is likewise **not tied to the IP address**, so
> switching networks does not log a signed-in user out. Folder 01 was left open so that there is
> also a measurement path with no login in it.

## 0. Why identity is not tied to the IP address

The obvious first idea is to have the server remember the client's IP on the first `GET` and later
check whether it is dealing with "the same person". That approach was rejected for three reasons:

- The IP changes mid-flow (mobile network ↔ wifi, NAT, CGNAT) — binding to it would reject exactly
  the legitimate user.
- `X-Forwarded-For` can be forged, and behind a proxy or NAT several users share the same IP.
- Cryptographic identity (the wallet) and single-use tokens are stronger **and** independent of the
  network.

**Rule: the IP may serve at most as soft telemetry or as a log entry, never as a condition for
access.** The idea of "save a token on the GET, check it later" is therefore implemented with the
`sid` session cookie (section B below) — which travels with the browser, not with the network.

## 1. Principle

Identity in this system **is not tied to an IP address**. "The same person" is recognised through:

| Mechanism | Where | What it proves |
|---|---|---|
| `requestId` (UUID, TTL) | 402 → `/verify` | the link challenge → verification |
| wallet address (`X-Payer` / `tx.from`) | transaction verification | the payer's cryptographic identity |
| `proofToken` (single-use, TTL, bound to a resource) | `X-Payment` header | paid access to exactly that resource |
| `sessionId` + EIP-191 signature (`X-Signature`) | every metered debit | "holds the private key" on *every* request |
| **`sid` (cookie, TTL)** — *new* | folder 05 | **correlation** of events within one session |

All of it travels **with the client** (HTTP headers/body, cookie), not with the network — which is
why a change of IP (mobile ↔ wifi, NAT, CGNAT) does not interrupt the flow.

**Nowhere in the code is the IP used as a measure of identity or authorisation.** It has only two
uses:

- **Rate limiting** (`express-rate-limit`) in folders 01–03 — hence `app.set('trust proxy', 1)`.
  To be precise: this *is* the one place where the IP influences the response (`429`), but it caps
  **the rate**, not **who you are**. A legitimate user's one-off request after a network change
  cannot be rejected because of it. Folder 05 has no rate limiter.
- **Soft telemetry** in folder 05 — a counter of the IP changes detected within one `sid` session.
  It exists purely so that it is possible to *show* that a change of IP has no effect on access.

## 2. What was added

### A — HTTPS/TLS for public access

`proofToken` is a "bearer" token: whoever intercepts it gets access. The real fix is **TLS**, not
binding to the IP. New deployment files in `05_website_direct/server/`:

```
Caddyfile           reverse proxy with TLS (Let's Encrypt), HSTS, flush_interval -1 for SSE
docker-compose.yml  Node application + Caddy (the same pattern as test-environments/00_demo/server)
Dockerfile          node:20-alpine, builds better-sqlite3, runs as a non-root user
.dockerignore
```

No application code had to be changed for this. Because `trust proxy` is already set, `req.secure`
correctly reflects `X-Forwarded-Proto` from behind Caddy, so the `sid` cookie automatically gets the
`Secure` flag behind public HTTPS (you can also force it with `COOKIE_SECURE=true`).

> **Wireshark:** under TLS the content is not visible in the capture. For screenshot evidence of the
> flow, leave access over plain HTTP on the LAN/loopback (uncomment `ports` in
> `docker-compose.yml`).

### B — The `sid` session token (a cookie) instead of relying on the IP

This is the correct implementation of the idea "save a token on the GET, check later whether it is
the same person", but **resilient to a change of IP**.

- On the first request without a valid cookie, the server issues
  `Set-Cookie: sid=<uuid>; Path=/; Max-Age=1800; HttpOnly; SameSite=Lax` (+ `Secure` under HTTPS).
- `sid` is kept in the new `sessions_web` table, and the linked events in `sessions_web_links`
  (`request_id`, `proof_token`, `metered_session`). Both are cleaned up by the existing `sweep()`.
- **The key rule:** a missing, invalid or altered `sid` **never** causes a rejection. The whole
  correlation runs inside `try`/`catch` and always calls `next()`; not even a database error
  interrupts the request. This makes it impossible to reproduce the IP-binding problem.
- The new `GET /session` returns a view of the session. Because the cookie is `HttpOnly`, it returns
  **only a truncated `sid`** (the first 8 characters) and **the number of IP changes** — never the
  IP addresses themselves. Without a cookie it answers `200` with `session: null`, never `403`.
- The website has a new **"Session and identity"** section that shows this live (the *Refresh
  session* button).
- The built-in M2M agent (`runner.js`) marks its own calls with the header `X-Demo-Agent: runner`
  and does **not** receive a session cookie: a machine is not a browser, and its identity is the
  wallet + the signature.

Changed files: `05_website_direct/server/server.js`, `db.js`, `runner.js`, `public/index.html`,
`public/app.js`, `.env.example`. No new dependencies (the cookie is read by hand from
`req.headers.cookie`, without `cookie-parser`).

New settings:

| Variable | Default | Meaning |
|---|---|---|
| `WEB_SESSION_TTL_SECONDS` | `1800` | the lifetime of the `sid` cookie and of the session |
| `COOKIE_SECURE` | `false` | `true` = always add `Secure` to the cookie (for a TLS proxy) |

### C — A hostname instead of a hard-coded IP

`MERCHANT_URL` / `IOT_URL` were already configurable through an environment variable that takes
precedence over `config.json`. The default value remains `127.0.0.1`, **so that mock measurements
run with no configuration at all**; all three `config.json` files now document explicitly how to use
a hostname instead of an IP:

```bash
MERCHANT_URL=http://x402.your-domain.example:3000 npm run mock     # folder 01
IOT_URL=http://iot.your-domain.example:3100 npm run mock           # folder 02
IOT_URL=http://iot.your-domain.example:3200 npm run mock           # folder 03
```

The browser (folders 01 and 04) needs no changes — it makes every call to its own server over
**relative paths** (`/config`, `/single/service`, `/run/tx`, `/session`), so no address is written
into the page at all. The only absolute URLs are third-party resources: `esm.sh` (the viem library),
the RPC provider and `sepolia.etherscan.io`.

## 3. Testing that "it works across a change of IP"

1. Start folder 05: `cd 05_website_direct/server && npm run mock`, then open `http://<address>:8080`.
2. At the bottom of the page open the **Session and identity** section — the `sid` is issued on the
   first visit, and "IP changes detected" shows `0 (same IP)`.
3. Start a flow (tab 1 via MetaMask or the *Demo* button, or tab 2/3).
4. **Switch the device's network mid-flow** (wifi → mobile internet) so that the IP changes.
5. Continue the flow, or click *Refresh session*.
6. **Expected:** no `403` anywhere. "IP changes detected" rises to `1`, while the `sid` and the
   linked events stay the same — the server recognises the same session despite the different IP.

A test without a cookie (proof that `sid` is not authorisation): open the page in a private window
or refuse cookies — the flow works exactly the same, only the session section stays empty.

From the command line:

```bash
# 1) the first GET issues the cookie
curl -si http://localhost:8080/config | grep -i set-cookie

# 2) the same session on the requests that follow
curl -s -c jar.txt http://localhost:8080/config > /dev/null
curl -s -b jar.txt http://localhost:8080/session

# 3) a forged/foreign sid -> NOT a 403, the server merely starts a new correlation
curl -si -H 'Cookie: sid=00000000-0000-0000-0000-000000000000' \
     http://localhost:8080/single/service | head -1     # HTTP/1.1 402, not 403
```

## 4. What is deliberately absent

- **No binding of access to the IP or to `X-Forwarded-For`.** The IP changes along the way, behind a
  proxy/NAT it is shared by several users, and `X-Forwarded-For` can be forged.
- **No change to the identity logic in the measurement folders 01–03** that could affect latency.
  The only thing changed there are the explanatory notes in `config.json` (`_note*`), which the code
  does not read as configuration.
- The `test-environments/00_demo/` folders were left untouched (originals).

## 5. Findings from the code review

During implementation the code was reviewed folder by folder. Two things turned out to have been
described too broadly before. Neither was fixed in folders 01–03, because the identity logic of the
measurement folders is deliberately left alone (touching it would affect the measured latency) —
but they are known shortcomings worth being aware of.

| Expected behaviour | Actual state |
|---|---|
| "`requestId` … mandatory at `/verify-payment`" | True for folders **01** and **02**. Folder **03** has no `requestId` and no `/verify-payment` route **at all** — its `402` is stateless, and the link challenge → session is carried by the single-use `txHash` (the `redeemed_tx_hashes` table). |
| "if the `402` bound the payer, that has to match too" | True for folder **01** (`server.js:432`). Folder **02** **saves** `payer_address` from the payment request **but never reads it back during verification** — it only compares `tx.from` against the `payerAddress` field in the body. Folder **03** solves this differently (and more strictly): the payer is pinned from the chain when the session is opened and proved by a signature on every debit. |

Further points that support the decision to use **TLS rather than IP binding** (section A above):

- On redemption, `proofToken` is **a pure "bearer" token** — neither the wallet nor a signature is
  checked at the point of access. Whoever intercepts it can spend it. That is precisely why the real
  fix is TLS.
- In folder 03, `GET /session/:id` was **unsigned and unthrottled**; `sessionView` returns the
  payer's address, the deposit, the budget and the balance. That is now closed off behind the admin
  login (see [admin login](../README.md#admin-login)), but a signature still does not protect this
  route.
- A separate, unrelated bug: `01_one_time_payments/server/public/app.js:54` calls
  `createPublicClient({ chain: sepolia, transport: http() })` with no address, so viem falls back to
  the default RPC, which the server's own CSP (`server.js:156`) blocks. Folder 05 does not have this
  problem (it uses `CFG.rpcUrl`). The fix is a one-liner, but it reaches into folder 01 — your call.

Known limitations of the correlation as implemented (deliberate, because `sid` is not
authorisation):

- `X-Forwarded-For` can be forged, so the **IP-change counter is telemetry only** and not evidence.
  If the server runs without a proxy in front of it, `trust proxy, 1` means the client can simply
  declare its own IP.
- Every request without a cookie opens a new row in `sessions_web`. The rows are small and the
  existing `sweep()` deletes them every minute by `expires_at`; `/health` is exempt.
- Anyone can send the `X-Demo-Agent` header — doing so only gives up their own correlation and gains
  them nothing (access does not depend on `sid`).

## 6. Key takeaways

The essence of the security model and the architecture, in three points:

- Identity is **cryptographic and carried by the client**, not by the network. Binding to the IP
  would reject the legitimate user on every network change while still failing to stop an attacker
  behind the same NAT/proxy — so it is worse on both axes.
- The session cookie is **for correlation, not for authorisation**. That distinction is the whole
  point: the session improves traceability and logging without creating a new way to be refused.
- The confidentiality of the "bearer" token (`proofToken`) is solved with **TLS**, not by
  restricting access by network address.
