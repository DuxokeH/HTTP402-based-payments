# X402 Payment Protocol - Protocol Specification
**Version:** 2.0  
**Date:** Avgust 2026  
**Author:** Tim Heinzer  

> 🚀 **Za deployment navodila, instalacijo, troubleshooting in praktične primere glej:** [README.md](../README.md)

---

## 1. UVOD

### 1.1 Namen Dokumenta

Ta dokument opisuje formalno specifikacijo X402 Payment Protocol - razširitve HTTP/1.1 protokola za podporo blockchain-based plačil. Protokol implementira HTTP status kodo 402 (Payment Required), ki je bila rezervirana v RFC 2616 in RFC 7231, vendar do sedaj ni bila standardizirana.

Specifikacija opisuje **dejansko implementacijo** v tem repozitoriju (`server/server.js`, `server/db.js`, `klient/run.js`, `server/public/app.js`).

### 1.2 Obseg

Specifikacija pokriva:
- HTTP message format (združena izmenjava: verifikacija + dostava)
- Payment request/response strukture
- Blockchain verification mehanizme
- State machine za payment flow
- Error handling

### 1.3 Standardi

- **RFC 2616** - HTTP/1.1 Protocol
- **RFC 7231** - HTTP/1.1 Semantics (Section 6.5.2 - 402 Payment Required)
- **RFC 8259** - JSON Data Interchange Format
- **RFC 4122** - UUID Generation
- **Ethereum JSON-RPC** - Blockchain Interface Specification

---

## 2. ARHITEKTURA PROTOKOLA

### 2.1 Komponente

```
┌─────────────┐                          ┌──────────────────┐
│             │      HTTP/HTTPS          │                  │
│   KLIENT    │◄─────────────────────────►│  HOSTING SERVER  │
│ (Uporabnik) │                          │   (Merchant)     │
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

**End-to-End Princip:**
- Samo 2 aktivne komponente (klient, server)
- Blockchain = pasivna javna knjiga
- Ni posrednikov (facilitatorjev)
- Direktna verifikacija

### 2.2 Protokol Layers

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

### 2.3 Združena Izmenjava (Design Choice)

Implementacija **združi verifikacijo plačila in dostavo vsebine v isto izmenjavo**. Strežnik ima za plačljivo storitev samo dve metodi na isti poti:

- `GET /service` → izda plačilno zahtevo (402),
- `POST /service` → preveri transakcijo na verigi **in** v istem odgovoru vrne vsebino ter dokazni žeton.

Na žici zato nastaneta **2 para zahteva/odgovor = 4 sporočila HTTP**:

```
1. C → S   GET  /service                                   (zahteva vira)
2. S → C   402  Payment Required   {payment: {...}}         (račun)
   ─────── klient pošlje transakcijo na Sepolio, dobi txHash ───────
3. C → S   POST /service  {requestId, txHash, network,
                           payerAddress, prompt}            (dokazilo + zahteva)
