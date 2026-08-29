'use strict';

// Node 18: the global WebCrypto is only unconditionally available from Node 19 on (see x402.js).
if (!globalThis.crypto) globalThis.crypto = require('node:crypto').webcrypto;

/**
 * x402 v2 — shared CLIENT module for the measurement agents (official protocol).
 * Byte-identical copy in the folders 01/client, 02/agent, 03/agent, 04/agent.
 *
 * The measurement flow is DECOMPOSED into phases (like the existing measurement
 * clients), so it does not use wrapFetchWithPayment but drives the steps itself:
 *
 *   1. GET resource       → 402 + PAYMENT-REQUIRED     (t_402)
 *   2. EIP-3009 signature → PaymentPayload             (t_sign)
 *   3. repeat GET + PAYMENT-SIGNATURE → 200 + PAYMENT-RESPONSE (t_payment_http)
 *
 * The client signs an AUTHORIZATION; the settlement transaction is submitted by
 * the server/facilitator, which pays the gas. The client does NOT pay gas.
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
 * Payer: privateKey from wallet.json (x402PayerPrivateKey) or a one-time
 * wallet for mock mode (no funds — the mock server never reads the chain).
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
  // The SDK's default spendControls only allows assets from its registry;
  // test ETH on eip155:11155111 is not in there, so createPaymentPayload would
  // otherwise reject ALL of the server's requests ("rejected by spendControls").
  client.setSpendControls(false);
  // A single persistent hook (not per call — hooks cannot be unregistered): the
  // payment-id for the current signature is carried by the __pid property, set by payFlow.
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
 * One x402 payment round trip with phase measurement.
 *
 * @param {object} o
 *   o.url          full URL of the resource
 *   o.account      viem account of the payer (makePayer)
 *   o.client       x402Client (makeClient) — may be shared across calls
 *   o.headers      additional headers (e.g. Authorization: Bearer <TOKEN>)
 *   o.paymentId    explicit payment-identifier (default: a fresh generatePaymentId())
 *   o.method       default GET
 *   o.fault        for tests: value of the X-X402-Mock-Fault header on the PAID request
 *   o.reuseHeaders for tests: already-signed headers from a previous round (replay)
 * @returns measurements + response + signed headers (for replay in tests)
 */
async function payFlow(o) {
  const { x402HTTPClient, generatePaymentId, appendPaymentIdentifierToExtensions } = requireSdk();
  const httpClient = new x402HTTPClient(o.client);
  const headers = { ...(o.headers || {}) };
  const t = {};
  const paymentId = o.paymentId || generatePaymentId();

  // 1) challenge
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
  if (!paymentRequired) throw new Error('402 without a readable PAYMENT-REQUIRED');

  let signedHeaders = o.reuseHeaders;
  if (!signedHeaders) {
    // 2) sign the authorization (payment-identifier goes into the extensions BEFORE signing)
    o.client.__pid = paymentId;
    t0 = performance.now();
    let payload;
    try {
      payload = await o.client.createPaymentPayload(paymentRequired);
    } finally {
      o.client.__pid = null;
    }
    t.tSign = performance.now() - t0;
    signedHeaders = httpClient.encodePaymentSignatureHeader(payload);
    if (o.mutateAuthorization) {
      // for negative tests: corrupt a signed field after signing
      const raw = decodeB64Json(Object.values(signedHeaders)[0]);
      o.mutateAuthorization(raw.payload.authorization, raw);
      const b64 = Buffer.from(JSON.stringify(raw), 'utf8').toString('base64');
      for (const k of Object.keys(signedHeaders)) signedHeaders[k] = b64;
    }
  } else {
    t.tSign = 0;
  }

  // 3) paid request
  const paidHeaders = { ...headers, ...signedHeaders, 'Access-Control-Expose-Headers': 'PAYMENT-RESPONSE,X-PAYMENT-RESPONSE' };
  if (o.fault) paidHeaders['X-X402-Mock-Fault'] = o.fault;
  t0 = performance.now();
  const res = await fetch(o.url, { method: o.method || 'GET', headers: paidHeaders, ...bodyInit });
  t.tPaymentHttp = performance.now() - t0;

  const paymentResponse = readPaymentResponseHeader(res);
  const serverMs = parseFloat(res.headers.get('X-Server-Ms') || '') || null;
  const settleMs = parseFloat(res.headers.get('X-Settle-Ms') || '') || null;
  const verifyMs = parseFloat(res.headers.get('X-Verify-Ms') || '') || null;
  const replayed = res.headers.get('X-X402-Idempotent-Replay') === '1';

  return {
    ok: res.ok, status: res.status, res, t, paymentId, signedHeaders,
    paymentResponse, serverMs, settleMs, verifyMs, replayed,
    synthetic: !!(paymentResponse && paymentResponse.txHash &&
      paymentResponse.txHash.startsWith('0x6d6f636b6d6f636b'))
  };
}

module.exports = { requireSdk, makePayer, makeClient, payFlow, readPaymentResponseHeader, decodeB64Json };
