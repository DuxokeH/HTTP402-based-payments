'use strict';

/**
 * ============================================================================
 *  X402 — MERGED ONE-TIME PAYMENT MERCHANT SERVER  (folder 06_x402)
 * ============================================================================
 *
 *  Variant of folder 01 with the verification and access exchanges FUSED into
 *  one, so the whole paid flow is 2 HTTP exchanges / 4 messages:
 *    - GET  /service                 -> 402 challenge (identical to folder 01)
 *      (client pays on-chain, waits for confirmation, obtains txHash)
 *    - POST /service {requestId, txHash, network, payerAddress, prompt}
 *                                    -> 200 + content + proofToken (one go)
 *    - GET  /service (X-Payment: proof) -> 200 acknowledgment that the payment
 *      was already made (authorized/consumed/expiresAt) — no second payment.
 *
 *  There is NO /verify-payment endpoint — its absence is the point of this
 *  variant (see ../README.md). The verification pipeline itself (existence,
 *  confirmation, status, recipient, payer, amount, txHash replay protection)
 *  is byte-for-byte the same checks as folder 01, just relocated.
 *
 *  Fallback kept from folder 01: POST /service WITH an X-Payment header
 *  redeems a previously minted, unconsumed proof (used when the downstream
 *  call was capped/failed after a successful verification).
 *
 *  Measurement headers (same convention as folder 01):
 *      X-Server-Ms       total server handler time (ms)
 *      X-Chain-Read-Ms   time spent reading the tx from the chain (ms)
 *      X-Downstream-Ms   time spent in the downstream/external API (ms)
 *
 *  Code/comments: English. User-facing messages: Slovenian (on the wire).
 * ============================================================================
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const { v4: uuidv4 } = require('uuid');
const pino = require('pino');
const { z } = require('zod');
let OpenAI = null;
try { OpenAI = require('openai'); } catch { /* optional dependency */ }

const db = require('./db');
// Uradni x402 v2 — VZPOREDNI plačilni način (X402_MODE=off|self). Ob 'off' se
// /x402/* poti ne priklopijo in mapa deluje bajt-enako kot doslej.
const x402 = require('./x402');
const dbx = x402.enabled ? require('./db_x402') : null;

// ─────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────

const PORT = parseInt(process.env.MERCHANT_PORT || '3300', 10);
const NETWORK = process.env.NETWORK || 'sepolia';
const RPC_URL = process.env.RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';

// Experimental MOCK control condition: skip on-chain verification entirely so
// the protocol machinery can be measured hundreds of times without spending
// test ETH or waiting for blocks. Never enable in a real demo/production run.
const MOCK_VERIFY = process.env.MOCK_VERIFY === 'true' && (!IS_PROD || process.env.FORCE_MOCK === '1');

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const PROOF_TOKEN_TTL_SECONDS = parseInt(process.env.PROOF_TOKEN_TTL_SECONDS || '600', 10);
const PAYMENT_REQUEST_TTL_SECONDS = parseInt(process.env.PAYMENT_REQUEST_TTL_SECONDS || '1800', 10);
const MIN_CONFIRMATIONS = parseInt(process.env.MIN_CONFIRMATIONS || '1', 10);

// Price for one /service access. Default 1e-7 ETH ≈ 0.025 euro-cent of Sepolia ETH at the
// reference rate below (purely for human-readable reporting on a testnet).
const SERVICE_PRICE_ETH = process.env.SERVICE_PRICE_ETH || '0.0000001';
const ETH_EUR_RATE = parseFloat(process.env.ETH_EUR_RATE || '2500'); // assumption, reporting only

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OPENAI_DAILY_USD_CAP = parseFloat(process.env.OPENAI_DAILY_USD_CAP || '5');
const OPENAI_MAX_TOKENS = parseInt(process.env.OPENAI_MAX_TOKENS || '400', 10);
const OPENAI_MAX_PROMPT_CHARS = parseInt(process.env.OPENAI_MAX_PROMPT_CHARS || '4000', 10);

const MODEL_PRICING = {
  'gpt-4o-mini': { input: 0.15 / 1_000_000, output: 0.60 / 1_000_000 },
  'gpt-4o':      { input: 2.50 / 1_000_000, output: 10.00 / 1_000_000 }
};