4. S → C   200  OK        {response, proofToken, payment}   (vsebina + žeton)
```

Ločenega vira, ki bi plačilo samo preveril in vrnil žeton (klient pa bi moral vsebino zahtevati še s tretjo izmenjavo), strežnik **ne izpostavlja**. Zasnova z ločeno verifikacijo bi potrebovala tri pare (6 sporočil); združena jih potrebuje dva (4 sporočila), torej **eno celotno HTTP povratno pot manj**, klient pa dobi vsebino takoj, ko je plačilo potrjeno.

**Neobvezni tretji par (`--ack`):** klient lahko po prejemu žetona pošlje še `GET /service` z glavo `X-Payment`. Ta izmenjava samo potrdi, da je plačilo avtorizirano; **ni** del obveznega poteka in ne dostavi vsebine.

### 2.4 Vmesnik HTTP (celoten seznam virov)

| Metoda | Pot | Namen |
|--------|-----|-------|
| `GET` | `/service` | brez glave `X-Payment`: izda 402 s plačilno zahtevo; z veljavno glavo: potrdi avtorizacijo |
| `POST` | `/service` | združena izmenjava (verifikacija + dostava); z glavo `X-Payment` unovči že izdan žeton |
| `GET` | `/config` | javna konfiguracija za spletni odjemalec (omrežje, cena, naslov prejemnika) |
| `GET` | `/health` | stanje strežnika, baze in povezave do vozlišča JSON-RPC |
| `GET` | `/` in statične datoteke | spletni odjemalec (`server/public/`) |

Drugih poti strežnik ne izpostavlja.

---

## 3. MESSAGE FORMAT SPECIFICATION

### 3.1 Sporočilo 1 in 2: HTTP 402 Payment Required

**Trigger:** Klient zahteva zaščiten vir brez glave `X-Payment`

**HTTP Request:**
```http
GET /service HTTP/1.1
Host: <merchant-server>
X-Payer: 0x<payerAddress>          ; neobvezno
```

Naslov plačnika lahko klient napove z glavo `X-Payer` ali s poizvedbenim parametrom `?payer=0x...`. Če je naslov veljaven, se **veže** na plačilno zahtevo in ga mora kasnejši `POST /service` ujeti (glej 5.2). Neveljaven naslov se tiho zavrže (zahteva ostane nevezana).

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

**Polja:**

| Polje | Tip | Obvezno | Opis |
|-------|-----|---------|------|
| `error` | string | Da | Kratek opis napake ("Payment Required") |
| `message` | string | Da | Čitljiv opis za uporabnika |
| `payment.requestId` | UUID v4 | Da | Unikaten identifikator zahteve |
| `payment.to` | Ethereum Address | Da | Naslov merchant denarnice (0x..., checksum oblika) |
| `payment.amount` | string | Da | Znesek v ETH (decimalni string, `SERVICE_PRICE_ETH`) |
| `payment.currency` | string | Da | Valuta ("ETH") |
| `payment.network` | string | Da | Blockchain network ("sepolia") |
| `payment.createdAt` | ISO 8601 | Da | Čas izdaje zahteve |
| `payment.expiresInSeconds` | number | Da | Veljavnost zahteve (`PAYMENT_REQUEST_TTL_SECONDS`, privzeto 1800) |

Plačilna zahteva se zapiše v tabelo `payment_requests` (SQLite) skupaj s prejemnikom, zneskom, omrežjem, morebitnim vezanim plačnikom in časom poteka.

**Validation Rules:**
- `requestId`: MUST be valid UUID v4 format
- `to`: MUST be valid Ethereum address (42 chars, 0x prefix)
- `amount`: MUST be positive decimal number
- `network`: MUST match server configuration (`NETWORK`)

---

### 3.2 Sporočilo 3: Združena Zahteva (verifikacija + dostava)

**Trigger:** Klient je poslal plačilno transakcijo na verigo in ima `txHash`

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
  "prompt": "<vprašanje za storitev>",
  "model": "gpt-4o-mini"
}
```

**Polja:**

| Polje | Tip | Obvezno | Opis |
|-------|-----|---------|------|
| `requestId` | UUID v4 | Da | ID iz prvotnega 402 response |
| `txHash` | string | Da | Ethereum transaction hash (`0x` + 64 hex znakov) |
| `network` | string | Da | MORA biti enak `NETWORK` strežnika (zod `literal`) |
| `payerAddress` | Ethereum Address | Da | Naslov, s katerega je bila transakcija poslana |
| `prompt` | string | Da | Vhod za plačljivo storitev, 1..`OPENAI_MAX_PROMPT_CHARS` (privzeto 4000) znakov |
| `model` | string | Ne | Želeni model; če ni v cenovniku strežnika, se uporabi privzeti (`OPENAI_MODEL`) |

**Validation Rules (zod, pred vsakim dostopom do verige):**
- `requestId`: MUST be valid UUID
- `txHash`: MUST match `^0x[0-9a-fA-F]{64}$`; strežnik ga pred uporabo pretvori v **male črke** (primarni ključ tabele `redeemed_tx_hashes` je občutljiv na velikost črk)
- `network`: MUST equal server `NETWORK`
- `payerAddress`: MUST be parsable by `ethers.getAddress()`
- `prompt`: MUST be non-empty and within the length limit

