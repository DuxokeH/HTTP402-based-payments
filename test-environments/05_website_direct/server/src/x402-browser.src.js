// Source for public/x402-browser.js — built with: npm run build:client
// Official x402 v2 client for the browser: @x402/fetch + @x402/evm (exact) +
// payment-identifier, with a MetaMask signer (eth_signTypedData_v4).
// Everything is in the bundle (no CDN) — the CSP stays 'self'.
import { x402Client, x402HTTPClient } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { generatePaymentId, appendPaymentIdentifierToExtensions } from '@x402/extensions/payment-identifier';

const b64 = {
  dec(v) { try { return JSON.parse(atob(String(v))); } catch { return null; } },
};

/** MetaMask → ClientEvmSigner: the scheme needs only address + signTypedData. */
function makeMetaMaskSigner(ethereum, address) {
  return {
    address,
    async signTypedData({ domain, types, primaryType, message }) {
      // eth_signTypedData_v4 also requires the EIP712Domain type description
      const domainType = [];
      if ('name' in domain) domainType.push({ name: 'name', type: 'string' });
      if ('version' in domain) domainType.push({ name: 'version', type: 'string' });
      if ('chainId' in domain) domainType.push({ name: 'chainId', type: 'uint256' });
      if ('verifyingContract' in domain) domainType.push({ name: 'verifyingContract', type: 'address' });
      const payload = JSON.stringify({
        domain, primaryType, message,
        types: { EIP712Domain: domainType, ...types },
      }, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
      return ethereum.request({ method: 'eth_signTypedData_v4', params: [address, payload] });
    },
  };
}

function makeClient(signer) {
  const client = new x402Client();
  client.register('eip155:*', new ExactEvmScheme(signer));
  client.setSpendControls(false); // the SDK registry does not know the testnet asset
  client.__pid = null;
  client.onBeforePaymentCreation(async ({ paymentRequired }) => {
    if (client.__pid && paymentRequired.extensions) {
      appendPaymentIdentifierToExtensions(paymentRequired.extensions, client.__pid);
    }
  });
  return client;
}

/** One x402 round trip: 402 → signature → paid request. Returns the measurements and the response. */
async function payFlow({ url, client, method = 'GET', body = null, paymentId = null }) {
  const httpClient = new x402HTTPClient(client);
  const pid = paymentId || generatePaymentId();
  const init = { method, headers: {} };
  if (body != null) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
  const t = {};
  let t0 = performance.now();
  const first = await fetch(url, init);
  t.t402 = performance.now() - t0;
  if (first.status !== 402) return { status: first.status, res: first, t, paymentId: pid, unexpected: true };
  const pr = b64.dec(first.headers.get('PAYMENT-REQUIRED'));
  if (!pr) throw new Error('402 without a readable PAYMENT-REQUIRED');

  client.__pid = pid;
  t0 = performance.now();
  let payload;
  try { payload = await client.createPaymentPayload(pr); }
  finally { client.__pid = null; }
  t.tPodpis = performance.now() - t0;

  const paid = { ...init, headers: { ...init.headers, ...httpClient.encodePaymentSignatureHeader(payload), 'Access-Control-Expose-Headers': 'PAYMENT-RESPONSE,X-PAYMENT-RESPONSE' } };
  t0 = performance.now();
  const res = await fetch(url, paid);
  t.tPayment = performance.now() - t0;

  const prh = b64.dec(res.headers.get('PAYMENT-RESPONSE') || res.headers.get('X-PAYMENT-RESPONSE'));
  return {
    status: res.status, res, t, paymentId: pid,
    txHash: prh && prh.transaction || null,
    synthetic: !!(prh && prh.transaction && prh.transaction.startsWith('0x6d6f636b6d6f636b')),
    replayed: res.headers.get('X-X402-Idempotent-Replay') === '1',
  };
}

window.X402Client = { makeMetaMaskSigner, makeClient, payFlow, generatePaymentId };
