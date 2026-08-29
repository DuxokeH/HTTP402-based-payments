'use strict';

/**
 * In-process M2M agent for the showcase site (folder 05_website_direct).
 *
 * runTx      — the 20-transactions flow: one full on-chain pay-per-reading loop.
 * runMetered — the metered flow: one top-up opens a session, then N EIP-191
 *              signed debits (no new transaction per reading).
 *
 * Both make REAL HTTP calls to this server over loopback (so Wireshark still
 * sees the 402 / X-Payment / X-Signature traffic) and stream live events to the
 * browser via the `emit(event, data)` callback (Server-Sent Events).
 *
 * mock === true  → no chain: transactions are faked and the server mock-verifies;
 *                  debits are signed by an ephemeral wallet (no funds needed).
 * mock === false → real Sepolia: needs payerPk (a funded consumer wallet).
 */

const axios = require('axios');
const { ethers } = require('ethers');
const { performance } = require('perf_hooks');

// Mark this agent's calls: a machine is not a browser, so there is no `sid` session
// cookie for it (its identity is the wallet + EIP-191 signature). See docs/IDENTITY.md §2 B.
// Because the website is locked behind the admin login, the agent identifies itself as a machine with a token.
const agentHeaders = (adminToken) => ({
  'X-Demo-Agent': 'runner',
  ...(adminToken ? { Authorization: `Bearer ${adminToken}` } : {})
});

const debitMessage = (payer, session, nonce, resource, maxWei) =>
  `x402-debit:${payer.toLowerCase()}:${session}:${nonce}:${resource}:${maxWei}`;
const randTxHash = () => '0x' + Buffer.from(ethers.randomBytes(32)).toString('hex');
const mkNonce = () => `${Date.now()}-${Buffer.from(ethers.randomBytes(6)).toString('hex')}`;

function makeWallet(mock, payerPk, rpcUrl) {
  if (mock) return { wallet: ethers.Wallet.createRandom(), provider: null };
  if (!payerPk) throw new Error('Real mode is missing payerPrivateKey in wallet.json');
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  return { wallet: new ethers.Wallet(payerPk, provider), provider };
}

// ── 2) 20 transactions ───────────────────────────────────────────────────────
async function runTx(opts) {
  const { baseURL, network, rpcUrl, mock, payerPk, priceWei, queries, isAlive, emit } = opts;
  const CONF = Math.max(1, parseInt(opts.confirmations || 1, 10));
  const http = axios.create({ baseURL, timeout: 90_000, validateStatus: () => true, headers: agentHeaders(opts.adminToken) });
  const { wallet } = makeWallet(mock, payerPk, rpcUrl);
  emit('start', { mode: mock ? 'mock' : 'real', queries: queries, payer: wallet.address, priceWei: priceWei });

  let cumFee = 0, ok = 0;
  for (let i = 1; i <= queries; i++) {
    if (!isAlive()) return;
    const T0 = performance.now();
    // 402 challenge
    const ch = await http.get('/tx/reading', { headers: { 'X-Payer': wallet.address } });
    if (ch.status !== 402) { emit('error', { i, message: `expected 402, got ${ch.status}` }); continue; }
    const pay = ch.data.payment;

    // pay (one tx per reading)
    let txHash, gasUsed = null, feeEth = null, tConfirm = 0;
    if (mock) {
      txHash = randTxHash();
    } else {
      const s = performance.now();
      const tx = await wallet.sendTransaction({ to: pay.to, value: BigInt(pay.priceWei) });
      txHash = tx.hash;
      const rc = await tx.wait(CONF);   // not hard-coded 1: otherwise MIN_CONFIRMATIONS>1 means every verification fails
      tConfirm = performance.now() - s;
      gasUsed = rc.gasUsed.toString();
      const gp = rc.gasPrice ?? tx.gasPrice ?? null;
      if (gp) { feeEth = parseFloat(ethers.formatEther(rc.gasUsed * gp)); cumFee += feeEth; }
    }
    // verify -> proof
    const vf = await http.post('/tx/verify', { requestId: pay.requestId, txHash, network, payerAddress: wallet.address });
    if (vf.status !== 200) { emit('error', { i, message: `verify ${vf.status}` }); continue; }
    // reading
    const rd = await http.get('/tx/reading', { headers: { 'X-Payment': vf.data.proofToken } });
    if (rd.status !== 200) { emit('error', { i, message: `reading ${rd.status}` }); continue; }
    ok++;
    emit('query', {
      i, reading: rd.data.reading, tTotalMs: +(performance.now() - T0).toFixed(1),
      tConfirmMs: +tConfirm.toFixed(1), gasUsed, feeEth, cumFeeEth: +cumFee.toFixed(8),
      onChainTx: mock ? i : ok
    });
  }
  emit('summary', { mode: mock ? 'mock' : 'real', succeeded: ok, onChainTransactions: mock ? queries : ok, cumulativeFeeEth: +cumFee.toFixed(8) });
}