const RESOURCE = '/service';
const SERVICES = {
  [RESOURCE]: { price: SERVICE_PRICE_ETH, currency: 'ETH', network: NETWORK }
};

// ─────────────────────────────────────────────────────────
// LOGGER
// ─────────────────────────────────────────────────────────

const logger = pino({
  level: process.env.LOG_LEVEL || (IS_PROD ? 'info' : 'debug'),
  ...(IS_PROD ? {} : { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } } }),
  redact: { paths: ['*.privateKey', '*.x402SettlerPrivateKey', '*.x402PayerPrivateKey', '*.OPENAI_API_KEY', 'req.headers.authorization'], remove: true }
});

// ─────────────────────────────────────────────────────────
// MERCHANT WALLET (address only — no private key needed to verify payments)
// ─────────────────────────────────────────────────────────

const walletPath = path.join(__dirname, 'wallet.json');
let MERCHANT_WALLET;
try {
  const walletData = JSON.parse(fs.readFileSync(walletPath, 'utf8'));
  MERCHANT_WALLET = ethers.getAddress(walletData.address);
  logger.info({ merchant: MERCHANT_WALLET }, 'Merchant wallet loaded (address only)');
} catch (error) {
  logger.fatal({ err: error.message }, 'Failed to load wallet.json — copy wallet.example.json to wallet.json and set your address');
  process.exit(1);
}

const openai = (OpenAI && OPENAI_API_KEY) ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
if (!openai) logger.warn('OpenAI disabled — /service returns a deterministic demo payload (best for clean latency measurements)');

const provider = new ethers.JsonRpcProvider(RPC_URL);

// ─────────────────────────────────────────────────────────
// VALIDATION SCHEMAS
// ─────────────────────────────────────────────────────────

const txHashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'Invalid transaction hash');
const uuidSchema = z.string().uuid('Invalid request ID');
const addressSchema = z.string().refine(v => { try { ethers.getAddress(v); return true; } catch { return false; } }, 'Invalid Ethereum address');

// The MERGED exchange carries the payment claim AND the order in one body.
const zdruzenoSchema = z.object({
  requestId: uuidSchema,
  txHash: txHashSchema,
  network: z.literal(NETWORK),
  payerAddress: addressSchema,
  prompt: z.string().min(1).max(OPENAI_MAX_PROMPT_CHARS),
  model: z.string().optional()
});
// Fallback redemption path (proof already minted earlier).
const servicePostSchema = z.object({
  prompt: z.string().min(1).max(OPENAI_MAX_PROMPT_CHARS),
  model: z.string().optional()
});

// ─────────────────────────────────────────────────────────
// EXPRESS APP
// ─────────────────────────────────────────────────────────

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
// Expose measurement headers to browser clients (CORS) too.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Expose-Headers', 'X-Server-Ms, X-Chain-Read-Ms, X-Downstream-Ms, X-Request-Id');
  next();
});

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'script-src': ["'self'", 'https://esm.sh', "'unsafe-inline'"],
      'connect-src': ["'self'", 'https://*.publicnode.com', 'https://*.infura.io', 'https://*.alchemy.com'],
      'img-src': ["'self'", 'data:']
    }
  }
}));

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (!IS_PROD) return cb(null, true);
    if (ALLOWED_ORIGINS.length === 0) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error(`Origin ${origin} not allowed`));
  },
  credentials: false
}));

app.use(express.json({ limit: '64kb' }));

app.use((req, res, next) => {
  req.reqId = uuidv4();
  req.tStart = performance.now();
  req.log = logger.child({ reqId: req.reqId, method: req.method, path: req.path });
  res.setHeader('X-Request-Id', req.reqId);
  next();
});

// POST /service now does the on-chain verification work, so it gets the
// stricter "verify" budget; GET /service stays on the roomier service budget.
const verifyLimiter = rateLimit({ windowMs: 60_000, max: parseInt(process.env.RATE_VERIFY_PER_MIN || '60', 10), standardHeaders: true, legacyHeaders: false });
const serviceLimiter = rateLimit({ windowMs: 60_000, max: parseInt(process.env.RATE_SERVICE_PER_MIN || '120', 10), standardHeaders: true, legacyHeaders: false });

