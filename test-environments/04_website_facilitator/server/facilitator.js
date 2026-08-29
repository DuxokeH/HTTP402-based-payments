'use strict';

/**
 * ============================================================================
 *  FACILITATOR client — the merchant's only path to payment state
 *  (folder 04_website_facilitator/server)
 * ============================================================================
 *
 *  In topology (b) the merchant cannot see the chain. Everything that in the direct
 *  implementation (folder 05_website_direct) is a `provider.getTransaction(...)` or
 *  `ethers.verifyMessage(...)` call is an HTTP call to the facilitator here. This module
 *  is exactly that mapping and nothing else.
 *
 *  Addresses:
 *    FACILITATOR_URL         where the MERCHANT calls (normally loopback, e.g. http://127.0.0.1:4000)
 *    FACILITATOR_PUBLIC_URL  what the merchant writes into the 402 response, so the PAYER
 *                            knows where to send `POST /submit-payment` (arrow C→F of the
 *                            facilitator flow). If the payer is not on the same machine,
 *                            this must be a public address.
 *
 *  Token: the facilitator authenticates merchants. Obtain the token with
 *      grep TOKEN ../facilitator/data/admin-credentials.txt
 *  and enter it as FACILITATOR_TOKEN in .env. Because the facilitator is deliberately
 *  LOCAL in this environment (self-hosted), the module can also read the token directly
 *  from the neighbouring folder — then starting both processes needs no manual copying.
 *
 *  No function throws in the request path: when the facilitator is unreachable it
 *  returns `{ status: 0, error }`, so the merchant answers with a 502 and not a 500.
 * ============================================================================
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

const FACILITATOR_URL = (process.env.FACILITATOR_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');
const FACILITATOR_PUBLIC_URL = (process.env.FACILITATOR_PUBLIC_URL || FACILITATOR_URL).replace(/\/+$/, '');
const TIMEOUT_MS = parseInt(process.env.FACILITATOR_TIMEOUT_MS || '20000', 10);

function resolveToken(logger) {
  if (process.env.FACILITATOR_TOKEN) return process.env.FACILITATOR_TOKEN;
  // Neighbour path: both processes run on the same host (self-hosted facilitator).
  const file = path.join(__dirname, '..', 'facilitator', 'data', 'admin-credentials.txt');
  try {
    const m = /^TOKEN=(.+)$/m.exec(fs.readFileSync(file, 'utf8'));
    if (m) {
      if (logger) logger.info({ file }, 'FACILITATOR_TOKEN is not set — token read from the neighbouring facilitator folder');
      return m[1].trim();
    }
  } catch { /* the facilitator has not run yet, or is not on this host */ }
  return null;
}

let token = null;
let http = null;
let logger = null;

function init(log) {
  logger = log;
  token = resolveToken(log);
  http = axios.create({
    baseURL: FACILITATOR_URL,
    timeout: TIMEOUT_MS,
    validateStatus: () => true,
    headers: { 'X-Merchant': process.env.MERCHANT_ID || 'default', ...(token ? { Authorization: `Bearer ${token}` } : {}) }
  });
  if (!token) log.warn({ facilitator: FACILITATOR_URL }, 'No facilitator token — set FACILITATOR_TOKEN (grep TOKEN ../facilitator/data/admin-credentials.txt)');
  return module.exports;
}

// If the facilitator was not yet running when the merchant started, there was no token.
// On the first rejection (401/403) we try to read it once more, instead of demanding a restart.
function refreshToken() {
  const t = resolveToken(null);
  if (t && t !== token) {
    token = t;
    http.defaults.headers.Authorization = `Bearer ${token}`;
    if (logger) logger.info('facilitator token refreshed');
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

// ── facilitator protocol ─────────────────────────────────────────────────────
const paymentRequest = (b) => call('post', '/payment-request', b);
const verifyProof = (b) => call('post', '/verify-proof', b);
// ── metered session ──────────────────────────────────────────────────────────
const sessionOpen = (b) => call('post', '/session/open', b);
const sessionView = (id) => call('get', `/session/${encodeURIComponent(id)}`);
const debit = (b) => call('post', '/debit', b);
// ── status ───────────────────────────────────────────────────────────────────
const health = () => call('get', '/health');
// ── x402 v2 facilitator calls ────────────────────────────────────────────────
// Verification/settlement/reconciliation is done by the facilitator; the merchant
// still NEVER talks to the chain. The same `call` wrapper preserves the token, the
// re-login and the X-Downstream-Ms counters — which is why we do NOT use the SDK's
// HTTPFacilitatorClient, as it would bypass these measurements with its own HTTP stack.
const x402Verify = (b) => call('post', '/x402/verify', b);
const x402Settle = (b) => call('post', '/x402/settle', b);
const x402Supported = () => call('get', '/x402/supported');
const x402Reconcile = (b) => call('post', '/x402/reconcile', b);
const x402Payment = (id) => call('get', `/x402/payment/${encodeURIComponent(id)}`);

// Facilitator settings (network, mock mode) with a short cache: the merchant needs
// them for the page and for the embedded agent, but not on every request.
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
  url: FACILITATOR_URL, publicUrl: FACILITATOR_PUBLIC_URL, hasToken: () => !!token
};