// ── 3) metered session ───────────────────────────────────────────────────────
async function runMetered(opts) {
  const { baseURL, network, rpcUrl, mock, payerPk, resource, debits, topupWei, isAlive, emit } = opts;
  const CONF = Math.max(1, parseInt(opts.confirmations || 1, 10));
  const http = axios.create({ baseURL, timeout: 90_000, validateStatus: () => true, headers: agentHeaders(opts.adminToken) });
  const { wallet } = makeWallet(mock, payerPk, rpcUrl);
  const cfg = (await http.get('/config')).data.metered;
  const maxWei = (BigInt(cfg.priceWeiPerCall) + BigInt(cfg.priceWeiPerByte) * 4096n).toString();
  emit('start', { mode: mock ? 'mock' : 'real', debits: debits, payer: wallet.address, priceWei: cfg.priceWeiPerCall });

  // top-up (one on-chain tx) -> open session
  let txHash, gasUsed = null, feeEth = null;
  if (mock) { txHash = randTxHash(); }
  else {
    const tx = await wallet.sendTransaction({ to: opts.receiver, value: BigInt(topupWei) });
    txHash = tx.hash;
    const rc = await tx.wait(CONF);   // not hard-coded 1: otherwise MIN_CONFIRMATIONS>1 means every verification fails
    gasUsed = rc.gasUsed.toString();
    const gp = rc.gasPrice ?? tx.gasPrice ?? null;
    if (gp) feeEth = parseFloat(ethers.formatEther(rc.gasUsed * gp));
  }
  const openBody = { txHash, network, payerAddress: wallet.address };
  const op = await http.post('/metered/session/open', openBody);
  if (op.status !== 200) throw new Error(`session/open ${op.status}: ${JSON.stringify(op.data)}`);
  const session = op.data.session;
  if (typeof opts.onSession === 'function') { try { opts.onSession(session.sessionId, wallet.address); } catch {} }
  emit('session', { sessionId: session.sessionId, depositWei: session.depositWei, budgetWei: session.budgetWei, expiresAt: session.expiresAt, gasUsed, feeEth });

  // N signed debits (no chain)
  const tPod = [], tZah = []; let ok = 0;
  for (let i = 1; i <= debits; i++) {
    if (!isAlive()) return;
    const nonce = mkNonce();
    let s = performance.now();
    const sig = await wallet.signMessage(debitMessage(wallet.address, session.sessionId, nonce, resource, maxWei));
    const tPodpis = performance.now() - s;
    s = performance.now();
    const r = await http.get('/metered/reading-metered', { headers: { 'X-Payer': wallet.address, 'X-Session': session.sessionId, 'X-Nonce': nonce, 'X-Signature': sig, 'X-Max-Wei': maxWei } });
    const tZahteva = performance.now() - s;
    if (r.status !== 200) { emit('error', { i, message: `${r.status}: ${JSON.stringify(r.data)}` }); continue; }
    ok++; tPod.push(tPodpis); tZah.push(tZahteva);
    emit('debit', {
      i, reading: r.data.reading, tSignMs: +tPodpis.toFixed(2), tRequestMs: +tZahteva.toFixed(2),
      priceWei: r.headers['x-charged-wei'], creditWei: r.headers['x-balance-wei'], budgetRemainingWei: r.headers['x-budget-remaining-wei']
    });
  }
  const med = (a) => { a = a.slice().sort((x, y) => x - y); return a.length ? +a[Math.floor(a.length / 2)].toFixed(2) : null; };
  const fin = (await http.get(`/metered/session/${session.sessionId}`)).data.session;
  emit('summary', { mode: mock ? 'mock' : 'real', succeeded: ok, onChainTransactions: 1, medSignMs: med(tPod), medRequestMs: med(tZah), finalCreditWei: fin.balanceWei, spentWei: fin.spentWei });
}


