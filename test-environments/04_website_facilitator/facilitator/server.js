'use strict';

/**
 * ============================================================================
 *  X402 FACILITATOR — topology (b)
 *  (folder 04_website_facilitator/facilitator)
 * ============================================================================
 *
 *  The only component in this folder that has a chain connection (JSON-RPC).
 *  The merchant (`../server/server.js`) is deliberately WITHOUT a `JsonRpcProvider` —
 *  that is exactly what topology (b) requires: ONLY the facilitator has JSON-RPC.
 *
 *  The facilitator protocol of this branch:
 *
 *    C -> M   GET  /resource                     (no payment)
 *    M -> F   POST /payment-request              → 201 {requestId, paymentInfo}
 *    M -> C   402 Payment Required               {requestId, to, amount, facilitatorUrl}
 *    C -> B   payment transaction                (payer pays their own gas)
 *    C -> F   POST /submit-payment {requestId, txHash}
 *    F -> B   getTransaction + getTransactionReceipt
 *    F -> C   200 {proof.token}
 *    C -> M   GET /resource + X-Payment: token
 *    M -> F   POST /verify-proof {token}         → 200 {verified: true}
 *    M -> C   200 content
 *
 *  = 5 exchanges / 10 messages / 3 relationships (vs 3 / 6 / 2 in the direct implementation).
 *
 *  NOTE — this is NOT the official x402 protocol (`verify` + `settle`). Official
 *  x402 sends the facilitator a signed EIP-3009 authorization and the FACILITATOR
 *  pays the gas; here the payer pays the gas themselves and the facilitator only
 *  READS the chain. The reasons for this choice are in `../README.md`; EIP-3009
 *  remains future work.
 *
 *  Five bugs of the old implementation fixed
 *  (`experiments/legacy/server-only/facilitator-server/facilitator.js`):
 *    1. the proof token is now CONSUMED (single use, TTL 600 s)
 *    2. the same transaction cannot redeem two payment requests
 *    3. amounts are compared as BigInt wei, not via `parseFloat`
 *    4. `MIN_CONFIRMATIONS` is actually enforced, not merely documented
 *    5. merchant authentication, limiting of chain read calls, configurable
 *       port and durable storage (SQLite) instead of in-memory `Map`s
 * ============================================================================
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { ethers } = require('ethers');
const path = require('path');
const { performance } = require('perf_hooks');
const { v4: uuidv4 } = require('uuid');
const pino = require('pino');
const { z } = require('zod');

const db = require('./db');
// Official x402 v2 — the facilitator also becomes a REAL x402 facilitator (X402_MODE=self:
// THIS process holds the settlement key and the only chain access, and pays the gas).
// The custom protocol (/payment-request → /submit-payment → /verify-proof) stays
// UNTOUCHED — it is the measured baseline; the x402 routes live in parallel under /x402/*.
const x402 = require('./x402');
const dbx = x402.enabled ? require('./db_x402') : null;
const authLib = require('./auth');

// ── settings ─────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.FACILITATOR_PORT || '4000', 10);
const NETWORK = process.env.NETWORK || 'sepolia';
const RPC_URL = process.env.RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';
// `MOCK_FACILITATOR` is the name from the design plan, while `MOCK_VERIFY` is the name
// used by the rest of the `measurements/` package. We accept both, so that a single
// `MOCK_VERIFY=true` in the environment puts both processes of this branch
// (facilitator and merchant) into mock mode.
const MOCK_VERIFY = (process.env.MOCK_VERIFY === 'true' || process.env.MOCK_FACILITATOR === 'true')
  && (!IS_PROD || process.env.FORCE_MOCK === '1');
const MIN_CONFIRMATIONS = parseInt(process.env.MIN_CONFIRMATIONS || '1', 10);

const PROOF_TTL = parseInt(process.env.PROOF_TOKEN_TTL_SECONDS || '600', 10);
const REQ_TTL = parseInt(process.env.PAYMENT_REQUEST_TTL_SECONDS || '1800', 10);
const DEBIT_MAX_AGE_MS = parseInt(process.env.DEBIT_MAX_AGE_MS || '120000', 10);
const SESSION_TTL_DEFAULT = parseInt(process.env.SESSION_TTL_DEFAULT || '3600', 10);
const SESSION_TTL_MAX = parseInt(process.env.SESSION_TTL_MAX || '86400', 10);

// Reading the chain is the only expensive part of the facilitator. We cap the number
// of CONCURRENT read calls; the excess gets an immediate 429 and does NOT pile up in a
// queue (the same principle as for login in `auth.js`: flooding must not crowd out
// honest requests). The limit is deliberately NOT tied to the IP — see `../../docs/IDENTITY.md`.
const MAX_CHAIN_READS_IN_FLIGHT = parseInt(process.env.MAX_CHAIN_READS_IN_FLIGHT || '8', 10);
let chainReadsInFlight = 0;

const logger = pino({
  level: process.env.LOG_LEVEL || (IS_PROD ? 'info' : 'debug'),
  ...(IS_PROD ? {} : { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } } })
});

// The facilitator has NO wallet. It sends no transactions and receives no funds —
// it takes the recipient from the payment request the merchant opened. This is exactly
// the "one service verifies payments for multiple merchants" primitive.
const provider = new ethers.JsonRpcProvider(RPC_URL);

// ── validation ───────────────────────────────────────────────────────────────
const txHashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const weiSchema = z.string().regex(/^\d{1,32}$/);
const addressSchema = z.string().refine(v => { try { ethers.getAddress(v); return true; } catch { return false; } });
const uuidSchema = z.string().uuid();

const requestSchema = z.object({
  resource: z.string().min(1).max(200),
  recipient: addressSchema,
  amountWei: weiSchema,
  currency: z.string().min(1).max(16).optional(),
  network: z.string().min(1).max(32).optional(),
  payerAddress: addressSchema.nullable().optional(),
  ttlSeconds: z.number().int().positive().max(86400).optional()
});
const submitSchema = z.object({
  requestId: uuidSchema,
  txHash: txHashSchema,
  payerAddress: addressSchema,
  network: z.string().min(1).max(32).optional(),
  mockValueWei: weiSchema.optional()
});
const proofSchema = z.object({
  token: z.string().min(8).max(120),
  resource: z.string().min(1).max(200).optional(),
  consume: z.boolean().optional()
});
const openSchema = z.object({
  txHash: txHashSchema,
  payerAddress: addressSchema,
  resource: z.string().min(1).max(200),
  recipient: addressSchema,
  budgetWei: weiSchema.optional(),
  ttlSeconds: z.number().int().positive().optional(),
  mockDepositWei: weiSchema.optional()
});
const debitSchema = z.object({
  sessionId: z.string().min(8).max(120),
  payer: addressSchema,
  nonce: z.string().min(4).max(120),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
  path: z.string().min(1).max(200),
  maxWei: weiSchema,
  priceWei: weiSchema,
  bytes: z.number().int().nonnegative().max(10_000_000).optional()
});

// ── application ──────────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('Access-Control-Expose-Headers', 'X-Server-Ms, X-Chain-Read-Ms, X-Request-Id, X-Charged-Wei, X-Balance-Wei, X-Budget-Remaining-Wei');
  next();
});
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      // The only HTML the facilitator serves is the login page from `auth.js`;
      // its styling lives in an embedded `<style>` and it has no scripts.
      'script-src': ["'none'"],
      'style-src': ["'self'", "'unsafe-inline'"],
      ...(IS_PROD ? {} : { 'upgrade-insecure-requests': null })
    }
  }
}));
// The payer (a browser on the merchant's page) sends `POST /submit-payment`
// DIRECTLY to the facilitator — that is the C→F arrow of the facilitator flow — so CORS
// must be open. No credentials are involved (`credentials: false`, the default), so there
// can be no CSRF either: a request without a token holds no ambient authority.
app.use(cors());
app.use(express.json({ limit: '64kb' }));
app.use((req, res, next) => {
  req.tStart = performance.now();
  req.reqId = uuidv4();
  req.chainMs = 0;
  req.log = logger.child({ reqId: req.reqId, path: req.path });
  res.setHeader('X-Request-Id', req.reqId);
  next();
});
// `X-Server-Ms` = how long the request spent INSIDE the facilitator,
// `X-Chain-Read-Ms` = how much of that was waiting on JSON-RPC.
// The difference is the "pure" cost of the facilitator topology (t_facilitator_ms in the analysis).
function done(req, res) {
  res.setHeader('X-Server-Ms', (performance.now() - req.tStart).toFixed(3));
  res.setHeader('X-Chain-Read-Ms', req.chainMs.toFixed(3));
  return res;
}

// ── authentication ───────────────────────────────────────────────────────────
// The facilitator authenticates MERCHANTS, not payers — same as real x402.
//   public:           /health, /config, /submit-payment  (the payer has no account)
//   machine token:    /payment-request, /verify-proof, /session/*, /debit
// `/submit-payment` is public because it accepts ONLY a `txHash`, which it must itself
// confirm on the chain; without a valid, not-yet-redeemed transaction it is useless.
const auth = authLib.create({
  dataDir: path.join(__dirname, 'data'),
  appName: 'X402 facilitator (folder 04)',
  logger,
  publicPaths: ['/config', '/submit-payment', '/x402/supported']
});
auth.mount(app);
app.use(auth.requireAdmin);

// Merchant label. With a single machine token it is always `default`; the field exists
// so the ledger shows which merchant opened the request, and so that extending to
// multiple merchants is a change to the token registry, not to the schema.
const merchantOf = (req) => String(req.headers['x-merchant'] || 'default').slice(0, 64).replace(/[^\w.\-]/g, '') || 'default';

// ── chain reads ──────────────────────────────────────────────────────────────
async function verifyOnChain(txHash, req) {
  if (chainReadsInFlight >= MAX_CHAIN_READS_IN_FLIGHT) return { verified: false, busy: true, error: 'Facilitator is busy (too many concurrent chain reads)' };
  chainReadsInFlight++;
  const t0 = performance.now();
  try {
    const tx = await provider.getTransaction(txHash);
    if (!tx) return { verified: false, error: 'Transaction not found' };
    const rc = await provider.getTransactionReceipt(txHash);
    if (!rc) return { verified: false, error: 'Transaction not yet confirmed' };
    // BUG 4 of the old implementation: `MIN_CONFIRMATIONS` was documented but never
    // checked — the mere existence of a receipt counted as enough. For MIN_CONFIRMATIONS<=1
    // we make no extra call, since the existence of a receipt already is one confirmation.
    if (MIN_CONFIRMATIONS > 1) {
      const latest = await provider.getBlockNumber();
      const depth = latest - rc.blockNumber + 1;
      if (depth < MIN_CONFIRMATIONS) return { verified: false, error: `Too few confirmations (${depth} < ${MIN_CONFIRMATIONS})` };
    }
    return { verified: true, tx: {
      hash: tx.hash, from: ethers.getAddress(tx.from), to: tx.to ? ethers.getAddress(tx.to) : null,
      value: tx.value.toString(), blockNumber: rc.blockNumber,
      gasUsed: rc.gasUsed ? rc.gasUsed.toString() : null, status: rc.status
    } };
  } catch (err) {
    req.log.error({ err: err.message }, 'chain read failed');
    return { verified: false, error: err.message };
  } finally {
    chainReadsInFlight--;
    req.chainMs += performance.now() - t0;
  }
}

// ── /health, /config ─────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  const dbOk = db.healthCheck();
  let rpcOk = false, lastBlock = null;
  if (MOCK_VERIFY) { rpcOk = true; }
  else {
    try { lastBlock = await Promise.race([provider.getBlockNumber(), new Promise((_, r) => setTimeout(() => r(new Error('t/o')), 2000))]); rpcOk = true; } catch {}
  }
  done(req, res).status(dbOk ? 200 : 503).json({
    status: dbOk ? 'ok' : 'down', vloga: 'facilitator', network: NETWORK,
    mockVerify: MOCK_VERIFY, rpc: rpcOk ? 'ok' : 'down', lastBlock,
    minConfirmations: MIN_CONFIRMATIONS, chainReadsInFlight
  });
});

app.get('/config', (req, res) => done(req, res).json({
  vloga: 'facilitator', protocol: 'facilitator-mediated (payment-request / submit-payment / verify-proof)',
  network: NETWORK, chainId: NETWORK === 'sepolia' ? '0xaa36a7' : null,
  mockVerify: MOCK_VERIFY, minConfirmations: MIN_CONFIRMATIONS,
  proofTtlSeconds: PROOF_TTL, requestTtlSeconds: REQ_TTL,
  debitMessage: 'x402-debit:{payer}:{session}:{nonce}:{path}:{maxWei}',
  x402: x402.enabled ? x402.summary() : null
}));

// ════════════ 1) M -> F : open a payment request ═════════════════════════════
app.post('/payment-request', (req, res) => {
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) return done(req, res).status(400).json({ error: 'Validation error', details: parsed.error.flatten() });
  const { resource, amountWei, payerAddress, ttlSeconds } = parsed.data;
  const recipient = ethers.getAddress(parsed.data.recipient);
  const currency = parsed.data.currency || 'ETH';
  const network = parsed.data.network || NETWORK;
  if (network !== NETWORK) return done(req, res).status(400).json({ error: `Facilitator operates on network ${NETWORK}, not ${network}` });
  if (BigInt(amountWei) <= 0n) return done(req, res).status(400).json({ error: 'Amount must be greater than zero' });

  const requestId = uuidv4();
  const ttl = ttlSeconds || REQ_TTL;
  db.createPaymentRequest({ requestId, merchant: merchantOf(req), resource, recipient, amountWei, currency, network,
    payerAddress: payerAddress ? ethers.getAddress(payerAddress) : null, ttlSeconds: ttl });
  req.log.debug({ requestId, resource, amountWei }, 'payment request opened');
  // 201 Created — as in the facilitator flow described above.
  done(req, res).status(201).json({
    requestId,
    paymentInfo: { requestId, resource, to: recipient, amount: ethers.formatEther(BigInt(amountWei)),
      priceWei: BigInt(amountWei).toString(), currency, network, expiresInSeconds: ttl }
  });
});

// ════════════ 2) C -> F : submit a payment, receive a proof token ════════════
// The facilitator's only public route and the only place in the entire branch that reads the chain.
app.post('/submit-payment', async (req, res, next) => {
  const parsed = submitSchema.safeParse(req.body);
  if (!parsed.success) return done(req, res).status(400).json({ error: 'Validation error', details: parsed.error.flatten() });
  const { requestId, txHash, mockValueWei } = parsed.data;
  const payerAddress = ethers.getAddress(parsed.data.payerAddress);

  const pr = db.getPaymentRequest(requestId);
  if (!pr) return done(req, res).status(400).json({ error: 'Invalid or expired payment request' });
  // BUG 2: the same transaction must not redeem two requests. This is the quick rejection;
  // the definitive guarantee is the PRIMARY KEY in `db.issueProof` (concurrency).
  if (db.isTxRedeemed(txHash)) return done(req, res).status(400).json({ error: 'Transaction has already been redeemed' });

  const amountWei = BigInt(pr.amount_wei);
  let verification;
  if (MOCK_VERIFY) {
    const value = mockValueWei ? BigInt(mockValueWei) : amountWei;
    verification = { verified: true, tx: { hash: txHash, from: payerAddress, to: ethers.getAddress(pr.recipient), value: value.toString(), blockNumber: 0, gasUsed: '21000', status: 1 } };
  } else {
    verification = await verifyOnChain(txHash, req);
  }
  if (!verification.verified) {
    return done(req, res).status(verification.busy ? 429 : 400).json({ error: 'Transaction verification failed', message: verification.error });
  }
  const tx = verification.tx;
  if (tx.status !== 1) return done(req, res).status(400).json({ error: 'Transaction failed on chain' });
  // The recipient is checked against the PAYMENT REQUEST, not against a single global wallet:
  // the facilitator is a service for multiple merchants.
  if (!tx.to || tx.to.toLowerCase() !== pr.recipient.toLowerCase()) return done(req, res).status(400).json({ error: 'Wrong recipient' });
  if (tx.from.toLowerCase() !== payerAddress.toLowerCase()) return done(req, res).status(400).json({ error: 'Payer mismatch' });
  // BUG 3: the comparison is done in integers (wei), not `parseFloat` over ETH.
  if (BigInt(tx.value) < amountWei) return done(req, res).status(400).json({ error: 'Amount too low', zahtevanoWei: amountWei.toString(), placanoWei: tx.value });
  if (pr.payer_address && pr.payer_address.toLowerCase() !== tx.from.toLowerCase()) return done(req, res).status(400).json({ error: 'Payer does not match the payment request' });

  const proofToken = `proof_${uuidv4()}`;
  try {
    db.issueProof({ proofToken, requestId, resource: pr.resource, txHash: tx.hash, blockNumber: tx.blockNumber,
      payerAddress: tx.from, recipient: tx.to, amountWei: BigInt(tx.value).toString(), ttlSeconds: PROOF_TTL });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return done(req, res).status(400).json({ error: 'Transaction has already been redeemed' });
    return next(err);
  }
  req.log.info({ requestId, txHash, payer: tx.from }, 'payment confirmed, proof issued');
  done(req, res).json({
    success: true,
    proof: { token: proofToken, requestId, resource: pr.resource, expiresInSeconds: PROOF_TTL },
    // Duplicated at the top level for clients that read `proofToken` (same shape as in the direct branch).
    proofToken,
    transaction: { hash: tx.hash, blockNumber: tx.blockNumber, from: tx.from, to: tx.to,
      value: ethers.formatEther(BigInt(tx.value)) + ' ETH', valueWei: tx.value, gasUsed: tx.gasUsed }
  });
});

// ════════════ 3) M -> F : verify (and consume) a proof token ═════════════════
app.post('/verify-proof', (req, res) => {
  const parsed = proofSchema.safeParse(req.body);
  if (!parsed.success) return done(req, res).status(400).json({ error: 'Validation error', details: parsed.error.flatten() });
  const { token, resource } = parsed.data;
  const consume = parsed.data.consume !== false;      // CONSUME by default

  const proof = db.getProof(token);
  if (!proof) return done(req, res).status(403).json({ verified: false, error: 'Invalid or expired proof token' });
  if (resource && proof.resource !== resource) return done(req, res).status(403).json({ verified: false, error: 'Token is not valid for this resource' });
  if (proof.consumed_at) return done(req, res).status(403).json({ verified: false, error: 'Proof token has already been consumed' });
  // BUG 1: in the old implementation `/verify-proof` was read-only, so one token
  // unlocked the resource indefinitely. One-time use must match the direct branch,
  // otherwise the comparison measures two different security properties, not the topology.
  if (consume && !db.consumeProof(token)) return done(req, res).status(409).json({ verified: false, error: 'Token consumed concurrently' });

  done(req, res).json({
    verified: true, requestId: proof.request_id, resource: proof.resource,
    payer: proof.payer_address, recipient: proof.recipient,
    txHash: proof.tx_hash, blockNumber: proof.block_number,
    amountWei: proof.amount_wei, consumed: consume
  });
});

// ════════════ 4) M -> F : metered session ════════════════════════════════════
// By the principle of the facilitator flow, it is the facilitator that "verifies
// the signature, the payer's credit and the match with the stated requirements".
// In the direct branch the merchant does all three locally (no network hop); here
// they move to this process — exactly the difference the metered-session experiment measures.
const debitMessage = (payer, sessionId, nonce, reqPath, maxWei) =>
  `x402-debit:${payer.toLowerCase()}:${sessionId}:${nonce}:${reqPath}:${maxWei}`;

app.post('/session/open', async (req, res, next) => {
  const parsed = openSchema.safeParse(req.body);
  if (!parsed.success) return done(req, res).status(400).json({ error: 'Validation error', details: parsed.error.flatten() });
  const { txHash, resource, budgetWei, ttlSeconds, mockDepositWei } = parsed.data;
  const payerAddress = ethers.getAddress(parsed.data.payerAddress);
  const recipient = ethers.getAddress(parsed.data.recipient);
  if (db.isTxRedeemed(txHash)) return done(req, res).status(400).json({ error: 'Transaction has already been redeemed' });

  let verification;
  if (MOCK_VERIFY) {
    const deposit = mockDepositWei ? BigInt(mockDepositWei) : 100_000_000n;
    verification = { verified: true, tx: { hash: txHash, from: payerAddress, to: recipient, value: deposit.toString(), blockNumber: 0, gasUsed: '21000', status: 1 } };
  } else {
    verification = await verifyOnChain(txHash, req);
  }
  if (!verification.verified) return done(req, res).status(verification.busy ? 429 : 400).json({ error: 'Transaction verification failed', message: verification.error });
  const tx = verification.tx;
  if (tx.status !== 1) return done(req, res).status(400).json({ error: 'Transaction failed on chain' });
  if (!tx.to || tx.to.toLowerCase() !== recipient.toLowerCase()) return done(req, res).status(400).json({ error: 'Wrong recipient' });
  if (tx.from.toLowerCase() !== payerAddress.toLowerCase()) return done(req, res).status(400).json({ error: 'Payer mismatch' });

  const deposit = BigInt(tx.value);
  if (deposit <= 0n) return done(req, res).status(400).json({ error: 'Top-up is zero' });
  let budget = deposit;
  if (budgetWei) { const b = BigInt(budgetWei); budget = b < deposit ? b : deposit; }
  const ttl = Math.min(ttlSeconds || SESSION_TTL_DEFAULT, SESSION_TTL_MAX);
  const sessionId = `sess_${uuidv4()}`;
  let session;
  try {
    session = db.openSession({ sessionId, merchant: merchantOf(req), payerAddress: tx.from, resource,
      recipient, depositWei: deposit, budgetWei: budget, txHash: tx.hash, ttlSeconds: ttl });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return done(req, res).status(400).json({ error: 'Transaction has already been redeemed' });
    return next(err);
  }
  req.log.info({ sessionId, payer: tx.from, depositWei: deposit.toString() }, 'metered session opened');
  done(req, res).json({ success: true, session: db.sessionView(session),
    transaction: { hash: tx.hash, blockNumber: tx.blockNumber, gasUsed: tx.gasUsed } });
});

app.get('/session/:id', (req, res) => {
  const s = db.getSession(String(req.params.id));
  if (!s) return done(req, res).status(404).json({ error: 'Session does not exist' });
  done(req, res).json({ success: true, session: db.sessionView(s) });
});

// The merchant forwards the signed debit; the facilitator is the one that authorizes it.
app.post('/debit', (req, res) => {
  const parsed = debitSchema.safeParse(req.body);
  if (!parsed.success) return done(req, res).status(400).json({ error: 'Validation error', details: parsed.error.flatten() });
  const { sessionId, nonce, signature, path: reqPath, maxWei, priceWei, bytes } = parsed.data;
  let payer;
  try { payer = ethers.getAddress(parsed.data.payer); } catch { return done(req, res).status(400).json({ error: 'Invalid payer address' }); }

  // nonce freshness (against replay of old signatures)
  const nonceTs = parseInt(String(nonce).split('-')[0], 10);
  if (!Number.isFinite(nonceTs) || Math.abs(Date.now() - nonceTs) > DEBIT_MAX_AGE_MS) {
    return done(req, res).status(400).json({ error: 'Stale or malformed nonce' });
  }
  // EIP-191 signature over exactly what the payer saw
  let recovered;
  try { recovered = ethers.verifyMessage(debitMessage(payer, sessionId, nonce, reqPath, maxWei), signature); }
  catch { return done(req, res).status(400).json({ error: 'Invalid signature' }); }
  if (recovered.toLowerCase() !== payer.toLowerCase()) return done(req, res).status(403).json({ error: 'Signature does not match the payer' });

  const s = db.getSession(sessionId);
  if (!s) return done(req, res).status(404).json({ error: 'Session does not exist' });
  if (s.payer_address.toLowerCase() !== payer.toLowerCase()) return done(req, res).status(403).json({ error: 'Session does not belong to this payer' });
  if (s.merchant !== merchantOf(req)) return done(req, res).status(403).json({ error: 'Session does not belong to this merchant' });
  if (s.resource !== reqPath) return done(req, res).status(403).json({ error: 'Signature is valid for a different resource' });
  // "match with the stated requirements": the merchant's price must not exceed the signed maximum
  if (BigInt(priceWei) > BigInt(maxWei)) return done(req, res).status(400).json({ error: 'Price exceeds the signed maximum', priceWei, maxWei });

  const result = db.debit({ sessionId, amountWei: BigInt(priceWei), nonce, requestPath: reqPath, bytes });
  if (!result.ok) {
    if (result.reason === 'nonce_reused') return done(req, res).status(403).json({ error: 'Nonce already used (replay rejected)', reason: result.reason });
    if (result.reason === 'session_expired') return done(req, res).status(403).json({ error: 'Session has expired (validity period)', reason: result.reason });
    if (result.reason === 'session_closed') return done(req, res).status(403).json({ error: 'Session is closed', reason: result.reason });
    if (result.reason === 'budget_exceeded') return done(req, res).status(402).json({ error: 'Session budget exceeded', reason: result.reason, budgetRemainingWei: (result.budgetRemainingWei ?? 0n).toString() });
    return done(req, res).status(402).json({ error: 'Insufficient credit', reason: result.reason || 'insufficient_balance', balanceWei: (result.balanceWei ?? 0n).toString() });
  }
  res.set('X-Charged-Wei', BigInt(priceWei).toString());
  res.set('X-Balance-Wei', result.balanceWei.toString());
  res.set('X-Budget-Remaining-Wei', result.budgetRemainingWei.toString());
  done(req, res).json({
    authorized: true, chargedWei: BigInt(priceWei).toString(),
    balanceWei: result.balanceWei.toString(), budgetRemainingWei: result.budgetRemainingWei.toString(),
    spentWei: result.spentWei.toString(), expiresAt: new Date(s.expires_at).toISOString()
  });
});

// ══════════ x402 v2 FACILITATOR API (in parallel with the custom protocol) ═══
// The official facilitator role: POST /x402/verify + POST /x402/settle
// (+ GET /x402/supported for discovery). The merchant stays without RPC; this
// process verifies signatures, SUBMITS the settlement transaction (synthetic in
// test mode) and pays the gas. /x402/reconcile is our addition: it lets an
// RPC-less merchant resolve an uncertain settlement (receipt / authorization
// state) without blindly resubmitting — the official protocol does not define this route.
if (x402.enabled) {
  const bodySchema = z.object({ paymentPayload: z.any(), paymentRequirements: z.any() });

  app.post('/x402/verify', async (req, res) => {
    const parsed = bodySchema.safeParse(req.body || {});
    if (!parsed.success || !parsed.data.paymentPayload || !parsed.data.paymentRequirements) {
      return done(req, res).status(400).json({ error: 'Missing paymentPayload or paymentRequirements' });
    }
    try {
      const out = await x402.getVerifyFacilitator().verify(parsed.data.paymentPayload, parsed.data.paymentRequirements);
      done(req, res).json(out);
    } catch (err) {
      req.log.warn({ err: err.message }, 'x402 verify failed');
      done(req, res).json({ isValid: false, invalidReason: 'verify_error', errorMessage: String(err.message).slice(0, 200) });
    }
  });

  app.post('/x402/settle', async (req, res) => {
    const parsed = bodySchema.safeParse(req.body || {});
    if (!parsed.success || !parsed.data.paymentPayload || !parsed.data.paymentRequirements) {
      return done(req, res).status(400).json({ error: 'Missing paymentPayload or paymentRequirements' });
    }
    const payload = parsed.data.paymentPayload;
    const requirements = parsed.data.paymentRequirements;
    if (x402.MOCK && process.env.X402_MOCK_FAULTS === 'true' && req.headers['x-x402-mock-fault']) {
      x402.noteFault(x402.paymentKeyOf(payload, requirements), String(req.headers['x-x402-mock-fault']));
    }
    try {
      const resourceKey = x402.normResource((payload && payload.resource && (payload.resource.url || payload.resource)) || '');
      // the entire state machine (idempotency, BROADCAST before waiting, reconciliation)
      // runs HERE — the facilitator is the settlement authority with its own database
      const out = await x402.settleWithIdempotency({ dbx, payload, requirements, resourceKey, logger: req.log });
      done(req, res).json(out.settleResponse);
    } catch (err) {
      req.log.error({ err: err.message }, 'x402 settle failed');
      done(req, res).json({ success: false, errorReason: 'settle_error', errorMessage: String(err.message).slice(0, 200), network: requirements && requirements.network });
    }
  });

  app.get('/x402/supported', async (req, res) => {
    try { done(req, res).json(await x402.getVerifyFacilitator().getSupported()); }
    catch (err) { done(req, res).status(500).json({ error: String(err.message).slice(0, 200) }); }
  });

  // Reconciliation for an RPC-less merchant: {txHash} → receipt; {from, nonce} → authorization state.
  const reconcileSchema = z.object({
    txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
    from: z.string().optional(),
    nonce: z.string().optional()
  });
  app.post('/x402/reconcile', async (req, res) => {
    const parsed = reconcileSchema.safeParse(req.body || {});
    if (!parsed.success) return done(req, res).status(400).json({ error: 'Validation error' });
    const { txHash, from, nonce } = parsed.data;
    try {
      if (txHash) {
        const rc = await x402.getReceipt(txHash);
        return done(req, res).json(rc ? { status: rc.status, blockNumber: rc.blockNumber != null ? Number(rc.blockNumber) : null, gasUsed: rc.gasUsed != null ? String(rc.gasUsed) : null, effectiveGasPrice: rc.effectiveGasPrice != null ? String(rc.effectiveGasPrice) : null } : null);
      }
      if (from && nonce) {
        const used = await x402.isAuthorizationUsed({ from, nonce });
        return done(req, res).json({ authorizationUsed: used });
      }
      done(req, res).status(400).json({ error: 'Provide txHash or (from, nonce)' });
    } catch (err) {
      done(req, res).status(502).json({ error: String(err.message).slice(0, 200) });
    }
  });

  // settlement-state lookup (for agents/measurements)
  app.get('/x402/payment/:id', (req, res) => {
    const row = dbx.getPayment(String(req.params.id).slice(0, 160));
    if (!row) return done(req, res).status(404).json({ error: 'Unknown payment' });
    done(req, res).json({
      paymentId: row.payment_id, status: row.status, resource: row.resource,
      network: row.network, asset: row.asset, amountAtomic: row.amount_atomic,
      payer: row.payer, payTo: row.pay_to, txHash: row.tx_hash,
      block: row.block_number, gasUnits: row.gas_used, gasPriceWei: row.effective_gas_price,
      poskusi: row.attempt
    });
  });

  logger.info({ x402: x402.summary() }, 'x402 v2 facilitator routes mounted (/x402/verify, /x402/settle, /x402/supported, /x402/reconcile)');
}

// ── errors, sweeping, startup ────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Body-parser errors (`express.json`) carry their own 400 status: malformed
  // JSON is a client error, not a server failure.
  const code = Number.isInteger(err.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
  const log = req.log || logger;
  if (code === 500) log.error({ err: err.message }, 'Unhandled error');
  else log.warn({ err: err.message, code }, 'Bad request');
  if (!res.headersSent) res.status(code).json(code === 500 ? { error: 'Internal server error' } : { error: 'Bad request', message: err.message });
});
setInterval(() => { try { db.sweep(); if (dbx) dbx.x402Sweep(); } catch {} }, 60_000).unref();

const server = app.listen(PORT, '0.0.0.0', () =>
  logger.info({ port: PORT, network: NETWORK, mockVerify: MOCK_VERIFY, minConfirmations: MIN_CONFIRMATIONS },
    `X402 facilitator → http://localhost:${PORT}`));
function shutdown(sig) {
  logger.info({ sig }, 'Shutting down');
  server.close(() => { try { db.db.close(); } catch {} process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
module.exports = app;
