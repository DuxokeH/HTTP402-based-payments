'use strict';

// Node 18: globalni WebCrypto je brezpogojen šele od Node 19 (glej x402.js).
if (!globalThis.crypto) globalThis.crypto = require('node:crypto').webcrypto;

/**
 * x402 v2 — skupni ODJEMALSKI modul za merilne agente (uradni protokol).
 * Bajt-identična kopija v mapah 01/klient, 02/agent, 03/agent, 04/agent.
 *
 * Meritveni tok je RAZSTAVLJEN na faze (kot obstoječi merilni klienti), zato
 * ne uporablja wrapFetchWithPayment, ampak korake vodi sam:
 *
 *   1. GET vir            → 402 + PAYMENT-REQUIRED     (t_402)
 *   2. podpis EIP-3009    → PaymentPayload             (t_podpis)
 *   3. ponovni GET + PAYMENT-SIGNATURE → 200 + PAYMENT-RESPONSE (t_poravnava_http)
 *
 * Odjemalec podpiše POOBLASTILO; poravnalno transakcijo odda strežnik/
 * posrednik in ta plača gas. Odjemalec gasa NE plača.
 */

const { performance } = require('perf_hooks');

let sdk = null;
function requireSdk() {
  if (sdk) return sdk;
  const { x402Client, x402HTTPClient } = require('@x402/fetch');
  const { ExactEvmScheme } = require('@x402/evm/exact/client');
  const { generatePaymentId, appendPaymentIdentifierToExtensions, extractPaymentIdentifier } =
    require('@x402/extensions/payment-identifier');
  const { privateKeyToAccount, generatePrivateKey } = require('viem/accounts');
  sdk = { x402Client, x402HTTPClient, ExactEvmScheme, generatePaymentId, appendPaymentIdentifierToExtensions, extractPaymentIdentifier, privateKeyToAccount, generatePrivateKey };
  return sdk;
}

/**
 * Plačnik: privateKey iz wallet.json (x402PayerPrivateKey) ali enkratna
 * denarnica za mock (brez sredstev — mock strežnik verige ne bere).
 */
function makePayer({ privateKey } = {}) {
  const { privateKeyToAccount, generatePrivateKey } = requireSdk();
  const account = privateKeyToAccount(privateKey || generatePrivateKey());
  return account;
}

function makeClient(account) {
  const { x402Client, ExactEvmScheme, appendPaymentIdentifierToExtensions } = requireSdk();
  const client = new x402Client();
  client.register('eip155:*', new ExactEvmScheme(account));
  // SDK-jev privzeti spendControls dovoli le sredstva iz njegovega registra;
  // testni ETH na eip155:11155111 tam ni, zato bi createPaymentPayload sicer
  // zavrnil VSE strežnikove zahteve ("rejected by spendControls").
  client.setSpendControls(false);
  // En sam trajni hook (ne po klicu — hooki se ne dajo odjaviti): payment-id
  // za tekoči podpis nosi lastnost __pid, ki jo nastavi payFlow.
  client.__pid = null;
  client.onBeforePaymentCreation(async ({ paymentRequired }) => {
    if (client.__pid && paymentRequired.extensions) {
      appendPaymentIdentifierToExtensions(paymentRequired.extensions, client.__pid);
    }
  });
  return client;
}

function decodeB64Json(v) {
  try { return JSON.parse(Buffer.from(String(v), 'base64').toString('utf8')); } catch { return null; }
}

function readPaymentResponseHeader(res) {
  const h = res.headers.get('PAYMENT-RESPONSE') || res.headers.get('X-PAYMENT-RESPONSE');
  if (!h) return null;
  const j = decodeB64Json(h);
  if (!j) return null;
  return { success: !!j.success, txHash: j.transaction || null, network: j.network, payer: j.payer, errorReason: j.errorReason || null };
}

