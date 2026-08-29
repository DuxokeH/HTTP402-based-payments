require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const pino = require('pino');
const { z } = require('zod');
const OpenAI = require('openai');

const db = require('./db');

// ─────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────

const PORT = parseInt(process.env.MERCHANT_PORT || '3000', 10);
const NETWORK = process.env.NETWORK || 'sepolia';
const RPC_URL = process.env.RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';

// Experimental control condition: skip on-chain verification entirely.
// Disabled in production unless FORCE_MOCK=1.
const MOCK_VERIFY = process.env.MOCK_VERIFY === 'true' && (!IS_PROD || process.env.FORCE_MOCK === '1');

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const PROOF_TOKEN_TTL_SECONDS = parseInt(process.env.PROOF_TOKEN_TTL_SECONDS || '600', 10);
const PAYMENT_REQUEST_TTL_SECONDS = parseInt(process.env.PAYMENT_REQUEST_TTL_SECONDS || '1800', 10);
const MIN_CONFIRMATIONS = parseInt(process.env.MIN_CONFIRMATIONS || '1', 10);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OPENAI_DAILY_USD_CAP = parseFloat(process.env.OPENAI_DAILY_USD_CAP || '5');
const OPENAI_MAX_TOKENS = parseInt(process.env.OPENAI_MAX_TOKENS || '1000', 10);
const OPENAI_MAX_PROMPT_CHARS = parseInt(process.env.OPENAI_MAX_PROMPT_CHARS || '4000', 10);

// gpt-4o-mini approx pricing (USD per 1M tokens): $0.15 input, $0.60 output
const MODEL_PRICING = {
  'gpt-4o-mini': { input: 0.15 / 1_000_000, output: 0.60 / 1_000_000 },
  'gpt-4o':      { input: 2.50 / 1_000_000, output: 10.00 / 1_000_000 },
  'gpt-4-turbo': { input: 10.00 / 1_000_000, output: 30.00 / 1_000_000 }
};

const SERVICES = {
  '/service': {
    price: process.env.SERVICE_PRICE_ETH || '0.0001',
    currency: 'ETH',
    network: NETWORK
  }
};

// ─────────────────────────────────────────────────────────
// LOGGER
// ─────────────────────────────────────────────────────────

const logger = pino({
  level: process.env.LOG_LEVEL || (IS_PROD ? 'info' : 'debug'),
  ...(IS_PROD ? {} : { transport: { target: 'pino-pretty', options: { colorize: true } } }),
  redact: { paths: ['*.privateKey', '*.OPENAI_API_KEY', 'req.headers.authorization'], remove: true }
});

// ─────────────────────────────────────────────────────────
// MERCHANT WALLET
// ─────────────────────────────────────────────────────────

const walletPath = path.join(__dirname, 'wallet.json');
let MERCHANT_WALLET;
try {
  const walletData = JSON.parse(fs.readFileSync(walletPath, 'utf8'));
  MERCHANT_WALLET = ethers.getAddress(walletData.address);
  logger.info({ merchant: MERCHANT_WALLET }, 'Merchant wallet loaded');
} catch (error) {
  logger.fatal({ err: error.message }, 'Failed to load wallet.json');
  process.exit(1);
}

if (!OPENAI_API_KEY) {
  logger.warn('OPENAI_API_KEY is not set — /service will return a stub response');
}

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
const provider = new ethers.JsonRpcProvider(RPC_URL);

// ─────────────────────────────────────────────────────────
// VALIDATION SCHEMAS
// ─────────────────────────────────────────────────────────

const txHashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'Invalid transaction hash');
const uuidSchema = z.string().uuid('Invalid request ID');
const addressSchema = z.string().refine(v => {
  try { ethers.getAddress(v); return true; } catch { return false; }
}, 'Invalid Ethereum address');

const servicePostSchema = z.object({
  prompt: z.string().min(1).max(OPENAI_MAX_PROMPT_CHARS),
  model: z.string().optional()
});