Telo zahteve je omejeno na **64 kB** (`express.json({ limit: '64kb' })`).

---

### 3.3 Sporočilo 4: Združen Odgovor (Success)

**HTTP Response:**
```http
HTTP/1.1 200 OK
Content-Type: application/json
Content-Length: <length>

{
  "success": true,
  "response": "<vsebina storitve>",
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

**Polja:**

| Polje | Tip | Opis |
|-------|-----|------|
| `success` | boolean | `true` ob uspešni verifikaciji in dostavi |
| `response` | string | Plačana vsebina (odgovor modela) |
| `model` | string | Uporabljeni model; `"demo"`, kadar `OPENAI_API_KEY` ni nastavljen |
| `usage` | object | Poraba žetonov modela (ni prisotno v demo načinu) |
| `proofToken` | string | Dokazni žeton, izdan v tej isti izmenjavi |
| `expiresInSeconds` | number | Veljavnost žetona (`PROOF_TOKEN_TTL_SECONDS`, privzeto 600) |
| `payment.verified` | boolean | Vedno `true` v uspešnem odgovoru |
| `payment.txHash` | string | Potrjen transaction hash |
| `payment.blockNumber` | number | Blok, v katerem je transakcija |

**Token Format:**
- `proofToken`: `"proof_"` + UUID v4
- Primer: `proof_a1b2c3d4-e5f6-7890-1234-567890abcdef`

**Demo način (brez `OPENAI_API_KEY`):** odgovor ima enako obliko, polje `usage` manjka, `model` je `"demo"`, `response` pa se začne z `[DEMO MODE — no OPENAI_API_KEY set]`. Potek HTTP je identičen.

**Pomembno:** žeton je v tej točki že **porabljen** (`consumed_at` je nastavljen pred klicem storitve). Klient ga ne potrebuje za dostop do te vsebine - dobi jo v istem odgovoru. Žeton služi kot dokazilo o plačilu (npr. za neobvezno potrditev iz 3.4).

---

### 3.4 Neobvezna Potrditev Avtorizacije (`--ack`)

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
- Žeton MORA obstajati v tabeli `payment_proofs`
- Žeton NE SME biti potekel (`expires_at > now`)

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

Polje `consumed` pove, ali je bil žeton že unovčen. Ta izmenjava **ne dostavi vsebine** in ne porabi žetona; potrjuje samo, da je plačilo opravljeno in evidentirano.

**Error Response:**
```http
HTTP/1.1 403 Forbidden

{ "error": "Invalid or expired proof token" }
```

---

### 3.5 Rezervna Izmenjava: Unovčenje Izdanega Žetona

Uporabi se, kadar klient že ima neporabljen žeton (npr. ker je združena izmenjava vrnila `503` zaradi dnevne omejitve porabe, plačilo pa je bilo veljavno).

**HTTP Request:**
```http
POST /service HTTP/1.1
Host: <merchant-server>
Content-Type: application/json
X-Payment: proof_<uuid>

{
  "prompt": "<vprašanje za storitev>",
  "model": "gpt-4o-mini"
}
```

V tej veji telo **ne** vsebuje `requestId`, `txHash`, `network` ali `payerAddress` - plačilo je bilo preverjeno že prej. Strežnik:

1. poišče žeton (`403 Invalid or expired proof token`, če ga ni ali je potekel),
2. zavrne že unovčen žeton (`403 Proof token already consumed`),
3. validira telo (`400 Validation error`),
4. preveri dnevno omejitev porabe (`503`),
5. **označi žeton kot porabljen pred** klicem storitve (`409`, če ga je vzporedna zahteva prehitela),
6. vrne enak odgovor kot v 3.3.

---

### 3.6 Pomožna Vira

**`GET /config`** - javna konfiguracija za spletni odjemalec:

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

**`GET /health`** - stanje strežnika (`200 ok` / `503 degraded`):

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

Poizvedba po zadnjem bloku ima 2-sekundni timeout; ob neuspehu sta `rpc: "down"` in `status: "degraded"` (HTTP 503).

---

## 4. STATE MACHINE

### 4.1 Sequence Diagram (obvezni potek)

```
KLIENT                    HOSTING SERVER                 SEPOLIA
  │                             │                            │
  │─(1) GET /service ──────────►│                            │
  │                             │ zapiši payment_request     │
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
  │                             │ preveri + izdaj žeton      │
  │                             │ pokliči storitev           │
  │◄─(4) 200 {response,         │                            │
  │      proofToken, payment} ──│                            │
  │                             │                            │
  │─ (neobvezno) GET + X-Payment ►│                          │
  │◄─ 200 {authorized:true} ────│                            │
