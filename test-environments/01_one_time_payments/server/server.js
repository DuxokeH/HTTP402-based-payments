'use strict';

/**
 * ============================================================================
 *  X402 — ONE-TIME PAYMENT MERCHANT SERVER  (folder 01_one_time_payments)
 * ============================================================================
 *
 *  Scenario ("One-time micropayment mode"):
 *    - This server is the SERVICE PROVIDER.
 *    - A human user (MetaMask) or a headless client pays ONE on-chain Sepolia
 *      transaction to unlock ONE protected resource (an external-API call).
 *    - Flow: GET /service -> 402 -> pay on-chain -> POST /verify-payment ->
 *            proof token -> POST /service (X-Payment: proof) -> 200 + content.
 *
 *  Measurement additions (do not exist in the original test-environments/00_demo/server/server.js):
 *    - Server-side processing time is returned in response headers so the
 *      client can separate NETWORK+RPC latency from pure SERVER compute:
 *          X-Server-Ms       total server handler time (ms)
 *          X-Chain-Read-Ms   time spent reading the tx from the chain (ms)
 *          X-Downstream-Ms   time spent in the downstream/external API (ms)
 *    - Proof is bound to the requested resource (unambiguous linking).
 *
 *  Code/comments: English (matches original server.js).
 *  User-facing 402 message goes on the wire — visible in Wireshark.
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
// Official x402 v2 — PARALLEL payment mode (X402_MODE=off|self). With 'off' the
// /x402/* routes are not mounted and the folder behaves byte-identically to before.
const x402 = require('./x402');
const dbx = x402.enabled ? require('./db_x402') : null;

// ─────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────

const PORT = parseInt(process.env.MERCHANT_PORT || '3000', 10);
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

const verifyPaymentSchema = z.object({
  requestId: uuidSchema,
  txHash: txHashSchema,
  network: z.literal(NETWORK),
  payerAddress: addressSchema
});
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
    status, service: 'X402 one-time payments (merchant)', network: NETWORK,
    merchant: MERCHANT_WALLET, db: dbOk ? 'ok' : 'down', rpc: rpcOk ? 'ok' : 'down',
    mockVerify: MOCK_VERIFY, lastBlock, aiEnabled: !!openai,
    x402: x402.enabled ? await x402.health() : { mode: 'off' }
  });
});

// ─────────────────────────────────────────────────────────
// GET /service — 402 challenge, or authorization readout with a proof token
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
      message: 'Payment is required to access this service.',
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

  const proof = db.getProof(proofToken);
  if (!proof) { res.setHeader('X-Server-Ms', serverMs(req)); return res.status(403).json({ error: 'Invalid or expired proof token' }); }
  res.setHeader('X-Server-Ms', serverMs(req));
  res.json({
    success: true, authorized: true, proofToken,
    resource: proof.resource,
    expiresAt: new Date(proof.expires_at).toISOString(),
    consumed: !!proof.consumed_at,
    payment: { verified: true, txHash: proof.tx_hash, blockNumber: proof.block_number }
  });
});

// ─────────────────────────────────────────────────────────
// POST /service — consume proof, do the paid downstream work
// ─────────────────────────────────────────────────────────

app.post('/service', serviceLimiter, async (req, res) => {
  const proofToken = req.headers['x-payment'] || req.headers['x-payment-proof'];
  if (!proofToken) { res.setHeader('X-Server-Ms', serverMs(req)); return res.status(402).json({ error: 'Payment Required', message: 'Missing X-Payment header' }); }

  const proof = db.getProof(proofToken);
  if (!proof) { res.setHeader('X-Server-Ms', serverMs(req)); return res.status(403).json({ error: 'Invalid or expired proof token' }); }
  if (proof.consumed_at) { res.setHeader('X-Server-Ms', serverMs(req)); return res.status(403).json({ error: 'Proof token has already been consumed' }); }

  // Resource binding: the proof may only unlock the resource it paid for.
  if (proof.resource !== req.path) {
    res.setHeader('X-Server-Ms', serverMs(req));
    return res.status(403).json({ error: 'Proof token is not valid for this resource', expected: proof.resource, got: req.path });
  }

  const parsed = servicePostSchema.safeParse(req.body || {});
  if (!parsed.success) { res.setHeader('X-Server-Ms', serverMs(req)); return res.status(400).json({ error: 'Validation error', details: parsed.error.flatten() }); }
  const { prompt, model: requestedModel } = parsed.data;
  const model = requestedModel && MODEL_PRICING[requestedModel] ? requestedModel : OPENAI_MODEL;

  // Daily cost cap is checked BEFORE consuming the proof, so a capped request
  // does not burn the token (only meaningful with a real OPENAI_API_KEY).
  if (openai) {
    const todaySpend = db.getTodayOpenAISpend();
    if (todaySpend >= OPENAI_DAILY_USD_CAP) { res.setHeader('X-Server-Ms', serverMs(req)); return res.status(503).json({ error: 'Daily AI budget reached' }); }
  }

  // One-shot: consume BEFORE the downstream call so a slow client cannot re-spend.
  if (!db.consumeProof(proofToken)) { res.setHeader('X-Server-Ms', serverMs(req)); return res.status(409).json({ error: 'Proof token consumed concurrently' }); }

  let downstreamMs = 0;
  // Deterministic demo downstream (default). Best for clean latency measurement:
  // it removes the highly variable external-API time from the protocol numbers.
  if (!openai) {
    const t0 = performance.now();
    const response = `Protected service response. Your prompt: "${prompt}". ` +
      `(demo mode — no external call; set OPENAI_API_KEY for a real external API)`;
    downstreamMs = performance.now() - t0;
    res.setHeader('X-Downstream-Ms', downstreamMs.toFixed(3));
    res.setHeader('X-Server-Ms', serverMs(req));
    return res.json({ success: true, response, model: 'demo', payment: { txHash: proof.tx_hash, blockNumber: proof.block_number } });
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
    res.json({ success: true, response, model, usage, payment: { txHash: proof.tx_hash, blockNumber: proof.block_number } });
  } catch (err) {
    req.log.error({ err: err.message }, 'Downstream API call failed');
    res.setHeader('X-Server-Ms', serverMs(req));
    res.status(502).json({ error: 'AI service error', message: 'The payment is valid, but the external API returned an error.' });
  }
});

// ─────────────────────────────────────────────────────────
// POST /verify-payment — verify on-chain tx, mint a proof token
// ─────────────────────────────────────────────────────────

app.post('/verify-payment', verifyLimiter, async (req, res) => {
  const parsed = verifyPaymentSchema.safeParse(req.body);
  if (!parsed.success) { res.setHeader('X-Server-Ms', serverMs(req)); return res.status(400).json({ error: 'Validation error', details: parsed.error.flatten() }); }
  const { requestId, txHash, payerAddress } = parsed.data;

  const paymentRequest = db.getPaymentRequest(requestId);
  if (!paymentRequest) { res.setHeader('X-Server-Ms', serverMs(req)); return res.status(400).json({ error: 'Invalid or expired payment request' }); }

  if (db.isTxRedeemed(txHash)) {
    req.log.warn({ txHash }, 'Replay attempt: tx already redeemed');
    res.setHeader('X-Server-Ms', serverMs(req));
    return res.status(400).json({ error: 'Transaction has already been redeemed' });
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
  if (!verification.verified) { res.setHeader('X-Server-Ms', serverMs(req)); return res.status(400).json({ error: 'Transaction verification failed', message: verification.error }); }
  const tx = verification.tx;

  if (tx.status !== 1) { res.setHeader('X-Server-Ms', serverMs(req)); return res.status(400).json({ error: 'On-chain transaction failed' }); }

  const expectedRecipient = paymentRequest.recipient || MERCHANT_WALLET;
  if (tx.to?.toLowerCase() !== expectedRecipient.toLowerCase()) { res.setHeader('X-Server-Ms', serverMs(req)); return res.status(400).json({ error: 'Wrong recipient' }); }
  if (tx.from.toLowerCase() !== payerAddress.toLowerCase()) { res.setHeader('X-Server-Ms', serverMs(req)); return res.status(400).json({ error: 'Payer mismatch', message: 'Transaction sender does not match the stated payer address' }); }
  if (paymentRequest.payer_address && paymentRequest.payer_address.toLowerCase() !== payerAddress.toLowerCase()) { res.setHeader('X-Server-Ms', serverMs(req)); return res.status(400).json({ error: 'Payer does not match the original request' }); }

  const expected = ethers.parseEther(paymentRequest.amount_eth);
  if (BigInt(tx.value) < expected) {
    res.setHeader('X-Server-Ms', serverMs(req));
    return res.status(400).json({ error: 'Amount too low', message: `Required ${paymentRequest.amount_eth} ETH, received ${ethers.formatEther(tx.value)} ETH` });
  }

  const proofToken = `proof_${uuidv4()}`;
  try {
    db.finalizeVerification({
      proofToken, requestId, resource: paymentRequest.resource,
      txHash: tx.hash, blockNumber: tx.blockNumber, payerAddress: tx.from,
      recipient: tx.to, amountEth: ethers.formatEther(tx.value), ttlSeconds: PROOF_TOKEN_TTL_SECONDS
    });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') { res.setHeader('X-Server-Ms', serverMs(req)); return res.status(400).json({ error: 'Transaction has already been redeemed' }); }
    throw err;
  }

  req.log.info({ proofToken, txHash, blockNumber: tx.blockNumber }, 'Payment verified');
  res.setHeader('X-Server-Ms', serverMs(req));
  res.json({
    success: true, proofToken, resource: paymentRequest.resource,
    expiresInSeconds: PROOF_TOKEN_TTL_SECONDS, verified: true,
    transaction: { hash: tx.hash, blockNumber: tx.blockNumber, from: tx.from, to: tx.to, value: ethers.formatEther(tx.value) + ' ETH', gasUsed: tx.gasUsed }
  });
});

// ─────────────────────────────────────────────────────────
// x402 v2 (PARALLEL MODE) — GET /x402/service, GET /x402/config
//
// Official protocol: 402 + PAYMENT-REQUIRED → the client signs an EIP-3009
// authorization (test ETH) → repeated GET with PAYMENT-SIGNATURE →
// the server ITSELF verifies and settles (self-facilitated) → 200 + PAYMENT-RESPONSE.
// The custom protocol above (/service + /verify-payment) is untouched.
// ─────────────────────────────────────────────────────────

if (x402.enabled) {
  const { middleware: x402Middleware, x402Route } = x402.buildMiddleware({
    dbx, logger,
    routes: {
      'GET /x402/service': x402.routeConfig('Protected service — x402 exact (Ethereum Sepolia, test ETH)')
    }
  });

  // public configuration for browsers/agents (no secrets)
  app.get('/x402/config', (req, res) => {
    res.setHeader('X-Server-Ms', serverMs(req));
    res.json(x402.summary());
  });

  app.use(x402Middleware);

  app.get('/x402/service', serviceLimiter, x402Route((req, res) => {
    const prompt = typeof req.query.prompt === 'string' ? req.query.prompt.slice(0, OPENAI_MAX_PROMPT_CHARS) : '';
    const pr = x402.readPaymentResponse(res.getHeader('PAYMENT-RESPONSE'));
    // deterministic demo response (like POST /service without OPENAI_API_KEY) —
    // a clean measurement of the payment phases without external-API noise
    const response = `Protected service response (x402). Your prompt: "${prompt}". ` +
      `(demo mode — paid via x402 exact / ${x402.config.assetName} / Ethereum Sepolia (testnet))`;
    res.setHeader('X-Server-Ms', serverMs(req));
    res.json({
      success: true, response, model: 'demo',
      payment: {
        protocol: 'x402-self', scheme: 'exact',
        network: x402.config.network, asset: x402.config.assetName,
        txHash: pr ? pr.txHash : null, gasPayer: 'server'
      }
    });
  }));

  // payment state readout (for measurements/reconciliation; payment_id is unguessable)
  app.get('/x402/payment/:id', (req, res) => {
    const row = dbx.getPayment(String(req.params.id).slice(0, 160));
    res.setHeader('X-Server-Ms', serverMs(req));
    if (!row) return res.status(404).json({ error: 'Unknown payment' });
    res.json({
      paymentId: row.payment_id, status: row.status, resource: row.resource,
      network: row.network, asset: row.asset, amountAtomic: row.amount_atomic,
      payer: row.payer, payTo: row.pay_to, txHash: row.tx_hash,
      block: row.block_number, gasUnits: row.gas_used, gasPriceWei: row.effective_gas_price,
      attempts: row.attempt, createdAt: row.created_at, updatedAt: row.updated_at
    });
  });

  logger.info({ x402: x402.summary() }, 'x402 v2 parallel mode mounted (/x402/service)');
}

// ─────────────────────────────────────────────────────────
// ERROR HANDLER + BACKGROUND SWEEPER + START
// ─────────────────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Body-parser errors (`express.json`) carry their own 400 status: malformed
  // JSON is a client error, not a server failure. Without this, every mangled body
  // would look like a 500 — a false vulnerability in the security test, and noise in the log.
  const code = Number.isInteger(err.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
  const log = req.log || logger;
  if (code === 500) log.error({ err: err.message }, 'Unhandled');
  else log.warn({ err: err.message, code }, 'Bad request');
  if (!res.headersSent) res.status(code).json(code === 500 ? { error: 'Internal server error' } : { error: 'Bad request', message: err.message });
});

setInterval(() => { db.sweep(); if (dbx) dbx.x402Sweep(); }, 60_000).unref();

const server = app.listen(PORT, '0.0.0.0', () => {
  logger.info({ port: PORT, network: NETWORK, merchant: MERCHANT_WALLET, mockVerify: MOCK_VERIFY, priceEth: SERVICE_PRICE_ETH }, 'X402 one-time merchant server started');
});

function shutdown(signal) {
  logger.info({ signal }, 'Shutting down');
  server.close(() => { try { db.db.close(); } catch {} process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = app;