// Merged exchange: payment proof and prompt travel in the same POST,
// so verification and delivery fit into a single request/response pair.
const mergedSchema = z.object({
  requestId: uuidSchema,
  txHash: txHashSchema,
  network: z.literal(NETWORK),
  payerAddress: addressSchema,
  prompt: z.string().min(1).max(OPENAI_MAX_PROMPT_CHARS),
  model: z.string().optional()
});

// ─────────────────────────────────────────────────────────
// EXPRESS APP
// ─────────────────────────────────────────────────────────

const app = express();
app.set('trust proxy', 1); // we run behind Caddy/Nginx in prod

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'script-src': ["'self'", 'https://esm.sh', "'unsafe-inline'"],
      'connect-src': ["'self'", 'https://*.publicnode.com', 'https://*.infura.io', 'https://*.alchemy.com'],
      'img-src': ["'self'", 'data:'],
      // Demo is served over plain HTTP (also from a LAN IP for Wireshark); do
      // not let the browser upgrade same-origin subresource requests to HTTPS.
      'upgrade-insecure-requests': null
    }
  }
}));

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);                      // curl, same-origin
    if (!IS_PROD) return cb(null, true);                     // permissive in dev
    if (ALLOWED_ORIGINS.length === 0) return cb(null, true); // not configured
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error(`Origin ${origin} not allowed`));
  },
  credentials: false
}));

app.use(express.json({ limit: '64kb' }));

// Per-request log context
app.use((req, res, next) => {
  req.log = logger.child({ reqId: uuidv4(), method: req.method, path: req.path });
  next();
});

const verifyLimiter = rateLimit({ windowMs: 60_000, max: parseInt(process.env.RATE_VERIFY_PER_MIN || '10', 10), standardHeaders: true, legacyHeaders: false });
const serviceLimiter = rateLimit({ windowMs: 60_000, max: parseInt(process.env.RATE_SERVICE_PER_MIN || '30', 10), standardHeaders: true, legacyHeaders: false });

// ─────────────────────────────────────────────────────────
// BLOCKCHAIN VERIFICATION
// ─────────────────────────────────────────────────────────

async function verifyTransactionOnChain(txHash, log) {
  try {
    log.info({ txHash }, 'Fetching transaction from RPC');
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
        status: receipt.status
      }
    };
  } catch (err) {
    log.error({ err: err.message }, 'Blockchain verification error');
    return { verified: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────

function estimateCost(model, promptTokens, completionTokens) {
  const p = MODEL_PRICING[model] || MODEL_PRICING['gpt-4o-mini'];
  return promptTokens * p.input + completionTokens * p.output;
}

// Runs the paid AI call and sends the final response. Every 200 carries the
// proof token alongside the content, so the whole exchange stays one
// request/response pair on the wire.
async function runDownstream(req, res, { prompt, model: requestedModel, proof }) {
  const model = requestedModel && MODEL_PRICING[requestedModel] ? requestedModel : OPENAI_MODEL;

  if (!openai) {
    return res.json({
      success: true,
      response: `[DEMO MODE — no OPENAI_API_KEY set]\n\nYou asked: ${prompt}\n\nIn production this would be an OpenAI ${model} response.`,
      model: 'demo',
      proofToken: proof.proofToken,
      expiresInSeconds: PROOF_TOKEN_TTL_SECONDS,
      payment: { verified: true, txHash: proof.txHash, blockNumber: proof.blockNumber }
    });
  }

  try {
    const completion = await openai.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: OPENAI_MAX_TOKENS
    });
    const response = completion.choices[0]?.message?.content || '';
    const usage = completion.usage || { prompt_tokens: 0, completion_tokens: 0 };
    const cost = estimateCost(model, usage.prompt_tokens, usage.completion_tokens);
    db.recordOpenAIUsage({
      model,
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      costUsd: cost
    });

    req.log.info({ model, usage, costUsd: cost.toFixed(6) }, 'OpenAI call succeeded');

    return res.json({
      success: true,
      response,
      model,
      usage,
      proofToken: proof.proofToken,
      expiresInSeconds: PROOF_TOKEN_TTL_SECONDS,
      payment: { verified: true, txHash: proof.txHash, blockNumber: proof.blockNumber }
    });
  } catch (err) {
    req.log.error({ err: err.message }, 'OpenAI call failed');
    return res.status(502).json({
      error: 'AI service error',
      message: 'The AI provider returned an error. Your payment is valid but the response could not be generated.',
      proofToken: proof.proofToken,
      payment: { verified: true, txHash: proof.txHash, blockNumber: proof.blockNumber }
    });
  }
}

