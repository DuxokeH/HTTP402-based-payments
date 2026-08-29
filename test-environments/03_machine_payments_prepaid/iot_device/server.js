'use strict';

/**
 * ============================================================================
 *  MOCK IoT NAPRAVA — METERED PREPAID SESSION (credit + budget + validity)
 *  (folder 03_avtomatska_placila_dobroimetje)
 * ============================================================================
 *
 *  Same IoT scenario as folder 02, but ONE on-chain top-up opens a prepaid
 *  SESSION; every later reading is authorized by a cheap EIP-191 signature and
 *  debited locally — no new transaction per reading. This is the metered model,
 *  extended with explicit session semantics:
 *
 *     dobroimetje (credit)  = deposit_wei      (remaining = deposit - spent)
 *     proračun    (budget)  = budget_wei       (spent may never exceed it)
 *     veljavnost  (validity)= expires_at       (debits rejected after TTL)
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
// Uradni x402 v2 — VZPOREDNI način financiranja seje (X402_MODE=off|self).
// x402 se uporabi SAMO za polnitev (faza A); bremenitve ostanejo lokalne.
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
// two folders differ ONLY in settlement cost — a clean amortization comparison.
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

// ══════════ SKRBNIŠKA PRIJAVA — naprava je zaprta ════════════════════════════
// Javna ostaneta samo /prijava (+ /odjava) in /health. Vse ostalo (/config,
// /session/open, /session/:id, /reading-metered) zahteva prijavo ali strojni žeton.
// Merilni agent se predstavi z glavo `Authorization: Bearer <ZETON>`; žeton dobiš
// na napravi z:  grep ZETON data/admin-credentials.txt
// S tem je zaprta tudi pot /session/:id, ki je prej brez prijave razkrivala
// naslov plačnika in stanje dobroimetja.
const auth = authLib.create({
  dataDir: path.join(__dirname, 'data'),
  appName: 'X402 IoT naprava — merjena seja (mapa 03)',
  logger,
  homePath: '/config'          // naprava nima spletne strani; po prijavi pokaži nastavitve
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

  if (db.isTxRedeemed(txHash)) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Transakcija je že bila unovčena' }); }

  let verification, chainReadMs = 0;
  if (MOCK_VERIFY) {
    // In mock the deposit defaults to ~25 default-priced readings; a test may
    // request a specific mock deposit (to demonstrate insufficient-balance).
    const mockDeposit = mockDepositWei ? BigInt(mockDepositWei).toString() : (PRICE_WEI_PER_CALL * 25n).toString();
    verification = { verified: true, tx: { hash: txHash, from: ethers.getAddress(payerAddress), to: DEVICE_WALLET, value: mockDeposit, blockNumber: 0, gasUsed: '21000', status: 1 } };
  } else {
    const t0 = performance.now();
    verification = await verifyOnChain(txHash, req.log);
    chainReadMs = performance.now() - t0;
    res.setHeader('X-Chain-Read-Ms', chainReadMs.toFixed(3));
  }
  if (!verification.verified) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Preverjanje transakcije ni uspelo', message: verification.error }); }
  const tx = verification.tx;
  if (tx.status !== 1) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Transakcija na verigi ni uspela' }); }
  if (tx.to?.toLowerCase() !== DEVICE_WALLET.toLowerCase()) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Napačen prejemnik' }); }
  if (tx.from.toLowerCase() !== payerAddress.toLowerCase()) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Neujemanje plačnika' }); }
  const deposit = BigInt(tx.value);
  if (deposit < MIN_TOPUP_WEI) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Prenizek polog' }); }

  // budget (proračun): default = full deposit; may be lower, never higher.
  let budget = deposit;
  if (budgetWei) { const b = BigInt(budgetWei); budget = b < deposit ? b : deposit; }
  // validity (čas veljavnosti): bounded TTL.
  const ttl = Math.min(ttlSeconds || SESSION_TTL_DEFAULT, SESSION_TTL_MAX);

  const sessionId = `sess_${uuidv4()}`;
  let session;
  try {
    session = db.openSession({ sessionId, payerAddress: tx.from, resource: RESOURCE, depositWei: deposit, budgetWei: budget, txHash: tx.hash, ttlSeconds: ttl });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Transakcija je že bila unovčena' }); }
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
  if (!s) return res.status(404).json({ error: 'Seja ne obstaja' });
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
        message: 'Podpiši (EIP-191): x402-debit:{payer}:{session}:{nonce}:{path}:{maxWei}'
      }
    });
  }

  let payerAddr;
  try { payerAddr = ethers.getAddress(payer); } catch { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Neveljaven naslov plačnika' }); }

  // nonce freshness window (nonce format: <epoch-ms>-<random>)
  const nonceTs = parseInt(String(nonce).split('-')[0], 10);
  if (!Number.isFinite(nonceTs) || Math.abs(Date.now() - nonceTs) > DEBIT_MAX_AGE_MS) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Zastarel ali napačen nonce' }); }

  // EIP-191 signature check
  let recovered;
  try { recovered = ethers.verifyMessage(debitMessage(payerAddr, sessionId, nonce, req.path, maxWei), signature); }
  catch { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Napačen podpis' }); }
  if (recovered.toLowerCase() !== payerAddr.toLowerCase()) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(403).json({ error: 'Podpis se ne ujema s plačnikom' }); }

  // session must belong to this payer
  const s = db.getSession(sessionId);
  if (!s) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(404).json({ error: 'Seja ne obstaja' }); }
  if (s.payer_address.toLowerCase() !== payerAddr.toLowerCase()) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(403).json({ error: 'Seja ne pripada temu plačniku' }); }

  // price the reading, cap at signed maximum
  const reading = nextReading();
  const body = JSON.stringify({ success: true, reading });
  const bytes = Buffer.byteLength(body);
  let price = PRICE_WEI_PER_CALL + PRICE_WEI_PER_BYTE * BigInt(bytes);
  if (price < MIN_PRICE_WEI) price = MIN_PRICE_WEI;
  if (price > BigInt(maxWei)) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Cena presega podpisani maksimum', priceWei: price.toString(), maxWei }); }

  const result = db.debit({ sessionId, amountWei: price, nonce, requestPath: req.path, bytes });
  if (!result.ok) {
    res.setHeader('X-Server-Ms', sMs(req));
    if (result.reason === 'nonce_reused') return res.status(403).json({ error: 'Nonce že uporabljen (replay zavrnjen)' });
    if (result.reason === 'session_expired') return res.status(403).json({ error: 'Seja je potekla (čas veljavnosti)' });
    if (result.reason === 'session_closed') return res.status(403).json({ error: 'Seja je zaprta' });
    if (result.reason === 'budget_exceeded') return res.status(402).json({ error: 'Presežen proračun seje', reason: 'budget_exceeded', budgetRemainingWei: (result.budgetRemainingWei ?? 0n).toString(), priceWei: price.toString() });
    return res.status(402).json({ error: 'Nezadostno dobroimetje', reason: 'insufficient_balance', balanceWei: (result.balanceWei ?? 0n).toString(), priceWei: price.toString() });
  }

  req.log.info({ sessionId, priceWei: price.toString(), balanceWei: result.balanceWei.toString() }, 'metered debit');
  res.set('X-Charged-Wei', price.toString());
  res.set('X-Balance-Wei', result.balanceWei.toString());
  res.set('X-Budget-Remaining-Wei', result.budgetRemainingWei.toString());
  res.set('X-Session-Expires', new Date(s.expires_at).toISOString());
  res.setHeader('X-Server-Ms', sMs(req));
  res.type('application/json').send(body);
});

// ══════════ x402 v2 (VZPOREDNI NAČIN) — SAMO financiranje seje (faza A) ═════
// C2: ENA x402 exact poravnava (ETH, Ethereum Sepolia; testno — poravnava
// sintetična/mock) odpre predplačniško sejo; vseh N bremenitev nato teče
// LOKALNO s podpisi EIP-191 — NIČ dodatnih poravnav na verigi. Lokalni
// merilni protokol NI x402 (in se tako tudi ne imenuje): sporočilo v2 je
// različica lastnega formata iz te mape, z atomskimi enotami žetona namesto
// wei ter vpletenim omrežjem in žetonom, da podpisa ni mogoče predvajati med
// denominacijama.
if (x402.enabled) {
  // Sporočilo bremenitve v2 — LOČENO od podedovanega `x402-debit:{...}:{maxWei}`.
  // Vezava: plačnik, seja, nonce, pot, maksimum V ATOMSKIH ENOTAH, omrežje, žeton.
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
      // plačilo TE poti JE polnitev: 402 izziv nosi znesek pologa
      'POST /x402/session/open': x402.routeConfig('Odprtje predplačniške seje — x402 exact polnitev (Ethereum Sepolia, ETH — testno)', x402.config.sessionDepositAtomic)
    },
    // Tok "authorization" poravna PO handlerju: handler sejo samo NAČRTUJE
    // (req.x402Plan), ustvari pa jo šele uspešna poravnava — tu. Če poravnava
    // spodleti, odgovor handlerja ni dostavljen in seja nikoli ne nastane.
    onSettled: async ({ payload, requirements, settleResponse, plan }) => {
      if (!plan || !plan.sessionId) return;
      const payer = payload && payload.payload && payload.payload.authorization
        ? ethers.getAddress(payload.payload.authorization.from) : null;
      dbx.openX402Session({
        sessionId: plan.sessionId, payerAddress: payer, resource: RES_X402_METERED,
        network: x402.config.network, asset: asset.address, assetDecimals: asset.decimals,
        depositAtomic: plan.depositAtomic, budgetAtomic: plan.budgetAtomic,
        settleTxHash: settleResponse.transaction || '(neznan)', paymentId: plan.paymentId || null,
        expiresAt: plan.expiresAt
      });
      logger.info({ sessionId: plan.sessionId, payer, depositAtomic: plan.depositAtomic }, 'x402 seja odprta (po poravnavi)');
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

  // POST /x402/session/open — x402 zaščitena pot; telo: { budgetAtomic?, ttlSeconds? }
  const openX402Schema = z.object({
    budgetAtomic: z.string().regex(/^\d+$/).optional(),
    ttlSeconds: z.number().int().positive().optional()
  });
  app.post('/x402/session/open', openLimiter, x402Route((req, res) => {
    const parsed = openX402Schema.safeParse(req.body || {});
    if (!parsed.success) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Validation error', details: parsed.error.flatten() }); }
    const ttl = Math.min(parsed.data.ttlSeconds || SESSION_TTL_DEFAULT, SESSION_TTL_MAX);
    let budget = parsed.data.budgetAtomic ? BigInt(parsed.data.budgetAtomic) : DEPOSIT_ATOMIC;
    if (budget > DEPOSIT_ATOMIC) budget = DEPOSIT_ATOMIC; // proračun ne presega pologa
    const sessionId = `xseja_${uuidv4()}`;
    const expiresAt = Date.now() + ttl * 1000;
    // seja se USTVARI šele v onSettled (po uspešni poravnavi) — tu samo načrt
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
      payment: { protokol: 'x402-self', shema: 'exact', txHash: pr ? pr.txHash : null, placnikGasa: 'streznik' }
    });
  }));

  app.get('/x402/session/:id', (req, res) => {
    const s = dbx.getX402Session(req.params.id);
    res.setHeader('X-Server-Ms', sMs(req));
    if (!s) return res.status(404).json({ error: 'Seja ne obstaja' });
    res.json({ success: true, session: {
      sessionId: s.session_id, payer: s.payer_address, depositAtomic: s.deposit_atomic,
      budgetAtomic: s.budget_atomic, spentAtomic: s.spent_atomic,
      balanceAtomic: (BigInt(s.deposit_atomic) - BigInt(s.spent_atomic)).toString(),
      network: s.network, asset: s.asset, expiresAt: new Date(s.expires_at).toISOString(),
      settleTxHash: s.settle_tx_hash, steviloBremenitev: dbx.countX402Debits(s.session_id)
    } });
  });

  // GET /x402/reading-metered — LOKALNA bremenitev x402-financirane seje.
  // ISTI logični algoritem kot /reading-metered (nonce → podpis → seja →
  // maksimum → dobroimetje → proračun → atomski odpis), enote pa so ATOMSKE
  // enote žetona; glave se imenujejo *-Atomic in NIKOLI *-Wei.
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
          message: 'Podpiši (EIP-191): metered-debit-v2:{payer}:{session}:{nonce}:{path}:{maxAtomic}:{network}:{asset}'
        }
      });
    }

    let payerAddr;
    try { payerAddr = ethers.getAddress(payer); } catch { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Neveljaven naslov plačnika' }); }
    if (!/^\d{1,32}$/.test(String(maxAtomic))) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Neveljaven X-Max-Atomic' }); }

    const nonceTs = parseInt(String(nonce).split('-')[0], 10);
    if (!Number.isFinite(nonceTs) || Math.abs(Date.now() - nonceTs) > DEBIT_MAX_AGE_MS) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Zastarel ali napačen nonce' }); }

    let recovered;
    try { recovered = ethers.verifyMessage(debitMessageV2(payerAddr, sessionId, nonce, req.path, maxAtomic), signature); }
    catch { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Napačen podpis' }); }
    if (recovered.toLowerCase() !== payerAddr.toLowerCase()) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(403).json({ error: 'Podpis se ne ujema s plačnikom' }); }

    const sx = dbx.getX402Session(sessionId);
    if (!sx) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(404).json({ error: 'Seja ne obstaja' }); }
    if (sx.payer_address.toLowerCase() !== payerAddr.toLowerCase()) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(403).json({ error: 'Seja ne pripada temu plačniku' }); }

    const reading = nextReading();
    const price = PRICE_ATOMIC_PER_CALL;
    if (price > BigInt(maxAtomic)) { res.setHeader('X-Server-Ms', sMs(req)); return res.status(400).json({ error: 'Cena presega podpisani maksimum', priceAtomic: price.toString(), maxAtomic }); }

    const result = dbx.debitX402({ sessionId, amountAtomic: price.toString(), nonce, requestPath: req.path, bytes: null });
    if (!result.ok) {
      res.setHeader('X-Server-Ms', sMs(req));
      if (result.reason === 'nonce_reused') return res.status(403).json({ error: 'Nonce že uporabljen (replay zavrnjen)' });
      if (result.reason === 'session_expired') return res.status(403).json({ error: 'Seja je potekla (čas veljavnosti)' });
      if (result.reason === 'session_closed') return res.status(403).json({ error: 'Seja je zaprta' });
      if (result.reason === 'no_session') return res.status(404).json({ error: 'Seja ne obstaja' });
      if (result.reason === 'budget_exceeded') return res.status(402).json({ error: 'Presežen proračun seje', reason: 'budget_exceeded', budgetRemainingAtomic: result.budgetRemainingAtomic ?? '0', priceAtomic: price.toString() });
      return res.status(402).json({ error: 'Nezadostno dobroimetje', reason: 'insufficient_balance', balanceAtomic: result.balanceAtomic ?? '0', priceAtomic: price.toString() });
    }

    req.log.info({ sessionId, priceAtomic: price.toString(), balanceAtomic: result.balanceAtomic }, 'x402 metered debit (lokalno, brez verige)');
    res.set('X-Charged-Atomic', price.toString());
    res.set('X-Balance-Atomic', result.balanceAtomic);
    res.set('X-Budget-Remaining-Atomic', result.budgetRemainingAtomic);
    res.set('X-Session-Expires', new Date(sx.expires_at).toISOString());
    res.setHeader('X-Server-Ms', sMs(req));
    res.json({ success: true, reading, metered: { chargedAtomic: price.toString(), balanceAtomic: result.balanceAtomic, veriga: false } });
  });

  logger.info({ x402: x402.summary() }, 'x402 v2 financiranje seje priklopljeno (/x402/session/open — SAMO polnitev; bremenitve lokalne)');
}

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Napake razčlenjevalnika telesa (`express.json`) nosijo svoj status 400: pokvarjen
  // JSON je napaka odjemalca in ne odpoved strežnika.
  const code = Number.isInteger(err.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
  const log = req.log || logger;
  if (code === 500) log.error({ err: err.message }, 'Unhandled');
  else log.warn({ err: err.message, code }, 'Slaba zahteva');
  if (!res.headersSent) res.status(code).json(code === 500 ? { error: 'Internal server error' } : { error: 'Bad request', message: err.message });
});

setInterval(() => { try { db.sweep(); } catch {} }, 60_000).unref();

const server = app.listen(PORT, '0.0.0.0', () => logger.info({ port: PORT, device: DEVICE_WALLET, priceWeiPerCall: PRICE_WEI_PER_CALL.toString(), mockVerify: MOCK_VERIFY }, 'Mock IoT device (metered session) started'));
function shutdown(sig) { logger.info({ sig }, 'Shutting down'); server.close(() => { try { db.db.close(); } catch {} process.exit(0); }); setTimeout(() => process.exit(1), 10_000).unref(); }
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
module.exports = app;
