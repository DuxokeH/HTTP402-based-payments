'use strict';

/**
 * In-process M2M agent for the showcase site — FACILITATOR BRANCH
 * (folder 04_website_facilitator/server).
 *
 * runTx      — 20-transactions flow: one full on-chain pay-per-reading loop.
 * runMetered — metered flow: one top-up opens a session, then N EIP-191
 *              signed debits (no new transaction per reading).
 *
 * Difference from the direct branch (folder 05): this agent is the PAYER, so
 * under the facilitator protocol it reports the payment to the FACILITATOR
 * (`POST /submit-payment`) and not to the merchant (`POST /tx/verify`, which
 * does not exist in this branch). It therefore has two addresses:
 *
 *    baseURL      merchant    — 402 challenge and access to the resource
 *    posrednikURL facilitator — payment reporting, proof-token issuance
 *
 * Requests to the facilitator do NOT carry the merchant's admin token:
 * `/submit-payment` is a public facilitator route, and the facilitator does not
 * know the merchant's token anyway (it has its own, separate login).
 *
 * Every event also carries `tFacilitatorMs` from the `X-Downstream-Ms` header —
 * how long the merchant waited for the facilitator. In the direct branch this
 * value is always 0; the difference between the branches is the measured
 * topology cost (the pay-per-reading and metered-session experiments).
 *
 * mock === true  → no chain: transactions are faked and the facilitator mock-verifies;
 *                  debits are signed by an ephemeral wallet (no funds needed).
 * mock === false → real Sepolia: needs payerPk (a funded consumer wallet).
 */

const axios = require('axios');
const { ethers } = require('ethers');
const { performance } = require('perf_hooks');

// Mark this agent's calls: a machine is not a browser, so it gets no `sid` session cookie
// (its identity is the wallet + the EIP-191 signature). See docs/IDENTITY.md §2 B.
// Since the website is closed behind the admin login, the agent identifies itself
// to the merchant with a token.
const agentHeaders = (adminToken) => ({
  'X-Demo-Agent': 'runner',
  ...(adminToken ? { Authorization: `Bearer ${adminToken}` } : {})
});

const debitMessage = (payer, session, nonce, resource, maxWei) =>
  `x402-debit:${payer.toLowerCase()}:${session}:${nonce}:${resource}:${maxWei}`;
const randTxHash = () => '0x' + Buffer.from(ethers.randomBytes(32)).toString('hex');
const mkNonce = () => `${Date.now()}-${Buffer.from(ethers.randomBytes(6)).toString('hex')}`;
const downMs = (r) => { const v = parseFloat(r.headers && r.headers['x-downstream-ms']); return Number.isFinite(v) ? +v.toFixed(2) : null; };

function makeWallet(mock, payerPk, rpcUrl) {
  if (mock) return { wallet: ethers.Wallet.createRandom(), provider: null };
  if (!payerPk) throw new Error('Real mode requires payerPrivateKey in wallet.json');
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  return { wallet: new ethers.Wallet(payerPk, provider), provider };
}

// Two clients: the merchant (with the admin token) and the facilitator (without).
function makeClients(opts) {
  return {
    merchant: axios.create({ baseURL: opts.baseURL, timeout: 90_000, validateStatus: () => true, headers: agentHeaders(opts.adminToken) }),
    facilitator: axios.create({ baseURL: opts.posrednikURL, timeout: 90_000, validateStatus: () => true, headers: { 'X-Demo-Agent': 'runner' } })
  };
}

// ── 2) 20 transactions ───────────────────────────────────────────────────────
async function runTx(opts) {
  const { network, rpcUrl, mock, payerPk, priceWei, queries, isAlive, emit } = opts;
  const CONF = Math.max(1, parseInt(opts.confirmations || 1, 10));
  const { merchant, facilitator } = makeClients(opts);
  const { wallet } = makeWallet(mock, payerPk, rpcUrl);
  emit('start', { mode: mock ? 'mock' : 'real', topology: 'facilitator', queries: queries, payer: wallet.address, priceWei: priceWei, facilitator: opts.posrednikURL });

  let cumFee = 0, ok = 0;
  for (let i = 1; i <= queries; i++) {
    if (!isAlive()) return;
    const T0 = performance.now();
    // 1) 402 challenge at the merchant (which opened it at the facilitator: M→F, F→M)
    const ch = await merchant.get('/tx/reading', { headers: { 'X-Payer': wallet.address } });
    if (ch.status !== 402) { emit('error', { i, message: `expected 402, got ${ch.status}` }); continue; }
    const pay = ch.data.payment;
    const tIzziv = performance.now() - T0;
    const dIzziv = downMs(ch);

    // 2) on-chain payment (C→B) — one payment per reading
    let txHash, gasUsed = null, feeEth = null, tConfirm = 0;
    if (mock) {
      txHash = randTxHash();
    } else {
      const s = performance.now();
      const tx = await wallet.sendTransaction({ to: pay.to, value: BigInt(pay.priceWei) });
      txHash = tx.hash;
      const rc = await tx.wait(CONF);   // not a hard-coded 1: otherwise MIN_CONFIRMATIONS>1 means every verification fails
      tConfirm = performance.now() - s;
      gasUsed = rc.gasUsed.toString();
      const gp = rc.gasPrice ?? tx.gasPrice ?? null;
      if (gp) { feeEth = parseFloat(ethers.formatEther(rc.gasUsed * gp)); cumFee += feeEth; }
    }

    // 3) report the payment to the FACILITATOR (C→F) — this is where the proof token is created
    let s = performance.now();
    const sp = await facilitator.post('/submit-payment', { requestId: pay.requestId, txHash, network, payerAddress: wallet.address });
    const tPrijava = performance.now() - s;
    if (sp.status !== 200) { emit('error', { i, message: `submit-payment ${sp.status}: ${JSON.stringify(sp.data)}` }); continue; }
    const proofToken = sp.data.proofToken || (sp.data.proof && sp.data.proof.token);

    // 4) access at the merchant with the proof (C→M; the merchant redeems it at the facilitator, M→F)
    s = performance.now();
    const rd = await merchant.get('/tx/reading', { headers: { 'X-Payment': proofToken } });
    const tDostop = performance.now() - s;
    if (rd.status !== 200) { emit('error', { i, message: `reading ${rd.status}` }); continue; }
    ok++;
    emit('query', {
      i, reading: rd.data.reading, tTotalMs: +(performance.now() - T0).toFixed(1),
      tChallengeMs: +tIzziv.toFixed(1), tReportMs: +tPrijava.toFixed(1), tAccessMs: +tDostop.toFixed(1),
      tFacilitatorMs: [dIzziv, downMs(rd)].filter(v => v !== null).reduce((a, b) => a + b, 0) || null,
      tConfirmMs: +tConfirm.toFixed(1), gasUsed, feeEth, cumFeeEth: +cumFee.toFixed(8),
      onChainTx: mock ? i : ok
    });
  }
  emit('summary', { mode: mock ? 'mock' : 'real', topology: 'facilitator', succeeded: ok, onChainTransactions: mock ? queries : ok, cumulativeFeeEth: +cumFee.toFixed(8) });
}