// ─────────────────────────────────────────────────────────
// STATIC FRONTEND
// ─────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

// ─────────────────────────────────────────────────────────
// PUBLIC CONFIG (frontend needs to know the network + price)
// ─────────────────────────────────────────────────────────

app.get('/config', (req, res) => {
  res.json({
    network: NETWORK,
    chainId: NETWORK === 'sepolia' ? '0xaa36a7' : null,
    merchant: MERCHANT_WALLET,
    service: SERVICES['/service'],
    proofTokenTtlSeconds: PROOF_TOKEN_TTL_SECONDS,
    aiEnabled: !!openai,
    model: OPENAI_MODEL
  });
});

// ─────────────────────────────────────────────────────────
// HEALTH
// ─────────────────────────────────────────────────────────

app.get('/health', async (req, res) => {
  const dbOk = db.healthCheck();
  let rpcOk = false;
  let lastBlock = null;
  try {
    lastBlock = await Promise.race([
      provider.getBlockNumber(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('rpc timeout')), 2000))
    ]);
    rpcOk = true;
  } catch (err) {
    req.log.warn({ err: err.message }, 'RPC health check failed');
  }
  const status = dbOk && rpcOk ? 'ok' : 'degraded';
  res.status(status === 'ok' ? 200 : 503).json({
    status,
    service: 'X402 Hosting Server',
    network: NETWORK,
    merchant: MERCHANT_WALLET,
    db: dbOk ? 'ok' : 'down',
    rpc: rpcOk ? 'ok' : 'down',
    lastBlock,
    aiEnabled: !!openai,
    todayOpenAISpendUsd: db.getTodayOpenAISpend()
  });
});

// ─────────────────────────────────────────────────────────
// /service — GET (402 challenge) and POST (merged verify + AI call)
// Wire trace: GET → 402 → POST {requestId, txHash, prompt} → 200 {response, proofToken}
// ─────────────────────────────────────────────────────────