```

### 4.2 Klient State Machine

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
    └──┬───┘          │ Napaka /     │
       │              │ prekini      │
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
       │              │ obravnavaj napako    │
      Yes             └──────────────────────┘
       │
       ▼
┌──────────────────────────────┐
│ Vsebina + proofToken         │
│ prejeta v ISTEM odgovoru     │
└──────┬───────────────────────┘
       │
       ▼
┌──────────────────────────────┐
│ (neobvezno --ack)            │
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
  Ne       Da
   │        │
   │        ▼
   │   ┌──────────────┐
   │   │ Poišči žeton │
   │   └──┬────────┬──┘
   │  Najden?    Ni / potekel
   │      │          │
   │      ▼          ▼
   │  ┌──────────────────┐  ┌────────────────────────┐
   │  │ 200 OK           │  │ 403 Invalid or expired │
   │  │ authorized: true │  │     proof token        │
   │  └──────────────────┘  └────────────────────────┘
   ▼
┌─────────────────────┐
│ Generate requestId  │
│ Zapiši v SQLite     │
│ Return 402          │
└─────────────────────┘
```

### 4.4 Server State Machine - POST /service

```
┌──────────────┐
│ X-Payment ?  │───Da──►┌─────────────────────────┐
└──────┬───────┘        │ Unovči obstoječi žeton  │
       │                │ (3.5) → 200 / 403 / 409 │
      Ne                └─────────────────────────┘
       │
       ▼
┌─────────────────────┐
│ Validate body (zod) │──Napaka──► 400 Validation error
└──────┬──────────────┘
       │
       ▼
┌─────────────────────┐
│ Poišči payment_req  │──Ni / potekel──► 400 Invalid or expired
└──────┬──────────────┘                  payment request
       │
       ▼
┌─────────────────────┐
│ Replay check        │──Že unovčen──► 400 Transaction already
│ (redeemed_tx_hashes)│                 redeemed
└──────┬──────────────┘
       │
       ▼
┌─────────────────────┐
│ Verify on Blockchain│──Neveljavno──► 400 (glej 6.2)
│ (JSON-RPC calls)    │
└──────┬──────────────┘
       │
       ▼
┌─────────────────────┐
│ Označi tx unovčen   │
│ Izdaj proofToken    │
└──────┬──────────────┘
       │
       ▼
┌─────────────────────┐
│ Dnevna meja porabe? │──Dosežena──► 503 + proofToken
└──────┬──────────────┘              (plačilo velja, žeton
       │                              ostane neporabljen)
       ▼
┌─────────────────────┐
│ Porabi žeton        │──Vzporedna zahteva──► 409
│ (consumed_at)       │
└──────┬──────────────┘
       │
       ▼
┌─────────────────────┐
│ Pokliči storitev    │──Napaka storitve──► 502 + proofToken
│ 200 OK: vsebina +   │
│ proofToken          │
└─────────────────────┘
```

---

## 5. BLOCKCHAIN VERIFICATION PROTOCOL

### 5.1 Verification Steps

Strežnik med obravnavo `POST /service` izvede naslednje korake:

**Step 1: Retrieve Transaction**
```javascript
provider.getTransaction(txHash)
```

**Step 2: Retrieve Receipt**
```javascript
provider.getTransactionReceipt(txHash)
```

**Step 3: Confirmations (samo če `MIN_CONFIRMATIONS > 1`)**
```javascript
provider.getBlockNumber()   // confirmations = latest - receipt.blockNumber + 1
```

