# X402 Payment Protocol - Protocol Specification
**Version:** 2.0  
**Date:** August 2026  
**Author:** Tim Heinzer  

> 🚀 **For deployment instructions, installation, troubleshooting and worked examples, see:** [README.md](../README.md)

---

## 1. INTRODUCTION

### 1.1 Purpose of This Document

This document is the formal specification of the X402 Payment Protocol - an extension of HTTP/1.1 that adds support for blockchain-based payments. The protocol builds on HTTP status code 402 (Payment Required), a code reserved by RFC 2616 and RFC 7231 but never standardised.

The specification describes the **actual implementation** in this repository (`server/server.js`, `server/db.js`, `client/run.js`, `server/public/app.js`).

### 1.2 Scope

The specification covers:
- HTTP message format (merged exchange: verification + delivery)
- Payment request/response structures
- Blockchain verification mechanisms
- The state machine of the payment flow
- Error handling

### 1.3 Standards

- **RFC 2616** - HTTP/1.1 Protocol
- **RFC 7231** - HTTP/1.1 Semantics (Section 6.5.2 - 402 Payment Required)
- **RFC 8259** - JSON Data Interchange Format
- **RFC 4122** - UUID Generation
- **Ethereum JSON-RPC** - Blockchain Interface Specification

---

## 2. PROTOCOL ARCHITECTURE

### 2.1 Components

```
┌─────────────┐                          ┌──────────────────┐
│             │      HTTP/HTTPS          │                  │
│   CLIENT    │◄─────────────────────────►│  HOSTING SERVER  │
│   (User)    │                          │   (Merchant)     │
│             │                          │                  │
└──────┬──────┘                          └────────┬─────────┘
       │                                          │
       │     ┌─────────────────────────────┐     │
       └────►│   ETHEREUM BLOCKCHAIN       │◄────┘
             │   (Sepolia Testnet)         │
             │   - Transaction Storage     │
             │   - Immutable Ledger        │
             └─────────────────────────────┘
```

**End-to-End Principle:**
- Only 2 active components (client, server)
- Blockchain = passive public ledger
- No intermediaries (facilitators)
- Direct verification

### 2.2 Protocol Layers

```
┌──────────────────────────────────────┐
│  Application Layer (X402 Protocol)  │
├──────────────────────────────────────┤
│  HTTP/1.1 (RFC 7231)                │
├──────────────────────────────────────┤
│  TCP/IP                              │
├──────────────────────────────────────┤
│  Ethereum JSON-RPC (Blockchain)     │
└──────────────────────────────────────┘
```

### 2.3 Merged Exchange (Design Choice)

The implementation **merges payment verification and content delivery into a single exchange**. For the paid service the server exposes only two methods on one path:

- `GET /service` → issues a payment request (402),
- `POST /service` → verifies the transaction on chain **and** returns the content plus a proof token in the same response.

On the wire this produces **2 request/response pairs = 4 HTTP messages**:

```
1. C → S   GET  /service                                    (resource request)
2. S → C   402  Payment Required   {payment: {...}}         (the bill)
   ────── client sends the transaction to Sepolia, gets txHash ──────
3. C → S   POST /service  {requestId, txHash, network,
                           payerAddress, prompt}            (proof + request)
4. S → C   200  OK        {response, proofToken, payment}   (content + token)
```

The server **does not expose** a separate resource that would only verify the payment and return a token, leaving the client to fetch the content in a third exchange. A design with separate verification would need three pairs (6 messages); the merged design needs two (4 messages), i.e. **one full HTTP round trip fewer**, and the client receives the content the moment the payment is confirmed.

**Optional third pair (`--ack`):** after receiving the token the client may send one more `GET /service` carrying the `X-Payment` header. That exchange only acknowledges that the payment is authorised; it is **not** part of the mandatory flow and delivers no content.

### 2.4 HTTP Interface (complete list of resources)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/service` | without an `X-Payment` header: issues a 402 with a payment request; with a valid header: acknowledges authorisation |
| `POST` | `/service` | merged exchange (verification + delivery); with an `X-Payment` header, redeems an already issued token |
| `GET` | `/config` | public configuration for the web client (network, price, recipient address) |
| `GET` | `/health` | status of the server, the database and the connection to the JSON-RPC node |
| `GET` | `/` and static files | web client (`server/public/`) |