app.get('/service', serviceLimiter, (req, res) => {
  const proofToken = req.headers['x-payment'] || req.headers['x-payment-proof'];

  if (!proofToken) {
    const requestId = uuidv4();
    const serviceConfig = SERVICES['/service'];

    let payerAddress = req.headers['x-payer'] || req.query.payer || null;
    if (payerAddress) {
      try { payerAddress = ethers.getAddress(payerAddress); }
      catch { payerAddress = null; }
    }

    db.createPaymentRequest({
      requestId,
      recipient: MERCHANT_WALLET,
      amountEth: serviceConfig.price,
      currency: serviceConfig.currency,
      network: serviceConfig.network,
      payerAddress,
      ttlSeconds: PAYMENT_REQUEST_TTL_SECONDS
    });

    req.log.info({ requestId, payerAddress }, '402 Payment Required issued');

    return res.status(402).json({
      error: 'Payment Required',
      message: 'Payment required to access this service',
      payment: {
        requestId,
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
  if (!proof) {
    return res.status(403).json({ error: 'Invalid or expired proof token' });
  }

  // GET /service with valid proof: tell the client they're authorized.
  // Actual AI work happens on POST /service so we can carry the prompt.
  res.json({
    success: true,
    authorized: true,
    proofToken,
    expiresAt: new Date(proof.expires_at).toISOString(),
    consumed: !!proof.consumed_at,
    payment: { verified: true, txHash: proof.tx_hash, blockNumber: proof.block_number }
  });
});

// POST /service — the merged exchange (wire message 3 → 4): the body carries
// requestId + txHash + prompt, the server verifies the payment on-chain and
// answers with the AI response AND the proof token in a single 200.
// With an X-Payment header it instead redeems a previously minted proof.
app.post('/service', verifyLimiter, async (req, res) => {
  const proofToken = req.headers['x-payment'] || req.headers['x-payment-proof'];

  // Fallback exchange: redeem an already-minted, unconsumed proof token.
  if (proofToken) {
    const proof = db.getProof(proofToken);
    if (!proof) {
      return res.status(403).json({ error: 'Invalid or expired proof token' });
    }
    if (proof.consumed_at) {
      return res.status(403).json({ error: 'Proof token already consumed' });
    }

    const parsed = servicePostSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Validation error', details: parsed.error.flatten() });
    }
    const { prompt, model: requestedModel } = parsed.data;

    // Daily cost cap (best-effort: based on the spend so far; one request slipping through is OK)
    const todaySpend = db.getTodayOpenAISpend();
    if (todaySpend >= OPENAI_DAILY_USD_CAP) {
      req.log.warn({ todaySpend }, 'Daily OpenAI cap reached');
      return res.status(503).json({
        error: 'Service temporarily unavailable',
        message: 'Daily AI usage limit reached. Please try again tomorrow.'
      });
    }

    // Consume the token BEFORE the AI call so a slow user can't refresh-spam
    if (!db.consumeProof(proofToken)) {
      return res.status(409).json({ error: 'Proof token consumed concurrently' });
    }

    return runDownstream(req, res, {
      prompt,
      model: requestedModel,
      proof: { proofToken, txHash: proof.tx_hash, blockNumber: proof.block_number }
    });
  }

  // Merged exchange: verify the on-chain payment and deliver the content.
  const parsed = mergedSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation error', details: parsed.error.flatten() });
  }
  const { requestId, payerAddress, prompt, model: requestedModel } = parsed.data;
  // Normalize the hash so the replay guard can't be bypassed with a case
  // variant (redeemed_tx_hashes.tx_hash is a case-sensitive TEXT PRIMARY KEY).
  const txHash = parsed.data.txHash.toLowerCase();

  req.log.info({ requestId, txHash, payerAddress }, 'Merged verify+deliver received');

  const paymentRequest = db.getPaymentRequest(requestId);
  if (!paymentRequest) {
    return res.status(400).json({ error: 'Invalid or expired payment request' });
  }

  if (db.isTxRedeemed(txHash)) {
    req.log.warn({ txHash }, 'Replay attempt: tx already redeemed');
    return res.status(400).json({ error: 'Transaction already redeemed' });
  }

  let verification;
  if (MOCK_VERIFY) {
    req.log.warn({ txHash }, 'MOCK_VERIFY enabled — skipping on-chain verification');
    verification = {
      verified: true,
      tx: {
        hash: txHash,
        from: ethers.getAddress(payerAddress),
        to: paymentRequest.recipient || MERCHANT_WALLET,
        value: ethers.parseEther(paymentRequest.amount_eth).toString(),
        blockNumber: 0,
        status: 1
      }
    };
  } else {
    verification = await verifyTransactionOnChain(txHash, req.log);
  }
  if (!verification.verified) {
    return res.status(400).json({ error: 'Transaction verification failed', message: verification.error });
  }
  const tx = verification.tx;

  if (tx.status !== 1) return res.status(400).json({ error: 'Transaction failed on chain' });

  const expectedRecipient = paymentRequest.recipient || MERCHANT_WALLET;
  if (tx.to?.toLowerCase() !== expectedRecipient.toLowerCase()) {
    return res.status(400).json({ error: 'Invalid recipient' });
  }

  if (tx.from.toLowerCase() !== payerAddress.toLowerCase()) {
    return res.status(400).json({ error: 'Payer mismatch', message: 'The transaction sender does not match the declared payer address' });
  }

  // If the original payment request bound a payer, the verifying payer must match
  if (paymentRequest.payer_address &&
      paymentRequest.payer_address.toLowerCase() !== payerAddress.toLowerCase()) {
    return res.status(400).json({ error: 'Payer mismatch with original request' });
  }

  const expected = ethers.parseEther(paymentRequest.amount_eth);
  if (BigInt(tx.value) < expected) {
    return res.status(400).json({
      error: 'Insufficient amount',
      message: `Needed ${paymentRequest.amount_eth} ETH, got ${ethers.formatEther(tx.value)} ETH`
    });
  }

  const newProofToken = `proof_${uuidv4()}`;
  try {
    db.markTxRedeemed(txHash, requestId);
    db.createProof({
      proofToken: newProofToken,
      requestId,
      txHash: tx.hash,
      blockNumber: tx.blockNumber,
      payerAddress: tx.from,
      recipient: tx.to,
      amountEth: ethers.formatEther(tx.value),
      ttlSeconds: PROOF_TOKEN_TTL_SECONDS
    });
  } catch (err) {
    // UNIQUE constraint on redeemed_tx_hashes race
    if (err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
      return res.status(400).json({ error: 'Transaction already redeemed' });
    }
    throw err;
  }

  req.log.info({ proofToken: newProofToken, txHash, blockNumber: tx.blockNumber }, 'Payment verified');

  // Daily cap AFTER minting: the payment stands, so hand back the token —
  // the client can redeem it later through the X-Payment fallback branch.
  const todaySpend = db.getTodayOpenAISpend();
  if (todaySpend >= OPENAI_DAILY_USD_CAP) {
    req.log.warn({ todaySpend }, 'Daily OpenAI cap reached');
    return res.status(503).json({
      error: 'Service temporarily unavailable',
      message: 'Daily AI usage limit reached. Your payment is valid — redeem the proof token later.',
      proofToken: newProofToken,
      expiresInSeconds: PROOF_TOKEN_TTL_SECONDS
    });
  }

  if (!db.consumeProof(newProofToken)) {
    return res.status(409).json({ error: 'Proof token consumed concurrently' });
  }

  return runDownstream(req, res, {
    prompt,
    model: requestedModel,
    proof: { proofToken: newProofToken, txHash: tx.hash, blockNumber: tx.blockNumber }
  });
});

// ─────────────────────────────────────────────────────────
// ERROR HANDLER
// ─────────────────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  (req.log || logger).error({ err: err.message, stack: err.stack }, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
});