**Step 4: Validation Checks**

| Check | Pogoj | Pričakovano | Odgovor ob napaki |
|-------|-------|-------------|-------------------|
| Payment request obstaja | `payment_requests` vsebuje `requestId` in ni potekel | true | 400 `Invalid or expired payment request` |
| Replay | `redeemed_tx_hashes` ne vsebuje `txHash` | true | 400 `Transaction already redeemed` |
| Transaction exists | `tx !== null` | true | 400 `Transaction verification failed` / `Transaction not found` |
| Receipt exists | `receipt !== null` | true | 400 `Transaction verification failed` / `Transaction not confirmed yet` |
| Confirmations | `latest - blockNumber + 1 >= MIN_CONFIRMATIONS` | true | 400 `Transaction verification failed` / `Only N/M confirmations` |
| Status | `receipt.status === 1` | 1 (success) | 400 `Transaction failed on chain` |
| Recipient | `tx.to == paymentRequest.recipient` | enak naslov | 400 `Invalid recipient` |
| Payer (deklariran) | `tx.from == payerAddress` | enak naslov | 400 `Payer mismatch` |
| Payer (vezan ob 402) | `payment_requests.payer_address == payerAddress` | enak naslov | 400 `Payer mismatch with original request` |
| Amount | `tx.value >= parseEther(amount_eth)` | zadosten znesek | 400 `Insufficient amount` |

Primerjave naslovov potekajo neobčutljivo na velikost črk (`toLowerCase()`), `txHash` pa se normalizira v male črke že pred preverjanjem ponovitve.

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

### 5.3 MOCK_VERIFY (kontrolni pogoj)

Če je `MOCK_VERIFY=true` (in strežnik ni v produkciji oz. je nastavljen `FORCE_MOCK=1`), strežnik **preskoči branje verige** in sestavi navidezno transakcijo iz podatkov plačilne zahteve (`blockNumber: 0`). Vse ostale kontrole (plačilna zahteva, ponovitev, enkratnost žetona) ostanejo v veljavi, potek in oblika sporočil HTTP pa sta identična realnemu načinu. Način je namenjen zajemu prometa in meritvam brez porabe testnih sredstev; **ni** varen za javno rabo.

---

## 6. ERROR CODES

### 6.1 HTTP Status Codes

| Code | Name | When |
|------|------|------|
| **200** | OK | Uspešna združena izmenjava, uspešno unovčenje žetona ali potrditev avtorizacije |
| **400** | Bad Request | Napaka validacije, potekla/neznana plačilna zahteva, neuspela verifikacija transakcije, ponovitev |
| **402** | Payment Required | `GET /service` brez glave `X-Payment` |
| **403** | Forbidden | Neveljaven/potekel dokazni žeton; že unovčen žeton |
| **409** | Conflict | Žeton je vzporedno porabila druga zahteva |
| **429** | Too Many Requests | Presežena omejitev pogostosti (`express-rate-limit`) |
| **500** | Internal Server Error | Nepričakovana izjema (globalni error handler) |
| **502** | Bad Gateway | Plačilo je veljavno, zunanja storitev pa je vrnila napako |
| **503** | Service Unavailable | Dosežena dnevna zgornja meja porabe; `GET /health` ob nedosegljivem RPC ali bazi |

### 6.2 Application Error Messages

Vsi napačni odgovori so JSON. Polje `error` je kratek strojno berljiv razlog, `message` (kadar je prisoten) pa človeku namenjeno pojasnilo.

#### Validacija zahteve

```json
{
  "error": "Validation error",
  "details": { "formErrors": [], "fieldErrors": { "txHash": ["Invalid transaction hash"] } }
}
```

`details` je izpis `zod` (`error.flatten()`).

#### Plačilna zahteva in ponovitev

```json
{ "error": "Invalid or expired payment request" }
```
```json
{ "error": "Transaction already redeemed" }
```

#### Verifikacija transakcije

```json
{
  "error": "Transaction verification failed",
  "message": "Transaction not confirmed yet"
}
```