/**
 * En x402 plačilni obhod z merjenjem faz.
 *
 * @param {object} o
 *   o.url          polni URL vira
 *   o.account      viem račun plačnika (makePayer)
 *   o.client       x402Client (makeClient) — lahko se deli med klici
 *   o.headers      dodatne glave (npr. Authorization: Bearer <ZETON>)
 *   o.paymentId    izrecni payment-identifier (privzeto nov generatePaymentId())
 *   o.method       privzeto GET
 *   o.fault        za teste: vrednost glave X-X402-Mock-Fault pri PLAČANI zahtevi
 *   o.reuseHeaders za teste: že podpisane glave prejšnjega kroga (predvajanje)
 * @returns meritve + odgovor + podpisane glave (za predvajanje v testih)
 */
async function payFlow(o) {
  const { x402HTTPClient, generatePaymentId, appendPaymentIdentifierToExtensions } = requireSdk();
  const httpClient = new x402HTTPClient(o.client);
  const headers = { ...(o.headers || {}) };
  const t = {};
  const paymentId = o.paymentId || generatePaymentId();

  // 1) izziv
  const bodyInit = o.body != null ? { body: typeof o.body === 'string' ? o.body : JSON.stringify(o.body) } : {};
  if (o.body != null) headers['Content-Type'] = 'application/json';
  let t0 = performance.now();
  const first = await fetch(o.url, { method: o.method || 'GET', headers, ...bodyInit });
  t.t402 = performance.now() - t0;
  if (first.status !== 402) {
    return { ok: first.ok, status: first.status, unexpected: true, res: first, t, paymentId };
  }
  const prHeader = first.headers.get('PAYMENT-REQUIRED');
  const paymentRequired = prHeader ? decodeB64Json(prHeader) : await first.json().catch(() => null);
  if (!paymentRequired) throw new Error('402 brez berljivega PAYMENT-REQUIRED');

  let signedHeaders = o.reuseHeaders;
  if (!signedHeaders) {
    // 2) podpis pooblastila (payment-identifier v razširitve PRED podpisom)
    o.client.__pid = paymentId;
    t0 = performance.now();
    let payload;
    try {
      payload = await o.client.createPaymentPayload(paymentRequired);
    } finally {
      o.client.__pid = null;
    }
    t.tPodpis = performance.now() - t0;
    signedHeaders = httpClient.encodePaymentSignatureHeader(payload);
    if (o.mutateAuthorization) {
      // za negativne teste: pokvari podpisano polje po podpisu
      const raw = decodeB64Json(Object.values(signedHeaders)[0]);
      o.mutateAuthorization(raw.payload.authorization, raw);
      const b64 = Buffer.from(JSON.stringify(raw), 'utf8').toString('base64');
      for (const k of Object.keys(signedHeaders)) signedHeaders[k] = b64;
    }
  } else {
    t.tPodpis = 0;
  }

  // 3) plačana zahteva
  const paidHeaders = { ...headers, ...signedHeaders, 'Access-Control-Expose-Headers': 'PAYMENT-RESPONSE,X-PAYMENT-RESPONSE' };
  if (o.fault) paidHeaders['X-X402-Mock-Fault'] = o.fault;
  t0 = performance.now();
  const res = await fetch(o.url, { method: o.method || 'GET', headers: paidHeaders, ...bodyInit });
  t.tPoravnavaHttp = performance.now() - t0;

  const paymentResponse = readPaymentResponseHeader(res);
  const serverMs = parseFloat(res.headers.get('X-Server-Ms') || '') || null;
  const settleMs = parseFloat(res.headers.get('X-Settle-Ms') || '') || null;
  const verifyMs = parseFloat(res.headers.get('X-Verify-Ms') || '') || null;
  const replayed = res.headers.get('X-X402-Idempotent-Replay') === '1';

  return {
    ok: res.ok, status: res.status, res, t, paymentId, signedHeaders,
    paymentResponse, serverMs, settleMs, verifyMs, replayed,
    sinteticni: !!(paymentResponse && paymentResponse.txHash &&
      paymentResponse.txHash.startsWith('0x6d6f636b6d6f636b'))
  };
}

module.exports = { requireSdk, makePayer, makeClient, payFlow, readPaymentResponseHeader, decodeB64Json };
