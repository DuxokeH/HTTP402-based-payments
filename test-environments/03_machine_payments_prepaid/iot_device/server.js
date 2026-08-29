'use strict';

/**
 * ============================================================================
 *  MOCK IoT DEVICE — METERED PREPAID SESSION (credit + budget + validity)
 *  (folder 03_machine_payments_prepaid)
 * ============================================================================
 *
 *  Same IoT scenario as folder 02, but ONE on-chain top-up opens a prepaid
 *  SESSION; every later reading is authorized by a cheap EIP-191 signature and
 *  debited locally — no new transaction per reading. This is the metered model,
 *  extended with explicit session semantics:
 *
 *     credit    = deposit_wei      (remaining = deposit - spent)
 *     budget    = budget_wei       (spent may never exceed it)
 *     validity  = expires_at       (debits rejected after TTL)
 *
 *  Endpoints:
 *    POST /session/open        verify top-up tx  -> open session
 *    GET  /reading-metered     signed debit      -> reading (no on-chain tx)
 *    GET  /session/:id         session status
 *    GET  /config, /health
 *
 *  Signed message (EIP-191 personal_sign), binding payer↔session↔nonce↔path↔cap:
 *    x402-debit:{payer}:{session}:{nonce}:{path}:{maxWei}
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
// Official x402 v2 — PARALLEL session-funding mode (X402_MODE=off|self).
// x402 is used ONLY for the top-up (phase A); debits stay local.
const x402 = require('./x402');
const dbx = x402.enabled ? require('./db_x402') : null;

const PORT = parseInt(process.env.IOT_PORT || '3200', 10);
const NETWORK = process.env.NETWORK || 'sepolia';
const RPC_URL = process.env.RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';
const MOCK_VERIFY = process.env.MOCK_VERIFY === 'true' && (!IS_PROD || process.env.FORCE_MOCK === '1');
const MIN_CONFIRMATIONS = parseInt(process.env.MIN_CONFIRMATIONS || '1', 10);

// Metered pricing. Default: per-reading value equals folder 02 (1e11 wei) so the
// two folders differ ONLY in settlement cost — a clean amortisation comparison.
const PRICE_WEI_PER_CALL = BigInt(process.env.PRICE_WEI_PER_CALL || '100000000000');
const PRICE_WEI_PER_BYTE = BigInt(process.env.PRICE_WEI_PER_BYTE || '0');
const MIN_PRICE_WEI = BigInt(process.env.MIN_PRICE_WEI || '100000000000');
const DEBIT_MAX_AGE_MS = parseInt(process.env.DEBIT_MAX_AGE_MS || '120000', 10);

// Session validity bounds (seconds). Client may request shorter (to test expiry).
const SESSION_TTL_DEFAULT = parseInt(process.env.SESSION_TTL_DEFAULT || '3600', 10);
const SESSION_TTL_MAX = parseInt(process.env.SESSION_TTL_MAX || '86400', 10);
const MIN_TOPUP_WEI = BigInt(process.env.MIN_TOPUP_WEI || '1');
const ETH_EUR_RATE = parseFloat(process.env.ETH_EUR_RATE || '2500');
const RESOURCE = '/reading-metered';

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
  logger.fatal({ err: e.message }, 'Copy wallet.example.json -> wallet.json and set the RECEIVING address');
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC_URL);

// mock sensor (same model as folder 02)
let temperature = 22.0, humidity = 50.0;
function nextReading() {
  temperature = Math.max(15, Math.min(30, temperature + (Math.random() - 0.5) * 0.4));
  humidity = Math.max(30, Math.min(70, humidity + (Math.random() - 0.5) * 1.2));
  return { reading_id: uuidv4(), temperature_c: Math.round(temperature * 100) / 100, humidity_pct: Math.round(humidity * 10) / 10, sensor: 'DHT22 (mock)', timestamp: new Date().toISOString() };
}

const txHashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const addressSchema = z.string().refine(v => { try { ethers.getAddress(v); return true; } catch { return false; } });
const openSchema = z.object({ txHash: txHashSchema, payerAddress: addressSchema, budgetWei: z.string().regex(/^\d+$/).optional(), ttlSeconds: z.number().int().positive().optional(), mockDepositWei: z.string().regex(/^\d+$/).optional() });

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => { res.setHeader('Access-Control-Expose-Headers', 'X-Server-Ms, X-Chain-Read-Ms, X-Charged-Wei, X-Balance-Wei, X-Budget-Remaining-Wei, X-Session-Expires, X-Request-Id'); next(); });
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '64kb' }));
app.use((req, res, next) => { req.tStart = performance.now(); req.reqId = uuidv4(); req.log = logger.child({ reqId: req.reqId, path: req.path }); res.setHeader('X-Request-Id', req.reqId); next(); });
const limiter = rateLimit({ windowMs: 60_000, max: parseInt(process.env.RATE_PER_MIN || '600', 10), standardHeaders: true, legacyHeaders: false });
const openLimiter = rateLimit({ windowMs: 60_000, max: parseInt(process.env.RATE_OPEN_PER_MIN || '60', 10), standardHeaders: true, legacyHeaders: false });
const sMs = (req) => (performance.now() - req.tStart).toFixed(3);

// ══════════ ADMIN LOGIN — the device is locked down ══════════════════════════
// Only /login (+ /logout) and /health remain public. Everything else (/config,
// /session/open, /session/:id, /reading-metered) requires a login or a machine token.
// The measurement agent identifies itself with the `Authorization: Bearer <TOKEN>`
// header; obtain the token on the device with:  grep TOKEN data/admin-credentials.txt
// This also closes the /session/:id path, which previously exposed the payer
// address and the credit balance without a login.
const auth = authLib.create({
  dataDir: path.join(__dirname, 'data'),
  appName: 'X402 IoT device — metered session (folder 03)',
  logger,
  homePath: '/config'          // the device has no web page; show the config after login
});
auth.mount(app);
app.use(auth.requireAdmin);

// canonical debit message — binds payer, session, nonce, resource path and price cap
function debitMessage(payer, sessionId, nonce, reqPath, maxWei) {
  return `x402-debit:${payer.toLowerCase()}:${sessionId}:${nonce}:${reqPath}:${maxWei}`;
}

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

app.get('/config', (req, res) => res.json({
  network: NETWORK, chainId: NETWORK === 'sepolia' ? '0xaa36a7' : null, device: DEVICE_WALLET, resource: RESOURCE,
  priceWeiPerCall: PRICE_WEI_PER_CALL.toString(), priceWeiPerByte: PRICE_WEI_PER_BYTE.toString(), minPriceWei: MIN_PRICE_WEI.toString(),
  sessionTtlDefault: SESSION_TTL_DEFAULT, debitMaxAgeMs: DEBIT_MAX_AGE_MS, ethEurRate: ETH_EUR_RATE, mockVerify: MOCK_VERIFY,
  signMessage: 'x402-debit:{payer}:{session}:{nonce}:{path}:{maxWei}',
  x402: x402.enabled ? x402.summary() : null
}));

app.get('/health', async (req, res) => {
  const dbOk = db.healthCheck();
  let rpcOk = false, lastBlock = null;
  try { lastBlock = await Promise.race([provider.getBlockNumber(), new Promise((_, r) => setTimeout(() => r(new Error('t/o')), 2000))]); rpcOk = true; } catch {}
  res.setHeader('X-Server-Ms', sMs(req));
  res.status(dbOk && (rpcOk || MOCK_VERIFY) ? 200 : 503).json({ status: dbOk ? 'ok' : 'down', device: DEVICE_WALLET, mockVerify: MOCK_VERIFY, rpc: rpcOk ? 'ok' : 'down', lastBlock });
});

// POST /session/open — verify top-up tx, open a prepaid session
app.post('/session/open', openLimiter, async (req, res) => {
  const parsed = openSchema.safeParse(req.body);
  if (!parsed.success) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Validation error', details: parsed.error.flatten() }); }
  const { txHash, payerAddress, budgetWei, ttlSeconds, mockDepositWei } = parsed.data;

  if (db.isTxRedeemed(txHash)) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Transaction has already been redeemed' }); }

  let verification, chainReadMs = 0;
  if (MOCK_VERIFY) {
    // In mock mode the deposit defaults to the price of ~25 readings; a test may
    // request a specific mock deposit (to demonstrate insufficient-balance).
    const mockDeposit = mockDepositWei ? BigInt(mockDepositWei).toString() : (PRICE_WEI_PER_CALL * 25n).toString();
    verification = { verified: true, tx: { hash: txHash, from: ethers.getAddress(payerAddress), to: DEVICE_WALLET, value: mockDeposit, blockNumber: 0, gasUsed: '21000', status: 1 } };
  } else {
    const t0 = performance.now();
    verification = await verifyOnChain(txHash, req.log);
    chainReadMs = performance.now() - t0;
    res.setHeader('X-Chain-Read-Ms', chainReadMs.toFixed(3));
  }
  if (!verification.verified) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Transaction verification failed', message: verification.error }); }
  const tx = verification.tx;
  if (tx.status !== 1) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'On-chain transaction failed' }); }
  if (tx.to?.toLowerCase() !== DEVICE_WALLET.toLowerCase()) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Wrong recipient' }); }
  if (tx.from.toLowerCase() !== payerAddress.toLowerCase()) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Payer mismatch' }); }
  const deposit = BigInt(tx.value);
  if (deposit < MIN_TOPUP_WEI) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Deposit too low' }); }

  // budget: default = full deposit; may be lower, never higher.
  let budget = deposit;
  if (budgetWei) { const b = BigInt(budgetWei); budget = b < deposit ? b : deposit; }
  // validity: bounded TTL.
  const ttl = Math.min(ttlSeconds || SESSION_TTL_DEFAULT, SESSION_TTL_MAX);

  const sessionId = `sess_${uuidv4()}`;
  let session;
  try {
    session = db.openSession({ sessionId, payerAddress: tx.from, resource: RESOURCE, depositWei: deposit, budgetWei: budget, txHash: tx.hash, ttlSeconds: ttl });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Transaction has already been redeemed' }); }
    throw err;
  }
  req.log.info({ sessionId, deposit: deposit.toString(), budget: budget.toString(), ttl }, 'session opened');
  res.setHeader('X-Server-Ms', sMs(req));
  res.json({ success: true, session: db.sessionView(session), signMessage: 'x402-debit:{payer}:{session}:{nonce}:{path}:{maxWei}', transaction: { hash: tx.hash, blockNumber: tx.blockNumber, gasUsed: tx.gasUsed } });
});

// GET /session/:id — status
app.get('/session/:id', (req, res) => {
  const s = db.getSession(req.params.id);
  res.setHeader('X-Server-Ms', sMs(req));
  if (!s) return res.status(404).json({ error: 'Session does not exist' });
  res.json({ success: true, session: db.sessionView(s) });
});

// GET /reading-metered — signed debit, no on-chain tx
app.get('/reading-metered', limiter, (req, res) => {
  const payer = req.header('X-Payer');
  const sessionId = req.header('X-Session');
  const nonce = req.header('X-Nonce');
  const signature = req.header('X-Signature');
  const maxWei = req.header('X-Max-Wei') || PRICE_WEI_PER_CALL.toString();

  if (!payer || !sessionId || !nonce || !signature) {
    res.setHeader('X-Server-Ms', sMs(req));
    return res.status(402).json({
      error: 'payment_required',
      metered: {
        mode: 'prepaid-session', openEndpoint: '/session/open',
        priceWeiPerCall: PRICE_WEI_PER_CALL.toString(), priceWeiPerByte: PRICE_WEI_PER_BYTE.toString(), minPriceWei: MIN_PRICE_WEI.toString(),
        signedHeaders: ['X-Payer', 'X-Session', 'X-Nonce', 'X-Signature', 'X-Max-Wei'],
        message: 'Sign (EIP-191): x402-debit:{payer}:{session}:{nonce}:{path}:{maxWei}'
      }
    });
  }

  let payerAddr;
  try { payerAddr = ethers.getAddress(payer); } catch { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Invalid payer address' }); }

  // nonce freshness window (nonce format: <epoch-ms>-<random>)
  const nonceTs = parseInt(String(nonce).split('-')[0], 10);
  if (!Number.isFinite(nonceTs) || Math.abs(Date.now() - nonceTs) > DEBIT_MAX_AGE_MS) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Stale or invalid nonce' }); }

  // EIP-191 signature check
  let recovered;
  try { recovered = ethers.verifyMessage(debitMessage(payerAddr, sessionId, nonce, req.path, maxWei), signature); }
  catch { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Invalid signature' }); }
  if (recovered.toLowerCase() !== payerAddr.toLowerCase()) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(403).json({ error: 'Signature does not match the payer' }); }

  // session must belong to this payer
  const s = db.getSession(sessionId);
  if (!s) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(404).json({ error: 'Session does not exist' }); }
  if (s.payer_address.toLowerCase() !== payerAddr.toLowerCase()) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(403).json({ error: 'Session does not belong to this payer' }); }

  // price the reading, cap at signed maximum
  const reading = nextReading();
  const body = JSON.stringify({ success: true, reading });
  const bytes = Buffer.byteLength(body);
  let price = PRICE_WEI_PER_CALL + PRICE_WEI_PER_BYTE * BigInt(bytes);
  if (price < MIN_PRICE_WEI) price = MIN_PRICE_WEI;
  if (price > BigInt(maxWei)) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Price exceeds the signed maximum', priceWei: price.toString(), maxWei }); }

  const result = db.debit({ sessionId, amountWei: price, nonce, requestPath: req.path, bytes });
  if (!result.ok) {
    res.setHeader('X-Server-Ms', sMs(req));
    if (result.reason === 'nonce_reused') return res.status(403).json({ error: 'Nonce already used (replay rejected)' });
    if (result.reason === 'session_expired') return res.status(403).json({ error: 'Session expired (validity window)' });
    if (result.reason === 'session_closed') return res.status(403).json({ error: 'Session is closed' });
    if (result.reason === 'budget_exceeded') return res.status(402).json({ error: 'Session budget exceeded', reason: 'budget_exceeded', budgetRemainingWei: (result.budgetRemainingWei ?? 0n).toString(), priceWei: price.toString() });
    return res.status(402).json({ error: 'Insufficient credit', reason: 'insufficient_balance', balanceWei: (result.balanceWei ?? 0n).toString(), priceWei: price.toString() });
  }

  req.log.info({ sessionId, priceWei: price.toString(), balanceWei: result.balanceWei.toString() }, 'metered debit');
  res.set('X-Charged-Wei', price.toString());
  res.set('X-Balance-Wei', result.balanceWei.toString());
  res.set('X-Budget-Remaining-Wei', result.budgetRemainingWei.toString());
  res.set('X-Session-Expires', new Date(s.expires_at).toISOString());
  res.setHeader('X-Server-Ms', sMs(req));
  res.type('application/json').send(body);
});

// ══════════ x402 v2 (PARALLEL MODE) — session funding ONLY (phase A) ════════
// C2: ONE x402 exact settlement (ETH, Ethereum Sepolia; test — the settlement
// is synthetic/mock) opens a prepaid session; all N debits then run LOCALLY
// with EIP-191 signatures — NO additional on-chain settlements. The local
// metering protocol is NOT x402 (and is not named that way): the v2 message is
// a variant of this folder's own format, with atomic token units instead of
// wei and with the network and token woven in, so a signature cannot be
// replayed across denominations.
if (x402.enabled) {
  // v2 debit message — SEPARATE from the legacy `x402-debit:{...}:{maxWei}`.
  // Binds: payer, session, nonce, path, maximum IN ATOMIC UNITS, network, token.
  const asset = x402.resolveAsset();
  function debitMessageV2(payer, sessionId, nonce, reqPath, maxAtomic) {
    return `metered-debit-v2:${payer.toLowerCase()}:${sessionId}:${nonce}:${reqPath}:${maxAtomic}:${x402.config.network}:${asset.address.toLowerCase()}`;
  }
  const PRICE_ATOMIC_PER_CALL = BigInt(x402.config.priceAtomic);
  const DEPOSIT_ATOMIC = BigInt(x402.config.sessionDepositAtomic);
  const RES_X402_METERED = '/x402/reading-metered';

  const { middleware: x402Middleware, x402Route } = x402.buildMiddleware({
    dbx, logger,
    routes: {
      // paying for THIS path IS the top-up: the 402 challenge carries the deposit amount
      'POST /x402/session/open': x402.routeConfig('Prepaid session opening — x402 exact top-up (Ethereum Sepolia, ETH — test)', x402.config.sessionDepositAtomic)
    },
    // The "authorization" flow settles AFTER the handler: the handler only PLANS
    // the session (req.x402Plan); only a successful settlement creates it — here.
    // If settlement fails, the handler's response is not delivered and the
    // session never comes into existence.
    onSettled: async ({ payload, requirements, settleResponse, plan }) => {
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
      logger.info({ sessionId: plan.sessionId, payer, depositAtomic: plan.depositAtomic }, 'x402 session opened (after settlement)');
    }
  });

  app.get('/x402/config', (req, res) => {
    res.setHeader('X-Server-Ms', sMs(req));
    res.json({
      ...x402.summary(),
      sessionDepositAtomic: x402.config.sessionDepositAtomic,
      priceAtomicPerCall: PRICE_ATOMIC_PER_CALL.toString(),
      openEndpoint: '/x402/session/open', meteredEndpoint: RES_X402_METERED,
      signMessage: 'metered-debit-v2:{payer}:{session}:{nonce}:{path}:{maxAtomic}:{network}:{asset}',
      sessionTtlDefault: SESSION_TTL_DEFAULT, debitMaxAgeMs: DEBIT_MAX_AGE_MS
    });
  });

  app.use(x402Middleware);

  // POST /x402/session/open — x402-protected path; body: { budgetAtomic?, ttlSeconds? }
  const openX402Schema = z.object({
    budgetAtomic: z.string().regex(/^\d+$/).optional(),
    ttlSeconds: z.number().int().positive().optional()
  });
  app.post('/x402/session/open', openLimiter, x402Route((req, res) => {
    const parsed = openX402Schema.safeParse(req.body || {});
    if (!parsed.success) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Validation error', details: parsed.error.flatten() }); }
    const ttl = Math.min(parsed.data.ttlSeconds || SESSION_TTL_DEFAULT, SESSION_TTL_MAX);
    let budget = parsed.data.budgetAtomic ? BigInt(parsed.data.budgetAtomic) : DEPOSIT_ATOMIC;
    if (budget > DEPOSIT_ATOMIC) budget = DEPOSIT_ATOMIC; // budget may not exceed the deposit
    const sessionId = `xsess_${uuidv4()}`;
    const expiresAt = Date.now() + ttl * 1000;
    // the session is CREATED only in onSettled (after a successful settlement) — here just the plan
    req.x402Plan = { sessionId, depositAtomic: DEPOSIT_ATOMIC.toString(), budgetAtomic: budget.toString(), expiresAt, paymentId: req.x402PaymentKey || null };
    const pr = x402.readPaymentResponse(res.getHeader('PAYMENT-RESPONSE'));
    res.setHeader('X-Server-Ms', sMs(req));
    res.json({
      success: true,
      session: {
        sessionId, depositAtomic: DEPOSIT_ATOMIC.toString(), budgetAtomic: budget.toString(),
        spentAtomic: '0', asset: asset.address, assetDecimals: asset.decimals,
        network: x402.config.network, expiresAt: new Date(expiresAt).toISOString()
      },
      signMessage: 'metered-debit-v2:{payer}:{session}:{nonce}:{path}:{maxAtomic}:{network}:{asset}',
      payment: { protocol: 'x402-self', scheme: 'exact', txHash: pr ? pr.txHash : null, gasPayer: 'server' }
    });
  }));

  app.get('/x402/session/:id', (req, res) => {
    const s = dbx.getX402Session(req.params.id);
    res.setHeader('X-Server-Ms', sMs(req));
    if (!s) return res.status(404).json({ error: 'Session does not exist' });
    res.json({ success: true, session: {
      sessionId: s.session_id, payer: s.payer_address, depositAtomic: s.deposit_atomic,
      budgetAtomic: s.budget_atomic, spentAtomic: s.spent_atomic,
      balanceAtomic: (BigInt(s.deposit_atomic) - BigInt(s.spent_atomic)).toString(),
      network: s.network, asset: s.asset, expiresAt: new Date(s.expires_at).toISOString(),
      settleTxHash: s.settle_tx_hash, debitCount: dbx.countX402Debits(s.session_id)
    } });
  });

  // GET /x402/reading-metered — LOCAL debit against an x402-funded session.
  // SAME logical algorithm as /reading-metered (nonce → signature → session →
  // maximum → credit → budget → atomic deduction), but the units are ATOMIC
  // token units; headers are named *-Atomic and NEVER *-Wei.
  app.get(RES_X402_METERED, limiter, (req, res) => {
    const payer = req.header('X-Payer');
    const sessionId = req.header('X-Session');
    const nonce = req.header('X-Nonce');
    const signature = req.header('X-Signature');
    const maxAtomic = req.header('X-Max-Atomic') || PRICE_ATOMIC_PER_CALL.toString();

    if (!payer || !sessionId || !nonce || !signature) {
      res.setHeader('X-Server-Ms', sMs(req));
      return res.status(402).json({
        error: 'payment_required',
        metered: {
          mode: 'prepaid-session-x402', openEndpoint: '/x402/session/open',
          priceAtomicPerCall: PRICE_ATOMIC_PER_CALL.toString(),
          signedHeaders: ['X-Payer', 'X-Session', 'X-Nonce', 'X-Signature', 'X-Max-Atomic'],
          message: 'Sign (EIP-191): metered-debit-v2:{payer}:{session}:{nonce}:{path}:{maxAtomic}:{network}:{asset}'
        }
      });
    }

    let payerAddr;
    try { payerAddr = ethers.getAddress(payer); } catch { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Invalid payer address' }); }
    if (!/^\d{1,32}$/.test(String(maxAtomic))) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Invalid X-Max-Atomic' }); }

    const nonceTs = parseInt(String(nonce).split('-')[0], 10);
    if (!Number.isFinite(nonceTs) || Math.abs(Date.now() - nonceTs) > DEBIT_MAX_AGE_MS) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Stale or invalid nonce' }); }

    let recovered;
    try { recovered = ethers.verifyMessage(debitMessageV2(payerAddr, sessionId, nonce, req.path, maxAtomic), signature); }
    catch { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Invalid signature' }); }
    if (recovered.toLowerCase() !== payerAddr.toLowerCase()) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(403).json({ error: 'Signature does not match the payer' }); }

    const sx = dbx.getX402Session(sessionId);
    if (!sx) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(404).json({ error: 'Session does not exist' }); }
    if (sx.payer_address.toLowerCase() !== payerAddr.toLowerCase()) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(403).json({ error: 'Session does not belong to this payer' }); }

    const reading = nextReading();
    const price = PRICE_ATOMIC_PER_CALL;
    if (price > BigInt(maxAtomic)) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Price exceeds the signed maximum', priceAtomic: price.toString(), maxAtomic }); }

    const result = dbx.debitX402({ sessionId, amountAtomic: price.toString(), nonce, requestPath: req.path, bytes: null });
    if (!result.ok) {
      res.setHeader('X-Server-Ms', sMs(req));
      if (result.reason === 'nonce_reused') return res.status(403).json({ error: 'Nonce already used (replay rejected)' });
      if (result.reason === 'session_expired') return res.status(403).json({ error: 'Session expired (validity window)' });
      if (result.reason === 'session_closed') return res.status(403).json({ error: 'Session is closed' });
      if (result.reason === 'no_session') return res.status(404).json({ error: 'Session does not exist' });
      if (result.reason === 'budget_exceeded') return res.status(402).json({ error: 'Session budget exceeded', reason: 'budget_exceeded', budgetRemainingAtomic: result.budgetRemainingAtomic ?? '0', priceAtomic: price.toString() });
      return res.status(402).json({ error: 'Insufficient credit', reason: 'insufficient_balance', balanceAtomic: result.balanceAtomic ?? '0', priceAtomic: price.toString() });
    }

    req.log.info({ sessionId, priceAtomic: price.toString(), balanceAtomic: result.balanceAtomic }, 'x402 metered debit (local, off-chain)');
    res.set('X-Charged-Atomic', price.toString());
    res.set('X-Balance-Atomic', result.balanceAtomic);
    res.set('X-Budget-Remaining-Atomic', result.budgetRemainingAtomic);
    res.set('X-Session-Expires', new Date(sx.expires_at).toISOString());
    res.setHeader('X-Server-Ms', sMs(req));
    res.json({ success: true, reading, metered: { chargedAtomic: price.toString(), balanceAtomic: result.balanceAtomic, chain: false } });
  });

  logger.info({ x402: x402.summary() }, 'x402 v2 session funding attached (/x402/session/open — top-up ONLY; debits stay local)');
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

setInterval(() => { try { db.sweep(); } catch {} }, 60_000).unref();

const server = app.listen(PORT, '0.0.0.0', () => logger.info({ port: PORT, device: DEVICE_WALLET, priceWeiPerCall: PRICE_WEI_PER_CALL.toString(), mockVerify: MOCK_VERIFY }, 'Mock IoT device (metered session) started'));
function shutdown(sig) { logger.info({ sig }, 'Shutting down'); server.close(() => { try { db.db.close(); } catch {} process.exit(0); }); setTimeout(() => process.exit(1), 10_000).unref(); }
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
module.exports = app;