The server exposes no other paths.

---

## 3. MESSAGE FORMAT SPECIFICATION

### 3.1 Messages 1 and 2: HTTP 402 Payment Required

**Trigger:** the client requests a protected resource without an `X-Payment` header

**HTTP Request:**
```http
GET /service HTTP/1.1
Host: <merchant-server>
X-Payer: 0x<payerAddress>          ; optional
```

The client may declare the payer address either with the `X-Payer` header or with the `?payer=0x...` query parameter. If the address is valid it is **bound** to the payment request, and the later `POST /service` must match it (see 5.2). An invalid address is silently discarded (the request stays unbound).

**HTTP Response:**
```http
HTTP/1.1 402 Payment Required
Content-Type: application/json
Content-Length: <length>
Date: <timestamp>

{
  "error": "Payment Required",
  "message": "Payment required to access this service",
  "payment": {
    "requestId": "<uuid>",
    "to": "0x<merchantAddress>",
    "amount": "0.0001",
    "currency": "ETH",
    "network": "sepolia",
    "createdAt": "2026-01-08T12:00:00.000Z",
    "expiresInSeconds": 1800
  }
}
```

**Fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `error` | string | Yes | Short error label ("Payment Required") |
| `message` | string | Yes | Human-readable description for the user |
| `payment.requestId` | UUID v4 | Yes | Unique identifier of the request |
| `payment.to` | Ethereum Address | Yes | Merchant wallet address (0x..., checksummed form) |
| `payment.amount` | string | Yes | Amount in ETH (decimal string, `SERVICE_PRICE_ETH`) |
| `payment.currency` | string | Yes | Currency ("ETH") |
| `payment.network` | string | Yes | Blockchain network ("sepolia") |
| `payment.createdAt` | ISO 8601 | Yes | Time the request was issued |
| `payment.expiresInSeconds` | number | Yes | Validity of the request (`PAYMENT_REQUEST_TTL_SECONDS`, default 1800) |

The payment request is written to the `payment_requests` table (SQLite) together with the recipient, the amount, the network, the bound payer (if any) and the expiry time.

**Validation Rules:**
- `requestId`: MUST be valid UUID v4 format
- `to`: MUST be valid Ethereum address (42 chars, 0x prefix)
- `amount`: MUST be positive decimal number
- `network`: MUST match server configuration (`NETWORK`)

---

### 3.2 Message 3: Merged Request (verification + delivery)

**Trigger:** the client has sent the payment transaction on chain and holds a `txHash`

**HTTP Request:**
```http
POST /service HTTP/1.1
Host: <merchant-server>
Content-Type: application/json
Content-Length: <length>

{
  "requestId": "<uuid>",
  "txHash": "0x<transactionHash>",
  "network": "sepolia",
  "payerAddress": "0x<payerAddress>",
  "prompt": "<question for the service>",
  "model": "gpt-4o-mini"
}
```

**Fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `requestId` | UUID v4 | Yes | ID from the original 402 response |
| `txHash` | string | Yes | Ethereum transaction hash (`0x` + 64 hex characters) |
| `network` | string | Yes | MUST equal the server's `NETWORK` (zod `literal`) |
| `payerAddress` | Ethereum Address | Yes | Address the transaction was sent from |
| `prompt` | string | Yes | Input for the paid service, 1..`OPENAI_MAX_PROMPT_CHARS` (default 4000) characters |
| `model` | string | No | Desired model; if it is not in the server's price list, the default (`OPENAI_MODEL`) is used |

**Validation Rules (zod, before any chain access):**
- `requestId`: MUST be valid UUID
- `txHash`: MUST match `^0x[0-9a-fA-F]{64}$`; the server converts it to **lowercase** before use (the primary key of the `redeemed_tx_hashes` table is case-sensitive)
- `network`: MUST equal server `NETWORK`
- `payerAddress`: MUST be parsable by `ethers.getAddress()`
- `prompt`: MUST be non-empty and within the length limit

The request body is capped at **64 kB** (`express.json({ limit: '64kb' })`).

---

### 3.3 Message 4: Merged Response (Success)