// helper: stamp total server handler time just before sending
function serverMs(req) { return (performance.now() - req.tStart).toFixed(3); }

// ─────────────────────────────────────────────────────────
// BLOCKCHAIN VERIFICATION
// ─────────────────────────────────────────────────────────

async function verifyTransactionOnChain(txHash, log) {
  try {
    const tx = await provider.getTransaction(txHash);
    if (!tx) return { verified: false, error: 'Transaction not found' };
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) return { verified: false, error: 'Transaction not confirmed yet' };
    if (MIN_CONFIRMATIONS > 1) {
      const latest = await provider.getBlockNumber();
      const confirmations = latest - receipt.blockNumber + 1;
      if (confirmations < MIN_CONFIRMATIONS) {
        return { verified: false, error: `Only ${confirmations}/${MIN_CONFIRMATIONS} confirmations` };
      }
    }
    return {
      verified: true,
      tx: {
        hash: tx.hash,
        from: ethers.getAddress(tx.from),
        to: tx.to ? ethers.getAddress(tx.to) : null,
        value: tx.value.toString(),
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed ? receipt.gasUsed.toString() : null,
        status: receipt.status
      }
    };
  } catch (err) {
    log.error({ err: err.message }, 'Blockchain verification error');
    return { verified: false, error: err.message };
  }
}

function estimateCost(model, promptTokens, completionTokens) {
  const p = MODEL_PRICING[model] || MODEL_PRICING['gpt-4o-mini'];
  return promptTokens * p.input + completionTokens * p.output;
}

// ─────────────────────────────────────────────────────────
// STATIC FRONTEND (MetaMask demo)
// ─────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

// ─────────────────────────────────────────────────────────
// /config, /health
// ─────────────────────────────────────────────────────────

app.get('/config', (req, res) => {
  res.json({
    network: NETWORK,
    chainId: NETWORK === 'sepolia' ? '0xaa36a7' : null,
    merchant: MERCHANT_WALLET,
    service: SERVICES[RESOURCE],
    priceEurApprox: (parseFloat(SERVICE_PRICE_ETH) * ETH_EUR_RATE).toFixed(4),
    ethEurRate: ETH_EUR_RATE,
    proofTokenTtlSeconds: PROOF_TOKEN_TTL_SECONDS,
    mockVerify: MOCK_VERIFY,
    aiEnabled: !!openai,
    model: OPENAI_MODEL,
    potek: 'zdruzen: 2 izmenjavi / 4 sporocila (GET->402, POST->200+vsebina+zeton)',
    x402: x402.enabled ? x402.summary() : null
  });
});

app.get('/health', async (req, res) => {
  const dbOk = db.healthCheck();
  let rpcOk = false, lastBlock = null;
  try {
    lastBlock = await Promise.race([
      provider.getBlockNumber(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('rpc timeout')), 2000))
    ]);
    rpcOk = true;
  } catch (err) { req.log.warn({ err: err.message }, 'RPC health check failed'); }
  const status = dbOk && (rpcOk || MOCK_VERIFY) ? 'ok' : 'degraded';
  res.setHeader('X-Server-Ms', serverMs(req));
  res.status(status === 'ok' ? 200 : 503).json({
    status, service: 'X402 združena enkratna plačila (merchant)', network: NETWORK,
    merchant: MERCHANT_WALLET, db: dbOk ? 'ok' : 'down', rpc: rpcOk ? 'ok' : 'down',
    mockVerify: MOCK_VERIFY, lastBlock, aiEnabled: !!openai,
    x402: x402.enabled ? await x402.health() : { mode: 'off' }
  });
});

// ─────────────────────────────────────────────────────────
// GET /service — 402 challenge, or payment acknowledgment with a proof token
// (message 1 -> message 2 of the merged flow; identical to folder 01)
// ─────────────────────────────────────────────────────────

