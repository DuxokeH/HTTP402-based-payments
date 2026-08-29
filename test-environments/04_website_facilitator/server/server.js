'use strict';

/**
 * ============================================================================
 *  X402 WEBSITE — FACILITATOR BRANCH (topology (b))
 *  (folder 04_website_facilitator/server)
 * ============================================================================
 *
 *  The same merchant as in folder 05_website_direct — same page, same three flows,
 *  same hardening (helmet, zod, SQLite, admin login, `sid` session correlation) —
 *  with ONE single difference: THIS MERCHANT HAS NO CONNECTION TO THE CHAIN.
 *
 *  In folder 05 this spot holds `new ethers.JsonRpcProvider(RPC_URL)` plus three
 *  places that read the chain. None of that is here: each of them was replaced by
 *  a call to the facilitator (`./facilitator.js`). That is exactly what topology (b)
 *  requires — ONLY the facilitator has JSON-RPC.
 *
 *  Mapping (folder 05  →  this folder):
 *    402 challenge                 local `db.createPaymentRequest`    →  POST /payment-request
 *    transaction verification      `provider.getTransaction`          →  (payer) POST /submit-payment
 *    proof redemption              local `db.getProof/consumeProof`   →  POST /verify-proof
 *    opening a metered session     `provider.getTransaction`          →  POST /session/open
 *    signed debit                  `ethers.verifyMessage` + `db.debit` →  POST /debit
 *
 *  Dropped routes: `/single/verify` and `/tx/verify`. In the facilitator flow the
 *  payer reports the payment to the FACILITATOR (arrow C→F), not to the merchant.
 *  Both routes are kept only as a 404 explainer, so the difference is visible in
 *  manual testing as well.
 *
 *  Who may talk to the chain: the payer (sends its own transaction, arrow C→B)
 *  and the facilitator (reads the chain, F→B). The merchant may not. `RPC_URL` in
 *  this folder is therefore only a hint the merchant forwards to the browser and
 *  the embedded agent — it never uses it itself.
 *
 *  Why this exists at all: in an earlier comparison the two architectures
 *  "differed in more than just topology". Since this merchant is byte-for-byte the
 *  same as the direct one (apart from the mapping above), that objection is gone —
 *  we measure topology and nothing else.
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
const authLib = require('./auth');
const facilitator = require('./facilitator');
// Official x402 v2 — merchant in FACILITATED mode (X402_MODE=facilitated):
// verification and settlement are performed entirely by the local facilitator via
// /x402/verify + /x402/settle; this process still NEVER talks to the chain.
const x402 = require('./x402');
const dbx = x402.enabled ? require('./db_x402') : null;

// ── config ───────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '8081', 10);
const NETWORK = process.env.NETWORK || 'sepolia';
// ONLY a hint for the browser and the embedded agent (both are payers and may access the chain).
// This process never turns it into a `JsonRpcProvider` — see the header comment.
const RPC_URL = process.env.RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';
const MOCK_VERIFY = process.env.MOCK_VERIFY === 'true' && (!IS_PROD || process.env.FORCE_MOCK === '1');
const ETH_EUR_RATE = parseFloat(process.env.ETH_EUR_RATE || '2500');

const REQ_TTL = parseInt(process.env.PAYMENT_REQUEST_TTL_SECONDS || '1800', 10);

const SERVICE_PRICE_ETH = process.env.SERVICE_PRICE_ETH || '0.0000001';                   // ≈ €0.0002
const SERVICE_PRICE_WEI = ethers.parseEther(SERVICE_PRICE_ETH);
const PRICE_WEI_PER_READING = BigInt(process.env.PRICE_WEI_PER_READING || '100000000000');    // per IoT reading
const PRICE_WEI_PER_CALL = BigInt(process.env.PRICE_WEI_PER_CALL || '100000000000');          // metered per reading
const PRICE_WEI_PER_BYTE = BigInt(process.env.PRICE_WEI_PER_BYTE || '0');
const MIN_PRICE_WEI = BigInt(process.env.MIN_PRICE_WEI || '100000000000');
const SESSION_TTL_DEFAULT = parseInt(process.env.SESSION_TTL_DEFAULT || '3600', 10);

// Browser session token (docs/IDENTITY.md §2, improvement B): correlation only, never authorization.
const SID_COOKIE = 'sid';
const WEB_SESSION_TTL = parseInt(process.env.WEB_SESSION_TTL_SECONDS || '1800', 10);
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';   // force `Secure` when TLS is terminated upstream

const RES_SINGLE = '/single/service';
const RES_TX = '/tx/reading';
const RES_METERED = '/metered/reading-metered';

// Origin of the configured RPC (browser sends its own tx) and of the facilitator
// (browser posts /submit-payment straight to it — arrow C→F of the facilitator flow).
const originOf = (u) => { try { return new URL(u).origin; } catch { return null; } };
const RPC_ORIGIN = originOf(RPC_URL);
const FACILITATOR_ORIGIN = originOf(facilitator.publicUrl);

const logger = pino({
  level: process.env.LOG_LEVEL || (IS_PROD ? 'info' : 'debug'),
  ...(IS_PROD ? {} : { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } } })
});

// ── wallets ──────────────────────────────────────────────────────────────────
// wallet.json: { address: <receiver, merchant+IoT device>, payerPrivateKey?: <M2M consumer, real mode> }
const walletPath = path.join(__dirname, 'wallet.json');
let RECEIVER, PAYER_PK = null;
try {
  const w = JSON.parse(fs.readFileSync(walletPath, 'utf8'));
  RECEIVER = ethers.getAddress(w.address);
  if (w.payerPrivateKey && /^0x[0-9a-fA-F]{64}$/.test(w.payerPrivateKey)) PAYER_PK = w.payerPrivateKey;
  logger.info({ receiver: RECEIVER, hasPayerKey: !!PAYER_PK }, 'Wallet loaded');
} catch (e) {
  logger.fatal({ err: e.message }, 'Copy wallet.example.json -> wallet.json and set the receiver address');
  process.exit(1);
}
facilitator.init(logger);
if (x402.enabled) {
  if (x402.MODE !== 'facilitated') {
    logger.fatal({ mode: x402.MODE }, 'The merchant in folder 04 allows only X402_MODE=facilitated (no RPC of its own)');
    process.exit(1);
  }
  if (process.env.X402_RPC_URL) {
    // same invariant as in the custom protocol: a merchant without chain access
    logger.fatal('X402_RPC_URL is not allowed on the merchant — settlement and chain reads belong to the facilitator (topology b)');
    process.exit(1);
  }
}
logger.info({ facilitator: facilitator.url, publicUrl: facilitator.publicUrl }, 'Topology (b): the merchant has no chain access');

// ── validation ───────────────────────────────────────────────────────────────
const txHashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const addressSchema = z.string().refine(v => { try { ethers.getAddress(v); return true; } catch { return false; } });
const openSchema = z.object({ txHash: txHashSchema, payerAddress: addressSchema, budgetWei: z.string().regex(/^\d+$/).optional(), ttlSeconds: z.number().int().positive().optional(), mockDepositWei: z.string().regex(/^\d+$/).optional() });

// ── app ──────────────────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => { res.setHeader('Access-Control-Expose-Headers', 'X-Server-Ms, X-Chain-Read-Ms, X-Downstream-Ms, X-Charged-Wei, X-Balance-Wei, X-Budget-Remaining-Wei, X-Session-Expires, X-Request-Id'); next(); });
app.use(helmet({ contentSecurityPolicy: { useDefaults: true, directives: {
  'script-src': ["'self'", 'https://esm.sh', "'unsafe-inline'"],
  // Besides the RPC also the FACILITATOR ORIGIN: the page sends it `POST /submit-payment`
  // directly, without the merchant relaying. That is the essence of topology (b) on the client side.
  'connect-src': ["'self'", 'https://*.publicnode.com', 'https://*.infura.io', 'https://*.alchemy.com',
    ...(RPC_ORIGIN ? [RPC_ORIGIN] : []), ...(FACILITATOR_ORIGIN ? [FACILITATOR_ORIGIN] : [])],
  'img-src': ["'self'", 'data:'],
  // Outside production, drop helmet's default `upgrade-insecure-requests`: plain-HTTP
  // access (LAN/loopback) is deliberately supported for the Wireshark capture, and the
  // browser would otherwise try to upgrade everything to https and the page would break.
  // In production (behind Caddy with TLS) the directive stays.
  ...(IS_PROD ? {} : { 'upgrade-insecure-requests': null }) } } }));
app.use(cors());
app.use(express.json({ limit: '64kb' }));
app.use((req, res, next) => { req.tStart = performance.now(); req.reqId = uuidv4(); req.downMs = 0; req.log = logger.child({ reqId: req.reqId, path: req.path }); res.setHeader('X-Request-Id', req.reqId); next(); });
const sMs = (req) => (performance.now() - req.tStart).toFixed(3);
// `X-Downstream-Ms` = how long the merchant waited for the facilitator. The difference
// to `X-Server-Ms` is the merchant's own work. In the direct branch this header is always
// 0 — that is exactly the topology cost measured by the pay-per-reading and
// metered-session experiments.
function fin(req, res) { res.setHeader('X-Server-Ms', sMs(req)); res.setHeader('X-Downstream-Ms', req.downMs.toFixed(3)); return res; }
const track = (req, r) => { req.downMs += r.ms || 0; return r; };

// ══════════ ADMIN LOGIN — the entire website is closed ═══════════════════════
// Only /login (+ /logout) and /health (for the container healthcheck) stay public.
// Everything else — the page, /config, all three payment flows, /run/* and /session —
// requires a login (cookie) or a machine token (Authorization: Bearer).
// Credentials are created on first start → data/admin-credentials.txt.
// NOTE: this is the MERCHANT's login. The facilitator has its own, separate one (../facilitator/data/).
const auth = authLib.create({
  dataDir: path.join(__dirname, 'data'),
  appName: 'X402 website — facilitator (folder 04)',
  logger
});
auth.mount(app);                 // /login, /logout — before the gate
app.use(auth.requireAdmin);      // everything from here on is closed

// ══════════ SESSION TOKEN `sid` — CORRELATION, NEVER AUTHORIZATION ═══════════
// (docs/IDENTITY.md §2, improvement B) — unchanged from the direct branch.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function readCookie(header, name) {
  if (!header) return null;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) { const raw = part.slice(i + 1).trim(); try { return decodeURIComponent(raw); } catch { return raw; } }
  }
  return null;
}
function buildSidCookie(sid, req) {
  const secure = COOKIE_SECURE || req.secure;   // req.secure honours X-Forwarded-Proto ('trust proxy' is set)
  return `${SID_COOKIE}=${sid}; Path=/; Max-Age=${WEB_SESSION_TTL}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}
app.use((req, res, next) => {
  try {
    if (req.get('X-Demo-Agent') || req.path === '/health') return next();
    let sid = readCookie(req.headers.cookie, SID_COOKIE);
    if (!sid || !UUID_RE.test(sid)) {
      sid = uuidv4();
      res.append('Set-Cookie', buildSidCookie(sid, req));
    }
    req.sid = sid;
    const t = db.touchWebSession({ sid, ip: req.ip, userAgent: req.get('user-agent'), ttlSeconds: WEB_SESSION_TTL });
    if (t.ipChanged) req.log.info({ sid: sid.slice(0, 8) }, 'Session IP changed — access is NOT denied (identity is not tied to the IP)');
  } catch (err) {
    (req.log || logger).warn({ err: err.message }, 'session correlation failed — the request continues normally');
  }
  next();
});
const linkSid = (req, kind, ref) => { try { if (req.sid && ref) db.linkWebSession({ sid: req.sid, kind, ref, ip: req.ip }); } catch (e) { (req.log || logger).warn({ err: e.message }, 'session link failed'); } };
const notePayer = (req, addr) => { try { if (req.sid && addr) db.setWebSessionPayer(req.sid, ethers.getAddress(addr)); } catch (e) { (req.log || logger).warn({ err: e.message }, 'recording the payer on the session failed'); } };

app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

// ── shared helpers for talking to the facilitator ────────────────────────────
// An unreachable facilitator is a 502 (the third-party dependency is a real cost
// of this topology and must be visible in the response, not hidden in a 500).
function facilitatorDown(req, res, r) {
  req.log.error({ err: r.error, facilitator: facilitator.url }, 'facilitator unreachable');
  return fin(req, res).status(502).json({ error: 'Facilitator unreachable', message: r.error, facilitator: facilitator.url });
}
// Open a payment request at the facilitator and build the 402 response (arrows M→F and M→C).
async function challenge402(req, res, { resource, amountWei, message }) {
  let payer = req.headers['x-payer'] || req.query.payer || null;
  if (payer) { try { payer = ethers.getAddress(payer); } catch { payer = null; } }
  const r = track(req, await facilitator.paymentRequest({ resource, recipient: RECEIVER, amountWei: amountWei.toString(), currency: 'ETH', network: NETWORK, payerAddress: payer, ttlSeconds: REQ_TTL }));
  if (r.status === 0) return facilitatorDown(req, res, r);
  if (r.status !== 201) return fin(req, res).status(502).json({ error: 'Facilitator did not open the payment request', status: r.status, details: r.data });
  const info = r.data.paymentInfo;
  linkSid(req, 'request_id', r.data.requestId);
  return fin(req, res).status(402).json({
    error: 'Payment Required', message: message,
    payment: { ...info,
      // The key difference from the direct branch: the payment is reported to the FACILITATOR.
      facilitatorUrl: facilitator.publicUrl, submitPath: '/submit-payment' },
    topology: 'facilitator'
  });
}
// Redeem the proof token at the facilitator (arrow M→F). `consume:false` = view only.
async function verifyProof(req, res, { token, resource, consume }) {
  const r = track(req, await facilitator.verifyProof({ token: String(token).slice(0, 120), resource, consume }));
  if (r.status === 0) { facilitatorDown(req, res, r); return null; }
  if (r.status !== 200 || !r.data || r.data.verified !== true) {
    const code = (r.status === 403 || r.status === 409) ? r.status : 502;
    fin(req, res).status(code).json({ error: (r.data && r.data.error) || 'Proof was not verified' });
    return null;
  }
  return r.data;
}

// mock sensor
let temperature = 22.0, humidity = 50.0;
function nextReading() {
  temperature = Math.max(15, Math.min(30, temperature + (Math.random() - 0.5) * 0.4));
  humidity = Math.max(30, Math.min(70, humidity + (Math.random() - 0.5) * 1.2));
  return { reading_id: uuidv4(), temperature_c: Math.round(temperature * 100) / 100, humidity_pct: Math.round(humidity * 10) / 10, sensor: 'DHT22 (mock)', timestamp: new Date().toISOString() };
}

// ── site config + health ─────────────────────────────────────────────────────
app.get('/config', async (req, res) => {
  const pcfg = await facilitator.config();
  fin(req, res).json({
    topology: 'facilitator', network: NETWORK, chainId: NETWORK === 'sepolia' ? '0xaa36a7' : null,
    receiver: RECEIVER, mockVerify: MOCK_VERIFY, rpcUrl: RPC_URL, ethEurRate: ETH_EUR_RATE, hasPayerKey: !!PAYER_PK,
    facilitator: { url: facilitator.publicUrl, submitPath: '/submit-payment', reachable: !!pcfg, mockVerify: pcfg ? pcfg.mockVerify : null },
    single: { resource: RES_SINGLE, priceEth: SERVICE_PRICE_ETH, priceWei: SERVICE_PRICE_WEI.toString(), priceEurApprox: (parseFloat(SERVICE_PRICE_ETH) * ETH_EUR_RATE).toFixed(4) },
    tx: { resource: RES_TX, priceWei: PRICE_WEI_PER_READING.toString(), priceEth: ethers.formatEther(PRICE_WEI_PER_READING) },
    metered: { resource: RES_METERED, priceWeiPerCall: PRICE_WEI_PER_CALL.toString(), priceWeiPerByte: PRICE_WEI_PER_BYTE.toString(), minPriceWei: MIN_PRICE_WEI.toString(), sessionTtlDefault: SESSION_TTL_DEFAULT }
  });
});

app.get('/session', (req, res) => {
  let session = null;
  try { session = req.sid ? db.webSessionView(req.sid) : null; } catch (e) { req.log.warn({ err: e.message }, 'session read failed'); }
  res.setHeader('Cache-Control', 'no-store');
  fin(req, res).json({
    success: true, session,
    policy: 'sid is correlation only. A missing or changed sid (e.g. after a network/IP change) does not cause a denial. Identity = wallet + one-time tokens, not the IP address.'
  });
});

// Health: the merchant does NOT report chain state, because it cannot see the chain. It
// reports facilitator reachability — in topology (b) that is precisely its dependency.
app.get('/health', async (req, res) => {
  const dbOk = db.healthCheck();
  const h = track(req, await facilitator.health());
  const pOk = h.status === 200;
  const pMock = pOk && h.data ? !!h.data.mockVerify : null;
  fin(req, res).status(dbOk ? 200 : 503).json({
    status: dbOk ? 'ok' : 'down', topology: 'facilitator', receiver: RECEIVER,
    chain: 'no access (facilitator only)', mockVerify: MOCK_VERIFY,
    facilitator: pOk ? 'ok' : 'down', facilitatorUrl: facilitator.url,
    facilitatorRpc: pOk && h.data ? h.data.rpc : null,
    facilitatorMockVerify: pMock,
    // If the two modes differ, the branch is inconsistent: the merchant would e.g. send
    // real transactions to a facilitator that never verifies them. Better loud than silent.
    mockMismatch: pMock === null ? null : (pMock !== MOCK_VERIFY)
  });
});

// ════════════════════════════ 1) SINGLE (MetaMask) ════════════════════════
app.get('/single/config', (req, res) => fin(req, res).json({ network: NETWORK, chainId: NETWORK === 'sepolia' ? '0xaa36a7' : null, merchant: RECEIVER, service: { price: SERVICE_PRICE_ETH, currency: 'ETH', network: NETWORK }, priceEurApprox: (parseFloat(SERVICE_PRICE_ETH) * ETH_EUR_RATE).toFixed(4), mockVerify: MOCK_VERIFY, facilitatorUrl: facilitator.publicUrl }));

app.get('/single/service', async (req, res) => {
  const proofToken = req.headers['x-payment'] || req.headers['x-payment-proof'];
  if (!proofToken) return challenge402(req, res, { resource: RES_SINGLE, amountWei: SERVICE_PRICE_WEI, message: 'Payment is required to access this service.' });
  // View without consuming (same as the direct branch): GET tells whether the proof is valid.
  const v = await verifyProof(req, res, { token: proofToken, resource: RES_SINGLE, consume: false });
  if (!v) return;
  fin(req, res).json({ success: true, authorized: true, proofToken, resource: v.resource, consumed: !!v.consumed, payment: { verified: true, txHash: v.txHash, blockNumber: v.blockNumber } });
});

app.post('/single/service', async (req, res) => {
  const proofToken = req.headers['x-payment'] || req.headers['x-payment-proof'];
  if (!proofToken) return fin(req, res).status(402).json({ error: 'Payment Required', message: 'Missing X-Payment header' });
  const prompt = (req.body && typeof req.body.prompt === 'string') ? req.body.prompt.slice(0, 4000) : 'hello';
  const v = await verifyProof(req, res, { token: proofToken, resource: RES_SINGLE, consume: true });
  if (!v) return;
  notePayer(req, v.payer); linkSid(req, 'proof_token', String(proofToken));
  fin(req, res).json({ success: true, response: `Protected service response. Your prompt: "${prompt}". (demo mode)`, model: 'demo', payment: { txHash: v.txHash, blockNumber: v.blockNumber } });
});

// ════════════════════════════ 2) TX (per reading, M2M) ══════════════════════
app.get('/tx/reading', async (req, res) => {
  const proofToken = req.headers['x-payment'] || req.headers['x-payment-proof'];
  if (!proofToken) return challenge402(req, res, { resource: RES_TX, amountWei: PRICE_WEI_PER_READING, message: 'Payment is required for a sensor reading.' });
  const v = await verifyProof(req, res, { token: proofToken, resource: RES_TX, consume: true });
  if (!v) return;
  notePayer(req, v.payer); linkSid(req, 'proof_token', String(proofToken));
  fin(req, res).json({ success: true, reading: nextReading(), payment: { verified: true, txHash: v.txHash, blockNumber: v.blockNumber } });
});

// ── dropped routes (the payment is reported to the facilitator, not the merchant) ──
const redirectToFacilitator = (req, res) => fin(req, res).status(404).json({
  error: 'This route does not exist in the facilitator topology',
  instructions: `Report the payment to the facilitator: POST ${facilitator.publicUrl}/submit-payment { requestId, txHash, payerAddress }`,
  protocol: 'facilitator flow — arrow C→F (payer → facilitator)'
});
app.post('/single/verify', redirectToFacilitator);
app.post('/tx/verify', redirectToFacilitator);

// ════════════════════════════ 3) METERED (session, M2M) ═════════════════════
// The client interface is DELIBERATELY the same as in the direct branch (same routes,
// same headers), so the metered-session experiment isolates topology. The difference is
// purely internal: where the direct branch verifies the signature and debits locally, this
// merchant delegates both to the facilitator (theoretical background).
app.post('/metered/session/open', async (req, res) => {
  const parsed = openSchema.safeParse(req.body);
  if (!parsed.success) return fin(req, res).status(400).json({ error: 'Validation error', details: parsed.error.flatten() });
  const { txHash, payerAddress, budgetWei, ttlSeconds, mockDepositWei } = parsed.data;
  const r = track(req, await facilitator.sessionOpen({
    txHash, payerAddress, resource: RES_METERED, recipient: RECEIVER,
    budgetWei, ttlSeconds: ttlSeconds || SESSION_TTL_DEFAULT,
    mockDepositWei: mockDepositWei || (PRICE_WEI_PER_CALL * 25n).toString()
  }));
  if (r.status === 0) return facilitatorDown(req, res, r);
  if (r.status !== 200) return fin(req, res).status(r.status >= 400 && r.status < 500 ? r.status : 502).json(r.data || { error: 'Facilitator did not open the session' });
  linkSid(req, 'metered_session', r.data.session.sessionId); notePayer(req, r.data.session.payer);
  fin(req, res).json({ success: true, session: r.data.session, transaction: r.data.transaction });
});

app.get('/metered/session/:id', async (req, res) => {
  const r = track(req, await facilitator.sessionView(String(req.params.id)));
  if (r.status === 0) return facilitatorDown(req, res, r);
  if (r.status === 404) return fin(req, res).status(404).json({ error: 'Session does not exist' });
  if (r.status !== 200) return fin(req, res).status(502).json(r.data || { error: 'Facilitator did not return the session' });
  fin(req, res).json({ success: true, session: r.data.session });
});

app.get('/metered/reading-metered', async (req, res) => {
  const payer = req.header('X-Payer'), sessionId = req.header('X-Session'), nonce = req.header('X-Nonce'), signature = req.header('X-Signature');
  const maxWei = req.header('X-Max-Wei') || PRICE_WEI_PER_CALL.toString();
  if (!payer || !sessionId || !nonce || !signature) {
    return fin(req, res).status(402).json({ error: 'payment_required', metered: { mode: 'prepaid-session', openEndpoint: '/metered/session/open', priceWeiPerCall: PRICE_WEI_PER_CALL.toString(), priceWeiPerByte: PRICE_WEI_PER_BYTE.toString(), minPriceWei: MIN_PRICE_WEI.toString(), signedHeaders: ['X-Payer', 'X-Session', 'X-Nonce', 'X-Signature', 'X-Max-Wei'], message: 'x402-debit:{payer}:{session}:{nonce}:' + RES_METERED + ':{maxWei}' } });
  }
  if (!/^\d{1,32}$/.test(String(maxWei))) return fin(req, res).status(400).json({ error: 'Invalid X-Max-Wei' });
  // The merchant sets the PRICE (that is its business decision); the facilitator verifies
  // the signature, the credit and the match against the signed maximum.
  const reading = nextReading();
  const body = JSON.stringify({ success: true, reading });
  const bytes = Buffer.byteLength(body);
  let price = PRICE_WEI_PER_CALL + PRICE_WEI_PER_BYTE * BigInt(bytes);
  if (price < MIN_PRICE_WEI) price = MIN_PRICE_WEI;
  if (price > BigInt(maxWei)) return fin(req, res).status(400).json({ error: 'Price exceeds the signed maximum', priceWei: price.toString(), maxWei });

  const r = track(req, await facilitator.debit({ sessionId: String(sessionId).slice(0, 120), payer: String(payer), nonce: String(nonce).slice(0, 120), signature: String(signature), path: RES_METERED, maxWei: String(maxWei), priceWei: price.toString(), bytes }));
  if (r.status === 0) return facilitatorDown(req, res, r);
  if (r.status !== 200 || !r.data || r.data.authorized !== true) {
    const code = (r.status >= 400 && r.status < 500) ? r.status : 502;
    return fin(req, res).status(code).json(r.data || { error: 'Facilitator did not authorize the debit' });
  }
  res.set('X-Charged-Wei', r.data.chargedWei);
  res.set('X-Balance-Wei', r.data.balanceWei);
  res.set('X-Budget-Remaining-Wei', r.data.budgetRemainingWei);
  res.set('X-Session-Expires', r.data.expiresAt);
  fin(req, res).type('application/json').send(body);
});

// ════════════════════════════ SSE M2M RUNNERS ═══════════════════════════════
function sse(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 10000\n\n');
  return (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

app.get('/run/token', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ token: auth.csrfFor(req) });
});

// The embedded agent is the PAYER, so it gets the facilitator's address: it reports the
// payment there (arrow C→F) and fetches the reading from the merchant.
// The confirmation depth is known to the FACILITATOR (it is the one reading the chain),
// so the agent takes it over from it. If the agent waited for fewer confirmations than
// the facilitator requires, every verification would fail — in the direct branch the
// same bug came from a hard-coded `tx.wait(1)`.
async function runnerBase() {
  const pcfg = await facilitator.config();
  return { baseURL: `http://127.0.0.1:${PORT}`, facilitatorUrl: facilitator.url, network: NETWORK, rpcUrl: RPC_URL,
    mock: MOCK_VERIFY, payerPk: PAYER_PK, receiver: RECEIVER, adminToken: auth.token(),
    confirmations: (pcfg && pcfg.minConfirmations) || 1 };
}

app.get('/run/tx', auth.requireCsrf, async (req, res) => {
  const emit = sse(res);
  const queries = Math.max(1, Math.min(200, parseInt(req.query.queries || '20', 10)));
  let alive = true; req.on('close', () => { alive = false; });
  try {
    await runner.runTx({ ...(await runnerBase()), priceWei: PRICE_WEI_PER_READING.toString(), queries, isAlive: () => alive, emit });
  } catch (e) { emit('error', { message: e.message }); }
  if (alive) emit('end', { ok: true });
  if (!res.writableEnded) res.end();
});

app.get('/run/metered', auth.requireCsrf, async (req, res) => {
  const emit = sse(res);
  const debits = Math.max(1, Math.min(500, parseInt(req.query.debits || '20', 10)));
  let alive = true; req.on('close', () => { alive = false; });
  try {
    await runner.runMetered({ ...(await runnerBase()), resource: RES_METERED, debits, topupWei: process.env.TOPUP_WEI || '2500000000000', isAlive: () => alive, emit,
      onSession: (sessionId, payerAddress) => { linkSid(req, 'metered_session', sessionId); notePayer(req, payerAddress); } });
  } catch (e) { emit('error', { message: e.message }); }
  if (alive) emit('end', { ok: true });
  if (!res.writableEnded) res.end();
});

// ══════════ x402 v2 (PARALLEL MODE) — facilitated via the facilitator ════════
// The client signs an EIP-3009 authorization (test setup: ETH, Ethereum Sepolia —
// settlement synthetic/mock); the merchant sends
// paymentPayload + paymentRequirements to the FACILITATOR (/x402/verify, /x402/settle),
// which holds the settlement key and the RPC and PAYS THE GAS. The merchant stays
// without chain access in BOTH modes — the custom facilitator protocol and x402.
// The metered flow stays exclusively on the custom protocol; the x402 variant of
// the metered session is shown in the self-facilitated folders 03 and 05.
if (x402.enabled) {
  // remote facilitator through the existing wrapper (token, X-Downstream-Ms)
  const remote = {
    verify: async (payload, requirements) => {
      const r = await facilitator.x402Verify({ paymentPayload: payload, paymentRequirements: requirements });
      if (r.status !== 200 || !r.data) return { isValid: false, invalidReason: 'facilitator_unavailable' };
      return r.data;
    },
    settle: async (payload, requirements) => {
      const r = await facilitator.x402Settle({ paymentPayload: payload, paymentRequirements: requirements });
      if (r.status !== 200 || !r.data) return { success: false, errorReason: 'facilitator_unavailable', network: requirements && requirements.network };
      return r.data;
    },
    getSupported: async () => {
      const r = await facilitator.x402Supported();
      return (r.status === 200 && r.data) ? r.data : { kinds: [] };
    },
    reconcile: async (q) => {
      const r = await facilitator.x402Reconcile(q);
      return r.status === 200 ? r.data : null;
    }
  };

  const { middleware: x402Middleware, x402Route } = x402.buildMiddleware({
    dbx, logger, remote,
    routes: {
      'GET /x402/single/service': x402.routeConfig('Protected service — x402 exact via the LOCAL facilitator (Ethereum Sepolia, ETH — test)'),
      'GET /x402/tx/reading': x402.routeConfig('IoT reading — x402 exact via the LOCAL facilitator, pay per reading')
    }
  });

  app.get('/x402/config', async (req, res) => {
    const sup = await remote.getSupported();
    const pcfg = await facilitator.config();
    fin(req, res).json({
      ...x402.summary(), facilitator: facilitator.publicUrl, supported: sup.kinds || [],
      facilitatorX402: (pcfg && pcfg.x402) || null   // this reveals the facilitator's mock mode
    });
  });

  app.use(x402Middleware);

  app.get('/x402/single/service', x402Route((req, res) => {
    const pr = x402.readPaymentResponse(res.getHeader('PAYMENT-RESPONSE'));
    fin(req, res).json({
      success: true,
      response: 'Protected service response (x402, facilitated). Settlement was performed by the local facilitator.',
      payment: { protocol: 'x402-facilitated', scheme: 'exact', network: x402.config.network, asset: x402.config.assetName, txHash: pr ? pr.txHash : null, gasPayer: 'facilitator' }
    });
  }));

  app.get('/x402/tx/reading', x402Route((req, res) => {
    const reading = nextReading();
    const pr = x402.readPaymentResponse(res.getHeader('PAYMENT-RESPONSE'));
    fin(req, res).json({
      success: true, reading,
      payment: { protocol: 'x402-facilitated', scheme: 'exact', network: x402.config.network, asset: x402.config.assetName, txHash: pr ? pr.txHash : null, gasPayer: 'facilitator' }
    });
  }));

  // payment status view — the merchant shows its own records, supplemented by the facilitator's
  app.get('/x402/payment/:id', async (req, res) => {
    const id = String(req.params.id).slice(0, 160);
    const local = dbx.getPayment(id);
    const r = await facilitator.x402Payment(id);
    const fac = r.status === 200 ? r.data : null;
    if (!local && !fac) return fin(req, res).status(404).json({ error: 'Unknown payment' });
    fin(req, res).json({
      paymentId: id,
      merchant: local ? { status: local.status, resource: local.resource, txHash: local.tx_hash } : null,
      facilitator: fac,
      txHash: (fac && fac.txHash) || (local && local.tx_hash) || null,
      block: fac ? fac.block : null, gasUnits: fac ? fac.gasUnits : null, gasPriceWei: fac ? fac.gasPriceWei : null
    });
  });

  // startup consistency check (like the existing `mockMismatch`): the facilitator must
  // support our scheme and network, otherwise the configuration is wrong
  setImmediate(async () => {
    try {
      const sup = await remote.getSupported();
      const okKind = (sup.kinds || []).some((k) => k.scheme === 'exact' && k.network === x402.config.network && k.x402Version === 2);
      if (!okKind) logger.error({ supported: sup.kinds }, 'x402: facilitator does NOT support exact/' + x402.config.network + ' — check the facilitator X402_* settings');
      else logger.info({ network: x402.config.network }, 'x402: facilitator confirms support (exact, v2)');
    } catch (e) { logger.warn({ err: e.message }, 'x402: /x402/supported unreachable'); }
  });

  logger.info({ x402: x402.summary(), facilitator: facilitator.url }, 'x402 v2 facilitated mode attached (/x402/single/service, /x402/tx/reading)');
}

// ── error handler + sweeper + start ──────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Body-parser errors (`express.json`) carry their own 400 status: broken JSON is a
  // client error, not a server failure. Without this, every mangled body would look like
  // a 500 — falsely flagged as a vulnerability in the security test, and noise in the log.
  const code = Number.isInteger(err.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
  const log = req.log || logger;
  if (code === 500) log.error({ err: err.message }, 'Unhandled');
  else log.warn({ err: err.message, code }, 'Bad request');
  if (!res.headersSent) res.status(code).json(code === 500 ? { error: 'Internal server error' } : { error: 'Bad request', message: err.message });
});
setInterval(() => { try { db.sweep(); if (dbx) dbx.x402Sweep(); } catch {} }, 60_000).unref();

const server = app.listen(PORT, '0.0.0.0', () => logger.info({ port: PORT, receiver: RECEIVER, mockVerify: MOCK_VERIFY, network: NETWORK, facilitator: facilitator.url }, `X402 website (facilitator branch) → http://localhost:${PORT}`));
function shutdown(sig) { logger.info({ sig }, 'Shutting down'); server.close(() => { try { db.db.close(); } catch {} process.exit(0); }); setTimeout(() => process.exit(1), 10_000).unref(); }
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
module.exports = app;
