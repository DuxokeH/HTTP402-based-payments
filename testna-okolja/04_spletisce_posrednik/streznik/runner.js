'use strict';

/**
 * In-process M2M agent for the showcase site — POSREDNIŠKA VEJA
 * (mapa 04_spletisce_posrednik/streznik).
 *
 * runTx      — 20-transactions flow: one full on-chain pay-per-reading loop.
 * runMerjeno — metered flow: one top-up opens a session, then N EIP-191
 *              signed debits (no new transaction per reading).
 *
 * Razlika proti neposredni veji (mapa 05): ta agent je PLAČNIK, zato po
 * posredniškem protokolu plačilo prijavi POSREDNIKU (`POST /submit-payment`) in ne trgovcu
 * (`POST /tx/verify`, ki ga v tej veji ni). Zato ima dva naslova:
 *
 *    baseURL      trgovec  — 402 izziv in dostop do vira
 *    posrednikURL posrednik — prijava plačila, izdaja dokaznega žetona
 *
 * Poti do posrednika NE nosijo trgovčevega skrbniškega žetona: `/submit-payment`
 * je javna pot posrednika, žetona trgovca pa posrednik tako ali tako ne pozna
 * (ima svojo, ločeno prijavo).
 *
 * Vsak dogodek nosi tudi `tPosrednikMs` iz glave `X-Downstream-Ms` — koliko je
 * trgovec čakal na posrednika. V neposredni veji je ta vrednost vedno 0; razlika
 * med vejama je merjeni strošek topologije (poskusa s plačilom na odčitek in z
 * merjeno sejo).
 *
 * mock === true  → no chain: transactions are faked and the facilitator mock-verifies;
 *                  debits are signed by an ephemeral wallet (no funds needed).
 * mock === false → real Sepolia: needs payerPk (a funded consumer wallet).
 */

const axios = require('axios');
const { ethers } = require('ethers');
const { performance } = require('perf_hooks');

// Označi klice tega agenta: stroj ni brskalnik, zato zanj ni sejnega piškotka `sid`
// (njegova identiteta je denarnica + EIP-191 podpis). Glej docs/IDENTITETA.md §2 B.
// Ker je spletišče zaprto s skrbniško prijavo, se agent trgovcu predstavi z žetonom.
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
  if (!payerPk) throw new Error('Za pravi način (real) manjka payerPrivateKey v wallet.json');
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  return { wallet: new ethers.Wallet(payerPk, provider), provider };
}

// Dva odjemalca: trgovec (s skrbniškim žetonom) in posrednik (brez).
function makeClients(opts) {
  return {
    trgovec: axios.create({ baseURL: opts.baseURL, timeout: 90_000, validateStatus: () => true, headers: agentHeaders(opts.adminToken) }),
    posrednik: axios.create({ baseURL: opts.posrednikURL, timeout: 90_000, validateStatus: () => true, headers: { 'X-Demo-Agent': 'runner' } })
  };
}

// ── 2) 20 transactions ───────────────────────────────────────────────────────
async function runTx(opts) {
  const { network, rpcUrl, mock, payerPk, priceWei, queries, isAlive, emit } = opts;
  const CONF = Math.max(1, parseInt(opts.confirmations || 1, 10));
  const { trgovec, posrednik } = makeClients(opts);
  const { wallet } = makeWallet(mock, payerPk, rpcUrl);
  emit('zacetek', { nacin: mock ? 'mock' : 'real', topologija: 'posredniska', poizvedbe: queries, placnik: wallet.address, cenaWei: priceWei, posrednik: opts.posrednikURL });

  let cumFee = 0, ok = 0;
  for (let i = 1; i <= queries; i++) {
    if (!isAlive()) return;
    const T0 = performance.now();
    // 1) 402 izziv pri trgovcu (ta ga je odprl pri posredniku: M→F, F→M)
    const ch = await trgovec.get('/tx/reading', { headers: { 'X-Payer': wallet.address } });
    if (ch.status !== 402) { emit('napaka', { i, message: `pričakoval 402, dobil ${ch.status}` }); continue; }
    const pay = ch.data.payment;
    const tIzziv = performance.now() - T0;
    const dIzziv = downMs(ch);

    // 2) plačilo na verigi (C→B) — eno plačilo za vsak odčitek
    let txHash, gasUsed = null, feeEth = null, tConfirm = 0;
    if (mock) {
      txHash = randTxHash();
    } else {
      const s = performance.now();
      const tx = await wallet.sendTransaction({ to: pay.to, value: BigInt(pay.priceWei) });
      txHash = tx.hash;
      const rc = await tx.wait(CONF);   // ne trdo 1: sicer MIN_CONFIRMATIONS>1 pomeni, da vsako preverjanje odpove
      tConfirm = performance.now() - s;
      gasUsed = rc.gasUsed.toString();
      const gp = rc.gasPrice ?? tx.gasPrice ?? null;
      if (gp) { feeEth = parseFloat(ethers.formatEther(rc.gasUsed * gp)); cumFee += feeEth; }
    }

    // 3) prijava plačila POSREDNIKU (C→F) — tu nastane dokazni žeton
    let s = performance.now();
    const sp = await posrednik.post('/submit-payment', { requestId: pay.requestId, txHash, network, payerAddress: wallet.address });
    const tPrijava = performance.now() - s;
    if (sp.status !== 200) { emit('napaka', { i, message: `submit-payment ${sp.status}: ${JSON.stringify(sp.data)}` }); continue; }
    const proofToken = sp.data.proofToken || (sp.data.proof && sp.data.proof.token);

    // 4) dostop pri trgovcu z dokazilom (C→M; trgovec ga unovči pri posredniku, M→F)
    s = performance.now();
    const rd = await trgovec.get('/tx/reading', { headers: { 'X-Payment': proofToken } });
    const tDostop = performance.now() - s;
    if (rd.status !== 200) { emit('napaka', { i, message: `reading ${rd.status}` }); continue; }
    ok++;
    emit('poizvedba', {
      i, reading: rd.data.reading, tSkupajMs: +(performance.now() - T0).toFixed(1),
      tIzzivMs: +tIzziv.toFixed(1), tPrijavaMs: +tPrijava.toFixed(1), tDostopMs: +tDostop.toFixed(1),
      tPosrednikMs: [dIzziv, downMs(rd)].filter(v => v !== null).reduce((a, b) => a + b, 0) || null,
      tConfirmMs: +tConfirm.toFixed(1), gasUsed, feeEth, cumFeeEth: +cumFee.toFixed(8),
      onChainTx: mock ? i : ok
    });
  }
  emit('povzetek', { nacin: mock ? 'mock' : 'real', topologija: 'posredniska', uspesnih: ok, onChainTransakcij: mock ? queries : ok, kumulativnaProvizijaEth: +cumFee.toFixed(8) });
}