**Možne vrednosti `message`:**
- `"Transaction not found"` - `txHash` ne obstaja na verigi
- `"Transaction not confirmed yet"` - transakcija še ni v bloku (ni potrdila)
- `"Only N/M confirmations"` - premalo potrditev glede na `MIN_CONFIRMATIONS`
- sporočilo izjeme knjižnice/RPC vozlišča

**Ločeni odgovori po uspešnem branju transakcije:**
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

#### Dokazni žeton

```json
{ "error": "Invalid or expired proof token" }
```
```json
{ "error": "Proof token already consumed" }
```
```json
{ "error": "Proof token consumed concurrently" }
```

#### Omejitev porabe in napaka zunanje storitve

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

V obeh primerih je plačilo že evidentirano, zato odgovor vsebuje dokazni žeton. Pri **503** je žeton izdan, a še **ni** porabljen - klient ga lahko unovči kasneje po postopku iz 3.5. Pri **502** je bil žeton porabljen že pred klicem storitve, zato ponovno unovčenje ni mogoče; služi le kot dokazilo o opravljenem plačilu.

#### Nepričakovana napaka

```json
{ "error": "Internal server error" }
```

---

## 7. SECURITY CONSIDERATIONS

### 7.1 Request ID Security

- **Uniqueness:** UUID v4 ensures 2^122 possible values (collision probability ≈ 0)
- **Unpredictability:** Cryptographically random, ni mogoče predvideti
- **Expiration:** `PAYMENT_REQUEST_TTL_SECONDS` (privzeto 1800 s); potekle vrstice pobriše periodični čistilec (vsakih 60 s)
- **Vezava na plačnika:** če je bil ob izdaji 402 podan veljaven `X-Payer`, se plačilna zahteva veže nanj

### 7.2 Proof Token Security

- **Format:** `"proof_"` prefix + UUID v4
- **Storage:** SQLite (`payment_proofs`), torej preživi ponovni zagon strežnika
- **Lifetime:** `PROOF_TOKEN_TTL_SECONDS` (privzeto 600 s)
- **Enkratnost:** pogoj `consumed_at IS NULL` je del stavka `UPDATE`, zato lahko žeton porabi le ena zahteva; vzporedna dobi 409
- **Validation:** Server-side only, klient ne more ponarejati
- **Bearer credential:** kdor prestreže žeton, ga lahko unovči - zato je TLS obvezen za javno rabo

### 7.3 Replay Protection

- Vsak `txHash` je lahko unovčen **samo enkrat**: primarni ključ tabele `redeemed_tx_hashes`
- Hash se pred preverjanjem normalizira v male črke, da obhod z drugačno velikostjo črk ni mogoč
- Tekmovanje med hkratnima zahtevama ujame kršitev primarnega ključa (`SQLITE_CONSTRAINT_PRIMARYKEY` → 400 `Transaction already redeemed`)

### 7.4 Blockchain Security

- **Immutability:** Transakcije so ireverzibilne
- **Public Verification:** Vsak lahko preveri TX na javnem raziskovalcu blokov
- **No Chargebacks:** Plačilo ni mogoče razveljaviti
- **Gas Fees:** Klient plača gas (dodatni strošek)
- **Confirmation Depth:** `MIN_CONFIRMATIONS` (privzeto 1) določa, koliko blokov globoko mora biti transakcija

### 7.5 Transport in Aplikacijska Zaščita

**Recommendation:** HTTPS (TLS 1.2+) za vso HTTP komunikacijo

```
Client ◄─────TLS encrypted─────► Server
```

Testno okolje teče po navadnem HTTP, ker mora biti promet berljiv za zajem z Wiresharkom. Za javno postavitev je priložen obratni posrednik s TLS.

Dodatni mehanizmi v implementaciji:
- **`helmet`** s CSP (dovoljeni viri skript in `connect-src` za RPC vozlišča)
- **CORS** - v produkciji omejen s seznamom `ALLOWED_ORIGINS`
- **Rate limiting** - `GET /service` privzeto 30 zahtev/min, `POST /service` 10 zahtev/min (okno 60 s)
- **Omejitev telesa zahteve** - 64 kB
- **Validacija vhodov** - `zod` sheme pred vsakim dostopom do baze ali verige
- **Dnevna zgornja meja stroškov** - `OPENAI_DAILY_USD_CAP` ščiti pred izčrpanjem sredstev za zunanjo storitev
- **Beleženje z redakcijo** - `pino` odstrani zasebne ključe in avtorizacijske glave iz dnevnika

