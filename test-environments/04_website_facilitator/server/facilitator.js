'use strict';

/**
 * ============================================================================
 *  Odjemalec POSREDNIKA — edina pot trgovca do plačilnega stanja
 *  (mapa 04_spletisce_posrednik/streznik)
 * ============================================================================
 *
 *  V topologiji (b) trgovec verige ne vidi. Vse, kar je v neposredni izvedbi
 *  (mapa 05_spletisce) klic `provider.getTransaction(...)` ali `ethers.verifyMessage(...)`,
 *  je tukaj HTTP klic posredniku. Ta modul je natanko ta preslikava in nič drugega.
 *
 *  Naslovi:
 *    POSREDNIK_URL         kamor kliče TRGOVEC (praviloma loopback, npr. http://127.0.0.1:4000)
 *    POSREDNIK_PUBLIC_URL  kar trgovec zapiše v odgovor 402, da PLAČNIK ve, kam
 *                          poslati `POST /submit-payment` (puščica C→F posredniškega toka).
 *                          Če plačnik ni na istem računalniku, mora biti to javni naslov.
 *
 *  Žeton: posrednik avtenticira trgovce. Žeton dobiš z
 *      grep ZETON ../posrednik/data/admin-credentials.txt
 *  in ga vpišeš kot POSREDNIK_TOKEN v .env. Ker je posrednik v tem okolju
 *  namenoma LOKALEN (samogostovan), modul zna žeton prebrati tudi neposredno iz
 *  sosednje mape — takrat je zagon obeh procesov brez ročnega prepisovanja.
 *
 *  Nobena funkcija ne meče izjem v pot zahteve: ob nedosegljivem posredniku
 *  vrne `{ status: 0, error }`, da trgovec odgovori s 502 in ne s 500.
 * ============================================================================
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

const POSREDNIK_URL = (process.env.POSREDNIK_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');
const POSREDNIK_PUBLIC_URL = (process.env.POSREDNIK_PUBLIC_URL || POSREDNIK_URL).replace(/\/+$/, '');
const TIMEOUT_MS = parseInt(process.env.POSREDNIK_TIMEOUT_MS || '20000', 10);

function resolveToken(logger) {
  if (process.env.POSREDNIK_TOKEN) return process.env.POSREDNIK_TOKEN;
  // Sosedska pot: oba procesa tečeta na istem gostitelju (samogostovan posrednik).
  const file = path.join(__dirname, '..', 'posrednik', 'data', 'admin-credentials.txt');
  try {
    const m = /^ZETON=(.+)$/m.exec(fs.readFileSync(file, 'utf8'));
    if (m) {
      if (logger) logger.info({ file }, 'POSREDNIK_TOKEN ni nastavljen — žeton prebran iz sosednje mape posrednika');
      return m[1].trim();
    }
  } catch { /* posrednik še ni tekel ali pa ni na tem gostitelju */ }
  return null;
}

let token = null;
let http = null;
let logger = null;

function init(log) {
  logger = log;
  token = resolveToken(log);
  http = axios.create({
    baseURL: POSREDNIK_URL,
    timeout: TIMEOUT_MS,
    validateStatus: () => true,
    headers: { 'X-Merchant': process.env.MERCHANT_ID || 'default', ...(token ? { Authorization: `Bearer ${token}` } : {}) }
  });
  if (!token) log.warn({ posrednik: POSREDNIK_URL }, 'Ni žetona posrednika — nastavi POSREDNIK_TOKEN (grep ZETON ../posrednik/data/admin-credentials.txt)');
  return module.exports;
}

// Če posrednik ob zagonu trgovca še ni tekel, žetona ni bilo. Ob prvi zavrnitvi
// (401/403) ga poskusimo prebrati še enkrat, namesto da bi zahtevali ponovni zagon.
function refreshToken() {
  const t = resolveToken(null);
  if (t && t !== token) {
    token = t;
    http.defaults.headers.Authorization = `Bearer ${token}`;
    if (logger) logger.info('žeton posrednika osvežen');
    return true;
  }
  return false;
}

async function call(method, url, body) {
  const t0 = performance.now();
  try {
    let r = await http.request({ method, url, data: body });
    if ((r.status === 401 || r.status === 403) && !url.startsWith('/submit') && refreshToken()) {
      r = await http.request({ method, url, data: body });
    }
    return { status: r.status, data: r.data, ms: performance.now() - t0 };
  } catch (err) {
    return { status: 0, error: err.message, ms: performance.now() - t0 };
  }
}

// ── posredniški protokol ─────────────────────────────────────────────────────
const paymentRequest = (b) => call('post', '/payment-request', b);
const verifyProof = (b) => call('post', '/verify-proof', b);
// ── merjena seja ─────────────────────────────────────────────────────────────
const sessionOpen = (b) => call('post', '/session/open', b);
const sessionView = (id) => call('get', `/session/${encodeURIComponent(id)}`);
const debit = (b) => call('post', '/debit', b);
// ── stanje ───────────────────────────────────────────────────────────────────
const health = () => call('get', '/health');
// ── x402 v2 facilitatorski klici ─────────────────────────────────────────────
// Preverjanje/poravnavo/uskladitev opravi posrednik; trgovec še naprej NIKOLI
// ne govori z verigo. Isti ovoj `call` ohrani žeton, ponovno prijavo in
// števce X-Downstream-Ms — zato NE uporabljamo SDK-jevega HTTPFacilitatorClient,
// ki bi te meritve obšel z lastnim HTTP skladom.
const x402Verify = (b) => call('post', '/x402/verify', b);
const x402Settle = (b) => call('post', '/x402/settle', b);
const x402Supported = () => call('get', '/x402/supported');
const x402Reconcile = (b) => call('post', '/x402/reconcile', b);
const x402Payment = (id) => call('get', `/x402/payment/${encodeURIComponent(id)}`);

// Nastavitve posrednika (omrežje, mock način) s kratkim predpomnilnikom: trgovec
// jih potrebuje za stran in za vgrajenega agenta, ne pa ob vsaki zahtevi.
let cfgCache = null, cfgAt = 0;
const CFG_TTL_MS = 15_000;
async function config({ force = false } = {}) {
  if (!force && cfgCache && Date.now() - cfgAt < CFG_TTL_MS) return cfgCache;
  const r = await call('get', '/config');
  if (r.status === 200 && r.data && typeof r.data === 'object') { cfgCache = r.data; cfgAt = Date.now(); }
  return cfgCache;
}

module.exports = {
  init, paymentRequest, verifyProof, sessionOpen, sessionView, debit, health, config,
  x402Verify, x402Settle, x402Supported, x402Reconcile, x402Payment,
  url: POSREDNIK_URL, publicUrl: POSREDNIK_PUBLIC_URL, hasToken: () => !!token
};