app.get('/service', serviceLimiter, (req, res) => {
  const proofToken = req.headers['x-payment'] || req.headers['x-payment-proof'];

  if (!proofToken) {
    const requestId = uuidv4();
    const serviceConfig = SERVICES[RESOURCE];

    let payerAddress = req.headers['x-payer'] || req.query.payer || null;
    if (payerAddress) { try { payerAddress = ethers.getAddress(payerAddress); } catch { payerAddress = null; } }

    db.createPaymentRequest({
      requestId, resource: RESOURCE, recipient: MERCHANT_WALLET,
      amountEth: serviceConfig.price, currency: serviceConfig.currency,
      network: serviceConfig.network, payerAddress, ttlSeconds: PAYMENT_REQUEST_TTL_SECONDS
    });

    req.log.info({ requestId, payerAddress }, '402 Payment Required issued');
    res.setHeader('X-Server-Ms', serverMs(req));
    return res.status(402).json({
      error: 'Payment Required',
      message: 'Za dostop do te storitve je potrebno plačilo.',
      payment: {
        requestId,
        resource: RESOURCE,
        to: MERCHANT_WALLET,
        amount: serviceConfig.price,
        currency: serviceConfig.currency,
        network: serviceConfig.network,
        createdAt: new Date().toISOString(),
        expiresInSeconds: PAYMENT_REQUEST_TTL_SECONDS
      }
    });
  }

  // Acknowledgment readout: the server confirms the payment was already made.
  const proof = db.getProof(proofToken);
  if (!proof) { res.setHeader('X-Server-Ms', serverMs(req)); return res.status(403).json({ error: 'Neveljaven ali potekel dokazni žeton' }); }
  res.setHeader('X-Server-Ms', serverMs(req));
  res.json({
    success: true, authorized: true, proofToken,
    resource: proof.resource,
    expiresAt: new Date(proof.expires_at).toISOString(),
    consumed: !!proof.consumed_at,
    message: 'Plačilo je bilo že opravljeno in preverjeno.',
    payment: { verified: true, txHash: proof.tx_hash, blockNumber: proof.block_number }
  });
});

// ─────────────────────────────────────────────────────────
// POST /service — THE MERGED EXCHANGE (message 3 -> message 4)
//
// Without X-Payment header: body carries {requestId, txHash, network,
// payerAddress, prompt}. The server verifies the on-chain payment (same
// pipeline as folder 01's /verify-payment), mints + immediately consumes the
// proof token, performs the downstream work, and returns content AND proof
// token in ONE response.
//
// With X-Payment header: fallback redemption of an earlier unconsumed proof
// (kept from folder 01 for the capped/failed-downstream edge cases).
// ─────────────────────────────────────────────────────────

async function runDownstream(req, res, { prompt, model, proof }) {
  // `proof` fields used for the payment echo: proofToken, txHash, blockNumber.
  let downstreamMs = 0;
  // Deterministic demo downstream (default). Best for clean latency measurement:
  // it removes the highly variable external-API time from the protocol numbers.
  if (!openai) {
    const t0 = performance.now();
    const response = `Odgovor zaščitene storitve. Vaš poziv: "${prompt}". ` +
      `(demo način — brez zunanjega klica; za pravi zunanji API nastavi OPENAI_API_KEY)`;
    downstreamMs = performance.now() - t0;
    res.setHeader('X-Downstream-Ms', downstreamMs.toFixed(3));
    res.setHeader('X-Server-Ms', serverMs(req));
    return res.json({
      success: true, response, model: 'demo',
      proofToken: proof.proofToken, expiresInSeconds: PROOF_TOKEN_TTL_SECONDS,
      payment: { verified: true, txHash: proof.txHash, blockNumber: proof.blockNumber }
    });
  }

  try {
    const t0 = performance.now();
    const completion = await openai.chat.completions.create({ model, messages: [{ role: 'user', content: prompt }], max_tokens: OPENAI_MAX_TOKENS });
    downstreamMs = performance.now() - t0;
    const response = completion.choices[0]?.message?.content || '';
    const usage = completion.usage || { prompt_tokens: 0, completion_tokens: 0 };
    db.recordOpenAIUsage({ model, promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, costUsd: estimateCost(model, usage.prompt_tokens, usage.completion_tokens) });
    res.setHeader('X-Downstream-Ms', downstreamMs.toFixed(3));
    res.setHeader('X-Server-Ms', serverMs(req));
    res.json({
      success: true, response, model, usage,
      proofToken: proof.proofToken, expiresInSeconds: PROOF_TOKEN_TTL_SECONDS,
      payment: { verified: true, txHash: proof.txHash, blockNumber: proof.blockNumber }
    });
  } catch (err) {
    req.log.error({ err: err.message }, 'Downstream API call failed');
    res.setHeader('X-Server-Ms', serverMs(req));
    // The payment stays proven: the client keeps the proofToken as evidence.
    res.status(502).json({
      error: 'AI service error',
      message: 'Plačilo je veljavno in preverjeno, a zunanji API je vrnil napako.',
      proofToken: proof.proofToken
    });
  }
}

