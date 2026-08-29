'use strict';

/**
 * ============================================================================
 *  MOCK IoT DEVICE — one on-chain transaction PER reading
 *  (folder 02_machine_payments_per_request)
 * ============================================================================
 *
 *  Role reversal vs. folder 01:
 *    - Here the device is the SERVICE PROVIDER of sensor readings
 *      (temperature + humidity). Its wallet RECEIVES the micro-payments.
 *    - The consumer/agent (the machine that in folder 01 was the provider) now
 *      PAYS a tiny amount (1e-7 ETH ≈ 0.025 euro-cent) for EACH reading,
 *      with a SEPARATE Sepolia transaction every time.
 *
 *  This is the deliberately-expensive baseline: N readings ⇒ N on-chain
 *  transactions ⇒ the fixed gas fee is paid N times. Folder 03 amortizes it.
 *
 *  Endpoints:
 *    GET  /reading            -> 402 challenge  (no proof)
 *    GET  /reading (X-Payment)-> 200 + { temperature_c, humidity_pct, ... }
 *    POST /verify-payment     -> verify tx, mint one-shot proof
 *    GET  /config, /health
 *
 *  Measurement headers: X-Server-Ms, X-Chain-Read-Ms (as in folder 01).
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

const db = require('./db');
const authLib = require('./auth');
// Official x402 v2 — PARALLEL payment mode (X402_MODE=off|self). With 'off' the
// /x402/* routes are not mounted and the folder behaves byte-identically as before.
const x402 = require('./x402');
const dbx = x402.enabled ? require('./db_x402') : null;

const PORT = parseInt(process.env.IOT_PORT || '3100', 10);
const NETWORK = process.env.NETWORK || 'sepolia';
const RPC_URL = process.env.RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';
const MOCK_VERIFY = process.env.MOCK_VERIFY === 'true' && (!IS_PROD || process.env.FORCE_MOCK === '1');
const MIN_CONFIRMATIONS = parseInt(process.env.MIN_CONFIRMATIONS || '1', 10);

const PROOF_TOKEN_TTL_SECONDS = parseInt(process.env.PROOF_TOKEN_TTL_SECONDS || '600', 10);
const PAYMENT_REQUEST_TTL_SECONDS = parseInt(process.env.PAYMENT_REQUEST_TTL_SECONDS || '1800', 10);

// Price per reading. Default 1e-7 ETH ≈ 0.025 euro-cent at ETH_EUR_RATE.
//   1e-6 cent = 1e-8 EUR ; at 2500 EUR/ETH -> 4e-12 ETH = 4_000_000 wei.
const PRICE_WEI_PER_READING = BigInt(process.env.PRICE_WEI_PER_READING || '100000000000');
const ETH_EUR_RATE = parseFloat(process.env.ETH_EUR_RATE || '2500');
const RESOURCE = '/reading';

const logger = pino({
  level: process.env.LOG_LEVEL || (IS_PROD ? 'info' : 'debug'),
  ...(IS_PROD ? {} : { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } } })
});

const walletPath = path.join(__dirname, 'wallet.json');
let DEVICE_WALLET;
try {
  DEVICE_WALLET = ethers.getAddress(JSON.parse(fs.readFileSync(walletPath, 'utf8')).address);
  logger.info({ device: DEVICE_WALLET }, 'IoT device receiving wallet loaded (address only)');
} catch (e) {
  logger.fatal({ err: e.message }, 'Copy wallet.example.json -> wallet.json and set the RECEIVING address of the IoT device');
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const priceEth = ethers.formatEther(PRICE_WEI_PER_READING);

// ── mock sensor: small bounded random walk ──────────────────────────────────
let temperature = 22.0, humidity = 50.0;
function nextReading() {
  temperature = Math.max(15, Math.min(30, temperature + (Math.random() - 0.5) * 0.4));
  humidity = Math.max(30, Math.min(70, humidity + (Math.random() - 0.5) * 1.2));
  return {
    reading_id: uuidv4(),
    temperature_c: Math.round(temperature * 100) / 100,
    humidity_pct: Math.round(humidity * 10) / 10,
    sensor: 'DHT22 (mock)',
    timestamp: new Date().toISOString()
  };
}

const txHashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'Invalid tx hash');
const uuidSchema = z.string().uuid();
const addressSchema = z.string().refine(v => { try { ethers.getAddress(v); return true; } catch { return false; } });
const verifySchema = z.object({ requestId: uuidSchema, txHash: txHashSchema, network: z.literal(NETWORK), payerAddress: addressSchema });

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => { res.setHeader('Access-Control-Expose-Headers', 'X-Server-Ms, X-Chain-Read-Ms, X-Request-Id'); next(); });
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '64kb' }));
app.use((req, res, next) => { req.tStart = performance.now(); req.reqId = uuidv4(); req.log = logger.child({ reqId: req.reqId, path: req.path }); res.setHeader('X-Request-Id', req.reqId); next(); });
const limiter = rateLimit({ windowMs: 60_000, max: parseInt(process.env.RATE_PER_MIN || '240', 10), standardHeaders: true, legacyHeaders: false });
const sMs = (req) => (performance.now() - req.tStart).toFixed(3);

// ══════════ ADMIN LOGIN — the device is closed ═══════════════════════════════
// Only /login (+ /logout) and /health remain public. Everything else (/config,
// /reading, /verify-payment) requires a login or a machine token.
// The measurement agent identifies itself with the header `Authorization: Bearer
// <TOKEN>`; get the token on the device with:  grep TOKEN data/admin-credentials.txt
const auth = authLib.create({
  dataDir: path.join(__dirname, 'data'),
  appName: 'X402 IoT device — transactions (folder 02)',
  logger,
  homePath: '/config'          // the device has no web page; show the config after login
});
auth.mount(app);
app.use(auth.requireAdmin);

async function verifyOnChain(txHash, log) {
  try {
    const tx = await provider.getTransaction(txHash);
    if (!tx) return { verified: false, error: 'Transaction not found' };
    const rc = await provider.getTransactionReceipt(txHash);
    if (!rc) return { verified: false, error: 'Transaction not confirmed yet' };
    if (MIN_CONFIRMATIONS > 1) {
      const latest = await provider.getBlockNumber();
      if (latest - rc.blockNumber + 1 < MIN_CONFIRMATIONS) return { verified: false, error: 'Not enough confirmations' };
    }
    return { verified: true, tx: { hash: tx.hash, from: ethers.getAddress(tx.from), to: tx.to ? ethers.getAddress(tx.to) : null, value: tx.value.toString(), blockNumber: rc.blockNumber, gasUsed: rc.gasUsed ? rc.gasUsed.toString() : null, status: rc.status } };
  } catch (err) { log.error({ err: err.message }, 'chain read failed'); return { verified: false, error: err.message }; }
}

app.get('/config', (req, res) => res.json({
  network: NETWORK, chainId: NETWORK === 'sepolia' ? '0xaa36a7' : null, device: DEVICE_WALLET,
  resource: RESOURCE, priceWei: PRICE_WEI_PER_READING.toString(), priceEth,
  priceEurApprox: (parseFloat(priceEth) * ETH_EUR_RATE).toExponential(3), mockVerify: MOCK_VERIFY,
  x402: x402.enabled ? x402.summary() : null
}));

app.get('/health', async (req, res) => {
  const dbOk = db.healthCheck();
  let rpcOk = false, lastBlock = null;
  try { lastBlock = await Promise.race([provider.getBlockNumber(), new Promise((_, r) => setTimeout(() => r(new Error('t/o')), 2000))]); rpcOk = true; } catch {}
  res.setHeader('X-Server-Ms', sMs(req));
  res.status(dbOk && (rpcOk || MOCK_VERIFY) ? 200 : 503).json({ status: dbOk ? 'ok' : 'down', device: DEVICE_WALLET, mockVerify: MOCK_VERIFY, rpc: rpcOk ? 'ok' : 'down', lastBlock });
});

// GET /reading — 402 challenge or, with a valid one-shot proof, the reading.
app.get('/reading', limiter, (req, res) => {
  const proofToken = req.headers['x-payment'] || req.headers['x-payment-proof'];

  if (!proofToken) {
    const requestId = uuidv4();
    let payerAddress = req.headers['x-payer'] || req.query.payer || null;
    if (payerAddress) { try { payerAddress = ethers.getAddress(payerAddress); } catch { payerAddress = null; } }
    db.createPaymentRequest({ requestId, resource: RESOURCE, recipient: DEVICE_WALLET, amountEth: priceEth, currency: 'ETH', network: NETWORK, payerAddress, ttlSeconds: PAYMENT_REQUEST_TTL_SECONDS });
    req.log.info({ requestId }, '402 issued for /reading');
    res.setHeader('X-Server-Ms', sMs(req));
    return res.status(402).json({
      error: 'Payment Required',
      message: 'Payment is required for a sensor reading.',
      payment: { requestId, resource: RESOURCE, to: DEVICE_WALLET, amount: priceEth, priceWei: PRICE_WEI_PER_READING.toString(), currency: 'ETH', network: NETWORK, expiresInSeconds: PAYMENT_REQUEST_TTL_SECONDS }
    });
  }

  const proof = db.getProof(proofToken);
  if (!proof) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(403).json({ error: 'Invalid or expired proof token' }); }
  if (proof.consumed_at) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(403).json({ error: 'Proof token has already been consumed' }); }
  if (proof.resource !== RESOURCE) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(403).json({ error: 'Token is not valid for this resource' }); }
  if (!db.consumeProof(proofToken)) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(409).json({ error: 'Token consumed concurrently' }); }

  const reading = nextReading();
  req.log.info({ reading_id: reading.reading_id }, 'reading served');
  res.setHeader('X-Server-Ms', sMs(req));
  res.json({ success: true, reading, payment: { verified: true, txHash: proof.tx_hash, blockNumber: proof.block_number } });
});

// POST /verify-payment — verify the per-reading tx, mint a one-shot proof.
app.post('/verify-payment', limiter, async (req, res) => {
  const parsed = verifySchema.safeParse(req.body);
  if (!parsed.success) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Validation error', details: parsed.error.flatten() }); }
  const { requestId, txHash, payerAddress } = parsed.data;

  const pr = db.getPaymentRequest(requestId);
  if (!pr) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Invalid or expired payment request' }); }
  if (db.isTxRedeemed(txHash)) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Transaction has already been redeemed' }); }

  let verification, chainReadMs = 0;
  if (MOCK_VERIFY) {
    verification = { verified: true, tx: { hash: txHash, from: ethers.getAddress(payerAddress), to: DEVICE_WALLET, value: PRICE_WEI_PER_READING.toString(), blockNumber: 0, gasUsed: '21000', status: 1 } };
  } else {
    const t0 = performance.now();
    verification = await verifyOnChain(txHash, req.log);
    chainReadMs = performance.now() - t0;
    res.setHeader('X-Chain-Read-Ms', chainReadMs.toFixed(3));
  }
  if (!verification.verified) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Transaction verification failed', message: verification.error }); }
  const tx = verification.tx;
  if (tx.status !== 1) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Transaction failed on chain' }); }
  if (tx.to?.toLowerCase() !== DEVICE_WALLET.toLowerCase()) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Wrong recipient' }); }
  if (tx.from.toLowerCase() !== payerAddress.toLowerCase()) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Payer mismatch' }); }
  if (BigInt(tx.value) < PRICE_WEI_PER_READING) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Amount too low', message: `Required ${priceEth} ETH` }); }

  const proofToken = `proof_${uuidv4()}`;
  try {
    db.finalizeVerification({ proofToken, requestId, resource: pr.resource, txHash: tx.hash, blockNumber: tx.blockNumber, payerAddress: tx.from, recipient: tx.to, amountEth: ethers.formatEther(tx.value), ttlSeconds: PROOF_TOKEN_TTL_SECONDS });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Transaction has already been redeemed' }); }
    throw err;
  }
  res.setHeader('X-Server-Ms', sMs(req));
  res.json({ success: true, proofToken, resource: pr.resource, verified: true, transaction: { hash: tx.hash, blockNumber: tx.blockNumber, from: tx.from, to: tx.to, value: ethers.formatEther(tx.value) + ' ETH', gasUsed: tx.gasUsed } });
});

// ══════════ x402 v2 (PARALLEL MODE) — GET /x402/reading ═════════════════════
// 20 readings = 20 x402 exact settlements (ETH — testnet). DELIBERATELY no
// batch settlement — folder 02 stays the expensive per-payment baseline; the
// comparison with folder 03 (1 top-up + N local debits) is the point of the
// experiment. The Bearer token (auth.requireAdmin above) remains AUTHENTICATION;
// x402 is PAYMENT. Neither replaces the other.
if (x402.enabled) {
  const { middleware: x402Middleware, x402Route } = x402.buildMiddleware({
    dbx, logger,
    routes: {
      'GET /x402/reading': x402.routeConfig('IoT reading — x402 exact, payment PER READING (Ethereum Sepolia, ETH — testnet)')
    }
  });

  app.get('/x402/config', (req, res) => { res.setHeader('X-Server-Ms', sMs(req)); res.json(x402.summary()); });

  app.use(x402Middleware);

  app.get('/x402/reading', limiter, x402Route((req, res) => {
    const reading = nextReading();
    const pr = x402.readPaymentResponse(res.getHeader('PAYMENT-RESPONSE'));
    req.log.info({ reading_id: reading.reading_id }, 'x402 reading served');
    res.setHeader('X-Server-Ms', sMs(req));
    res.json({
      success: true, reading,
      payment: { protocol: 'x402-self', scheme: 'exact', network: x402.config.network, asset: x402.config.assetName, txHash: pr ? pr.txHash : null, gasPayer: 'server' }
    });
  }));

  app.get('/x402/payment/:id', (req, res) => {
    const row = dbx.getPayment(String(req.params.id).slice(0, 160));
    res.setHeader('X-Server-Ms', sMs(req));
    if (!row) return res.status(404).json({ error: 'Unknown payment' });
    res.json({
      paymentId: row.payment_id, status: row.status, resource: row.resource,
      network: row.network, asset: row.asset, amountAtomic: row.amount_atomic,
      payer: row.payer, payTo: row.pay_to, txHash: row.tx_hash,
      block: row.block_number, gasUnits: row.gas_used, gasPriceWei: row.effective_gas_price,
      poskusi: row.attempt
    });
  });

  logger.info({ x402: x402.summary() }, 'x402 v2 parallel mode mounted (/x402/reading)');
}

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Body-parser errors (`express.json`) carry their own 400 status: malformed
  // JSON is a client error, not a server failure.
  const code = Number.isInteger(err.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
  const log = req.log || logger;
  if (code === 500) log.error({ err: err.message }, 'Unhandled');
  else log.warn({ err: err.message, code }, 'Bad request');
  if (!res.headersSent) res.status(code).json(code === 500 ? { error: 'Internal server error' } : { error: 'Bad request', message: err.message });
});
setInterval(() => { db.sweep(); if (dbx) dbx.x402Sweep(); }, 60_000).unref();

const server = app.listen(PORT, '0.0.0.0', () => logger.info({ port: PORT, device: DEVICE_WALLET, priceEth, mockVerify: MOCK_VERIFY }, 'Mock IoT device (per-tx) started'));
function shutdown(sig) { logger.info({ sig }, 'Shutting down'); server.close(() => { try { db.db.close(); } catch {} process.exit(0); }); setTimeout(() => process.exit(1), 10_000).unref(); }
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
module.exports = app;