// ══════════ x402 v2 (PARALLEL MODE) — built-in M2M agents ════════════════════
// The same idea as runTx/runMetered, but over the official x402 protocol: the client
// signs an EIP-3009 authorisation (PAYMENT-SIGNATURE), while the server settles the
// ETH on Ethereum Sepolia ITSELF (testnet — the settlement is synthetic/mock) and pays the gas.
// The new SSE events (challenge, settlement,
// idempotency) do not change the existing seven; in the metered flow every event
// is tagged with `chain: true|false`, so the screen can tell the ON-CHAIN TOP-UP from
// the OFF-CHAIN LOCAL DEBITS.
const x402o = () => require('./x402-client');
const x402cfg = () => require('./x402').config; // asset name etc. for the SSE labels

function makeX402Payer(mock, payerPk) {
  const { privateKeyToAccount, generatePrivateKey } = require('viem/accounts');
  if (mock) return privateKeyToAccount(generatePrivateKey());
  if (!payerPk) throw new Error('Real mode is missing x402PayerPrivateKey in wallet.json');
  return privateKeyToAccount(payerPk);
}

// ── 2x · 20 x402 settlements ────────────────────────────────────────────────────
async function runX402Tx(opts) {
  const { baseURL, mock, x402PayerPk, queries, isAlive, emit } = opts;
  const o = x402o();
  const account = makeX402Payer(mock, x402PayerPk);
  const client = o.makeClient(account);
  const H = opts.adminToken ? { Authorization: `Bearer ${opts.adminToken}`, 'X-Demo-Agent': 'runner' } : { 'X-Demo-Agent': 'runner' };
  emit('start', { mode: mock ? 'mock' : 'real', protocol: 'x402-self', network: opts.network, asset: x402cfg().assetName, queries: queries, payer: account.address, priceAtomic: opts.priceAtomic, gasPayer: 'server' });

  let ok = 0; let cumulativeAtomic = 0n;
  for (let i = 1; i <= queries; i++) {
    if (!isAlive()) return;
    const T0 = performance.now();
    try {
      const r = await o.payFlow({ url: `${baseURL}/x402/tx/reading`, account, client, headers: H });
      const skupaj = performance.now() - T0;
      if (r.status !== 200) { emit('error', { i, message: `payment ${r.status}` }); continue; }
      const body = await r.res.json();
      cumulativeAtomic += BigInt(opts.priceAtomic || '0');
      emit('challenge', { i, scheme: 'exact', network: opts.network, amountAtomic: opts.priceAtomic, paymentId: r.paymentId, tChallengeMs: r.t.t402 });
      emit('settlement', { i, passed: true, txHash: r.paymentResponse ? r.paymentResponse.txHash : null, synthetic: r.synthetic, gasPayer: 'server', tSignMs: r.t.tPodpis, tPoravnavaMs: r.t.tPoravnavaHttp });
      emit('idempotency', { i, paymentId: r.paymentId, outcome: r.replayed ? 'cached' : 'nov' });
      emit('query', { i, ok: true, protocol: 'x402-self', tTotalMs: skupaj, reading: body.reading, txHash: r.paymentResponse ? r.paymentResponse.txHash : null, synthetic: r.synthetic, cumulativeAtomic: cumulativeAtomic.toString() });
      ok++;
    } catch (e) { emit('error', { i, message: e.message }); }
  }
  emit('summary', { protocol: 'x402-self', succeeded: ok, queryCount: queries, settlements: ok, totalAtomic: cumulativeAtomic.toString(), gasPayer: 'server' });
}

