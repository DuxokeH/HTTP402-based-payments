'use strict';

/**
 * ============================================================================
 *  X402 POSREDNIK (facilitator) — topologija (b)
 *  (mapa 04_spletisce_posrednik/posrednik)
 * ============================================================================
 *
 *  Edina komponenta v tej mapi, ki ima povezavo do verige (JSON-RPC).
 *  Trgovec (`../streznik/server.js`) je namenoma BREZ `JsonRpcProvider` —
 *  natanko to zahteva topologija (b): JSON-RPC ima SAMO posrednik.
 *
 *  Posredniški protokol te veje:
 *
 *    C -> M   GET  /vir                          (brez plačila)
 *    M -> F   POST /payment-request              → 201 {requestId, paymentInfo}
 *    M -> C   402 Payment Required               {requestId, to, amount, facilitatorUrl}
 *    C -> B   plačilna transakcija               (plačnik plača svoj gas)
 *    C -> F   POST /submit-payment {requestId, txHash}
 *    F -> B   getTransaction + getTransactionReceipt
 *    F -> C   200 {proof.token}
 *    C -> M   GET /vir + X-Payment: token
 *    M -> F   POST /verify-proof {token}         → 200 {verified: true}
 *    M -> C   200 vsebina
 *
 *  = 5 izmenjav / 10 sporočil / 3 razmerja (proti 3 / 6 / 2 v neposredni izvedbi).
 *
 *  POZOR — to NI uradni protokol x402 (`verify` + `settle`). Uradni x402 pošlje
 *  posredniku podpisano EIP-3009 pooblastilo in gas plača POSREDNIK; tu gas
 *  plača plačnik sam, posrednik pa verigo samo BERE. Razlogi za to izbiro so v
 *  `../README.md`; EIP-3009 ostaja nadaljnje delo.
 *
 *  Popravljenih pet napak stare izvedbe
 *  (`experiments/legacy/server-only/facilitator-server/facilitator.js`):
 *    1. dokazni žeton se zdaj PORABI (enkratna uporaba, TTL 600 s)
 *    2. ista transakcija ne more unovčiti dveh plačilnih zahtev
 *    3. zneski se primerjajo kot BigInt wei, ne kot `parseFloat`
 *    4. `MIN_CONFIRMATIONS` je res uveljavljen, ne le dokumentiran
 *    5. avtentikacija trgovca, omejevanje bralnih klicev na verigo, nastavljiva
 *       vrata in trajna hramba (SQLite) namesto pomnilniških `Map`
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
// Uradni x402 v2 — posrednik postane tudi PRAVI x402 facilitator (X402_MODE=self:
// TA proces poseduje poravnalni ključ in edini dostop do verige ter plača gas).
// Lastni protokol (/payment-request → /submit-payment → /verify-proof) ostane
// NEDOTAKNJEN — to je izmerjena osnova; x402 poti živijo vzporedno pod /x402/*.
const x402 = require('./x402');
const dbx = x402.enabled ? require('./db_x402') : null;
const authLib = require('./auth');

// ── nastavitve ───────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.POSREDNIK_PORT || '4000', 10);
const NETWORK = process.env.NETWORK || 'sepolia';
const RPC_URL = process.env.RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';
// `MOCK_FACILITATOR` je ime iz načrta, `MOCK_VERIFY` pa je ime, ki ga uporablja
// preostanek paketa `meritve/`. Priznamo obe, da en sam `MOCK_VERIFY=true` v
// okolju postavi v mock način oba procesa te veje (posrednika in trgovca).
const MOCK_VERIFY = (process.env.MOCK_VERIFY === 'true' || process.env.MOCK_FACILITATOR === 'true')
  && (!IS_PROD || process.env.FORCE_MOCK === '1');
const MIN_CONFIRMATIONS = parseInt(process.env.MIN_CONFIRMATIONS || '1', 10);

const PROOF_TTL = parseInt(process.env.PROOF_TOKEN_TTL_SECONDS || '600', 10);
const REQ_TTL = parseInt(process.env.PAYMENT_REQUEST_TTL_SECONDS || '1800', 10);
const DEBIT_MAX_AGE_MS = parseInt(process.env.DEBIT_MAX_AGE_MS || '120000', 10);
const SESSION_TTL_DEFAULT = parseInt(process.env.SESSION_TTL_DEFAULT || '3600', 10);
const SESSION_TTL_MAX = parseInt(process.env.SESSION_TTL_MAX || '86400', 10);

// Branje verige je edini drag del posrednika. Omejimo število HKRATNIH bralnih
// klicev; presežek dobi takoj 429 in se NE kopiči v čakalni vrsti (enako načelo
// kot pri prijavi v `auth.js`: zasipavanje ne sme odriniti poštenih zahtev).
// Omejitev namenoma NI vezana na IP — glej `../../docs/IDENTITETA.md`.
const MAX_CHAIN_READS_IN_FLIGHT = parseInt(process.env.MAX_CHAIN_READS_IN_FLIGHT || '8', 10);
let chainReadsInFlight = 0;

const logger = pino({
  level: process.env.LOG_LEVEL || (IS_PROD ? 'info' : 'debug'),
  ...(IS_PROD ? {} : { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } } })
});

// Posrednik NIMA denarnice. Ne pošilja transakcij in ne prejema sredstev —
// prejemnika vzame iz plačilne zahteve, ki jo je odprl trgovec. Prav to je
// primitiv „ena storitev preverja plačila za več trgovcev".
const provider = new ethers.JsonRpcProvider(RPC_URL);

// ── validacija ───────────────────────────────────────────────────────────────
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

// ── aplikacija ───────────────────────────────────────────────────────────────
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
      // Edini HTML, ki ga posrednik postreže, je prijavna stran iz `auth.js`;
      // ta ima slog v vgrajenem `<style>` in nič skript.
      'script-src': ["'none'"],
      'style-src': ["'self'", "'unsafe-inline'"],
      ...(IS_PROD ? {} : { 'upgrade-insecure-requests': null })
    }
  }
}));
// Plačnik (brskalnik na trgovčevi strani) pošlje `POST /submit-payment`
// NEPOSREDNO posredniku — to je puščica C→F posredniškega toka — zato mora biti CORS
// odprt. Poverilnic pri tem ni (`credentials: false`, privzeto), zato tudi ne
// more biti CSRF: zahteva brez žetona nima nobene ambientalne pravice.
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
// `X-Server-Ms` = koliko časa je zahteva preživela V posredniku,
// `X-Chain-Read-Ms` = koliko od tega je bilo čakanje na JSON-RPC.
// Razlika je „čisti" strošek posredniške topologije (t_posrednik_ms v analizi).
function done(req, res) {
  res.setHeader('X-Server-Ms', (performance.now() - req.tStart).toFixed(3));
  res.setHeader('X-Chain-Read-Ms', req.chainMs.toFixed(3));
  return res;
}

// ── avtentikacija ────────────────────────────────────────────────────────────
// Posrednik avtenticira TRGOVCE, ne plačnikov — enako kot pravi x402.
//   javno:            /health, /config, /submit-payment  (plačnik nima računa)
//   strojni žeton:    /payment-request, /verify-proof, /session/*, /debit
// `/submit-payment` je javen, ker sprejme SAMO `txHash`, ki ga mora sam potrditi
// na verigi; brez veljavne, še neunovčene transakcije z njim ni mogoče ničesar.
const auth = authLib.create({
  dataDir: path.join(__dirname, 'data'),
  appName: 'X402 posrednik (mapa 04)',
  logger,
  publicPaths: ['/config', '/submit-payment', '/x402/supported']
});
auth.mount(app);
app.use(auth.requireAdmin);

// Oznaka trgovca. Z enim strojnim žetonom je vedno `default`; polje obstaja zato,
// da je v knjigi razvidno, kateri trgovec je zahtevo odprl, in da je razširitev
// na več trgovcev sprememba registra žetonov, ne sheme.
const merchantOf = (req) => String(req.headers['x-merchant'] || 'default').slice(0, 64).replace(/[^\w.\-]/g, '') || 'default';

// ── branje verige ────────────────────────────────────────────────────────────
async function verifyOnChain(txHash, req) {
  if (chainReadsInFlight >= MAX_CHAIN_READS_IN_FLIGHT) return { verified: false, busy: true, error: 'Posrednik je zaseden (preveč hkratnih branj verige)' };
  chainReadsInFlight++;
  const t0 = performance.now();
  try {
    const tx = await provider.getTransaction(txHash);
    if (!tx) return { verified: false, error: 'Transakcije ni mogoče najti' };
    const rc = await provider.getTransactionReceipt(txHash);
    if (!rc) return { verified: false, error: 'Transakcija še ni potrjena' };
    // NAPAKA 4 stare izvedbe: `MIN_CONFIRMATIONS` je bil dokumentiran, a nikoli
    // preverjen — obstoj potrdila je veljal za dovolj. Pri MIN_CONFIRMATIONS<=1
    // dodatnega klica ne delamo, ker je obstoj potrdila že ena potrditev.
    if (MIN_CONFIRMATIONS > 1) {
      const latest = await provider.getBlockNumber();
      const depth = latest - rc.blockNumber + 1;
      if (depth < MIN_CONFIRMATIONS) return { verified: false, error: `Premalo potrditev (${depth} < ${MIN_CONFIRMATIONS})` };
    }
    return { verified: true, tx: {
      hash: tx.hash, from: ethers.getAddress(tx.from), to: tx.to ? ethers.getAddress(tx.to) : null,
      value: tx.value.toString(), blockNumber: rc.blockNumber,
      gasUsed: rc.gasUsed ? rc.gasUsed.toString() : null, status: rc.status
    } };
  } catch (err) {
    req.log.error({ err: err.message }, 'branje verige ni uspelo');
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
    status: dbOk ? 'ok' : 'down', vloga: 'posrednik', network: NETWORK,
    mockVerify: MOCK_VERIFY, rpc: rpcOk ? 'ok' : 'down', lastBlock,
    minConfirmations: MIN_CONFIRMATIONS, chainReadsInFlight
  });
});

app.get('/config', (req, res) => done(req, res).json({
  vloga: 'posrednik', protokol: 'posredniski (payment-request / submit-payment / verify-proof)',
  network: NETWORK, chainId: NETWORK === 'sepolia' ? '0xaa36a7' : null,
  mockVerify: MOCK_VERIFY, minConfirmations: MIN_CONFIRMATIONS,
  proofTtlSeconds: PROOF_TTL, requestTtlSeconds: REQ_TTL,
  debitMessage: 'x402-debit:{payer}:{session}:{nonce}:{path}:{maxWei}',
  x402: x402.enabled ? x402.summary() : null
}));

// ════════════ 1) M -> F : odpri plačilno zahtevo ═════════════════════════════
app.post('/payment-request', (req, res) => {
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) return done(req, res).status(400).json({ error: 'Validation error', details: parsed.error.flatten() });
  const { resource, amountWei, payerAddress, ttlSeconds } = parsed.data;
  const recipient = ethers.getAddress(parsed.data.recipient);
  const currency = parsed.data.currency || 'ETH';
  const network = parsed.data.network || NETWORK;
  if (network !== NETWORK) return done(req, res).status(400).json({ error: `Posrednik dela na omrežju ${NETWORK}, ne ${network}` });
  if (BigInt(amountWei) <= 0n) return done(req, res).status(400).json({ error: 'Znesek mora biti večji od nič' });

  const requestId = uuidv4();
  const ttl = ttlSeconds || REQ_TTL;
  db.createPaymentRequest({ requestId, merchant: merchantOf(req), resource, recipient, amountWei, currency, network,
    payerAddress: payerAddress ? ethers.getAddress(payerAddress) : null, ttlSeconds: ttl });
  req.log.debug({ requestId, resource, amountWei }, 'plačilna zahteva odprta');
  // 201 Created — tako kot v zgoraj opisanem posredniškem toku.
  done(req, res).status(201).json({
    requestId,
    paymentInfo: { requestId, resource, to: recipient, amount: ethers.formatEther(BigInt(amountWei)),
      priceWei: BigInt(amountWei).toString(), currency, network, expiresInSeconds: ttl }
  });
});

// ════════════ 2) C -> F : prijavi plačilo, dobi dokazni žeton ════════════════
// Edina javna pot posrednika in edino mesto v celotni veji, ki bere verigo.
app.post('/submit-payment', async (req, res, next) => {
  const parsed = submitSchema.safeParse(req.body);
  if (!parsed.success) return done(req, res).status(400).json({ error: 'Validation error', details: parsed.error.flatten() });
  const { requestId, txHash, mockValueWei } = parsed.data;
  const payerAddress = ethers.getAddress(parsed.data.payerAddress);

  const pr = db.getPaymentRequest(requestId);
  if (!pr) return done(req, res).status(400).json({ error: 'Neveljavna ali potekla plačilna zahteva' });
  // NAPAKA 2: ista transakcija ne sme unovčiti dveh zahtev. Tu je hiter izpis,
  // dokončno pa to zagotovi PRIMARY KEY v `db.issueProof` (sočasnost).
  if (db.isTxRedeemed(txHash)) return done(req, res).status(400).json({ error: 'Transakcija je že bila unovčena' });

  const amountWei = BigInt(pr.amount_wei);
  let verification;
  if (MOCK_VERIFY) {
    const value = mockValueWei ? BigInt(mockValueWei) : amountWei;
    verification = { verified: true, tx: { hash: txHash, from: payerAddress, to: ethers.getAddress(pr.recipient), value: value.toString(), blockNumber: 0, gasUsed: '21000', status: 1 } };
  } else {
    verification = await verifyOnChain(txHash, req);
  }
  if (!verification.verified) {
    return done(req, res).status(verification.busy ? 429 : 400).json({ error: 'Preverjanje transakcije ni uspelo', message: verification.error });
  }
  const tx = verification.tx;
  if (tx.status !== 1) return done(req, res).status(400).json({ error: 'Transakcija na verigi ni uspela' });
  // Prejemnik se preverja proti PLAČILNI ZAHTEVI, ne proti eni globalni denarnici:
  // posrednik je storitev za več trgovcev.
  if (!tx.to || tx.to.toLowerCase() !== pr.recipient.toLowerCase()) return done(req, res).status(400).json({ error: 'Napačen prejemnik' });
  if (tx.from.toLowerCase() !== payerAddress.toLowerCase()) return done(req, res).status(400).json({ error: 'Neujemanje plačnika' });
  // NAPAKA 3: primerjava je celoštevilska (wei), ne `parseFloat` nad ETH.
  if (BigInt(tx.value) < amountWei) return done(req, res).status(400).json({ error: 'Prenizek znesek', zahtevanoWei: amountWei.toString(), placanoWei: tx.value });
  if (pr.payer_address && pr.payer_address.toLowerCase() !== tx.from.toLowerCase()) return done(req, res).status(400).json({ error: 'Plačnik se ne ujema s plačilno zahtevo' });

  const proofToken = `proof_${uuidv4()}`;
  try {
    db.issueProof({ proofToken, requestId, resource: pr.resource, txHash: tx.hash, blockNumber: tx.blockNumber,
      payerAddress: tx.from, recipient: tx.to, amountWei: BigInt(tx.value).toString(), ttlSeconds: PROOF_TTL });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return done(req, res).status(400).json({ error: 'Transakcija je že bila unovčena' });
    return next(err);
  }
  req.log.info({ requestId, txHash, payer: tx.from }, 'plačilo potrjeno, dokazilo izdano');
  done(req, res).json({
    success: true,
    proof: { token: proofToken, requestId, resource: pr.resource, expiresInSeconds: PROOF_TTL },
    // Podvojeno na vrhu za odjemalce, ki berejo `proofToken` (enaka oblika kot v neposredni veji).
    proofToken,
    transaction: { hash: tx.hash, blockNumber: tx.blockNumber, from: tx.from, to: tx.to,
      value: ethers.formatEther(BigInt(tx.value)) + ' ETH', valueWei: tx.value, gasUsed: tx.gasUsed }
  });
});

// ════════════ 3) M -> F : preveri (in porabi) dokazni žeton ══════════════════
app.post('/verify-proof', (req, res) => {
  const parsed = proofSchema.safeParse(req.body);
  if (!parsed.success) return done(req, res).status(400).json({ error: 'Validation error', details: parsed.error.flatten() });
  const { token, resource } = parsed.data;
  const consume = parsed.data.consume !== false;      // privzeto PORABI

  const proof = db.getProof(token);
  if (!proof) return done(req, res).status(403).json({ verified: false, error: 'Neveljaven ali potekel dokazni žeton' });
  if (resource && proof.resource !== resource) return done(req, res).status(403).json({ verified: false, error: 'Žeton ne velja za ta vir' });
  if (proof.consumed_at) return done(req, res).status(403).json({ verified: false, error: 'Dokazni žeton je že bil porabljen' });
  // NAPAKA 1: v stari izvedbi je bil `/verify-proof` zgolj branje, zato je en žeton
  // odklepal vir neomejeno. Enkratnost mora biti enaka kot v neposredni veji, sicer
  // primerjava meri dve različni varnostni lastnosti in ne topologije.
  if (consume && !db.consumeProof(token)) return done(req, res).status(409).json({ verified: false, error: 'Žeton porabljen sočasno' });

  done(req, res).json({
    verified: true, requestId: proof.request_id, resource: proof.resource,
    payer: proof.payer_address, recipient: proof.recipient,
    txHash: proof.tx_hash, blockNumber: proof.block_number,
    amountWei: proof.amount_wei, consumed: consume
  });
});

// ════════════ 4) M -> F : merjena seja ═══════════════════════════════════════
// Po načelu posredniškega toka je posrednik tisti, ki „preveri podpis,
// plačnikovo dobroimetje in ujemanje z navedenimi zahtevami". V neposredni veji
// vse troje dela trgovec lokalno (brez omrežnega skoka); tu se preseli sem —
// prav to razliko meri poskus z merjeno sejo.
const debitMessage = (payer, sessionId, nonce, reqPath, maxWei) =>
  `x402-debit:${payer.toLowerCase()}:${sessionId}:${nonce}:${reqPath}:${maxWei}`;

app.post('/session/open', async (req, res, next) => {
  const parsed = openSchema.safeParse(req.body);
  if (!parsed.success) return done(req, res).status(400).json({ error: 'Validation error', details: parsed.error.flatten() });
  const { txHash, resource, budgetWei, ttlSeconds, mockDepositWei } = parsed.data;
  const payerAddress = ethers.getAddress(parsed.data.payerAddress);
  const recipient = ethers.getAddress(parsed.data.recipient);
  if (db.isTxRedeemed(txHash)) return done(req, res).status(400).json({ error: 'Transakcija je že bila unovčena' });

  let verification;
  if (MOCK_VERIFY) {
    const deposit = mockDepositWei ? BigInt(mockDepositWei) : 100_000_000n;
    verification = { verified: true, tx: { hash: txHash, from: payerAddress, to: recipient, value: deposit.toString(), blockNumber: 0, gasUsed: '21000', status: 1 } };
  } else {
    verification = await verifyOnChain(txHash, req);
  }
  if (!verification.verified) return done(req, res).status(verification.busy ? 429 : 400).json({ error: 'Preverjanje transakcije ni uspelo', message: verification.error });
  const tx = verification.tx;
  if (tx.status !== 1) return done(req, res).status(400).json({ error: 'Transakcija na verigi ni uspela' });
  if (!tx.to || tx.to.toLowerCase() !== recipient.toLowerCase()) return done(req, res).status(400).json({ error: 'Napačen prejemnik' });
  if (tx.from.toLowerCase() !== payerAddress.toLowerCase()) return done(req, res).status(400).json({ error: 'Neujemanje plačnika' });

  const deposit = BigInt(tx.value);
  if (deposit <= 0n) return done(req, res).status(400).json({ error: 'Polnitev je nič' });
  let budget = deposit;
  if (budgetWei) { const b = BigInt(budgetWei); budget = b < deposit ? b : deposit; }
  const ttl = Math.min(ttlSeconds || SESSION_TTL_DEFAULT, SESSION_TTL_MAX);
  const sessionId = `sess_${uuidv4()}`;
  let session;
  try {
    session = db.openSession({ sessionId, merchant: merchantOf(req), payerAddress: tx.from, resource,
      recipient, depositWei: deposit, budgetWei: budget, txHash: tx.hash, ttlSeconds: ttl });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return done(req, res).status(400).json({ error: 'Transakcija je že bila unovčena' });
    return next(err);
  }
  req.log.info({ sessionId, payer: tx.from, depositWei: deposit.toString() }, 'merjena seja odprta');
  done(req, res).json({ success: true, session: db.sessionView(session),
    transaction: { hash: tx.hash, blockNumber: tx.blockNumber, gasUsed: tx.gasUsed } });
});

app.get('/session/:id', (req, res) => {
  const s = db.getSession(String(req.params.id));
  if (!s) return done(req, res).status(404).json({ error: 'Seja ne obstaja' });
  done(req, res).json({ success: true, session: db.sessionView(s) });
});

// Trgovec posreduje podpisano bremenitev; posrednik je tisti, ki jo pooblasti.
app.post('/debit', (req, res) => {
  const parsed = debitSchema.safeParse(req.body);
  if (!parsed.success) return done(req, res).status(400).json({ error: 'Validation error', details: parsed.error.flatten() });
  const { sessionId, nonce, signature, path: reqPath, maxWei, priceWei, bytes } = parsed.data;
  let payer;
  try { payer = ethers.getAddress(parsed.data.payer); } catch { return done(req, res).status(400).json({ error: 'Neveljaven naslov plačnika' }); }

  // svežina nonca (proti ponovnemu predvajanju starih podpisov)
  const nonceTs = parseInt(String(nonce).split('-')[0], 10);
  if (!Number.isFinite(nonceTs) || Math.abs(Date.now() - nonceTs) > DEBIT_MAX_AGE_MS) {
    return done(req, res).status(400).json({ error: 'Zastarel ali napačen nonce' });
  }
  // podpis EIP-191 nad natanko tistim, kar je plačnik videl
  let recovered;
  try { recovered = ethers.verifyMessage(debitMessage(payer, sessionId, nonce, reqPath, maxWei), signature); }
  catch { return done(req, res).status(400).json({ error: 'Napačen podpis' }); }
  if (recovered.toLowerCase() !== payer.toLowerCase()) return done(req, res).status(403).json({ error: 'Podpis se ne ujema s plačnikom' });

  const s = db.getSession(sessionId);
  if (!s) return done(req, res).status(404).json({ error: 'Seja ne obstaja' });
  if (s.payer_address.toLowerCase() !== payer.toLowerCase()) return done(req, res).status(403).json({ error: 'Seja ne pripada temu plačniku' });
  if (s.merchant !== merchantOf(req)) return done(req, res).status(403).json({ error: 'Seja ne pripada temu trgovcu' });
  if (s.resource !== reqPath) return done(req, res).status(403).json({ error: 'Podpis velja za drug vir' });
  // „ujemanje z navedenimi zahtevami": trgovčeva cena ne sme preseči podpisanega maksimuma
  if (BigInt(priceWei) > BigInt(maxWei)) return done(req, res).status(400).json({ error: 'Cena presega podpisani maksimum', priceWei, maxWei });

  const result = db.debit({ sessionId, amountWei: BigInt(priceWei), nonce, requestPath: reqPath, bytes });
  if (!result.ok) {
    if (result.reason === 'nonce_reused') return done(req, res).status(403).json({ error: 'Nonce že uporabljen (replay zavrnjen)', reason: result.reason });
    if (result.reason === 'session_expired') return done(req, res).status(403).json({ error: 'Seja je potekla (čas veljavnosti)', reason: result.reason });
    if (result.reason === 'session_closed') return done(req, res).status(403).json({ error: 'Seja je zaprta', reason: result.reason });
    if (result.reason === 'budget_exceeded') return done(req, res).status(402).json({ error: 'Presežen proračun seje', reason: result.reason, budgetRemainingWei: (result.budgetRemainingWei ?? 0n).toString() });
    return done(req, res).status(402).json({ error: 'Nezadostno dobroimetje', reason: result.reason || 'insufficient_balance', balanceWei: (result.balanceWei ?? 0n).toString() });
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

// ══════════ x402 v2 FACILITATOR API (vzporedno z lastnim protokolom) ═════════
// Uradna facilitatorska vloga: POST /x402/verify + POST /x402/settle
// (+ GET /x402/supported za odkrivanje). Trgovec ostane brez RPC; ta proces
// preverja podpise, ODDA poravnalno transakcijo (v testnem načinu sintetično) in
// plača gas. /x402/reconcile je naš dodatek: trgovcu brez RPC omogoči
// razrešitev negotove poravnave (potrdilo/stanje pooblastila) brez slepe
// ponovne oddaje — uradni protokol te poti ne definira.
if (x402.enabled) {
  const bodySchema = z.object({ paymentPayload: z.any(), paymentRequirements: z.any() });

  app.post('/x402/verify', async (req, res) => {
    const parsed = bodySchema.safeParse(req.body || {});
    if (!parsed.success || !parsed.data.paymentPayload || !parsed.data.paymentRequirements) {
      return done(req, res).status(400).json({ error: 'Manjka paymentPayload ali paymentRequirements' });
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
      return done(req, res).status(400).json({ error: 'Manjka paymentPayload ali paymentRequirements' });
    }
    const payload = parsed.data.paymentPayload;
    const requirements = parsed.data.paymentRequirements;
    if (x402.MOCK && process.env.X402_MOCK_FAULTS === 'true' && req.headers['x-x402-mock-fault']) {
      x402.noteFault(x402.paymentKeyOf(payload, requirements), String(req.headers['x-x402-mock-fault']));
    }
    try {
      const resourceKey = x402.normResource((payload && payload.resource && (payload.resource.url || payload.resource)) || '');
      // celotni statusni stroj (idempotenca, BROADCAST pred čakanjem, uskladitev)
      // teče TU — posrednik je poravnalna avtoriteta s svojo bazo
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

  // Uskladitev za trgovca brez RPC: {txHash} → potrdilo; {from, nonce} → stanje pooblastila.
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
      done(req, res).status(400).json({ error: 'Podaj txHash ali (from, nonce)' });
    } catch (err) {
      done(req, res).status(502).json({ error: String(err.message).slice(0, 200) });
    }
  });

  // vpogled v stanje poravnave (za agente/meritve)
  app.get('/x402/payment/:id', (req, res) => {
    const row = dbx.getPayment(String(req.params.id).slice(0, 160));
    if (!row) return done(req, res).status(404).json({ error: 'Neznano plačilo' });
    done(req, res).json({
      paymentId: row.payment_id, status: row.status, resource: row.resource,
      network: row.network, asset: row.asset, amountAtomic: row.amount_atomic,
      payer: row.payer, payTo: row.pay_to, txHash: row.tx_hash,
      blok: row.block_number, gasEnote: row.gas_used, cenaGasWei: row.effective_gas_price,
      poskusi: row.attempt
    });
  });

  logger.info({ x402: x402.summary() }, 'x402 v2 facilitatorske poti priklopljene (/x402/verify, /x402/settle, /x402/supported, /x402/reconcile)');
}

// ── napake, pometanje, zagon ─────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Napake razčlenjevalnika telesa (`express.json`) nosijo svoj status 400: pokvarjen
  // JSON je napaka odjemalca in ne odpoved strežnika.
  const code = Number.isInteger(err.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
  const log = req.log || logger;
  if (code === 500) log.error({ err: err.message }, 'Neobravnavana napaka');
  else log.warn({ err: err.message, code }, 'Slaba zahteva');
  if (!res.headersSent) res.status(code).json(code === 500 ? { error: 'Internal server error' } : { error: 'Bad request', message: err.message });
});
setInterval(() => { try { db.sweep(); if (dbx) dbx.x402Sweep(); } catch {} }, 60_000).unref();

const server = app.listen(PORT, '0.0.0.0', () =>
  logger.info({ port: PORT, network: NETWORK, mockVerify: MOCK_VERIFY, minConfirmations: MIN_CONFIRMATIONS },
    `X402 posrednik → http://localhost:${PORT}`));
function shutdown(sig) {
  logger.info({ sig }, 'Ugašam');
  server.close(() => { try { db.db.close(); } catch {} process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
module.exports = app;