// ─────────────────────────────────────────────────────────
// BACKGROUND SWEEPER
// ─────────────────────────────────────────────────────────

setInterval(() => {
  const swept = db.sweep();
  if (swept.requests || swept.proofs) {
    logger.debug({ swept }, 'Sweeper cleaned expired rows');
  }
}, 60_000).unref();

// ─────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────

const server = app.listen(PORT, '0.0.0.0', () => {
  logger.info({
    port: PORT,
    network: NETWORK,
    merchant: MERCHANT_WALLET,
    rpc: RPC_URL,
    env: NODE_ENV,
    aiEnabled: !!openai,
    model: openai ? OPENAI_MODEL : null,
    proofTtl: PROOF_TOKEN_TTL_SECONDS,
    requestTtl: PAYMENT_REQUEST_TTL_SECONDS,
    minConfirmations: MIN_CONFIRMATIONS,
    allowedOrigins: ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : '(unrestricted dev mode)'
  }, 'X402 server started');
});

function shutdown(signal) {
  logger.info({ signal }, 'Shutting down');
  server.close(() => {
    try { db.db.close(); } catch {}
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  logger.fatal({ err: err.message, stack: err.stack }, 'Uncaught exception');
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logger.error({ reason: String(reason) }, 'Unhandled rejection');
});

module.exports = app;
