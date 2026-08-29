'use strict';

/**
 * ============================================================================
 *  X402 SPLETIŠČE — POSREDNIŠKA VEJA (topologija (b))
 *  (mapa 04_spletisce_posrednik/streznik)
 * ============================================================================
 *
 *  Isti trgovec kot v mapi 05_spletisce — ista stran, isti trije tokovi, ista
 *  utrjenost (helmet, zod, SQLite, skrbniška prijava, korelacija seje `sid`) —
 *  z ENO samo razliko: TA TRGOVEC NIMA POVEZAVE DO VERIGE.
 *
 *  V mapi 05 je na tem mestu `new ethers.JsonRpcProvider(RPC_URL)` in tri mesta,
 *  ki berejo verigo. Tu tega ni: vsako od njih je zamenjal klic posredniku
 *  (`./posrednik.js`). Prav to zahteva topologija (b) — JSON-RPC ima SAMO
 *  posrednik.
 *
 *  Preslikava (mapa 05  →  ta mapa):
 *    402 izziv                     lokalno `db.createPaymentRequest`  →  POST /payment-request
 *    preverjanje transakcije       `provider.getTransaction`          →  (plačnik) POST /submit-payment
 *    unovčenje dokazila            lokalno `db.getProof/consumeProof`  →  POST /verify-proof
 *    odpiranje merjene seje        `provider.getTransaction`          →  POST /session/open
 *    podpisana bremenitev          `ethers.verifyMessage` + `db.debit` →  POST /debit
 *
 *  Odpadli poti: `/enkratno/verify` in `/tx/verify`. V posredniškem toku plačnik
 *  plačilo prijavi POSREDNIKU (puščica C→F), ne trgovcu. Poti sta ohranjeni le kot
 *  pojasnilo s statusom 404, da je razlika vidna tudi pri ročnem preizkušanju.
 *
 *  Kdo sme govoriti z verigo: plačnik (pošlje svojo transakcijo, puščica C→B)
 *  in posrednik (bere verigo, F→B). Trgovec ne. `RPC_URL` v tej mapi je zato
 *  samo namig, ki ga trgovec posreduje brskalniku in vgrajenemu agentu — sam ga
 *  nikoli ne uporabi.
 *
 *  Zakaj to sploh obstaja: pri zgodnejši primerjavi sta se arhitekturi
 *  „razlikovali v več kot le topologiji". Ker je ta trgovec bajt za bajtom isti
 *  kot neposredni (razen zgornje preslikave), ta omejitev odpade — merimo
 *  topologijo in nič drugega.
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
const posrednik = require('./posrednik');
// Uradni x402 v2 — trgovec v FACILITIRANEM načinu (X402_MODE=facilitated):
// preverjanje in poravnavo v celoti opravi lokalni posrednik prek
// /x402/verify + /x402/settle; ta proces še naprej NIKOLI ne govori z verigo.
const x402 = require('./x402');
const dbx = x402.enabled ? require('./db_x402') : null;

// ── config ───────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '8081', 10);
const NETWORK = process.env.NETWORK || 'sepolia';
// SAMO namig za brskalnik in vgrajenega agenta (oba sta plačnika in smeta na verigo).
// Ta proces iz njega nikoli ne naredi `JsonRpcProvider` — glej uvodni komentar.
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

// Browser session token (docs/IDENTITETA.md §2, izboljšava B): correlation only, never authorization.
const SID_COOKIE = 'sid';
const WEB_SESSION_TTL = parseInt(process.env.WEB_SESSION_TTL_SECONDS || '1800', 10);
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';   // force `Secure` when TLS is terminated upstream

const RES_ENKRATNO = '/enkratno/service';
const RES_TX = '/tx/reading';
const RES_MERJENO = '/merjeno/reading-metered';

// Origin of the configured RPC (browser sends its own tx) and of the facilitator
// (browser posts /submit-payment straight to it — arrow C→F of the facilitator flow).
const originOf = (u) => { try { return new URL(u).origin; } catch { return null; } };
const RPC_ORIGIN = originOf(RPC_URL);
const POSREDNIK_ORIGIN = originOf(posrednik.publicUrl);

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
posrednik.init(logger);
if (x402.enabled) {
  if (x402.MODE !== 'facilitated') {
    logger.fatal({ mode: x402.MODE }, 'Trgovec v mapi 04 sme le X402_MODE=facilitated (brez lastnega RPC)');
    process.exit(1);
  }
  if (process.env.X402_RPC_URL) {
    // enaka nespremenljivka kot pri lastnem protokolu: trgovec brez verige
    logger.fatal('X402_RPC_URL na trgovcu ni dovoljen — poravnava in branje verige pripadata posredniku (topologija b)');
    process.exit(1);
  }
}
logger.info({ posrednik: posrednik.url, javniNaslov: posrednik.publicUrl }, 'Topologija (b): trgovec nima dostopa do verige');

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
  // Poleg RPC še IZVOR POSREDNIKA: stran mu pošlje `POST /submit-payment` naravnost,
  // brez posredovanja trgovca. To je bistvo topologije (b) na strani odjemalca.
  'connect-src': ["'self'", 'https://*.publicnode.com', 'https://*.infura.io', 'https://*.alchemy.com',
    ...(RPC_ORIGIN ? [RPC_ORIGIN] : []), ...(POSREDNIK_ORIGIN ? [POSREDNIK_ORIGIN] : [])],
  'img-src': ["'self'", 'data:'],
  // Izven produkcije odstrani helmetov privzeti `upgrade-insecure-requests`: dostop po
  // navadnem HTTP (LAN/loopback) je namenoma podprt za zajem v Wiresharku, brskalnik pa
  // bi sicer poskusil vse nadgraditi v https in stran ne bi delovala. V produkciji
  // (za Caddyjem s TLS) direktiva ostane.
  ...(IS_PROD ? {} : { 'upgrade-insecure-requests': null }) } } }));
app.use(cors());
app.use(express.json({ limit: '64kb' }));
app.use((req, res, next) => { req.tStart = performance.now(); req.reqId = uuidv4(); req.downMs = 0; req.log = logger.child({ reqId: req.reqId, path: req.path }); res.setHeader('X-Request-Id', req.reqId); next(); });
const sMs = (req) => (performance.now() - req.tStart).toFixed(3);
// `X-Downstream-Ms` = koliko je trgovec čakal na posrednika. Razlika do `X-Server-Ms`
// je trgovčevo lastno delo. V neposredni veji je ta glava vedno 0 — natanko to je
// strošek topologije, ki ga merita poskusa s plačilom na odčitek in z merjeno sejo.
function fin(req, res) { res.setHeader('X-Server-Ms', sMs(req)); res.setHeader('X-Downstream-Ms', req.downMs.toFixed(3)); return res; }
const track = (req, r) => { req.downMs += r.ms || 0; return r; };

// ══════════ SKRBNIŠKA PRIJAVA — celotno spletišče je zaprto ══════════════════
// Javna ostaneta samo /prijava (+ /odjava) in /health (za healthcheck vsebnika).
// Vse ostalo — stran, /config, vsi trije plačilni tokovi, /run/* in /seja —
// zahteva prijavo (piškotek) ali strojni žeton (Authorization: Bearer).
// Poverilnice se ustvarijo ob prvem zagonu → data/admin-credentials.txt.
// POZOR: to je prijava TRGOVCA. Posrednik ima svojo, ločeno (../posrednik/data/).
const auth = authLib.create({
  dataDir: path.join(__dirname, 'data'),
  appName: 'X402 spletišče — posrednik (mapa 04)',
  logger
});
auth.mount(app);                 // /prijava, /odjava — pred zaporo
app.use(auth.requireAdmin);      // od tu naprej je vse zaprto

// ══════════ SEJNI ŽETON `sid` — KORELACIJA, NIKOLI AVTORIZACIJA ══════════════
// (docs/IDENTITETA.md §2, izboljšava B) — nespremenjeno proti neposredni veji.
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
    if (t.ipChanged) req.log.info({ sid: sid.slice(0, 8) }, 'IP seje se je spremenil — dostop se NE zavrne (identiteta ni vezana na IP)');
  } catch (err) {
    (req.log || logger).warn({ err: err.message }, 'korelacija seje ni uspela — zahteva se nadaljuje normalno');
  }
  next();
});
const linkSid = (req, kind, ref) => { try { if (req.sid && ref) db.linkWebSession({ sid: req.sid, kind, ref, ip: req.ip }); } catch (e) { (req.log || logger).warn({ err: e.message }, 'link seje ni uspel'); } };
const notePayer = (req, addr) => { try { if (req.sid && addr) db.setWebSessionPayer(req.sid, ethers.getAddress(addr)); } catch (e) { (req.log || logger).warn({ err: e.message }, 'zapis plačnika v sejo ni uspel'); } };

app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

// ── skupna pomočnika za pogovor s posrednikom ────────────────────────────────
// Nedosegljiv posrednik je 502 (odvisnost od tretje strani je resničen strošek
// te topologije in mora biti v odgovoru viden, ne skrit v 500).
function posrednikDown(req, res, r) {
  req.log.error({ err: r.error, posrednik: posrednik.url }, 'posrednik ni dosegljiv');
  return fin(req, res).status(502).json({ error: 'Posrednik ni dosegljiv', message: r.error, posrednik: posrednik.url });
}
// Odpri plačilno zahtevo pri posredniku in sestavi odgovor 402 (puščici M→F in M→C).
async function izziv402(req, res, { resource, amountWei, sporocilo }) {
  let payer = req.headers['x-payer'] || req.query.payer || null;
  if (payer) { try { payer = ethers.getAddress(payer); } catch { payer = null; } }
  const r = track(req, await posrednik.paymentRequest({ resource, recipient: RECEIVER, amountWei: amountWei.toString(), currency: 'ETH', network: NETWORK, payerAddress: payer, ttlSeconds: REQ_TTL }));
  if (r.status === 0) return posrednikDown(req, res, r);
  if (r.status !== 201) return fin(req, res).status(502).json({ error: 'Posrednik ni odprl plačilne zahteve', status: r.status, details: r.data });
  const info = r.data.paymentInfo;
  linkSid(req, 'request_id', r.data.requestId);
  return fin(req, res).status(402).json({
    error: 'Payment Required', message: sporocilo,
    payment: { ...info,
      // Ključna razlika proti neposredni veji: plačilo se prijavi POSREDNIKU.
      facilitatorUrl: posrednik.publicUrl, submitPath: '/submit-payment' },
    topologija: 'posredniska'
  });
}
// Unovči dokazni žeton pri posredniku (puščica M→F). `consume:false` = samo pogled.
async function preveriDokazilo(req, res, { token, resource, consume }) {
  const r = track(req, await posrednik.verifyProof({ token: String(token).slice(0, 120), resource, consume }));
  if (r.status === 0) { posrednikDown(req, res, r); return null; }
  if (r.status !== 200 || !r.data || r.data.verified !== true) {
    const code = (r.status === 403 || r.status === 409) ? r.status : 502;
    fin(req, res).status(code).json({ error: (r.data && r.data.error) || 'Dokazilo ni bilo potrjeno' });
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
  const pcfg = await posrednik.config();
  fin(req, res).json({
    topologija: 'posredniska', network: NETWORK, chainId: NETWORK === 'sepolia' ? '0xaa36a7' : null,
    receiver: RECEIVER, mockVerify: MOCK_VERIFY, rpcUrl: RPC_URL, ethEurRate: ETH_EUR_RATE, hasPayerKey: !!PAYER_PK,
    posrednik: { url: posrednik.publicUrl, submitPath: '/submit-payment', dosegljiv: !!pcfg, mockVerify: pcfg ? pcfg.mockVerify : null },
    enkratno: { resource: RES_ENKRATNO, priceEth: SERVICE_PRICE_ETH, priceWei: SERVICE_PRICE_WEI.toString(), priceEurApprox: (parseFloat(SERVICE_PRICE_ETH) * ETH_EUR_RATE).toFixed(4) },
    tx: { resource: RES_TX, priceWei: PRICE_WEI_PER_READING.toString(), priceEth: ethers.formatEther(PRICE_WEI_PER_READING) },
    merjeno: { resource: RES_MERJENO, priceWeiPerCall: PRICE_WEI_PER_CALL.toString(), priceWeiPerByte: PRICE_WEI_PER_BYTE.toString(), minPriceWei: MIN_PRICE_WEI.toString(), sessionTtlDefault: SESSION_TTL_DEFAULT }
  });
});

app.get('/seja', (req, res) => {
  let seja = null;
  try { seja = req.sid ? db.webSessionView(req.sid) : null; } catch (e) { req.log.warn({ err: e.message }, 'branje seje ni uspelo'); }
  res.setHeader('Cache-Control', 'no-store');
  fin(req, res).json({
    success: true, seja,
    pravilo: 'sid je zgolj korelacija. Manjkajoč ali spremenjen sid (npr. ob menjavi omrežja/IP) ne povzroči zavrnitve. Identiteta = denarnica + enkratni žetoni, ne IP naslov.'
  });
});

// Zdravje: trgovec NE poroča o stanju verige, ker je ne vidi. Poroča o dosegljivosti
// posrednika — v topologiji (b) je prav to njegova odvisnost.
app.get('/health', async (req, res) => {
  const dbOk = db.healthCheck();
  const h = track(req, await posrednik.health());
  const pOk = h.status === 200;
  const pMock = pOk && h.data ? !!h.data.mockVerify : null;
  fin(req, res).status(dbOk ? 200 : 503).json({
    status: dbOk ? 'ok' : 'down', topologija: 'posredniska', receiver: RECEIVER,
    veriga: 'ni dostopa (samo posrednik)', mockVerify: MOCK_VERIFY,
    posrednik: pOk ? 'ok' : 'down', posrednikUrl: posrednik.url,
    posrednikRpc: pOk && h.data ? h.data.rpc : null,
    posrednikMockVerify: pMock,
    // Če se načina razlikujeta, veja ni skladna: trgovec bi npr. pošiljal prave
    // transakcije posredniku, ki jih sploh ne preverja. Bolje glasno kot tiho.
    neskladjeMock: pMock === null ? null : (pMock !== MOCK_VERIFY)
  });
});

// ════════════════════════════ 1) ENKRATNO (MetaMask) ════════════════════════
app.get('/enkratno/config', (req, res) => fin(req, res).json({ network: NETWORK, chainId: NETWORK === 'sepolia' ? '0xaa36a7' : null, merchant: RECEIVER, service: { price: SERVICE_PRICE_ETH, currency: 'ETH', network: NETWORK }, priceEurApprox: (parseFloat(SERVICE_PRICE_ETH) * ETH_EUR_RATE).toFixed(4), mockVerify: MOCK_VERIFY, facilitatorUrl: posrednik.publicUrl }));

app.get('/enkratno/service', async (req, res) => {
  const proofToken = req.headers['x-payment'] || req.headers['x-payment-proof'];
  if (!proofToken) return izziv402(req, res, { resource: RES_ENKRATNO, amountWei: SERVICE_PRICE_WEI, sporocilo: 'Za dostop do te storitve je potrebno plačilo.' });
  // Pogled brez porabe (enako kot v neposredni veji): GET pove, ali je dokazilo veljavno.
  const v = await preveriDokazilo(req, res, { token: proofToken, resource: RES_ENKRATNO, consume: false });
  if (!v) return;
  fin(req, res).json({ success: true, authorized: true, proofToken, resource: v.resource, consumed: !!v.consumed, payment: { verified: true, txHash: v.txHash, blockNumber: v.blockNumber } });
});

app.post('/enkratno/service', async (req, res) => {
  const proofToken = req.headers['x-payment'] || req.headers['x-payment-proof'];
  if (!proofToken) return fin(req, res).status(402).json({ error: 'Payment Required', message: 'Manjka glava X-Payment' });
  const prompt = (req.body && typeof req.body.prompt === 'string') ? req.body.prompt.slice(0, 4000) : 'pozdravljen';
  const v = await preveriDokazilo(req, res, { token: proofToken, resource: RES_ENKRATNO, consume: true });
  if (!v) return;
  notePayer(req, v.payer); linkSid(req, 'proof_token', String(proofToken));
  fin(req, res).json({ success: true, response: `Odgovor zaščitene storitve. Vaš poziv: "${prompt}". (demo način)`, model: 'demo', payment: { txHash: v.txHash, blockNumber: v.blockNumber } });
});

// ════════════════════════════ 2) TX (per reading, M2M) ══════════════════════
app.get('/tx/reading', async (req, res) => {
  const proofToken = req.headers['x-payment'] || req.headers['x-payment-proof'];
  if (!proofToken) return izziv402(req, res, { resource: RES_TX, amountWei: PRICE_WEI_PER_READING, sporocilo: 'Za odčitek senzorja je potrebno plačilo.' });
  const v = await preveriDokazilo(req, res, { token: proofToken, resource: RES_TX, consume: true });
  if (!v) return;
  notePayer(req, v.payer); linkSid(req, 'proof_token', String(proofToken));
  fin(req, res).json({ success: true, reading: nextReading(), payment: { verified: true, txHash: v.txHash, blockNumber: v.blockNumber } });
});

// ── odpadli poti (plačilo se prijavi posredniku, ne trgovcu) ────────────────
const napotiNaPosrednika = (req, res) => fin(req, res).status(404).json({
  error: 'V posredniški topologiji te poti ni',
  navodilo: `Plačilo prijavi posredniku: POST ${posrednik.publicUrl}/submit-payment { requestId, txHash, payerAddress }`,
  protokol: 'posredniški tok — puščica C→F (plačnik → posrednik)'
});
app.post('/enkratno/verify', napotiNaPosrednika);
app.post('/tx/verify', napotiNaPosrednika);

// ════════════════════════════ 3) MERJENO (session, M2M) ═════════════════════
// Odjemalčev vmesnik je NAMENOMA enak kot v neposredni veji (iste poti, iste glave),
// da poskus z merjeno sejo osami topologijo. Razlika je izključno znotraj: kjer neposredna veja
// preveri podpis in bremeni lokalno, tu trgovec oboje prepusti posredniku
// (teoretično ozadje).
app.post('/merjeno/session/open', async (req, res) => {
  const parsed = openSchema.safeParse(req.body);
  if (!parsed.success) return fin(req, res).status(400).json({ error: 'Validation error', details: parsed.error.flatten() });
  const { txHash, payerAddress, budgetWei, ttlSeconds, mockDepositWei } = parsed.data;
  const r = track(req, await posrednik.sessionOpen({
    txHash, payerAddress, resource: RES_MERJENO, recipient: RECEIVER,
    budgetWei, ttlSeconds: ttlSeconds || SESSION_TTL_DEFAULT,
    mockDepositWei: mockDepositWei || (PRICE_WEI_PER_CALL * 25n).toString()
  }));
  if (r.status === 0) return posrednikDown(req, res, r);
  if (r.status !== 200) return fin(req, res).status(r.status >= 400 && r.status < 500 ? r.status : 502).json(r.data || { error: 'Posrednik ni odprl seje' });
  linkSid(req, 'metered_session', r.data.session.sessionId); notePayer(req, r.data.session.payer);
  fin(req, res).json({ success: true, session: r.data.session, transaction: r.data.transaction });
});

app.get('/merjeno/session/:id', async (req, res) => {
  const r = track(req, await posrednik.sessionView(String(req.params.id)));
  if (r.status === 0) return posrednikDown(req, res, r);
  if (r.status === 404) return fin(req, res).status(404).json({ error: 'Seja ne obstaja' });
  if (r.status !== 200) return fin(req, res).status(502).json(r.data || { error: 'Posrednik ni vrnil seje' });
  fin(req, res).json({ success: true, session: r.data.session });
});

app.get('/merjeno/reading-metered', async (req, res) => {
  const payer = req.header('X-Payer'), sessionId = req.header('X-Session'), nonce = req.header('X-Nonce'), signature = req.header('X-Signature');
  const maxWei = req.header('X-Max-Wei') || PRICE_WEI_PER_CALL.toString();
  if (!payer || !sessionId || !nonce || !signature) {
    return fin(req, res).status(402).json({ error: 'payment_required', metered: { mode: 'prepaid-session', openEndpoint: '/merjeno/session/open', priceWeiPerCall: PRICE_WEI_PER_CALL.toString(), priceWeiPerByte: PRICE_WEI_PER_BYTE.toString(), minPriceWei: MIN_PRICE_WEI.toString(), signedHeaders: ['X-Payer', 'X-Session', 'X-Nonce', 'X-Signature', 'X-Max-Wei'], message: 'x402-debit:{payer}:{session}:{nonce}:' + RES_MERJENO + ':{maxWei}' } });
  }
  if (!/^\d{1,32}$/.test(String(maxWei))) return fin(req, res).status(400).json({ error: 'Neveljaven X-Max-Wei' });
  // Trgovec določi CENO (to je njegova poslovna odločitev), posrednik pa preveri
  // podpis, dobroimetje in ujemanje s podpisanim maksimumom.
  const reading = nextReading();
  const body = JSON.stringify({ success: true, reading });
  const bytes = Buffer.byteLength(body);
  let price = PRICE_WEI_PER_CALL + PRICE_WEI_PER_BYTE * BigInt(bytes);
  if (price < MIN_PRICE_WEI) price = MIN_PRICE_WEI;
  if (price > BigInt(maxWei)) return fin(req, res).status(400).json({ error: 'Cena presega podpisani maksimum', priceWei: price.toString(), maxWei });

  const r = track(req, await posrednik.debit({ sessionId: String(sessionId).slice(0, 120), payer: String(payer), nonce: String(nonce).slice(0, 120), signature: String(signature), path: RES_MERJENO, maxWei: String(maxWei), priceWei: price.toString(), bytes }));
  if (r.status === 0) return posrednikDown(req, res, r);
  if (r.status !== 200 || !r.data || r.data.authorized !== true) {
    const code = (r.status >= 400 && r.status < 500) ? r.status : 502;
    return fin(req, res).status(code).json(r.data || { error: 'Posrednik ni pooblastil bremenitve' });
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

app.get('/run/zeton', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ zeton: auth.csrfFor(req) });
});

// Vgrajeni agent je PLAČNIK, zato dobi naslov posrednika: plačilo prijavi tja
// (puščica C→F), odčitek pa vzame pri trgovcu.
// Globino potrditev pozna POSREDNIK (on je tisti, ki bere verigo), zato jo agent
// prevzame od njega. Če bi agent čakal manj potrditev, kot jih posrednik zahteva,
// bi vsako preverjanje odpovedalo — v neposredni veji je isti hrošč izviral iz
// trdo zapisanega `tx.wait(1)`.
async function runnerBase() {
  const pcfg = await posrednik.config();
  return { baseURL: `http://127.0.0.1:${PORT}`, posrednikURL: posrednik.url, network: NETWORK, rpcUrl: RPC_URL,
    mock: MOCK_VERIFY, payerPk: PAYER_PK, receiver: RECEIVER, adminToken: auth.token(),
    confirmations: (pcfg && pcfg.minConfirmations) || 1 };
}

app.get('/run/tx', auth.requireCsrf, async (req, res) => {
  const emit = sse(res);
  const queries = Math.max(1, Math.min(200, parseInt(req.query.queries || '20', 10)));
  let alive = true; req.on('close', () => { alive = false; });
  try {
    await runner.runTx({ ...(await runnerBase()), priceWei: PRICE_WEI_PER_READING.toString(), queries, isAlive: () => alive, emit });
  } catch (e) { emit('napaka', { message: e.message }); }
  if (alive) emit('konec', { ok: true });
  if (!res.writableEnded) res.end();
});

app.get('/run/merjeno', auth.requireCsrf, async (req, res) => {
  const emit = sse(res);
  const debits = Math.max(1, Math.min(500, parseInt(req.query.debits || '20', 10)));
  let alive = true; req.on('close', () => { alive = false; });
  try {
    await runner.runMerjeno({ ...(await runnerBase()), resource: RES_MERJENO, debits, topupWei: process.env.TOPUP_WEI || '2500000000000', isAlive: () => alive, emit,
      onSession: (sessionId, payerAddress) => { linkSid(req, 'metered_session', sessionId); notePayer(req, payerAddress); } });
  } catch (e) { emit('napaka', { message: e.message }); }
  if (alive) emit('konec', { ok: true });
  if (!res.writableEnded) res.end();
});

// ══════════ x402 v2 (VZPOREDNI NAČIN) — facilitirano prek posrednika ═════════
// Odjemalec podpiše EIP-3009 pooblastilo (testno: ETH, Ethereum Sepolia —
// poravnava sintetična/mock); trgovec pošlje
// paymentPayload + paymentRequirements POSREDNIKU (/x402/verify, /x402/settle),
// ki poseduje poravnalni ključ in RPC ter PLAČA GAS. Trgovec ostane brez
// verige v OBEH načinih — lastnem posredniškem in x402.
// Merjeni tok ostane izključno na lastnem protokolu; x402 različica
// merjene seje je pokazana v samofacilitiranih mapah 03 in 05.
if (x402.enabled) {
  // oddaljeni facilitator prek obstoječega ovoja (žeton, X-Downstream-Ms)
  const remote = {
    verify: async (payload, requirements) => {
      const r = await posrednik.x402Verify({ paymentPayload: payload, paymentRequirements: requirements });
      if (r.status !== 200 || !r.data) return { isValid: false, invalidReason: 'facilitator_unavailable' };
      return r.data;
    },
    settle: async (payload, requirements) => {
      const r = await posrednik.x402Settle({ paymentPayload: payload, paymentRequirements: requirements });
      if (r.status !== 200 || !r.data) return { success: false, errorReason: 'facilitator_unavailable', network: requirements && requirements.network };
      return r.data;
    },
    getSupported: async () => {
      const r = await posrednik.x402Supported();
      return (r.status === 200 && r.data) ? r.data : { kinds: [] };
    },
    reconcile: async (q) => {
      const r = await posrednik.x402Reconcile(q);
      return r.status === 200 ? r.data : null;
    }
  };

  const { middleware: x402Middleware, x402Route } = x402.buildMiddleware({
    dbx, logger, remote,
    routes: {
      'GET /x402/enkratno/service': x402.routeConfig('Zaščitena storitev — x402 exact prek LOKALNEGA posrednika (Ethereum Sepolia, ETH — testno)'),
      'GET /x402/tx/reading': x402.routeConfig('IoT odčitek — x402 exact prek LOKALNEGA posrednika, plačilo na odčitek')
    }
  });

  app.get('/x402/config', async (req, res) => {
    const sup = await remote.getSupported();
    const pcfg = await posrednik.config();
    fin(req, res).json({
      ...x402.summary(), posrednik: posrednik.publicUrl, supported: sup.kinds || [],
      posrednikX402: (pcfg && pcfg.x402) || null   // od tod je razviden posrednikov mock način
    });
  });

  app.use(x402Middleware);

  app.get('/x402/enkratno/service', x402Route((req, res) => {
    const pr = x402.readPaymentResponse(res.getHeader('PAYMENT-RESPONSE'));
    fin(req, res).json({
      success: true,
      response: 'Odgovor zaščitene storitve (x402, facilitirano). Poravnavo je izvedel lokalni posrednik.',
      payment: { protokol: 'x402-facilitated', shema: 'exact', omrezje: x402.config.network, sredstvo: x402.config.assetName, txHash: pr ? pr.txHash : null, placnikGasa: 'posrednik' }
    });
  }));

  app.get('/x402/tx/reading', x402Route((req, res) => {
    const reading = nextReading();
    const pr = x402.readPaymentResponse(res.getHeader('PAYMENT-RESPONSE'));
    fin(req, res).json({
      success: true, reading,
      payment: { protokol: 'x402-facilitated', shema: 'exact', omrezje: x402.config.network, sredstvo: x402.config.assetName, txHash: pr ? pr.txHash : null, placnikGasa: 'posrednik' }
    });
  }));

  // vpogled v stanje plačila — trgovec pokaže svojo evidenco, dopolnjeno s posrednikovo
  app.get('/x402/payment/:id', async (req, res) => {
    const id = String(req.params.id).slice(0, 160);
    const local = dbx.getPayment(id);
    const r = await posrednik.x402Payment(id);
    const fac = r.status === 200 ? r.data : null;
    if (!local && !fac) return fin(req, res).status(404).json({ error: 'Neznano plačilo' });
    fin(req, res).json({
      paymentId: id,
      trgovec: local ? { status: local.status, resource: local.resource, txHash: local.tx_hash } : null,
      posrednik: fac,
      txHash: (fac && fac.txHash) || (local && local.tx_hash) || null,
      blok: fac ? fac.blok : null, gasEnote: fac ? fac.gasEnote : null, cenaGasWei: fac ? fac.cenaGasWei : null
    });
  });

  // skladnost ob zagonu (kot obstoječi `neskladjeMock`): posrednik mora podpirati
  // našo shemo in omrežje, sicer je konfiguracija napačna
  setImmediate(async () => {
    try {
      const sup = await remote.getSupported();
      const okKind = (sup.kinds || []).some((k) => k.scheme === 'exact' && k.network === x402.config.network && k.x402Version === 2);
      if (!okKind) logger.error({ supported: sup.kinds }, 'x402: posrednik NE podpira exact/' + x402.config.network + ' — preveri X402_* nastavitve posrednika');
      else logger.info({ network: x402.config.network }, 'x402: posrednik potrjuje podporo (exact, v2)');
    } catch (e) { logger.warn({ err: e.message }, 'x402: /x402/supported ni dosegljiv'); }
  });

  logger.info({ x402: x402.summary(), posrednik: posrednik.url }, 'x402 v2 facilitirani način priklopljen (/x402/enkratno/service, /x402/tx/reading)');
}

// ── error handler + sweeper + start ──────────────────────────────────────────
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
setInterval(() => { try { db.sweep(); if (dbx) dbx.x402Sweep(); } catch {} }, 60_000).unref();

const server = app.listen(PORT, '0.0.0.0', () => logger.info({ port: PORT, receiver: RECEIVER, mockVerify: MOCK_VERIFY, network: NETWORK, posrednik: posrednik.url }, `X402 spletišče (posredniška veja) → http://localhost:${PORT}`));
function shutdown(sig) { logger.info({ sig }, 'Shutting down'); server.close(() => { try { db.db.close(); } catch {} process.exit(0); }); setTimeout(() => process.exit(1), 10_000).unref(); }
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
module.exports = app;