// ── 3x · 1 x402 top-up + N local debits v2 ──────────────────────────────────────
async function runX402Metered(opts) {
  const { baseURL, mock, x402PayerPk, debits, isAlive, emit } = opts;
  const o = x402o();
  const account = makeX402Payer(mock, x402PayerPk);
  const client = o.makeClient(account);
  const H = opts.adminToken ? { Authorization: `Bearer ${opts.adminToken}`, 'X-Demo-Agent': 'runner' } : { 'X-Demo-Agent': 'runner' };
  emit('start', { mode: mock ? 'mock' : 'real', protocol: 'x402-self', network: opts.network, asset: x402cfg().assetName, debit: debits, payer: account.address, gasPayer: 'server' });

  // PHASE A — ON-CHAIN TOP-UP (a single x402 settlement)
  const open = await o.payFlow({ url: `${baseURL}/x402/metered/session/open`, method: 'POST', account, client, headers: H, body: {} });
  if (open.status !== 200) { emit('error', { message: `top-up ${open.status}` }); return; }
  const ob = await open.res.json();
  const session = ob.session;
  if (opts.onSession) opts.onSession(session.sessionId, account.address);
  emit('settlement', { passed: true, chain: true, txHash: open.paymentResponse ? open.paymentResponse.txHash : null, synthetic: open.synthetic, gasPayer: 'server', kind: 'topup' });
  emit('session', { chain: true, protocol: 'x402-self', sessionId: session.sessionId, depositAtomic: session.depositAtomic, budgetAtomic: session.budgetAtomic, expiresAt: session.expiresAt, txHash: open.paymentResponse ? open.paymentResponse.txHash : null, synthetic: open.synthetic });

  // PHASE B — OFF-CHAIN LOCAL DEBITS (no chain)
  const cfg = await fetch(`${baseURL}/x402/config`, { headers: H }).then((r) => r.json()).catch(() => null);
  const maxAtomic = (cfg && cfg.metered && cfg.metered.priceAtomicPerCall) || '10000';
  const assetAddr = (cfg && cfg.asset) || '';
  const network = (cfg && cfg.network) || 'eip155:11155111';
  const resPath = (cfg && cfg.metered && cfg.metered.resource) || '/x402/metered/reading-metered';
  let ok = 0;
  for (let i = 1; i <= debits; i++) {
    if (!isAlive()) return;
    try {
      const nonce = mkNonce();
      const msg = `metered-debit-v2:${account.address.toLowerCase()}:${session.sessionId}:${nonce}:${resPath}:${maxAtomic}:${network}:${assetAddr.toLowerCase()}`;
      const t0 = performance.now();
      const signature = await account.signMessage({ message: msg });
      const tPodpis = performance.now() - t0;
      const t1 = performance.now();
      const r = await fetch(`${baseURL}${resPath}`, { headers: { ...H, 'X-Payer': account.address, 'X-Session': session.sessionId, 'X-Nonce': nonce, 'X-Signature': signature, 'X-Max-Atomic': maxAtomic } });
      const tZahteva = performance.now() - t1;
      if (r.status !== 200) { emit('error', { i, message: `debit ${r.status}` }); continue; }
      const body = await r.json();
      emit('debit', { i, chain: false, protocol: 'x402-self', reading: body.reading,
        chargedAtomic: r.headers.get('X-Charged-Atomic'), balanceAtomic: r.headers.get('X-Balance-Atomic'),
        budgetRemainingAtomic: r.headers.get('X-Budget-Remaining-Atomic'),
        tSignMs: tPodpis, tRequestMs: tZahteva });
      ok++;
    } catch (e) { emit('error', { i, message: e.message }); }
  }
  emit('summary', { protocol: 'x402-self', succeeded: ok, debit: debits, settlements: 1, gasPayer: 'server', message: `1 on-chain top-up + ${ok} off-chain debits` });
}

module.exports = { runTx, runMetered, runX402Tx, runX402Metered };

