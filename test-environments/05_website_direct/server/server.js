'use strict';

/**
 * ============================================================================
 *  X402 SHOWCASE SITE — all three payment modes on ONE hosted server
 *  (folder 05_website_direct)
 * ============================================================================
 *
 *  One Express app + one web UI with three tabs:
 *    1) Single payment     — human pays via MetaMask   → /single/*
 *    2) Machine payments   — 20 on-chain tx (M2M)      → /tx/*   (+ SSE /run/tx)
 *    3) Metered session    — 1 top-up + N signed debits (M2M) → /metered/* (+ SSE /run/metered)
 *
 *  The two M2M modes are driven by an in-process agent (runner.js) that makes
 *  REAL HTTP calls to this server over loopback (so Wireshark still sees the
 *  402 / X-Payment / X-Signature traffic) and streams live events to the page
 *  via Server-Sent Events.
 *
 *  No smart contracts — the metered mode uses off-chain EIP-191 signed debits
 *  (smart contracts are future work).
 * ============================================================================
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const { v4: uuidv4 } = require('uuid');
const pino = require('pino');
const { z } = require('zod');

const db = require('./db');
const runner = require('./runner');
// Official x402 v2 — SELF-FACILITATED parallel mode (X402_MODE=self): the merchant
// verifies and settles ETH on Ethereum Sepolia itself (testnet — the settlement is
// synthetic/mock) through its own X402_RPC_URL.
// No calls to any facilitator — the opposite of folder 04.
const x402 = require('./x402');
const dbx = x402.enabled ? require('./db_x402') : null;
const authLib = require('./auth');

// ── config ───────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '8080', 10);
const NETWORK = process.env.NETWORK || 'sepolia';
const RPC_URL = process.env.RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';
const MOCK_VERIFY = process.env.MOCK_VERIFY === 'true' && (!IS_PROD || process.env.FORCE_MOCK === '1');
const MIN_CONFIRMATIONS = parseInt(process.env.MIN_CONFIRMATIONS || '1', 10);
const ETH_EUR_RATE = parseFloat(process.env.ETH_EUR_RATE || '2500');

const PROOF_TTL = parseInt(process.env.PROOF_TOKEN_TTL_SECONDS || '600', 10);
const REQ_TTL = parseInt(process.env.PAYMENT_REQUEST_TTL_SECONDS || '1800', 10);

const SERVICE_PRICE_ETH = process.env.SERVICE_PRICE_ETH || '0.0000001';                 // ≈ €0.0002
const PRICE_WEI_PER_READING = BigInt(process.env.PRICE_WEI_PER_READING || '100000000000');    // per IoT reading
const PRICE_WEI_PER_CALL = BigInt(process.env.PRICE_WEI_PER_CALL || '100000000000');          // metered per reading
const PRICE_WEI_PER_BYTE = BigInt(process.env.PRICE_WEI_PER_BYTE || '0');
const MIN_PRICE_WEI = BigInt(process.env.MIN_PRICE_WEI || '100000000000');
const DEBIT_MAX_AGE_MS = parseInt(process.env.DEBIT_MAX_AGE_MS || '120000', 10);
const SESSION_TTL_DEFAULT = parseInt(process.env.SESSION_TTL_DEFAULT || '3600', 10);
const SESSION_TTL_MAX = parseInt(process.env.SESSION_TTL_MAX || '86400', 10);

// Browser session token (docs/IDENTITY.md §2, improvement B): correlation only, never authorization.
const SID_COOKIE = 'sid';
const WEB_SESSION_TTL = parseInt(process.env.WEB_SESSION_TTL_SECONDS || '1800', 10);
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';   // force `Secure` when TLS is terminated upstream

const RES_SINGLE = '/single/service';
const RES_TX = '/tx/reading';
const RES_METERED = '/metered/reading-metered';

// Origin of the configured RPC, so the browser (viem publicClient) may reach it under CSP.
const RPC_ORIGIN = (() => { try { return new URL(RPC_URL).origin; } catch { return null; } })();

const logger = pino({
  level: process.env.LOG_LEVEL || (IS_PROD ? 'info' : 'debug'),
  ...(IS_PROD ? {} : { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } } })
});

// ── wallets ──────────────────────────────────────────────────────────────────
// wallet.json: { address: <receiver, merchant+IoT device>, payerPrivateKey?: <M2M consumer, real mode> }
const walletPath = path.join(__dirname, 'wallet.json');
let RECEIVER, PAYER_PK = null, X402_PAYER_PK = null;
try {
  const w = JSON.parse(fs.readFileSync(walletPath, 'utf8'));
  RECEIVER = ethers.getAddress(w.address);
  if (w.payerPrivateKey && /^0x[0-9a-fA-F]{64}$/.test(w.payerPrivateKey)) PAYER_PK = w.payerPrivateKey;
  if (w.x402PayerPrivateKey && /^0x[0-9a-fA-F]{64}$/.test(w.x402PayerPrivateKey)) X402_PAYER_PK = w.x402PayerPrivateKey;
  logger.info({ receiver: RECEIVER, hasPayerKey: !!PAYER_PK }, 'Wallet loaded');
} catch (e) {
  logger.fatal({ err: e.message }, 'Copy wallet.example.json -> wallet.json and set the receiver address');
  process.exit(1);
}
const provider = new ethers.JsonRpcProvider(RPC_URL);

// ── validation ───────────────────────────────────────────────────────────────
const txHashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const uuidSchema = z.string().uuid();
const addressSchema = z.string().refine(v => { try { ethers.getAddress(v); return true; } catch { return false; } });
const verifySchema = z.object({ requestId: uuidSchema, txHash: txHashSchema, network: z.literal(NETWORK), payerAddress: addressSchema });
const openSchema = z.object({ txHash: txHashSchema, payerAddress: addressSchema, budgetWei: z.string().regex(/^\d+$/).optional(), ttlSeconds: z.number().int().positive().optional(), mockDepositWei: z.string().regex(/^\d+$/).optional() });

// ── app ──────────────────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => { res.setHeader('Access-Control-Expose-Headers', 'X-Server-Ms, X-Chain-Read-Ms, X-Downstream-Ms, X-Charged-Wei, X-Balance-Wei, X-Budget-Remaining-Wei, X-Session-Expires, X-Request-Id'); next(); });
app.use(helmet({ contentSecurityPolicy: { useDefaults: true, directives: {
  'script-src': ["'self'", 'https://esm.sh', "'unsafe-inline'"],
  'connect-src': ["'self'", 'https://*.publicnode.com', 'https://*.infura.io', 'https://*.alchemy.com', ...(RPC_ORIGIN ? [RPC_ORIGIN] : [])],
  'img-src': ["'self'", 'data:'],
  // Outside production, drop helmet's default `upgrade-insecure-requests`: access over
  // plain HTTP (LAN/loopback) is deliberately supported for the Wireshark capture, and the
  // browser would otherwise try to upgrade everything to https, leaving the page broken.
  // In production (behind Caddy with TLS) the directive stays.
  ...(IS_PROD ? {} : { 'upgrade-insecure-requests': null }) } } }));
app.use(cors());
app.use(express.json({ limit: '64kb' }));
app.use((req, res, next) => { req.tStart = performance.now(); req.reqId = uuidv4(); req.log = logger.child({ reqId: req.reqId, path: req.path }); res.setHeader('X-Request-Id', req.reqId); next(); });
const sMs = (req) => (performance.now() - req.tStart).toFixed(3);

// ══════════ ADMIN LOGIN — the entire website is locked ═══════════════════════
// Only /login (+ /logout) and /health (for the container healthcheck) stay public.
// Everything else — the page, /config, all three payment flows, /run/* and /session —
// requires a login (cookie) or a machine token (Authorization: Bearer).
// The credentials are created on the first start → data/admin-credentials.txt.
const auth = authLib.create({
  dataDir: path.join(__dirname, 'data'),
  appName: 'X402 website — direct (folder 05)',
  logger
});
auth.mount(app);                 // /login, /logout — before the lockdown
app.use(auth.requireAdmin);      // from here on everything is locked

// ══════════ SESSION TOKEN `sid` — CORRELATION, NEVER AUTHORIZATION ═══════════
// (docs/IDENTITY.md §2, improvement B)
//
// On the first GET the server stores a short-lived `sid` token in a cookie and on
// later requests reads it ONLY in order to tie the events of one session together
// (402 → proof → access). Because the token travels with the browser and not with
// the network, "the same person" stays recognised even if the IP changes along the
// way (mobile ↔ wifi, NAT, CGNAT).
//
// KEY RULE (docs/IDENTITY.md §5 B.4): a missing, invalid or changed `sid` may
// NEVER cause a rejection. That is why everything below sits inside `try` and
// always calls `next()`. The real identity remains the wallet
// (the signature / sender of the transaction) and the one-time tokens —
// see docs/IDENTITY.md §2 and §3.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function readCookie(header, name) {
  if (!header) return null;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
function buildSidCookie(sid, req) {
  const secure = COOKIE_SECURE || req.secure;   // req.secure honours X-Forwarded-Proto ('trust proxy' is set)
  return `${SID_COOKIE}=${sid}; Path=/; Max-Age=${WEB_SESSION_TTL}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}
app.use((req, res, next) => {
  try {
    // In-process M2M agent (runner.js): a machine, not a browser — its identity is
    // the wallet + EIP-191 signature, so it gets no browser session cookie.
    // /health is polled by the container healthcheck; it would only pile up empty sessions.
    if (req.get('X-Demo-Agent') || req.path === '/health') return next();
    let sid = readCookie(req.headers.cookie, SID_COOKIE);
    if (!sid || !UUID_RE.test(sid)) {
      sid = uuidv4();
      res.append('Set-Cookie', buildSidCookie(sid, req));
    }
    req.sid = sid;
    const t = db.touchWebSession({ sid, ip: req.ip, userAgent: req.get('user-agent'), ttlSeconds: WEB_SESSION_TTL });
    if (t.ipChanged) req.log.info({ sid: sid.slice(0, 8) }, 'The session IP changed — access is NOT denied (identity is not tied to the IP)');
  } catch (err) {
    (req.log || logger).warn({ err: err.message }, 'session correlation failed — the request continues normally');
  }
  next();
});
// Correlation helpers: best-effort, never throw into the request path.
const linkSid = (req, kind, ref) => { try { if (req.sid && ref) db.linkWebSession({ sid: req.sid, kind, ref, ip: req.ip }); } catch (e) { (req.log || logger).warn({ err: e.message }, 'session link failed'); } };
const notePayer = (req, addr) => { try { if (req.sid && addr) db.setWebSessionPayer(req.sid, ethers.getAddress(addr)); } catch (e) { (req.log || logger).warn({ err: e.message }, 'recording the payer in the session failed'); } };

app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

// ── shared on-chain verification ─────────────────────────────────────────────
async function verifyOnChain(txHash, log) {
  try {
    const tx = await provider.getTransaction(txHash);
    if (!tx) return { verified: false, error: 'Transaction not found' };
    const rc = await provider.getTransactionReceipt(txHash);
    if (!rc) return { verified: false, error: 'Transaction not confirmed yet' };
    if (MIN_CONFIRMATIONS > 1) { const latest = await provider.getBlockNumber(); if (latest - rc.blockNumber + 1 < MIN_CONFIRMATIONS) return { verified: false, error: 'Not enough confirmations' }; }
    return { verified: true, tx: { hash: tx.hash, from: ethers.getAddress(tx.from), to: tx.to ? ethers.getAddress(tx.to) : null, value: tx.value.toString(), blockNumber: rc.blockNumber, gasUsed: rc.gasUsed ? rc.gasUsed.toString() : null, status: rc.status } };
  } catch (err) { log.error({ err: err.message }, 'chain read failed'); return { verified: false, error: err.message }; }
}

// mock sensor
let temperature = 22.0, humidity = 50.0;
function nextReading() {
  temperature = Math.max(15, Math.min(30, temperature + (Math.random() - 0.5) * 0.4));
  humidity = Math.max(30, Math.min(70, humidity + (Math.random() - 0.5) * 1.2));
  return { reading_id: uuidv4(), temperature_c: Math.round(temperature * 100) / 100, humidity_pct: Math.round(humidity * 10) / 10, sensor: 'DHT22 (mock)', timestamp: new Date().toISOString() };
}

// ── site config + health ─────────────────────────────────────────────────────
app.get('/config', (req, res) => res.json({
  network: NETWORK, chainId: NETWORK === 'sepolia' ? '0xaa36a7' : null, receiver: RECEIVER, mockVerify: MOCK_VERIFY,
  rpcUrl: RPC_URL, ethEurRate: ETH_EUR_RATE, hasPayerKey: !!PAYER_PK,
  single: { resource: RES_SINGLE, priceEth: SERVICE_PRICE_ETH, priceEurApprox: (parseFloat(SERVICE_PRICE_ETH) * ETH_EUR_RATE).toFixed(4) },
  tx: { resource: RES_TX, priceWei: PRICE_WEI_PER_READING.toString(), priceEth: ethers.formatEther(PRICE_WEI_PER_READING) },
  metered: { resource: RES_METERED, priceWeiPerCall: PRICE_WEI_PER_CALL.toString(), priceWeiPerByte: PRICE_WEI_PER_BYTE.toString(), minPriceWei: MIN_PRICE_WEI.toString(), sessionTtlDefault: SESSION_TTL_DEFAULT },
  x402: x402.enabled ? x402.summary() : null
}));

// A view of the browser session — proof that the server "stores a token on GET and
// recognises it later", even if the IP changes in between. It returns only a shortened
// `sid` (the cookie is HttpOnly) and the number of IP changes, never the addresses
// themselves. Without a cookie it answers 200 with `session: null` — never 403
// (docs/IDENTITY.md §5 B.4).
app.get('/session', (req, res) => {
  let session = null;
  try { session = req.sid ? db.webSessionView(req.sid) : null; } catch (e) { req.log.warn({ err: e.message }, 'reading the session failed'); }
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Server-Ms', sMs(req));
  res.json({
    success: true, session,
    pravilo: 'sid is correlation only. A missing or changed sid (e.g. when the network/IP changes) does not cause a rejection. Identity = wallet + one-time tokens, not the IP address.'
  });
});

app.get('/health', async (req, res) => {
  const dbOk = db.healthCheck();
  let rpcOk = false, lastBlock = null;
  try { lastBlock = await Promise.race([provider.getBlockNumber(), new Promise((_, r) => setTimeout(() => r(new Error('t/o')), 2000))]); rpcOk = true; } catch {}
  res.setHeader('X-Server-Ms', sMs(req));
  res.status(dbOk ? 200 : 503).json({ status: dbOk ? 'ok' : 'down', receiver: RECEIVER, mockVerify: MOCK_VERIFY, rpc: rpcOk ? 'ok' : 'down', lastBlock });
});

// ════════════════════════════ 1) SINGLE (MetaMask) ════════════════════════
app.get('/single/config', (req, res) => res.json({ network: NETWORK, chainId: NETWORK === 'sepolia' ? '0xaa36a7' : null, merchant: RECEIVER, service: { price: SERVICE_PRICE_ETH, currency: 'ETH', network: NETWORK }, priceEurApprox: (parseFloat(SERVICE_PRICE_ETH) * ETH_EUR_RATE).toFixed(4), mockVerify: MOCK_VERIFY }));

app.get('/single/service', (req, res) => {
  const proofToken = req.headers['x-payment'] || req.headers['x-payment-proof'];
  if (!proofToken) {
    const requestId = uuidv4();
    let payer = req.headers['x-payer'] || req.query.payer || null;
    if (payer) { try { payer = ethers.getAddress(payer); } catch { payer = null; } }
    db.createPaymentRequest({ requestId, resource: RES_SINGLE, recipient: RECEIVER, amountEth: SERVICE_PRICE_ETH, currency: 'ETH', network: NETWORK, payerAddress: payer, ttlSeconds: REQ_TTL });
    linkSid(req, 'request_id', requestId);
    res.setHeader('X-Server-Ms', sMs(req));
    return res.status(402).json({ error: 'Payment Required', message: 'Payment is required to access this service.', payment: { requestId, resource: RES_SINGLE, to: RECEIVER, amount: SERVICE_PRICE_ETH, currency: 'ETH', network: NETWORK, expiresInSeconds: REQ_TTL } });
  }
  const proof = db.getProof(proofToken);
  if (!proof) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(403).json({ error: 'Invalid or expired proof token' }); }
  res.setHeader('X-Server-Ms', sMs(req));
  res.json({ success: true, authorized: true, proofToken, resource: proof.resource, consumed: !!proof.consumed_at, payment: { verified: true, txHash: proof.tx_hash, blockNumber: proof.block_number } });
});

app.post('/single/service', (req, res) => {
  const proofToken = req.headers['x-payment'] || req.headers['x-payment-proof'];
  if (!proofToken) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(402).json({ error: 'Payment Required', message: 'The X-Payment header is missing' }); }
  const proof = db.getProof(proofToken);
  if (!proof) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(403).json({ error: 'Invalid or expired proof token' }); }
  if (proof.consumed_at) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(403).json({ error: 'The proof token has already been used' }); }
  if (proof.resource !== RES_SINGLE) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(403).json({ error: 'The token is not valid for this resource' }); }
  const prompt = (req.body && typeof req.body.prompt === 'string') ? req.body.prompt.slice(0, 4000) : 'hello';
  if (!db.consumeProof(proofToken)) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(409).json({ error: 'The token was consumed concurrently' }); }
  res.setHeader('X-Server-Ms', sMs(req));
  res.json({ success: true, response: `Response of the protected service. Your prompt: "${prompt}". (demo mode)`, model: 'demo', payment: { txHash: proof.tx_hash, blockNumber: proof.block_number } });
});

app.post('/single/verify', async (req, res, next) => {
  const parsed = verifySchema.safeParse(req.body);
  if (!parsed.success) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Validation error', details: parsed.error.flatten() }); }
  const { requestId, txHash, payerAddress } = parsed.data;
  const pr = db.getPaymentRequest(requestId);
  if (!pr) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Invalid or expired payment request' }); }
  if (db.isTxRedeemed(txHash)) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'The transaction has already been redeemed' }); }
  const v = await verifyPayment(txHash, payerAddress, RECEIVER, ethers.parseEther(pr.amount_eth), req);
  if (v.error) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json(v.error); }
  const tx = v.tx;
  const proofToken = `proof_${uuidv4()}`;
  try { db.finalizeVerification({ proofToken, requestId, resource: pr.resource, txHash: tx.hash, blockNumber: tx.blockNumber, payerAddress: tx.from, recipient: tx.to, amountEth: ethers.formatEther(tx.value), ttlSeconds: PROOF_TTL }); }
  catch (err) { if (err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'The transaction has already been redeemed' }); } return next(err); }
  linkSid(req, 'proof_token', proofToken); notePayer(req, tx.from);
  res.setHeader('X-Server-Ms', sMs(req));
  res.json({ success: true, proofToken, resource: pr.resource, verified: true, transaction: { hash: tx.hash, blockNumber: tx.blockNumber, from: tx.from, to: tx.to, value: ethers.formatEther(tx.value) + ' ETH', gasUsed: tx.gasUsed } });
});

// ════════════════════════════ 2) TX (per reading, M2M) ══════════════════════
app.get('/tx/reading', (req, res) => {
  const proofToken = req.headers['x-payment'] || req.headers['x-payment-proof'];
  if (!proofToken) {
    const requestId = uuidv4();
    let payer = req.headers['x-payer'] || req.query.payer || null;
    if (payer) { try { payer = ethers.getAddress(payer); } catch { payer = null; } }
    db.createPaymentRequest({ requestId, resource: RES_TX, recipient: RECEIVER, amountEth: ethers.formatEther(PRICE_WEI_PER_READING), currency: 'ETH', network: NETWORK, payerAddress: payer, ttlSeconds: REQ_TTL });
    linkSid(req, 'request_id', requestId);
    res.setHeader('X-Server-Ms', sMs(req));
    return res.status(402).json({ error: 'Payment Required', message: 'Payment is required for a sensor reading.', payment: { requestId, resource: RES_TX, to: RECEIVER, amount: ethers.formatEther(PRICE_WEI_PER_READING), priceWei: PRICE_WEI_PER_READING.toString(), currency: 'ETH', network: NETWORK, expiresInSeconds: REQ_TTL } });
  }
  const proof = db.getProof(proofToken);
  if (!proof) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(403).json({ error: 'Invalid or expired proof token' }); }
  if (proof.consumed_at) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(403).json({ error: 'The proof token has already been used' }); }
  if (proof.resource !== RES_TX) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(403).json({ error: 'The token is not valid for this resource' }); }
  if (!db.consumeProof(proofToken)) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(409).json({ error: 'The token was consumed concurrently' }); }
  res.setHeader('X-Server-Ms', sMs(req));
  res.json({ success: true, reading: nextReading(), payment: { verified: true, txHash: proof.tx_hash, blockNumber: proof.block_number } });
});

app.post('/tx/verify', async (req, res, next) => {
  const parsed = verifySchema.safeParse(req.body);
  if (!parsed.success) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Validation error', details: parsed.error.flatten() }); }
  const { requestId, txHash, payerAddress } = parsed.data;
  const pr = db.getPaymentRequest(requestId);
  if (!pr) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Invalid or expired payment request' }); }
  if (db.isTxRedeemed(txHash)) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'The transaction has already been redeemed' }); }
  const v = await verifyPayment(txHash, payerAddress, RECEIVER, PRICE_WEI_PER_READING, req);
  if (v.error) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json(v.error); }
  const tx = v.tx;
  const proofToken = `proof_${uuidv4()}`;
  try { db.finalizeVerification({ proofToken, requestId, resource: pr.resource, txHash: tx.hash, blockNumber: tx.blockNumber, payerAddress: tx.from, recipient: tx.to, amountEth: ethers.formatEther(tx.value), ttlSeconds: PROOF_TTL }); }
  catch (err) { if (err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'The transaction has already been redeemed' }); } return next(err); }
  linkSid(req, 'proof_token', proofToken); notePayer(req, tx.from);
  res.setHeader('X-Server-Ms', sMs(req));
  res.json({ success: true, proofToken, resource: pr.resource, verified: true, transaction: { hash: tx.hash, blockNumber: tx.blockNumber, gasUsed: tx.gasUsed } });
});

// shared verify helper for one-time + per-tx (returns {tx} or {error})
async function verifyPayment(txHash, payerAddress, expectedRecipient, minValueWei, req) {
  let verification;
  if (MOCK_VERIFY) {
    verification = { verified: true, tx: { hash: txHash, from: ethers.getAddress(payerAddress), to: expectedRecipient, value: minValueWei.toString(), blockNumber: 0, gasUsed: '21000', status: 1 } };
  } else {
    verification = await verifyOnChain(txHash, req.log);
  }
  if (!verification.verified) return { error: { error: 'Transaction verification failed', message: verification.error } };
  const tx = verification.tx;
  if (tx.status !== 1) return { error: { error: 'The on-chain transaction failed' } };
  if (tx.to?.toLowerCase() !== expectedRecipient.toLowerCase()) return { error: { error: 'Wrong recipient' } };
  if (tx.from.toLowerCase() !== payerAddress.toLowerCase()) return { error: { error: 'Payer mismatch' } };
  if (BigInt(tx.value) < BigInt(minValueWei)) return { error: { error: 'Amount too low' } };
  return { tx };
}

// ════════════════════════════ 3) METERED (session, M2M) ═════════════════════
function debitMessage(payer, sessionId, nonce, reqPath, maxWei) { return `x402-debit:${payer.toLowerCase()}:${sessionId}:${nonce}:${reqPath}:${maxWei}`; }

app.post('/metered/session/open', async (req, res, next) => {
  const parsed = openSchema.safeParse(req.body);
  if (!parsed.success) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Validation error', details: parsed.error.flatten() }); }
  const { txHash, payerAddress, budgetWei, ttlSeconds, mockDepositWei } = parsed.data;
  if (db.isTxRedeemed(txHash)) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'The transaction has already been redeemed' }); }
  let verification;
  if (MOCK_VERIFY) {
    const mockDeposit = mockDepositWei ? BigInt(mockDepositWei).toString() : (PRICE_WEI_PER_CALL * 25n).toString();
    verification = { verified: true, tx: { hash: txHash, from: ethers.getAddress(payerAddress), to: RECEIVER, value: mockDeposit, blockNumber: 0, gasUsed: '21000', status: 1 } };
  } else {
    verification = await verifyOnChain(txHash, req.log);
  }
  if (!verification.verified) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Transaction verification failed', message: verification.error }); }
  const tx = verification.tx;
  if (tx.status !== 1) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'The on-chain transaction failed' }); }
  if (tx.to?.toLowerCase() !== RECEIVER.toLowerCase()) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Wrong recipient' }); }
  if (tx.from.toLowerCase() !== payerAddress.toLowerCase()) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Payer mismatch' }); }
  const deposit = BigInt(tx.value);
  let budget = deposit; if (budgetWei) { const b = BigInt(budgetWei); budget = b < deposit ? b : deposit; }
  const ttl = Math.min(ttlSeconds || SESSION_TTL_DEFAULT, SESSION_TTL_MAX);
  const sessionId = `sess_${uuidv4()}`;
  let session;
  try { session = db.openSession({ sessionId, payerAddress: tx.from, resource: RES_METERED, depositWei: deposit, budgetWei: budget, txHash: tx.hash, ttlSeconds: ttl }); }
  catch (err) { if (err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'The transaction has already been redeemed' }); } return next(err); }
  linkSid(req, 'metered_session', sessionId); notePayer(req, tx.from);
  res.setHeader('X-Server-Ms', sMs(req));
  res.json({ success: true, session: db.sessionView(session), transaction: { hash: tx.hash, blockNumber: tx.blockNumber, gasUsed: tx.gasUsed } });
});

app.get('/metered/session/:id', (req, res) => {
  const s = db.getSession(req.params.id);
  res.setHeader('X-Server-Ms', sMs(req));
  if (!s) return res.status(404).json({ error: 'The session does not exist' });
  res.json({ success: true, session: db.sessionView(s) });
});

app.get('/metered/reading-metered', (req, res) => {
  const payer = req.header('X-Payer'), sessionId = req.header('X-Session'), nonce = req.header('X-Nonce'), signature = req.header('X-Signature');
  const maxWei = req.header('X-Max-Wei') || PRICE_WEI_PER_CALL.toString();
  if (!payer || !sessionId || !nonce || !signature) {
    res.setHeader('X-Server-Ms', sMs(req));
    return res.status(402).json({ error: 'payment_required', metered: { mode: 'prepaid-session', openEndpoint: '/metered/session/open', priceWeiPerCall: PRICE_WEI_PER_CALL.toString(), priceWeiPerByte: PRICE_WEI_PER_BYTE.toString(), minPriceWei: MIN_PRICE_WEI.toString(), signedHeaders: ['X-Payer', 'X-Session', 'X-Nonce', 'X-Signature', 'X-Max-Wei'], message: 'x402-debit:{payer}:{session}:{nonce}:' + RES_METERED + ':{maxWei}' } });
  }
  let payerAddr; try { payerAddr = ethers.getAddress(payer); } catch { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Invalid payer address' }); }
  const nonceTs = parseInt(String(nonce).split('-')[0], 10);
  if (!Number.isFinite(nonceTs) || Math.abs(Date.now() - nonceTs) > DEBIT_MAX_AGE_MS) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Stale or invalid nonce' }); }
  // sign/verify against the FIXED resource path (mount-prefix safe)
  let recovered; try { recovered = ethers.verifyMessage(debitMessage(payerAddr, sessionId, nonce, RES_METERED, maxWei), signature); }
  catch { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Invalid signature' }); }
  if (recovered.toLowerCase() !== payerAddr.toLowerCase()) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(403).json({ error: 'The signature does not match the payer' }); }
  const s = db.getSession(sessionId);
  if (!s) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(404).json({ error: 'The session does not exist' }); }
  if (s.payer_address.toLowerCase() !== payerAddr.toLowerCase()) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(403).json({ error: 'The session does not belong to this payer' }); }
  const reading = nextReading();
  const body = JSON.stringify({ success: true, reading });
  const bytes = Buffer.byteLength(body);
  let price = PRICE_WEI_PER_CALL + PRICE_WEI_PER_BYTE * BigInt(bytes);
  if (price < MIN_PRICE_WEI) price = MIN_PRICE_WEI;
  if (price > BigInt(maxWei)) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'The price exceeds the signed maximum', priceWei: price.toString(), maxWei }); }
  const result = db.debit({ sessionId, amountWei: price, nonce, requestPath: RES_METERED, bytes });
  if (!result.ok) {
    res.setHeader('X-Server-Ms', sMs(req));
    if (result.reason === 'nonce_reused') return res.status(403).json({ error: 'Nonce already used (replay rejected)' });
    if (result.reason === 'session_expired') return res.status(403).json({ error: 'The session has expired (time to live)' });
    if (result.reason === 'budget_exceeded') return res.status(402).json({ error: 'The session budget has been exceeded', reason: 'budget_exceeded', budgetRemainingWei: (result.budgetRemainingWei ?? 0n).toString() });
    return res.status(402).json({ error: 'Insufficient credit', reason: 'insufficient_balance', balanceWei: (result.balanceWei ?? 0n).toString() });
  }
  res.set('X-Charged-Wei', price.toString());
  res.set('X-Balance-Wei', result.balanceWei.toString());
  res.set('X-Budget-Remaining-Wei', result.budgetRemainingWei.toString());
  res.set('X-Session-Expires', new Date(s.expires_at).toISOString());
  res.setHeader('X-Server-Ms', sMs(req));
  res.type('application/json').send(body);
});

// ══════════ x402 v2 (PARALLEL MODE) — self-facilitated ══════════════════════
// The three x402 flows mirror the three tabs: single payment, pay per
// reading and the metered session (x402 ONLY for the top-up; the debits stay local
// EIP-191 v2 signatures — NO on-chain settlements for the individual readings).
// This server verifies and settles ITSELF (its own X402_RPC_URL) — in this folder
// there is NO call to a facilitator, local or remote.
if (x402.enabled) {
  const asset = x402.resolveAsset();
  const RES_X402_SINGLE = '/x402/single/service';
  const RES_X402_TX = '/x402/tx/reading';
  const RES_X402_METERED = '/x402/metered/reading-metered';
  const PRICE_ATOMIC_PER_CALL = BigInt(x402.config.priceAtomic);
  const DEPOSIT_ATOMIC = BigInt(x402.config.sessionDepositAtomic);
  function debitMessageV2(payer, sessionId, nonce, reqPath, maxAtomic) {
    return `metered-debit-v2:${payer.toLowerCase()}:${sessionId}:${nonce}:${reqPath}:${maxAtomic}:${x402.config.network}:${asset.address.toLowerCase()}`;
  }

  if (x402.MODE !== 'self') { logger.fatal({ mode: x402.MODE }, 'Folder 05 is self-facilitated — only X402_MODE=self is allowed'); process.exit(1); }
  if (process.env.X402_FACILITATOR_URL) { logger.fatal('X402_FACILITATOR_URL is not allowed in folder 05 — no facilitator'); process.exit(1); }

  const { middleware: x402Middleware, x402Route } = x402.buildMiddleware({
    dbx, logger,
    routes: {
      'GET /x402/single/service': x402.routeConfig('Protected service — x402 exact, self-facilitated (Ethereum Sepolia, ETH — testnet)'),
      'GET /x402/tx/reading': x402.routeConfig('IoT reading — x402 exact, payment per reading'),
      'POST /x402/metered/session/open': x402.routeConfig('Opening a prepaid session — x402 exact top-up', x402.config.sessionDepositAtomic)
    },
    onSettled: async ({ payload, settleResponse, plan }) => {
      if (!plan || !plan.sessionId) return;
      const payer = payload && payload.payload && payload.payload.authorization
        ? ethers.getAddress(payload.payload.authorization.from) : null;
      dbx.openX402Session({
        sessionId: plan.sessionId, payerAddress: payer, resource: RES_X402_METERED,
        network: x402.config.network, asset: asset.address, assetDecimals: asset.decimals,
        depositAtomic: plan.depositAtomic, budgetAtomic: plan.budgetAtomic,
        settleTxHash: settleResponse.transaction || '(unknown)', paymentId: plan.paymentId || null,
        expiresAt: plan.expiresAt
      });
      logger.info({ sessionId: plan.sessionId, payer }, 'x402 session opened (after settlement)');
    }
  });

  app.get('/x402/config', (req, res) => {
    res.setHeader('X-Server-Ms', sMs(req));
    res.json({
      ...x402.summary(),
      single: { resource: RES_X402_SINGLE, priceAtomic: x402.config.priceAtomic },
      tx: { resource: RES_X402_TX, priceAtomic: x402.config.priceAtomic },
      metered: {
        openEndpoint: '/x402/metered/session/open', resource: RES_X402_METERED,
        sessionDepositAtomic: x402.config.sessionDepositAtomic,
        priceAtomicPerCall: PRICE_ATOMIC_PER_CALL.toString(),
        signMessage: 'metered-debit-v2:{payer}:{session}:{nonce}:{path}:{maxAtomic}:{network}:{asset}'
      }
    });
  });

  app.use(x402Middleware);

  // 1 · single — x402 exact
  app.get('/x402/single/service', x402Route((req, res) => {
    const pr = x402.readPaymentResponse(res.getHeader('PAYMENT-RESPONSE'));
    linkSid(req, 'x402_payment', (req.x402PaymentKey || '').slice(0, 40));
    res.setHeader('X-Server-Ms', sMs(req));
    res.json({
      success: true,
      response: 'Response of the protected service (x402, self-facilitated). The merchant verified and settled the payment itself.',
      payment: { protocol: 'x402-self', scheme: 'exact', network: x402.config.network, asset: x402.config.assetName, txHash: pr ? pr.txHash : null, gasPayer: 'server' }
    });
  }));

  // 2 · payment per reading — x402 exact
  app.get('/x402/tx/reading', x402Route((req, res) => {
    const reading = nextReading();
    const pr = x402.readPaymentResponse(res.getHeader('PAYMENT-RESPONSE'));
    res.setHeader('X-Server-Ms', sMs(req));
    res.json({
      success: true, reading,
      payment: { protocol: 'x402-self', scheme: 'exact', network: x402.config.network, asset: x402.config.assetName, txHash: pr ? pr.txHash : null, gasPayer: 'server' }
    });
  }));

  // 3 · metered session — x402 ONLY for the top-up
  const openX402Schema = z.object({
    budgetAtomic: z.string().regex(/^\d+$/).optional(),
    ttlSeconds: z.number().int().positive().optional()
  });
  app.post('/x402/metered/session/open', x402Route((req, res) => {
    const parsed = openX402Schema.safeParse(req.body || {});
    if (!parsed.success) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Validation error', details: parsed.error.flatten() }); }
    const ttl = Math.min(parsed.data.ttlSeconds || SESSION_TTL_DEFAULT, SESSION_TTL_MAX);
    let budget = parsed.data.budgetAtomic ? BigInt(parsed.data.budgetAtomic) : DEPOSIT_ATOMIC;
    if (budget > DEPOSIT_ATOMIC) budget = DEPOSIT_ATOMIC;
    const sessionId = `xseja_${uuidv4()}`;
    const expiresAt = Date.now() + ttl * 1000;
    req.x402Plan = { sessionId, depositAtomic: DEPOSIT_ATOMIC.toString(), budgetAtomic: budget.toString(), expiresAt, paymentId: req.x402PaymentKey || null };
    linkSid(req, 'x402_metered_session', sessionId);
    const pr = x402.readPaymentResponse(res.getHeader('PAYMENT-RESPONSE'));
    res.setHeader('X-Server-Ms', sMs(req));
    res.json({
      success: true,
      session: {
        sessionId, depositAtomic: DEPOSIT_ATOMIC.toString(), budgetAtomic: budget.toString(), spentAtomic: '0',
        asset: asset.address, assetDecimals: asset.decimals, network: x402.config.network,
        expiresAt: new Date(expiresAt).toISOString()
      },
      signMessage: 'metered-debit-v2:{payer}:{session}:{nonce}:{path}:{maxAtomic}:{network}:{asset}',
      payment: { protocol: 'x402-self', scheme: 'exact', txHash: pr ? pr.txHash : null, gasPayer: 'server' }
    });
  }));

  app.get('/x402/metered/session/:id', (req, res) => {
    const sx = dbx.getX402Session(req.params.id);
    res.setHeader('X-Server-Ms', sMs(req));
    if (!sx) return res.status(404).json({ error: 'The session does not exist' });
    res.json({ success: true, session: {
      sessionId: sx.session_id, payer: sx.payer_address, depositAtomic: sx.deposit_atomic,
      budgetAtomic: sx.budget_atomic, spentAtomic: sx.spent_atomic,
      balanceAtomic: (BigInt(sx.deposit_atomic) - BigInt(sx.spent_atomic)).toString(),
      network: sx.network, asset: sx.asset, expiresAt: new Date(sx.expires_at).toISOString(),
      settleTxHash: sx.settle_tx_hash, debitCount: dbx.countX402Debits(sx.session_id)
    } });
  });

  // local debit v2 (atomic units; NO chain — see folder 03 for the details)
  app.get(RES_X402_METERED, (req, res) => {
    const payer = req.header('X-Payer'), sessionId = req.header('X-Session'), nonce = req.header('X-Nonce'), signature = req.header('X-Signature');
    const maxAtomic = req.header('X-Max-Atomic') || PRICE_ATOMIC_PER_CALL.toString();
    if (!payer || !sessionId || !nonce || !signature) {
      res.setHeader('X-Server-Ms', sMs(req));
      return res.status(402).json({ error: 'payment_required', metered: {
        mode: 'prepaid-session-x402', openEndpoint: '/x402/metered/session/open',
        priceAtomicPerCall: PRICE_ATOMIC_PER_CALL.toString(),
        signedHeaders: ['X-Payer', 'X-Session', 'X-Nonce', 'X-Signature', 'X-Max-Atomic'],
        message: 'metered-debit-v2:{payer}:{session}:{nonce}:' + RES_X402_METERED + ':{maxAtomic}:{network}:{asset}'
      } });
    }
    let payerAddr; try { payerAddr = ethers.getAddress(payer); } catch { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Invalid payer address' }); }
    if (!/^\d{1,32}$/.test(String(maxAtomic))) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Invalid X-Max-Atomic' }); }
    const nonceTs = parseInt(String(nonce).split('-')[0], 10);
    if (!Number.isFinite(nonceTs) || Math.abs(Date.now() - nonceTs) > DEBIT_MAX_AGE_MS) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Stale or invalid nonce' }); }
    let recovered; try { recovered = ethers.verifyMessage(debitMessageV2(payerAddr, sessionId, nonce, RES_X402_METERED, maxAtomic), signature); }
    catch { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Invalid signature' }); }
    if (recovered.toLowerCase() !== payerAddr.toLowerCase()) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(403).json({ error: 'The signature does not match the payer' }); }
    const sx = dbx.getX402Session(sessionId);
    if (!sx) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(404).json({ error: 'The session does not exist' }); }
    if (sx.payer_address.toLowerCase() !== payerAddr.toLowerCase()) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(403).json({ error: 'The session does not belong to this payer' }); }
    const reading = nextReading();
    const price = PRICE_ATOMIC_PER_CALL;
    if (price > BigInt(maxAtomic)) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'The price exceeds the signed maximum', priceAtomic: price.toString(), maxAtomic }); }
    const result = dbx.debitX402({ sessionId, amountAtomic: price.toString(), nonce, requestPath: RES_X402_METERED, bytes: null });
    if (!result.ok) {
      res.setHeader('X-Server-Ms', sMs(req));
      if (result.reason === 'nonce_reused') return res.status(403).json({ error: 'Nonce already used (replay rejected)' });
      if (result.reason === 'session_expired') return res.status(403).json({ error: 'The session has expired (time to live)' });
      if (result.reason === 'session_closed') return res.status(403).json({ error: 'The session is closed' });
      if (result.reason === 'no_session') return res.status(404).json({ error: 'The session does not exist' });
      if (result.reason === 'budget_exceeded') return res.status(402).json({ error: 'The session budget has been exceeded', reason: 'budget_exceeded', budgetRemainingAtomic: result.budgetRemainingAtomic ?? '0' });
      return res.status(402).json({ error: 'Insufficient credit', reason: 'insufficient_balance', balanceAtomic: result.balanceAtomic ?? '0' });
    }
    res.set('X-Charged-Atomic', price.toString());
    res.set('X-Balance-Atomic', result.balanceAtomic);
    res.set('X-Budget-Remaining-Atomic', result.budgetRemainingAtomic);
    res.set('X-Session-Expires', new Date(sx.expires_at).toISOString());
    res.setHeader('X-Server-Ms', sMs(req));
    res.json({ success: true, reading, metered: { chargedAtomic: price.toString(), balanceAtomic: result.balanceAtomic, chain: false } });
  });

  app.get('/x402/payment/:id', (req, res) => {
    const row = dbx.getPayment(String(req.params.id).slice(0, 160));
    res.setHeader('X-Server-Ms', sMs(req));
    if (!row) return res.status(404).json({ error: 'Unknown payment' });
    res.json({ paymentId: row.payment_id, status: row.status, resource: row.resource, network: row.network,
      asset: row.asset, amountAtomic: row.amount_atomic, payer: row.payer, payTo: row.pay_to,
      txHash: row.tx_hash, block: row.block_number, gasUnits: row.gas_used, gasPriceWei: row.effective_gas_price });
  });

  logger.info({ x402: x402.summary() }, 'x402 v2 self-facilitated mode mounted (single + tx + metered top-up)');
}

// ════════════════════════════ SSE M2M RUNNERS ═══════════════════════════════
function sse(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 10000\n\n');
  return (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// One-time run token (CSRF): the page reads it from the same origin and appends it
// to the EventSource URL. A foreign page cannot read it — `cors()` does not allow
// credentials, and a navigation does not expose the response to a script.
app.get('/run/token', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ token: auth.csrfFor(req) });
});

app.get('/run/tx', auth.requireCsrf, async (req, res) => {
  const emit = sse(res);
  const queries = Math.max(1, Math.min(200, parseInt(req.query.queries || '20', 10)));
  let alive = true; req.on('close', () => { alive = false; });
  try {
    await runner.runTx({ baseURL: `http://127.0.0.1:${PORT}`, network: NETWORK, rpcUrl: RPC_URL, mock: MOCK_VERIFY, payerPk: PAYER_PK, receiver: RECEIVER, priceWei: PRICE_WEI_PER_READING.toString(), queries, confirmations: MIN_CONFIRMATIONS, isAlive: () => alive, emit, adminToken: auth.token() });
  } catch (e) { emit('error', { message: e.message }); }
  if (alive) emit('end', { ok: true });
  if (!res.writableEnded) res.end();
});

app.get('/run/metered', auth.requireCsrf, async (req, res) => {
  const emit = sse(res);
  const debits = Math.max(1, Math.min(500, parseInt(req.query.debits || '20', 10)));
  let alive = true; req.on('close', () => { alive = false; });
  try {
    await runner.runMetered({ baseURL: `http://127.0.0.1:${PORT}`, network: NETWORK, rpcUrl: RPC_URL, mock: MOCK_VERIFY, payerPk: PAYER_PK, receiver: RECEIVER, resource: RES_METERED, debits, topupWei: process.env.TOPUP_WEI || '2500000000000', confirmations: MIN_CONFIRMATIONS, isAlive: () => alive, emit, adminToken: auth.token(),
      // Link the session opened by the in-process agent to the browser session that triggered the run.
      onSession: (sessionId, payerAddress) => { linkSid(req, 'metered_session', sessionId); notePayer(req, payerAddress); } });
  } catch (e) { emit('error', { message: e.message }); }
  if (alive) emit('end', { ok: true });
  if (!res.writableEnded) res.end();
});

// x402 runners — the same CSRF protection as /run/tx and /run/metered
app.get('/run/x402-tx', auth.requireCsrf, async (req, res) => {
  if (!x402.enabled) { res.status(404).json({ error: 'x402 mode is not enabled (X402_MODE=self)' }); return; }
  const emit = sse(res);
  const queries = Math.max(1, Math.min(200, parseInt(req.query.queries || '20', 10)));
  let alive = true; req.on('close', () => { alive = false; });
  try {
    await runner.runX402Tx({ baseURL: `http://127.0.0.1:${PORT}`, mock: x402.MOCK, x402PayerPk: X402_PAYER_PK, network: x402.config.network, priceAtomic: x402.config.priceAtomic, queries, isAlive: () => alive, emit, adminToken: auth.token() });
  } catch (e) { emit('error', { message: e.message }); }
  if (alive) emit('end', { ok: true });
  if (!res.writableEnded) res.end();
});

app.get('/run/x402-metered', auth.requireCsrf, async (req, res) => {
  if (!x402.enabled) { res.status(404).json({ error: 'x402 mode is not enabled (X402_MODE=self)' }); return; }
  const emit = sse(res);
  const debits = Math.max(1, Math.min(500, parseInt(req.query.debits || '20', 10)));
  let alive = true; req.on('close', () => { alive = false; });
  try {
    await runner.runX402Metered({ baseURL: `http://127.0.0.1:${PORT}`, mock: x402.MOCK, x402PayerPk: X402_PAYER_PK, network: x402.config.network, debits, isAlive: () => alive, emit, adminToken: auth.token(),
      onSession: (sessionId, payerAddress) => { linkSid(req, 'x402_metered_session', sessionId); notePayer(req, payerAddress); } });
  } catch (e) { emit('error', { message: e.message }); }
  if (alive) emit('end', { ok: true });
  if (!res.writableEnded) res.end();
});

// ── error handler + sweeper + start ──────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Body-parser errors (`express.json`) carry their own status 400: broken JSON is a
  // client error, not a server failure. Without this, every malformed body would look
  // like a 500 — falsely a vulnerability in the security test, and noise in the log.
  const code = Number.isInteger(err.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
  const log = req.log || logger;
  if (code === 500) log.error({ err: err.message }, 'Unhandled');
  else log.warn({ err: err.message, code }, 'Bad request');
  if (!res.headersSent) res.status(code).json(code === 500 ? { error: 'Internal server error' } : { error: 'Bad request', message: err.message });
});
setInterval(() => { try { db.sweep(); if (dbx) dbx.x402Sweep(); } catch {} }, 60_000).unref();

const server = app.listen(PORT, '0.0.0.0', () => logger.info({ port: PORT, receiver: RECEIVER, mockVerify: MOCK_VERIFY, network: NETWORK }, `X402 showcase site → http://localhost:${PORT}`));
function shutdown(sig) { logger.info({ sig }, 'Shutting down'); server.close(() => { try { db.db.close(); } catch {} process.exit(0); }); setTimeout(() => process.exit(1), 10_000).unref(); }
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
module.exports = app;