**HTTP Response:**
```http
HTTP/1.1 200 OK
Content-Type: application/json
Content-Length: <length>

{
  "success": true,
  "response": "<service content>",
  "model": "gpt-4o-mini",
  "usage": {
    "prompt_tokens": 24,
    "completion_tokens": 118,
    "total_tokens": 142
  },
  "proofToken": "proof_<uuid>",
  "expiresInSeconds": 600,
  "payment": {
    "verified": true,
    "txHash": "0x<txHash>",
    "blockNumber": 12345678
  }
}
```

**Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | `true` on successful verification and delivery |
| `response` | string | The paid content (the model's answer) |
| `model` | string | Model used; `"demo"` when `OPENAI_API_KEY` is not set |
| `usage` | object | Model token usage (absent in demo mode) |
| `proofToken` | string | Proof token, issued within this same exchange |
| `expiresInSeconds` | number | Token validity (`PROOF_TOKEN_TTL_SECONDS`, default 600) |
| `payment.verified` | boolean | Always `true` in a successful response |
| `payment.txHash` | string | Confirmed transaction hash |
| `payment.blockNumber` | number | Block that contains the transaction |

**Token Format:**
- `proofToken`: `"proof_"` + UUID v4
- Example: `proof_a1b2c3d4-e5f6-7890-1234-567890abcdef`

**Demo mode (no `OPENAI_API_KEY`):** the response has the same shape, the `usage` field is missing, `model` is `"demo"`, and `response` starts with `[DEMO MODE — no OPENAI_API_KEY set]`. The HTTP flow is identical.

**Important:** at this point the token has already been **consumed** (`consumed_at` is set before the service is called). The client does not need it to reach this content - it arrives in the same response. The token serves as proof of payment (e.g. for the optional acknowledgement in 3.4).

---

### 3.4 Optional Authorisation Acknowledgement (`--ack`)

**HTTP Request:**
```http
GET /service HTTP/1.1
Host: <merchant-server>
X-Payment: proof_<uuid>
```

**Alternative Header:**
```http
X-Payment-Proof: proof_<uuid>
```

**Validation:**
- The token MUST exist in the `payment_proofs` table
- The token MUST NOT be expired (`expires_at > now`)

**Success Response:**
```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "success": true,
  "authorized": true,
  "proofToken": "proof_<uuid>",
  "expiresAt": "2026-01-08T12:10:00.000Z",
  "consumed": true,
  "payment": {
    "verified": true,
    "txHash": "0x...",
    "blockNumber": 12345678
  }
}
```

The `consumed` field reports whether the token has already been redeemed. This exchange **delivers no content** and does not consume the token; it only confirms that the payment was made and recorded.

**Error Response:**
```http
HTTP/1.1 403 Forbidden

{ "error": "Invalid or expired proof token" }
```

---

### 3.5 Fallback Exchange: Redeeming an Issued Token

Used when the client already holds an unconsumed token (e.g. because the merged exchange returned `503` due to the daily spending cap even though the payment was valid).

**HTTP Request:**
```http
POST /service HTTP/1.1
Host: <merchant-server>
Content-Type: application/json
X-Payment: proof_<uuid>

{
  "prompt": "<question for the service>",
  "model": "gpt-4o-mini"
}
```

In this branch the body does **not** carry `requestId`, `txHash`, `network` or `payerAddress` - the payment was verified earlier. The server:

1. looks up the token (`403 Invalid or expired proof token` if it is missing or expired),
2. rejects an already redeemed token (`403 Proof token already consumed`),
3. validates the body (`400 Validation error`),
4. checks the daily spending cap (`503`),
5. **marks the token consumed before** calling the service (`409` if a concurrent request got there first),
6. returns the same response as in 3.3.

---

### 3.6 Auxiliary Resources

**`GET /config`** - public configuration for the web client:

```json
{
  "network": "sepolia",
  "chainId": "0xaa36a7",
  "merchant": "0x<merchantAddress>",
  "service": { "price": "0.0001", "currency": "ETH", "network": "sepolia" },
  "proofTokenTtlSeconds": 600,
  "aiEnabled": true,
  "model": "gpt-4o-mini"
}
```

**`GET /health`** - server status (`200 ok` / `503 degraded`):

```json
{
  "status": "ok",
  "service": "X402 Hosting Server",
  "network": "sepolia",
  "merchant": "0x<merchantAddress>",
  "db": "ok",
  "rpc": "ok",
  "lastBlock": 12345678,
  "aiEnabled": true,
  "todayOpenAISpendUsd": 0.0123
}
```

The last-block query has a 2-second timeout; on failure `rpc` is `"down"` and `status` is `"degraded"` (HTTP 503).

---

## 4. STATE MACHINE

### 4.1 Sequence Diagram (mandatory flow)

```
CLIENT                    HOSTING SERVER                 SEPOLIA
  │                             │                            │
  │─(1) GET /service ──────────►│                            │
  │                             │ store payment_request      │
  │◄─(2) 402 {payment} ─────────│                            │
  │                             │                            │
  │─ sendTransaction ───────────┼───────────────────────────►│
  │◄─ txHash + receipt ─────────┼────────────────────────────│
  │                             │                            │
  │─(3) POST /service ─────────►│                            │
  │     {requestId, txHash,     │─ getTransaction ──────────►│
  │      network, payerAddress, │◄─ tx ──────────────────────│
  │      prompt}                │─ getTransactionReceipt ───►│
  │                             │◄─ receipt ─────────────────│
  │                             │ verify + mint token        │
  │                             │ call the service           │
  │◄─(4) 200 {response,         │                            │
  │      proofToken, payment} ──│                            │
  │                             │                            │
  │─ (optional) GET + X-Payment ─►│                          │
  │◄─ 200 {authorized:true} ────│                            │
```

### 4.2 Client State Machine

```
┌─────────────┐
│   START     │
└──────┬──────┘
       │
       ▼
┌─────────────────────┐
│ Request Resource    │
│ (GET /service)      │
└──────┬──────────────┘
       │
       ▼
    ┌──────┐
    │ 402? │────No───►┌──────────────┐
    └──┬───┘          │ Error /      │
       │              │ abort        │
      Yes             └──────────────┘
       │
       ▼
┌─────────────────────┐
│ Send Blockchain TX  │
│ (ETH transfer)      │
└──────┬──────────────┘
       │
       ▼
┌─────────────────────┐
│ Wait for            │
│ Confirmation        │
│ (15-30s)            │
└──────┬──────────────┘
       │
       ▼
┌──────────────────────────────┐
│ POST /service                │
│ {requestId, txHash, network, │
│  payerAddress, prompt}       │
└──────┬───────────────────────┘
       │
       ▼
    ┌───────┐
    │ 200?  │───No───►┌──────────────────────┐
    └──┬────┘         │ 400/403/409/502/503  │
       │              │ handle the error     │
      Yes             └──────────────────────┘
       │
       ▼
┌──────────────────────────────┐
│ Content + proofToken         │
│ received in the SAME response│
└──────┬───────────────────────┘
       │
       ▼
┌──────────────────────────────┐
│ (optional --ack)             │
│ GET /service + X-Payment     │
│ → 200 authorized:true        │
└──────────────────────────────┘
```

### 4.3 Server State Machine - GET /service

```
┌─────────────┐
│   LISTEN    │
└──────┬──────┘
       │
       ▼
┌──────────────┐
│ X-Payment ?  │
└──┬────────┬──┘
  No      Yes
   │        │
   │        ▼
   │   ┌──────────────┐
   │   │ Find token   │
   │   └──┬────────┬──┘
   │  Found?     Missing / expired
   │      │          │
   │      ▼          ▼
   │  ┌──────────────────┐  ┌────────────────────────┐
   │  │ 200 OK           │  │ 403 Invalid or expired │
   │  │ authorized: true │  │     proof token        │
   │  └──────────────────┘  └────────────────────────┘
   ▼
┌─────────────────────┐
│ Generate requestId  │
│ Write to SQLite     │
│ Return 402          │
└─────────────────────┘
```

### 4.4 Server State Machine - POST /service

```
┌──────────────┐
│ X-Payment ?  │───Yes─►┌─────────────────────────┐
└──────┬───────┘        │ Redeem existing token   │
       │                │ (3.5) → 200 / 403 / 409 │
      No                └─────────────────────────┘
       │
       ▼
┌─────────────────────┐
│ Validate body (zod) │──Error───► 400 Validation error
└──────┬──────────────┘
       │
       ▼
┌─────────────────────┐
│ Find payment_req    │──Missing / expired──► 400 Invalid or expired
└──────┬──────────────┘                       payment request
       │
       ▼
┌─────────────────────┐
│ Replay check        │──Redeemed────► 400 Transaction already
│ (redeemed_tx_hashes)│                 redeemed
└──────┬──────────────┘
       │
       ▼
┌─────────────────────┐
│ Verify on Blockchain│──Invalid─────► 400 (see 6.2)
│ (JSON-RPC calls)    │
└──────┬──────────────┘
       │
       ▼
┌─────────────────────┐
│ Mark tx redeemed    │
│ Mint proofToken     │
└──────┬──────────────┘
       │
       ▼
┌─────────────────────┐
│ Daily spend cap?    │──Reached───► 503 + proofToken
└──────┬──────────────┘              (payment stands, token
       │                              stays unconsumed)
       ▼
┌─────────────────────┐
│ Consume token       │──Concurrent request──► 409
│ (consumed_at)       │
└──────┬──────────────┘
       │
       ▼
┌─────────────────────┐
│ Call the service    │──Service error────► 502 + proofToken
│ 200 OK: content +   │
│ proofToken          │
└─────────────────────┘
```

---

## 5. BLOCKCHAIN VERIFICATION PROTOCOL

### 5.1 Verification Steps

While handling `POST /service` the server performs the following steps:

**Step 1: Retrieve Transaction**
```javascript
provider.getTransaction(txHash)
```

**Step 2: Retrieve Receipt**
```javascript
provider.getTransactionReceipt(txHash)
```

**Step 3: Confirmations (only if `MIN_CONFIRMATIONS > 1`)**
```javascript
provider.getBlockNumber()   // confirmations = latest - receipt.blockNumber + 1
```

**Step 4: Validation Checks**

| Check | Condition | Expected | Response on failure |
|-------|-----------|----------|---------------------|
| Payment request exists | `payment_requests` holds `requestId` and it has not expired | true | 400 `Invalid or expired payment request` |
| Replay | `redeemed_tx_hashes` does not hold `txHash` | true | 400 `Transaction already redeemed` |
| Transaction exists | `tx !== null` | true | 400 `Transaction verification failed` / `Transaction not found` |
| Receipt exists | `receipt !== null` | true | 400 `Transaction verification failed` / `Transaction not confirmed yet` |
| Confirmations | `latest - blockNumber + 1 >= MIN_CONFIRMATIONS` | true | 400 `Transaction verification failed` / `Only N/M confirmations` |
| Status | `receipt.status === 1` | 1 (success) | 400 `Transaction failed on chain` |
| Recipient | `tx.to == paymentRequest.recipient` | same address | 400 `Invalid recipient` |
| Payer (declared) | `tx.from == payerAddress` | same address | 400 `Payer mismatch` |
| Payer (bound at the 402) | `payment_requests.payer_address == payerAddress` | same address | 400 `Payer mismatch with original request` |
| Amount | `tx.value >= parseEther(amount_eth)` | sufficient amount | 400 `Insufficient amount` |

Address comparisons are case-insensitive (`toLowerCase()`), and `txHash` is normalised to lowercase before the replay check.

### 5.2 Transaction Validation Algorithm

```
FUNCTION handleMergedExchange(body):

  // 1. Validate body (zod): requestId, txHash, network, payerAddress, prompt, model?
  IF invalid: RETURN 400 "Validation error"
  txHash = lowercase(body.txHash)

  // 2. Retrieve payment request (TTL enforced in DB layer)
  paymentRequest = db.getPaymentRequest(body.requestId)
  IF paymentRequest is NULL:
    RETURN 400 "Invalid or expired payment request"

  // 3. Replay protection
  IF db.isTxRedeemed(txHash):
    RETURN 400 "Transaction already redeemed"

  // 4. Read the transaction from the chain (or fabricate it if MOCK_VERIFY)
  verification = verifyTransactionOnChain(txHash)   // getTransaction + getTransactionReceipt
                                                    // + optional confirmation depth check
  IF NOT verification.verified:
    RETURN 400 "Transaction verification failed", message = verification.error

  tx = verification.tx

  // 5. Status, recipient, payer, amount
  IF tx.status != 1:                     RETURN 400 "Transaction failed on chain"
  IF tx.to != paymentRequest.recipient:  RETURN 400 "Invalid recipient"
  IF tx.from != body.payerAddress:       RETURN 400 "Payer mismatch"
  IF paymentRequest.payer_address AND paymentRequest.payer_address != body.payerAddress:
                                         RETURN 400 "Payer mismatch with original request"
  IF tx.value < parseEther(paymentRequest.amount_eth):
                                         RETURN 400 "Insufficient amount"

  // 6. Mint proof + mark the tx as redeemed
  proofToken = "proof_" + generateUUID()
  db.markTxRedeemed(txHash, requestId)
  db.createProof({ proofToken, requestId, txHash: tx.hash, blockNumber: tx.blockNumber,
                   payerAddress: tx.from, recipient: tx.to,
                   amountEth: formatEther(tx.value), ttlSeconds: PROOF_TOKEN_TTL_SECONDS })
  // race on the PRIMARY KEY of redeemed_tx_hashes → 400 "Transaction already redeemed"

  // 7. Daily spending cap: payment stands, hand the token back for later redemption
  IF db.getTodayOpenAISpend() >= OPENAI_DAILY_USD_CAP:
    RETURN 503 "Service temporarily unavailable", proofToken

  // 8. Single use: consume the token BEFORE doing the paid work
  IF NOT db.consumeProof(proofToken):
    RETURN 409 "Proof token consumed concurrently"

  // 9. Deliver the content and the proof in ONE response
  RETURN 200 { success, response, model, usage, proofToken, expiresInSeconds, payment }
```

### 5.3 MOCK_VERIFY (control condition)

When `MOCK_VERIFY=true` (and the server is not running in production, or `FORCE_MOCK=1` is set), the server **skips reading the chain** and assembles a synthetic transaction from the payment request data (`blockNumber: 0`). Every other check (payment request, replay, single use of the token) stays in force, and the HTTP flow and message shapes are identical to real mode. The mode exists for traffic capture and measurements without spending testnet funds; it is **not** safe for public use.

---

## 6. ERROR CODES

### 6.1 HTTP Status Codes

| Code | Name | When |
|------|------|------|
| **200** | OK | Successful merged exchange, successful token redemption, or authorisation acknowledgement |
| **400** | Bad Request | Validation error, expired/unknown payment request, failed transaction verification, replay |
| **402** | Payment Required | `GET /service` without an `X-Payment` header |
| **403** | Forbidden | Invalid/expired proof token; already redeemed token |
| **409** | Conflict | The token was consumed concurrently by another request |
| **429** | Too Many Requests | Rate limit exceeded (`express-rate-limit`) |
| **500** | Internal Server Error | Unexpected exception (global error handler) |
| **502** | Bad Gateway | The payment is valid but the external service returned an error |
| **503** | Service Unavailable | Daily spending cap reached; `GET /health` when the RPC or the database is unreachable |

### 6.2 Application Error Messages

All error responses are JSON. The `error` field is a short machine-readable reason; `message` (where present) is a human-readable explanation.

#### Request validation

```json
{
  "error": "Validation error",
  "details": { "formErrors": [], "fieldErrors": { "txHash": ["Invalid transaction hash"] } }
}
```

`details` is the `zod` output (`error.flatten()`).

#### Payment request and replay

```json
{ "error": "Invalid or expired payment request" }
```
```json
{ "error": "Transaction already redeemed" }
```

#### Transaction verification

```json
{
  "error": "Transaction verification failed",
  "message": "Transaction not confirmed yet"
}
```

**Possible `message` values:**
- `"Transaction not found"` - the `txHash` does not exist on chain
- `"Transaction not confirmed yet"` - the transaction is not in a block yet (no receipt)
- `"Only N/M confirmations"` - too few confirmations for `MIN_CONFIRMATIONS`
- the exception message from the library or the RPC node

**Separate responses once the transaction has been read successfully:**
```json
{ "error": "Transaction failed on chain" }
```
```json
{ "error": "Invalid recipient" }
```
```json
{
  "error": "Payer mismatch",
  "message": "The transaction sender does not match the declared payer address"
}
```
```json
{ "error": "Payer mismatch with original request" }
```
```json
{
  "error": "Insufficient amount",
  "message": "Needed 0.0001 ETH, got 0.00005 ETH"
}
```

#### Proof token

```json
{ "error": "Invalid or expired proof token" }
```
```json
{ "error": "Proof token already consumed" }
```
```json
{ "error": "Proof token consumed concurrently" }
```

#### Spending cap and external service error

```json
{
  "error": "Service temporarily unavailable",
  "message": "Daily AI usage limit reached. Your payment is valid — redeem the proof token later.",
  "proofToken": "proof_<uuid>",
  "expiresInSeconds": 600
}
```

```json
{
  "error": "AI service error",
  "message": "The AI provider returned an error. Your payment is valid but the response could not be generated.",
  "proofToken": "proof_<uuid>",
  "payment": { "verified": true, "txHash": "0x...", "blockNumber": 12345678 }
}
```

In both cases the payment is already on record, so the response carries a proof token. With **503** the token is issued but **not** yet consumed - the client can redeem it later using the procedure in 3.5. With **502** the token was consumed before the service call, so it cannot be redeemed again; it only serves as proof that the payment was made.

#### Unexpected error

```json
{ "error": "Internal server error" }
```

---

## 7. SECURITY CONSIDERATIONS

### 7.1 Request ID Security

- **Uniqueness:** UUID v4 ensures 2^122 possible values (collision probability ≈ 0)
- **Unpredictability:** Cryptographically random, impossible to guess
- **Expiration:** `PAYMENT_REQUEST_TTL_SECONDS` (default 1800 s); expired rows are deleted by a periodic cleaner (every 60 s)
- **Payer binding:** if a valid `X-Payer` was supplied when the 402 was issued, the payment request is bound to that address

### 7.2 Proof Token Security

- **Format:** `"proof_"` prefix + UUID v4
- **Storage:** SQLite (`payment_proofs`), so it survives a server restart
- **Lifetime:** `PROOF_TOKEN_TTL_SECONDS` (default 600 s)
- **Single use:** the `consumed_at IS NULL` condition is part of the `UPDATE` statement, so only one request can consume the token; a concurrent one gets 409
- **Validation:** Server-side only, the client cannot forge one
- **Bearer credential:** whoever intercepts the token can redeem it - which is why TLS is mandatory for public use

### 7.3 Replay Protection

- Each `txHash` can be redeemed **only once**: the primary key of the `redeemed_tx_hashes` table
- The hash is normalised to lowercase before the check, so a different-case bypass is impossible
- A race between two simultaneous requests is caught by the primary key violation (`SQLITE_CONSTRAINT_PRIMARYKEY` → 400 `Transaction already redeemed`)

### 7.4 Blockchain Security

- **Immutability:** Transactions are irreversible
- **Public Verification:** Anyone can check the TX in a public block explorer
- **No Chargebacks:** A payment cannot be undone
- **Gas Fees:** The client pays gas (an additional cost)
- **Confirmation Depth:** `MIN_CONFIRMATIONS` (default 1) sets how many blocks deep the transaction must be

### 7.5 Transport and Application Security

**Recommendation:** HTTPS (TLS 1.2+) for all HTTP communication

```
Client ◄─────TLS encrypted─────► Server
```

The test environment runs over plain HTTP because the traffic has to stay readable for the Wireshark capture. A TLS-terminating reverse proxy is included for public deployment.

Additional mechanisms in the implementation:
- **`helmet`** with CSP (allowed script sources and `connect-src` for RPC nodes)
- **CORS** - restricted in production by the `ALLOWED_ORIGINS` list
- **Rate limiting** - `GET /service` 30 requests/min by default, `POST /service` 10 requests/min (60 s window)
- **Request body limit** - 64 kB
- **Input validation** - `zod` schemas before any database or chain access
- **Daily cost cap** - `OPENAI_DAILY_USD_CAP` guards against draining the funds for the external service
- **Redacting logger** - `pino` strips private keys and authorisation headers from the log

---

## 8. PERFORMANCE CHARACTERISTICS

### 8.1 Latency

Indicative values (they depend on the network, the RPC node and the external service):

| Operation | Latency | Notes |
|-----------|---------|-------|
| GET /service (no token) | ~10 ms | writes the payment request to SQLite |
| Blockchain TX confirmation | 15-30 s | depends on the network, happens outside HTTP |
| POST /service (merged exchange) | ~0.5 s + service time | 2-3 JSON-RPC calls, then the paid service call |
| POST /service (`MOCK_VERIFY`) | ~10 ms | no chain read |
| GET /service (with X-Payment) | ~5 ms | SQLite query |

### 8.2 Effect of Merging

| Design | Request/response pairs | HTTP messages |
|--------|------------------------|---------------|
| Separate verification and delivery | 3 | 6 |
| **Merged exchange (this implementation)** | **2** | **4** |
| Merged exchange + optional `--ack` | 3 | 6 |

Merging saves one full HTTP round trip and one pass through the rate limiter; it does not reduce the number of verification calls to the chain.

### 8.3 Throughput

- **RPC Rate Limits:** public nodes cap the number of requests; verification spends 2-3 calls
- **Server Capacity:** bounded by the RPC and the external service rather than by server CPU
- **Proof/Request Lookup:** indexed SQLite queries, no bottleneck

### 8.4 Scalability

**Current implementation:**
- SQLite (WAL) on the local disk: a single server instance
- State survives a restart
- No horizontal scaling

**Production Recommendations:**
- A shared database (e.g. PostgreSQL) or Redis for proof tokens across several instances
- Load balancer for multiple instances
- A private/paid RPC node instead of a public one

---

## 9. PROTOCOL EXTENSIONS (Future)

The extensions below are **not implemented**; they are listed as possible follow-up work.

### 9.1 Subscription Support

Enables payment for a period of time (e.g. 30 days of access):

```json
{
  "payment": {
    "type": "subscription",
    "duration": 2592000,
    "expiresAt": "2026-02-08T12:00:00Z"
  }
}
```

### 9.2 Refund Protocol

Reverse a payment when something goes wrong:

```json
POST /refund
{
  "proofToken": "proof_...",
  "reason": "Service unavailable"
}
```

### 9.3 Multi-Currency Support

```json
{
  "payment": {
    "options": [
      { "currency": "ETH", "amount": "0.0001" },
      { "currency": "USDC", "amount": "0.25" }
    ]
  }
}
```

---

## 10. COMPLIANCE

### 10.1 Standards Compliance

✅ **RFC 2616 / RFC 7231** - HTTP/1.1 402 status code  
✅ **RFC 8259** - JSON format  
✅ **RFC 4122** - UUID v4 generation  
✅ **Ethereum JSON-RPC** - Standard blockchain calls  

### 10.2 Best Practices

✅ RESTful API design (one resource, two methods)  
✅ Stateless HTTP (state only in payment requests and tokens)  
✅ Idempotent operations where possible (a repeated `txHash` is rejected)  
✅ Clear error messages  
✅ Structured logging  

---

## 11. IMPLEMENTATION NOTES

**Programming Language:** JavaScript (Node.js 20+)  
**HTTP Framework:** Express.js 4.18+  
**Blockchain Library:** ethers.js v6.9+  
**Persistence:** better-sqlite3 (WAL)  
**Dependencies:** helmet, cors, express-rate-limit, zod, pino, uuid, dotenv, openai  

**Minimum Requirements:**
- Node.js >= 20.0
- Internet connection (RPC access)
- Ethereum wallet (client)
- ETH for gas fees (client)

**File structure covered by this specification:**

```
server/server.js   HTTP interface: 402, merged exchange, acknowledgement, /config, /health
server/db.js       SQLite: payment_requests, payment_proofs, redeemed_tx_hashes, openai_usage
server/public/     web client (MetaMask), runs the same flow
client/run.js      CLI client (mock and real mode, --ack flag)
```

---

## 12. REFERENCES

[1] RFC 2616 - HTTP/1.1 Protocol (Section 10.4.3)  
[2] RFC 7231 - HTTP/1.1 Semantics (Section 6.5.2)  
[3] RFC 8259 - JSON Data Interchange Format  
[4] RFC 4122 - UUID Generation Algorithm  
[5] Ethereum JSON-RPC Specification - https://ethereum.org/en/developers/docs/apis/json-rpc/  
[6] Ethereum Yellow Paper - Technical Specification  

---

## 13. VERSION HISTORY

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | January 2026 | Initial specification (separate verification and delivery, 3 message pairs) |
| 2.0 | August 2026 | Merged exchange: `POST /service` verifies the payment **and** delivers the content; the flow is shortened to 2 pairs (4 messages); `GET /service` with `X-Payment` becomes an optional acknowledgement; persistent SQLite storage, replay protection, single-use proof tokens |

---

## 14. AUTHOR

**Name:** Tim Heinzer  
**Date:** August 2026  

---

**End of Specification Document**