---

## 8. PERFORMANCE CHARACTERISTICS

### 8.1 Latency

Okvirne vrednosti (odvisne od omrežja, RPC vozlišča in zunanje storitve):

| Operation | Latency | Notes |
|-----------|---------|-------|
| GET /service (brez žetona) | ~10 ms | vpis plačilne zahteve v SQLite |
| Blockchain TX confirmation | 15-30 s | odvisno od omrežja, poteka izven HTTP |
| POST /service (združena izmenjava) | ~0,5 s + čas storitve | 2-3 klici JSON-RPC, nato klic plačljive storitve |
| POST /service (`MOCK_VERIFY`) | ~10 ms | brez branja verige |
| GET /service (z X-Payment) | ~5 ms | poizvedba v SQLite |

### 8.2 Učinek Združitve

| Zasnova | Pari zahteva/odgovor | Sporočila HTTP |
|---------|----------------------|----------------|
| Ločena verifikacija in dostava | 3 | 6 |
| **Združena izmenjava (ta implementacija)** | **2** | **4** |
| Združena izmenjava + neobvezni `--ack` | 3 | 6 |

Združitev prihrani eno celotno povratno pot HTTP in en prehod skozi omejevalnik pogostosti; verifikacijskih klicev na verigo ne zmanjša.

### 8.3 Throughput

- **RPC Rate Limits:** javna vozlišča omejujejo število zahtev; verifikacija porabi 2-3 klice
- **Server Capacity:** omejuje predvsem RPC in zunanja storitev, ne CPU strežnika
- **Proof/Request Lookup:** indeksirane poizvedbe SQLite, brez ozkega grla

### 8.4 Scalability

**Trenutna implementacija:**
- SQLite (WAL) na lokalnem disku: ena instanca strežnika
- Stanje preživi ponovni zagon
- Ni horizontalnega skaliranja

**Production Recommendations:**
- Skupna baza (npr. PostgreSQL) ali Redis za dokazne žetone pri več instancah
- Load balancer za multiple instances
- Zasebno/plačljivo RPC vozlišče namesto javnega

---

## 9. PROTOCOL EXTENSIONS (Future)

Naslednje razširitve **niso implementirane** in so navedene kot možna nadaljevanja.

### 9.1 Subscription Support

Omogoči plačilo za časovno obdobje (npr. 30 dni dostopa):

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

Reverse payment v primeru napake:

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

✅ RESTful API design (en vir, dve metodi)  
✅ Stateless HTTP (stanje samo v plačilnih zahtevah in žetonih)  
✅ Idempotent operations kjer mogoče (ponovitev `txHash` je zavrnjena)  
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
- Ethereum wallet (klient)
- ETH za gas fees (klient)

**Datotečna struktura, ki jo pokriva ta specifikacija:**

```
server/server.js   HTTP vmesnik: 402, združena izmenjava, potrditev, /config, /health
server/db.js       SQLite: payment_requests, payment_proofs, redeemed_tx_hashes, openai_usage
server/public/     spletni odjemalec (MetaMask), izvede isti potek
klient/run.js      odjemalec CLI (mock in realni način, zastavica --ack)
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
| 1.0 | Januar 2026 | Initial specification (ločena verifikacija in dostava, 3 pari sporočil) |
| 2.0 | Avgust 2026 | Združena izmenjava: `POST /service` preveri plačilo **in** dostavi vsebino; potek skrajšan na 2 para (4 sporočila); `GET /service` z `X-Payment` postane neobvezna potrditev; trajno shranjevanje v SQLite, zaščita pred ponovitvijo, enkratni dokazni žetoni |

---

## 14. AUTHOR

**Name:** Tim Heinzer  
**Date:** Avgust 2026  

---

**End of Specification Document**