app.post('/service', verifyLimiter, async (req, res) => {
  const proofToken = req.headers['x-payment'] || req.headers['x-payment-proof'];

  // ── Fallback path: redeem an existing proof (folder 01 semantics) ──
  if (proofToken) {
    const proof = db.getProof(proofToken);
    if (!proof) { res.setHeader('X-Server-Ms', serverMs(req)); return res.status(403).json({ error: 'Neveljaven ali potekel dokazni žeton' }); }
    if (proof.consumed_at) { res.setHeader('X-Server-Ms', serverMs(req)); return res.status(403).json({ error: 'Dokazni žeton je že bil porabljen' }); }

    // Resource binding: the proof may only unlock the resource it paid for.
    if (proof.resource !== req.path) {
      res.setHeader('X-Server-Ms', serverMs(req));
      return res.status(403).json({ error: 'Dokazni žeton ne velja za ta vir', expected: proof.resource, got: req.path });
    }

    const parsed = servicePostSchema.safeParse(req.body || {});
    if (!parsed.success) { res.setHeader('X-Server-Ms', serverMs(req)); return res.status(400).json({ error: 'Validation error', details: parsed.error.flatten() }); }
    const { prompt, model: requestedModel } = parsed.data;
    const model = requestedModel && MODEL_PRICING[requestedModel] ? requestedModel : OPENAI_MODEL;

    if (openai) {
      const todaySpend = db.getTodayOpenAISpend();
      if (todaySpend >= OPENAI_DAILY_USD_CAP) { res.setHeader('X-Server-Ms', serverMs(req)); return res.status(503).json({ error: 'Dnevni proračun AI dosežen', proofToken }); }
    }

    // One-shot: consume BEFORE the downstream call so a slow client cannot re-spend.
    if (!db.consumeProof(proofToken)) { res.setHeader('X-Server-Ms', serverMs(req)); return res.status(409).json({ error: 'Dokazni žeton porabljen sočasno' }); }

    return runDownstream(req, res, { prompt, model, proof: { proofToken, txHash: proof.tx_hash, blockNumber: proof.block_number } });
  }

  // ── MERGED path: verify the on-chain payment AND deliver the content ──
  const parsed = zdruzenoSchema.safeParse(req.body || {});
  if (!parsed.success) { res.setHeader('X-Server-Ms', serverMs(req)); return res.status(400).json({ error: 'Validation error', details: parsed.error.flatten() }); }
  const { requestId, txHash, payerAddress, prompt, model: requestedModel } = parsed.data;
  const model = requestedModel && MODEL_PRICING[requestedModel] ? requestedModel : OPENAI_MODEL;

  const paymentRequest = db.getPaymentRequest(requestId);
  if (!paymentRequest) { res.setHeader('X-Server-Ms', serverMs(req)); return res.status(400).json({ error: 'Neveljavna ali potekla plačilna zahteva' }); }

  if (db.isTxRedeemed(txHash)) {
    req.log.warn({ txHash }, 'Replay attempt: tx already redeemed');
    res.setHeader('X-Server-Ms', serverMs(req));
    return res.status(400).json({ error: 'Transakcija je že bila unovčena' });
  }

  let chainReadMs = 0, verification;
  if (MOCK_VERIFY) {
    verification = { verified: true, tx: {
      hash: txHash, from: ethers.getAddress(payerAddress),
      to: paymentRequest.recipient || MERCHANT_WALLET,
      value: ethers.parseEther(paymentRequest.amount_eth).toString(),
      blockNumber: 0, gasUsed: '21000', status: 1
    } };
  } else {
    const t0 = performance.now();
    verification = await verifyTransactionOnChain(txHash, req.log);
    chainReadMs = performance.now() - t0;
    res.setHeader('X-Chain-Read-Ms', chainReadMs.toFixed(3));
  }
  if (!verification.verified) { res.setHeader('X-Server-Ms', serverMs(req)); return res.status(400).json({ error: 'Preverjanje transakcije ni uspelo', message: verification.error }); }
  const tx = verification.tx;

  if (tx.status !== 1) { res.setHeader('X-Server-Ms', serverMs(req)); return res.status(400).json({ error: 'Transakcija na verigi ni uspela' }); }

  const expectedRecipient = paymentRequest.recipient || MERCHANT_WALLET;
  if (tx.to?.toLowerCase() !== expectedRecipient.toLowerCase()) { res.setHeader('X-Server-Ms', serverMs(req)); return res.status(400).json({ error: 'Napačen prejemnik' }); }
  if (tx.from.toLowerCase() !== payerAddress.toLowerCase()) { res.setHeader('X-Server-Ms', serverMs(req)); return res.status(400).json({ error: 'Neujemanje plačnika', message: 'Pošiljatelj transakcije se ne ujema z navedenim naslovom plačnika' }); }
  if (paymentRequest.payer_address && paymentRequest.payer_address.toLowerCase() !== payerAddress.toLowerCase()) { res.setHeader('X-Server-Ms', serverMs(req)); return res.status(400).json({ error: 'Neujemanje plačnika z izvorno zahtevo' }); }

  const expected = ethers.parseEther(paymentRequest.amount_eth);
  if (BigInt(tx.value) < expected) {
    res.setHeader('X-Server-Ms', serverMs(req));
    return res.status(400).json({ error: 'Prenizek znesek', message: `Zahtevano ${paymentRequest.amount_eth} ETH, prejeto ${ethers.formatEther(tx.value)} ETH` });
  }

  const newProofToken = `proof_${uuidv4()}`;
  try {
    db.finalizeVerification({
      proofToken: newProofToken, requestId, resource: paymentRequest.resource,
      txHash: tx.hash, blockNumber: tx.blockNumber, payerAddress: tx.from,
      recipient: tx.to, amountEth: ethers.formatEther(tx.value), ttlSeconds: PROOF_TOKEN_TTL_SECONDS
    });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') { res.setHeader('X-Server-Ms', serverMs(req)); return res.status(400).json({ error: 'Transakcija je že bila unovčena' }); }
    throw err;
  }
  req.log.info({ proofToken: newProofToken, txHash, blockNumber: tx.blockNumber }, 'Payment verified (merged exchange)');

  // Daily cost cap AFTER minting: the payment is already on-chain, so a capped
  // request must not lose it — the client gets the (unconsumed) proof token and
  // redeems it later through the fallback path above.
  if (openai) {
    const todaySpend = db.getTodayOpenAISpend();
    if (todaySpend >= OPENAI_DAILY_USD_CAP) {
      res.setHeader('X-Server-Ms', serverMs(req));
      return res.status(503).json({ error: 'Dnevni proračun AI dosežen', message: 'Plačilo je preverjeno — žeton unovči kasneje.', proofToken: newProofToken, expiresInSeconds: PROOF_TOKEN_TTL_SECONDS });
    }
  }

  // One-shot: consume immediately (content is delivered in this same response).
  if (!db.consumeProof(newProofToken)) { res.setHeader('X-Server-Ms', serverMs(req)); return res.status(409).json({ error: 'Dokazni žeton porabljen sočasno' }); }

  return runDownstream(req, res, { prompt, model, proof: { proofToken: newProofToken, txHash: tx.hash, blockNumber: tx.blockNumber } });
});