// ── 3) metered session ───────────────────────────────────────────────────────
async function runMerjeno(opts) {
  const { rpcUrl, mock, payerPk, resource, debits, topupWei, isAlive, emit } = opts;
  const CONF = Math.max(1, parseInt(opts.confirmations || 1, 10));
  const { trgovec } = makeClients(opts);
  const { wallet } = makeWallet(mock, payerPk, rpcUrl);
  const cfg = (await trgovec.get('/config')).data.merjeno;
  const maxWei = (BigInt(cfg.priceWeiPerCall) + BigInt(cfg.priceWeiPerByte) * 4096n).toString();
  emit('zacetek', { nacin: mock ? 'mock' : 'real', topologija: 'posredniska', bremenitve: debits, placnik: wallet.address, cenaWei: cfg.priceWeiPerCall, posrednik: opts.posrednikURL });

  // Polnitev (ena transakcija na verigi) → seja. Odjemalčev vmesnik je enak kot v
  // neposredni veji: seja se odpre PRI TRGOVCU, ta pa jo odpre pri posredniku.
  let txHash, gasUsed = null, feeEth = null;
  if (mock) { txHash = randTxHash(); }
  else {
    const tx = await wallet.sendTransaction({ to: opts.receiver, value: BigInt(topupWei) });
    txHash = tx.hash;
    const rc = await tx.wait(CONF);   // ne trdo 1: sicer MIN_CONFIRMATIONS>1 pomeni, da vsako preverjanje odpove
    gasUsed = rc.gasUsed.toString();
    const gp = rc.gasPrice ?? tx.gasPrice ?? null;
    if (gp) feeEth = parseFloat(ethers.formatEther(rc.gasUsed * gp));
  }
  const op = await trgovec.post('/merjeno/session/open', { txHash, payerAddress: wallet.address, mockDepositWei: (BigInt(cfg.priceWeiPerCall) * BigInt(debits + 5)).toString() });
  if (op.status !== 200) throw new Error(`session/open ${op.status}: ${JSON.stringify(op.data)}`);
  const session = op.data.session;
  if (typeof opts.onSession === 'function') { try { opts.onSession(session.sessionId, wallet.address); } catch {} }
  emit('seja', { sessionId: session.sessionId, depositWei: session.depositWei, budgetWei: session.budgetWei, expiresAt: session.expiresAt, gasUsed, feeEth, tPosrednikMs: downMs(op) });

  // N podpisanih bremenitev (brez verige) — vsaka gre pri trgovcu skozi posrednika
  const tPod = [], tZah = [], tPos = []; let ok = 0;
  for (let i = 1; i <= debits; i++) {
    if (!isAlive()) return;
    const nonce = mkNonce();
    let s = performance.now();
    const sig = await wallet.signMessage(debitMessage(wallet.address, session.sessionId, nonce, resource, maxWei));
    const tPodpis = performance.now() - s;
    s = performance.now();
    const r = await trgovec.get('/merjeno/reading-metered', { headers: { 'X-Payer': wallet.address, 'X-Session': session.sessionId, 'X-Nonce': nonce, 'X-Signature': sig, 'X-Max-Wei': maxWei } });
    const tZahteva = performance.now() - s;
    if (r.status !== 200) { emit('napaka', { i, message: `${r.status}: ${JSON.stringify(r.data)}` }); continue; }
    const tPosrednik = downMs(r);
    ok++; tPod.push(tPodpis); tZah.push(tZahteva); if (tPosrednik !== null) tPos.push(tPosrednik);
    emit('bremenitev', {
      i, reading: r.data.reading, tPodpisMs: +tPodpis.toFixed(2), tZahtevaMs: +tZahteva.toFixed(2), tPosrednikMs: tPosrednik,
      cenaWei: r.headers['x-charged-wei'], dobroimetjeWei: r.headers['x-balance-wei'], proracunOstanekWei: r.headers['x-budget-remaining-wei']
    });
  }
  const med = (a) => { a = a.slice().sort((x, y) => x - y); return a.length ? +a[Math.floor(a.length / 2)].toFixed(2) : null; };
  const fin = (await trgovec.get(`/merjeno/session/${session.sessionId}`)).data.session;
  emit('povzetek', { nacin: mock ? 'mock' : 'real', topologija: 'posredniska', uspesnih: ok, onChainTransakcij: 1, medPodpisMs: med(tPod), medZahtevaMs: med(tZah), medPosrednikMs: med(tPos), koncnoDobroimetjeWei: fin.balanceWei, porabljenoWei: fin.spentWei });
}

module.exports = { runTx, runMerjeno };
