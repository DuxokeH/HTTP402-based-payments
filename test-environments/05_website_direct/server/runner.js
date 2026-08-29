'use strict';

/**
 * In-process M2M agent for the showcase site (folder 05_spletisce).
 *
 * runTx      — the 20-transactions flow: one full on-chain pay-per-reading loop.
 * runMerjeno — the metered flow: one top-up opens a session, then N EIP-191
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

// Označi klice tega agenta: stroj ni brskalnik, zato zanj ni sejnega piškotka `sid`
// (njegova identiteta je denarnica + EIP-191 podpis). Glej docs/IDENTITETA.md §2 B.
// Ker je spletišče zaprto s skrbniško prijavo, se agent stroju predstavi z žetonom.
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
  if (!payerPk) throw new Error('Za pravi način (real) manjka payerPrivateKey v wallet.json');
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  return { wallet: new ethers.Wallet(payerPk, provider), provider };
}

// ── 2) 20 transactions ───────────────────────────────────────────────────────
async function runTx(opts) {
  const { baseURL, network, rpcUrl, mock, payerPk, priceWei, queries, isAlive, emit } = opts;
  const CONF = Math.max(1, parseInt(opts.confirmations || 1, 10));
  const http = axios.create({ baseURL, timeout: 90_000, validateStatus: () => true, headers: agentHeaders(opts.adminToken) });
  const { wallet } = makeWallet(mock, payerPk, rpcUrl);
  emit('zacetek', { nacin: mock ? 'mock' : 'real', poizvedbe: queries, placnik: wallet.address, cenaWei: priceWei });

  let cumFee = 0, ok = 0;
  for (let i = 1; i <= queries; i++) {
    if (!isAlive()) return;
    const T0 = performance.now();
    // 402 challenge
    const ch = await http.get('/tx/reading', { headers: { 'X-Payer': wallet.address } });
    if (ch.status !== 402) { emit('napaka', { i, message: `pričakoval 402, dobil ${ch.status}` }); continue; }
    const pay = ch.data.payment;

    // pay (one tx per reading)
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
    // verify -> proof
    const vf = await http.post('/tx/verify', { requestId: pay.requestId, txHash, network, payerAddress: wallet.address });
    if (vf.status !== 200) { emit('napaka', { i, message: `verify ${vf.status}` }); continue; }
    // reading
    const rd = await http.get('/tx/reading', { headers: { 'X-Payment': vf.data.proofToken } });
    if (rd.status !== 200) { emit('napaka', { i, message: `reading ${rd.status}` }); continue; }
    ok++;
    emit('poizvedba', {
      i, reading: rd.data.reading, tSkupajMs: +(performance.now() - T0).toFixed(1),
      tConfirmMs: +tConfirm.toFixed(1), gasUsed, feeEth, cumFeeEth: +cumFee.toFixed(8),
      onChainTx: mock ? i : ok
    });
  }
  emit('povzetek', { nacin: mock ? 'mock' : 'real', uspesnih: ok, onChainTransakcij: mock ? queries : ok, kumulativnaProvizijaEth: +cumFee.toFixed(8) });
}

// ── 3) metered session ───────────────────────────────────────────────────────
async function runMerjeno(opts) {
  const { baseURL, network, rpcUrl, mock, payerPk, resource, debits, topupWei, isAlive, emit } = opts;
  const CONF = Math.max(1, parseInt(opts.confirmations || 1, 10));
  const http = axios.create({ baseURL, timeout: 90_000, validateStatus: () => true, headers: agentHeaders(opts.adminToken) });
  const { wallet } = makeWallet(mock, payerPk, rpcUrl);
  const cfg = (await http.get('/config')).data.merjeno;
  const maxWei = (BigInt(cfg.priceWeiPerCall) + BigInt(cfg.priceWeiPerByte) * 4096n).toString();
  emit('zacetek', { nacin: mock ? 'mock' : 'real', bremenitve: debits, placnik: wallet.address, cenaWei: cfg.priceWeiPerCall });

  // top-up (one on-chain tx) -> open session
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
  const openBody = { txHash, network, payerAddress: wallet.address };
  const op = await http.post('/merjeno/session/open', openBody);
  if (op.status !== 200) throw new Error(`session/open ${op.status}: ${JSON.stringify(op.data)}`);
  const session = op.data.session;
  if (typeof opts.onSession === 'function') { try { opts.onSession(session.sessionId, wallet.address); } catch {} }
  emit('seja', { sessionId: session.sessionId, depositWei: session.depositWei, budgetWei: session.budgetWei, expiresAt: session.expiresAt, gasUsed, feeEth });

  // N signed debits (no chain)
  const tPod = [], tZah = []; let ok = 0;
  for (let i = 1; i <= debits; i++) {
    if (!isAlive()) return;
    const nonce = mkNonce();
    let s = performance.now();
    const sig = await wallet.signMessage(debitMessage(wallet.address, session.sessionId, nonce, resource, maxWei));
    const tPodpis = performance.now() - s;
    s = performance.now();
    const r = await http.get('/merjeno/reading-metered', { headers: { 'X-Payer': wallet.address, 'X-Session': session.sessionId, 'X-Nonce': nonce, 'X-Signature': sig, 'X-Max-Wei': maxWei } });
    const tZahteva = performance.now() - s;
    if (r.status !== 200) { emit('napaka', { i, message: `${r.status}: ${JSON.stringify(r.data)}` }); continue; }
    ok++; tPod.push(tPodpis); tZah.push(tZahteva);
    emit('bremenitev', {
      i, reading: r.data.reading, tPodpisMs: +tPodpis.toFixed(2), tZahtevaMs: +tZahteva.toFixed(2),
      cenaWei: r.headers['x-charged-wei'], dobroimetjeWei: r.headers['x-balance-wei'], proracunOstanekWei: r.headers['x-budget-remaining-wei']
    });
  }
  const med = (a) => { a = a.slice().sort((x, y) => x - y); return a.length ? +a[Math.floor(a.length / 2)].toFixed(2) : null; };
  const fin = (await http.get(`/merjeno/session/${session.sessionId}`)).data.session;
  emit('povzetek', { nacin: mock ? 'mock' : 'real', uspesnih: ok, onChainTransakcij: 1, medPodpisMs: med(tPod), medZahtevaMs: med(tZah), koncnoDobroimetjeWei: fin.balanceWei, porabljenoWei: fin.spentWei });
}


// ══════════ x402 v2 (VZPOREDNI NAČIN) — vgrajena M2M agenta ══════════════════
// Ista zamisel kot runTx/runMerjeno, a po uradnem protokolu x402: odjemalec
// podpiše EIP-3009 pooblastilo (PAYMENT-SIGNATURE), strežnik pa SAM poravna
// ETH na Ethereum Sepolia (testno — poravnava sintetična/mock) in plača gas.
// Novi SSE dogodki (izziv, poravnava,
// idempotenca) obstoječih sedmih ne spreminjajo; merjeni tok vsak dogodek
// označi z `veriga: true|false`, da zaslon loči ON-CHAIN POLNITEV od
// OFF-CHAIN LOKALNE BREMENITVE.
const x402o = () => require('./x402-odjemalec');
const x402cfg = () => require('./x402').config; // ime sredstva ipd. za SSE oznake

function makeX402Payer(mock, payerPk) {
  const { privateKeyToAccount, generatePrivateKey } = require('viem/accounts');
  if (mock) return privateKeyToAccount(generatePrivateKey());
  if (!payerPk) throw new Error('Za pravi način (real) manjka x402PayerPrivateKey v wallet.json');
  return privateKeyToAccount(payerPk);
}

// ── 2x · 20 x402 poravnav ────────────────────────────────────────────────────
async function runX402Tx(opts) {
  const { baseURL, mock, x402PayerPk, queries, isAlive, emit } = opts;
  const o = x402o();
  const account = makeX402Payer(mock, x402PayerPk);
  const client = o.makeClient(account);
  const H = opts.adminToken ? { Authorization: `Bearer ${opts.adminToken}`, 'X-Demo-Agent': 'runner' } : { 'X-Demo-Agent': 'runner' };
  emit('zacetek', { nacin: mock ? 'mock' : 'real', protokol: 'x402-self', omrezje: opts.omrezje, sredstvo: x402cfg().assetName, poizvedbe: queries, placnik: account.address, cenaAtomic: opts.cenaAtomic, placnikGasa: 'streznik' });

  let ok = 0; let kumulativnoAtomic = 0n;
  for (let i = 1; i <= queries; i++) {
    if (!isAlive()) return;
    const T0 = performance.now();
    try {
      const r = await o.payFlow({ url: `${baseURL}/x402/tx/reading`, account, client, headers: H });
      const skupaj = performance.now() - T0;
      if (r.status !== 200) { emit('napaka', { i, message: `plačilo ${r.status}` }); continue; }
      const body = await r.res.json();
      kumulativnoAtomic += BigInt(opts.cenaAtomic || '0');
      emit('izziv', { i, shema: 'exact', omrezje: opts.omrezje, znesekAtomic: opts.cenaAtomic, paymentId: r.paymentId, tIzzivMs: r.t.t402 });
      emit('poravnava', { i, uspeh: true, txHash: r.paymentResponse ? r.paymentResponse.txHash : null, sinteticni: r.sinteticni, placnikGasa: 'streznik', tPodpisMs: r.t.tPodpis, tPoravnavaMs: r.t.tPoravnavaHttp });
      emit('idempotenca', { i, paymentId: r.paymentId, izid: r.replayed ? 'predpomnjeno' : 'nov' });
      emit('poizvedba', { i, ok: true, protokol: 'x402-self', tSkupajMs: skupaj, reading: body.reading, txHash: r.paymentResponse ? r.paymentResponse.txHash : null, sinteticni: r.sinteticni, kumulativnoAtomic: kumulativnoAtomic.toString() });
      ok++;
    } catch (e) { emit('napaka', { i, message: e.message }); }
  }
  emit('povzetek', { protokol: 'x402-self', uspesnih: ok, poizvedb: queries, poravnav: ok, skupajAtomic: kumulativnoAtomic.toString(), placnikGasa: 'streznik' });
}

// ── 3x · 1 x402 polnitev + N lokalnih bremenitev v2 ─────────────────────────
async function runX402Merjeno(opts) {
  const { baseURL, mock, x402PayerPk, debits, isAlive, emit } = opts;
  const o = x402o();
  const account = makeX402Payer(mock, x402PayerPk);
  const client = o.makeClient(account);
  const H = opts.adminToken ? { Authorization: `Bearer ${opts.adminToken}`, 'X-Demo-Agent': 'runner' } : { 'X-Demo-Agent': 'runner' };
  emit('zacetek', { nacin: mock ? 'mock' : 'real', protokol: 'x402-self', omrezje: opts.omrezje, sredstvo: x402cfg().assetName, bremenitev: debits, placnik: account.address, placnikGasa: 'streznik' });

  // FAZA A — ON-CHAIN POLNITEV (ena sama x402 poravnava)
  const open = await o.payFlow({ url: `${baseURL}/x402/merjeno/session/open`, method: 'POST', account, client, headers: H, body: {} });
  if (open.status !== 200) { emit('napaka', { message: `polnitev ${open.status}` }); return; }
  const ob = await open.res.json();
  const session = ob.session;
  if (opts.onSession) opts.onSession(session.sessionId, account.address);
  emit('poravnava', { uspeh: true, veriga: true, txHash: open.paymentResponse ? open.paymentResponse.txHash : null, sinteticni: open.sinteticni, placnikGasa: 'streznik', vrsta: 'polnitev' });
  emit('seja', { veriga: true, protokol: 'x402-self', sessionId: session.sessionId, depositAtomic: session.depositAtomic, budgetAtomic: session.budgetAtomic, expiresAt: session.expiresAt, txHash: open.paymentResponse ? open.paymentResponse.txHash : null, sinteticni: open.sinteticni });

  // FAZA B — OFF-CHAIN LOKALNE BREMENITVE (brez verige)
  const cfg = await fetch(`${baseURL}/x402/config`, { headers: H }).then((r) => r.json()).catch(() => null);
  const maxAtomic = (cfg && cfg.merjeno && cfg.merjeno.priceAtomicPerCall) || '10000';
  const assetAddr = (cfg && cfg.asset) || '';
  const network = (cfg && cfg.network) || 'eip155:11155111';
  const resPath = (cfg && cfg.merjeno && cfg.merjeno.resource) || '/x402/merjeno/reading-metered';
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
      if (r.status !== 200) { emit('napaka', { i, message: `bremenitev ${r.status}` }); continue; }
      const body = await r.json();
      emit('bremenitev', { i, veriga: false, protokol: 'x402-self', reading: body.reading,
        chargedAtomic: r.headers.get('X-Charged-Atomic'), balanceAtomic: r.headers.get('X-Balance-Atomic'),
        budgetRemainingAtomic: r.headers.get('X-Budget-Remaining-Atomic'),
        tPodpisMs: tPodpis, tZahtevaMs: tZahteva });
      ok++;
    } catch (e) { emit('napaka', { i, message: e.message }); }
  }
  emit('povzetek', { protokol: 'x402-self', uspesnih: ok, bremenitev: debits, poravnav: 1, placnikGasa: 'streznik', sporocilo: `1 on-chain polnitev + ${ok} off-chain bremenitev` });
}

module.exports = { runTx, runMerjeno, runX402Tx, runX402Merjeno };