// ─────────────────────────────────────────────────────────
// x402 v2 (VZPOREDNI NAČIN) — GET /x402/service, GET /x402/config
//
// Uradni protokol: 402 + PAYMENT-REQUIRED → odjemalec podpiše EIP-3009
// pooblastilo (ETH — testno) → ponovni GET s PAYMENT-SIGNATURE →
// strežnik SAM preveri in poravna (samofacilitirano) → 200 + PAYMENT-RESPONSE.
// Lastni protokol zgoraj (združeni /service) je nedotaknjen.
// ─────────────────────────────────────────────────────────

if (x402.enabled) {
  const { middleware: x402Middleware, x402Route } = x402.buildMiddleware({
    dbx, logger,
    routes: {
      'GET /x402/service': x402.routeConfig('Zaščitena storitev — x402 exact (Ethereum Sepolia, ETH — testno)')
    }
  });

  // javna konfiguracija za brskalnik/agente (brez skrivnosti)
  app.get('/x402/config', (req, res) => {
    res.setHeader('X-Server-Ms', serverMs(req));
    res.json(x402.summary());
  });

  app.use(x402Middleware);

  app.get('/x402/service', serviceLimiter, x402Route((req, res) => {
    const prompt = typeof req.query.prompt === 'string' ? req.query.prompt.slice(0, OPENAI_MAX_PROMPT_CHARS) : '';
    const pr = x402.readPaymentResponse(res.getHeader('PAYMENT-RESPONSE'));
    // determinističen demo odgovor (kot POST /service brez OPENAI_API_KEY) —
    // čista meritev plačilnih faz brez šuma zunanjega API-ja
    const response = `Odgovor zaščitene storitve (x402). Vaš poziv: "${prompt}". ` +
      `(demo način — plačano z x402 exact / ${x402.config.assetName} / Ethereum Sepolia (testno))`;
    res.setHeader('X-Server-Ms', serverMs(req));
    res.json({
      success: true, response, model: 'demo',
      payment: {
        protokol: 'x402-self', shema: 'exact',
        omrezje: x402.config.network, sredstvo: x402.config.assetName,
        txHash: pr ? pr.txHash : null, placnikGasa: 'streznik'
      }
    });
  }));

  // vpogled v stanje plačila (za meritve/uskladitev; payment_id je neugibljiv)
  app.get('/x402/payment/:id', (req, res) => {
    const row = dbx.getPayment(String(req.params.id).slice(0, 160));
    res.setHeader('X-Server-Ms', serverMs(req));
    if (!row) return res.status(404).json({ error: 'Neznano plačilo' });
    res.json({
      paymentId: row.payment_id, status: row.status, resource: row.resource,
      network: row.network, asset: row.asset, amountAtomic: row.amount_atomic,
      payer: row.payer, payTo: row.pay_to, txHash: row.tx_hash,
      blok: row.block_number, gasEnote: row.gas_used, cenaGasWei: row.effective_gas_price,
      poskusi: row.attempt, ustvarjeno: row.created_at, posodobljeno: row.updated_at
    });
  });

  logger.info({ x402: x402.summary() }, 'x402 v2 vzporedni način priklopljen (/x402/service)');
}

