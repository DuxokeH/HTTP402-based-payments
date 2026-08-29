# Which networks could this system use?

> The question: *"could this be used on existing networks — Sepolia, Bitcoin, real Ethereum or
> anything else?"*
>
> The short answer: **Sepolia works today. Other EVM chains are a matter of configuration plus
> roughly four files. Real Ethereum works technically, but not economically. Bitcoin is not a
> configuration change but a rebuild of the verification layer (~40 % of the code). USDC/EURC is a
> new capability, and the facilitator branch (folder 04) is the shortest path to it.**

This document is an **analysis, not a work plan** — except where stated otherwise, none of the
changes below have been implemented. The point is to draw a precise line between the parts of the
system that are portable to other networks and the parts that are not.

## Summary

| Network / asset | Works? | What it would take | Why |
|---|---|---|---|
| **Ethereum Sepolia** | ✅ today | nothing | the default configuration |
| **Other EVM chains** (Base, Polygon, Arbitrum, Optimism) | 🟡 a small change | configuration + ~4 files | a different `chainId`, a different chain object in the browser |
| **Ethereum mainnet** | 🟡 technically yes, economically no | the same as above | 21 000 units of gas exceeds the micropayment by orders of magnitude |
| **Bitcoin (base layer)** | ❌ not without a rebuild | a new verification layer | UTXOs instead of accounts, no receipts, no gas, a different signature format |
| **Lightning / L402** | 🟡 a different system, the same pattern | a separate implementation | this is Bitcoin's own equivalent of x402 |
| **USDC / EURC (ERC-20)** | 🟡 a new capability | facilitator + merchant | a different way of reading the transaction; 6 decimals, not 18 |

---

## 1. Ethereum Sepolia — works today

`NETWORK=sepolia`, `chainId 0xaa36a7`, blocks roughly every 12 s. This is the default, tested
configuration of every folder.

## 2. Other EVM chains — configuration plus roughly four files

Payment verification is completely portable: `getTransaction` + `getTransactionReceipt` and the
comparison of `to` / `value` / `from` work the same way on every EVM chain. The EIP-191 signatures,
the SQLite schema and **the entire metered mode** are likewise unchanged.

What would have to change is this:

| Place | What | Note |
|---|---|---|
| `.env` | `NETWORK`, `RPC_URL` | the CSP policy adds `RPC_URL` by itself (`RPC_ORIGIN`) — no permissions need editing |
| `server/server.js` (`/config`) | the ternary `NETWORK === 'sepolia' ? '0xaa36a7' : null` | for any other chain it returns `null` and the browser has no idea what to switch to |
| `server/server.js` (`/single/config`) | in folders 04/05 `'0xaa36a7'` was hard-coded **unconditionally** | already fixed to the same ternary in this release; the route is dead anyway (the page never calls it), but it was a hidden trap |
| `server/public/app.js` | the `sepolia` import from `viem/chains`, and the comparison against the literal `'0xaa36a7'` instead of `CFG.chainId` | on top of that there is no `wallet_addEthereumChain` fallback — folder 01 has one (`public/app.js:33-41`) and it is worth copying across |

**A separate, genuine bug (it applies to every network).** `server/runner.js` hard-codes
`tx.wait(1)` instead of `MIN_CONFIRMATIONS`. If you set `MIN_CONFIRMATIONS=3`, the built-in agent
waits for only one confirmation while verification demands three — and every verification fails. On
chains with faster blocks (Base ~2 s) a greater confirmation depth is actually advisable, so this
bug would bite immediately there.

## 3. Ethereum mainnet — technically identical, economically pointless

Structurally nothing changes: mainnet is an EVM chain like any other. What collapses is the
economics. An ETH transfer costs 21 000 units of gas; at real mainnet prices that is **orders of
magnitude more than the micropayment itself** (~1 cent). A payment for a sensor reading would carry
a fee larger than the reading.

This estimate is **quoted, not measured** — there are no mainnet measurements in this repository.
It is worth stressing: this is exactly the reason for metered mode. The "one top-up + N signed
debits" model divides the gas cost by N, which makes it the only one of the three flows that would
make any sense at all on mainnet — and even there only once N is large enough.

## 4. Bitcoin — not a configuration change but a new verification layer

This is where the assumptions part ways. Bitcoin has no accounts; it has **UTXOs**:

| Assumption in the code | On Bitcoin |
|---|---|
| `tx.from` — the sender | **does not exist**; inputs are references to earlier outputs |
| one `tx.to` and one `tx.value` | a transaction has **several outputs**; the "recipient" is one of them |
| `receipt.status === 1` | **there are no receipts**; a transaction is either in a block or it is not |
| `gasUsed`, `gasPrice` | **there is no gas**; the fee is the difference between the inputs and the outputs |
| `ethers.getAddress` + `.toLowerCase()` | bech32 and base58 addresses — **`toLowerCase()` corrupts a base58 address**, because letter case is meaningful there |
| `ethers.verifyMessage` (EIP-191) | the equivalent is **BIP-322** (or the older "signmessage") |
| wei, 18 decimals | satoshi, 8 decimals |

On top of that, **ten-minute blocks kill the "payment per reading" flow**: 20 readings with one
confirmation each is ~3 hours or more. In practice it would break sooner — `runner.js` uses
`tx.wait(1)`, and the clients have a 90-second axios timeout.

**What would survive:** the shape of the 402 protocol, `db.js`, `auth.js`, SSE, the admin login and
— most importantly — **the whole "1 top-up + N signed debits" design**. Metered mode is in fact
**already chain-independent below the top-up level**: the only thing that touches the chain is
`/metered/session/open`. Everything else is signatures and bookkeeping.

Bitcoin's native equivalent is **Lightning / L402** (formerly LSAT): it too uses HTTP 402 and a
token that the client presents. L402 is the approach most closely related to this system. For
Bitcoin that is the right path — not adapting this code to the base layer.

## 5. USDC / EURC — a new capability, and the facilitator branch is the shortest path

Today there is **no ERC-20 support** in `test-environments/`: all three flows measure `tx.value`,
which is native ETH. For tokens you would need to:

- read the **`Transfer` event** from the receipt instead of `tx.value`;
- account for the fact that on a token transfer `tx.to` is **the token contract's address**, not the
  recipient's — which inverts the recipient check (`server/server.js`, the comparison against
  `RECEIVER`);
- use **6 decimals instead of 18** (USDC and EURC), i.e. every `parseEther`/`formatEther`
  conversion;
- handle the token approval / balance on the payer's side.

**Why folder 04 (the facilitator) is the best fit for this:** the old facilitator implementation
**already knows how to decode** `Transfer` (the code is in `experiments/legacy/.../facilitator.js`,
although unused), and above all, in topology (b) the chain is read in **a single place**. Moving to
tokens is therefore a change to **the facilitator**, and the merchant is left untouched — which is
incidentally a neat argument for topology (b) in itself.

Two points are worth highlighting:

1. **EIP-3009** (`transferWithAuthorization`) is what *official* x402 does: the payer signs an
   authorisation, the facilitator pays the gas, and the payer needs none of the chain's native
   token. That remains future work.
2. Coinbase's hosted facilitator supports **Base Sepolia, but not Ethereum Sepolia**. The official
   x402 branch in this repository therefore runs self-hosted, in **a test configuration denominated
   in ETH on Ethereum Sepolia** (with synthetic/mock settlement) — so the latency comparison takes
   place on a single network. **Real** x402 settlement, however, still requires an ERC-20 token with
   EIP-3009 (USDC/EURC), which remains future work.

**EURC.** A comparison with the regulated euro stablecoin (EURC) is deliberately not covered in this
code. If it were to come back into scope, the paragraph above is the cheapest path: EURC is an
ERC-20 just like USDC, so it is the same change.

## 6. What is actually tied to the chain

Most of the system **is not**:

| Layer | Tied to the chain? |
|---|---|
| the HTTP 402 protocol, the payment request, the proof token | no |
| the SQLite schema, token single-use, replay prevention | no |
| the admin login, the `sid` session correlation, CSP, Caddy | no |
| the metered session: credit, budget, expiry, nonce | no |
| the debit signature (EIP-191) | **yes** — the signature format is EVM-specific |
| payment verification (`getTransaction` / the receipt) | **yes** |
| topping up a metered session | **yes** — but that is a single code path |

Of the three flows, then, **the metered one is the most portable**: it touches the chain only once
per session. That is at once the answer to the question and an argument for the metered-session
model itself ("one top-up + N signed debits").