// ── 3) metered session ───────────────────────────────────────────────────────
async function runMetered(opts) {
  const { rpcUrl, mock, payerPk, resource, debits, topupWei, isAlive, emit } = opts;
  const CONF = Math.max(1, parseInt(opts.confirmations || 1, 10));
  const { merchant } = makeClients(opts);
  const { wallet } = makeWallet(mock, payerPk, rpcUrl);
  const cfg = (await merchant.get('/config')).data.metered;
  const maxWei = (BigInt(cfg.priceWeiPerCall) + BigInt(cfg.priceWeiPerByte) * 4096n).toString();
  emit('start', { mode: mock ? 'mock' : 'real', topology: 'facilitator', debits: debits, payer: wallet.address, priceWei: cfg.priceWeiPerCall, facilitator: opts.posrednikURL });

  // Top-up (one on-chain transaction) → session. The client interface is the same as in
  // the direct branch: the session is opened AT THE MERCHANT, which opens it at the facilitator.
  let txHash, gasUsed = null, feeEth = null;
  if (mock) { txHash = randTxHash(); }
  else {
    const tx = await wallet.sendTransaction({ to: opts.receiver, value: BigInt(topupWei) });
    txHash = tx.hash;
    const rc = await tx.wait(CONF);   // not a hard-coded 1: otherwise MIN_CONFIRMATIONS>1 means every verification fails
    gasUsed = rc.gasUsed.toString();
    const gp = rc.gasPrice ?? tx.gasPrice ?? null;
    if (gp) feeEth = parseFloat(ethers.formatEther(rc.gasUsed * gp));
  }
  const op = await merchant.post('/metered/session/open', { txHash, payerAddress: wallet.address, mockDepositWei: (BigInt(cfg.priceWeiPerCall) * BigInt(debits + 5)).toString() });
  if (op.status !== 200) throw new Error(`session/open ${op.status}: ${JSON.stringify(op.data)}`);
  const session = op.data.session;
  if (typeof opts.onSession === 'function') { try { opts.onSession(session.sessionId, wallet.address); } catch {} }
  emit('session', { sessionId: session.sessionId, depositWei: session.depositWei, budgetWei: session.budgetWei, expiresAt: session.expiresAt, gasUsed, feeEth, tFacilitatorMs: downMs(op) });

  // N signed debits (no chain) — each one passes through the facilitator at the merchant
  const tPod = [], tZah = [], tPos = []; let ok = 0;
  for (let i = 1; i <= debits; i++) {
    if (!isAlive()) return;
    const nonce = mkNonce();
    let s = performance.now();
    const sig = await wallet.signMessage(debitMessage(wallet.address, session.sessionId, nonce, resource, maxWei));
    const tPodpis = performance.now() - s;
    s = performance.now();
    const r = await merchant.get('/metered/reading-metered', { headers: { 'X-Payer': wallet.address, 'X-Session': session.sessionId, 'X-Nonce': nonce, 'X-Signature': sig, 'X-Max-Wei': maxWei } });
    const tZahteva = performance.now() - s;
    if (r.status !== 200) { emit('error', { i, message: `${r.status}: ${JSON.stringify(r.data)}` }); continue; }
    const tPosrednik = downMs(r);
    ok++; tPod.push(tPodpis); tZah.push(tZahteva); if (tPosrednik !== null) tPos.push(tPosrednik);
    emit('debit', {
      i, reading: r.data.reading, tSignMs: +tPodpis.toFixed(2), tRequestMs: +tZahteva.toFixed(2), tFacilitatorMs: tPosrednik,
      priceWei: r.headers['x-charged-wei'], creditWei: r.headers['x-balance-wei'], budgetRemainingWei: r.headers['x-budget-remaining-wei']
    });
  }
  const med = (a) => { a = a.slice().sort((x, y) => x - y); return a.length ? +a[Math.floor(a.length / 2)].toFixed(2) : null; };
  const fin = (await merchant.get(`/metered/session/${session.sessionId}`)).data.session;
  emit('summary', { mode: mock ? 'mock' : 'real', topology: 'facilitator', succeeded: ok, onChainTransactions: 1, medSignMs: med(tPod), medRequestMs: med(tZah), medFacilitatorMs: med(tPos), finalCreditWei: fin.balanceWei, spentWei: fin.spentWei });
}

module.exports = { runTx, runMetered };