// ─────────────────────────────────────────────────────────
// ERROR HANDLER + BACKGROUND SWEEPER + START
// ─────────────────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Napake razčlenjevalnika telesa (`express.json`) nosijo svoj status 400: pokvarjen
  // JSON je napaka odjemalca in ne odpoved strežnika. Brez tega bi vsako skazano telo
  // izgledalo kot 500 — pri varnostnem preizkusu lažno kot ranljivost, v dnevniku pa šum.
  const code = Number.isInteger(err.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
  const log = req.log || logger;
  if (code === 500) log.error({ err: err.message }, 'Unhandled');
  else log.warn({ err: err.message, code }, 'Slaba zahteva');
  if (!res.headersSent) res.status(code).json(code === 500 ? { error: 'Internal server error' } : { error: 'Bad request', message: err.message });
});

setInterval(() => { db.sweep(); if (dbx) dbx.x402Sweep(); }, 60_000).unref();

const server = app.listen(PORT, '0.0.0.0', () => {
  logger.info({ port: PORT, network: NETWORK, merchant: MERCHANT_WALLET, mockVerify: MOCK_VERIFY, priceEth: SERVICE_PRICE_ETH }, 'X402 merged one-time merchant server started (4-message flow)');
});

function shutdown(signal) {
  logger.info({ signal }, 'Shutting down');
  server.close(() => { try { db.db.close(); } catch {} process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = app;
