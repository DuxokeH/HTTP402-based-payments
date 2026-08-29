#!/usr/bin/env node
'use strict';

/**
 * ============================================================================
 *  AGENT (uporabnik storitve) — METERED PREPAID SESSION
 *  (folder 03_avtomatska_placila_dobroimetje)
 * ============================================================================
 *
 *  ONE on-chain top-up opens a prepaid session; then N readings are each paid
 *  with a local EIP-191 signature (no new transaction). This is the efficient
 *  counterpart of folder 02: the metered prepaid-session model.
 *
 *  Per debit it records: t_podpis (client signing) + t_zahteva (round trip) +
 *  server time, the charged price, remaining credit and remaining budget.
 *
 *  USAGE:
 *    node agent.js --mock --debits 20
 *    node agent.js --real --debits 20 --topup-wei 2500000000000 --pause-ms 200
 *    node agent.js --security          (failure / abuse suite)
 *
 *  Code/comments English; console + CSV headers Slovenian.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const axios = require('axios');
const { ethers } = require('ethers');

const cfgFile = path.join(__dirname, 'config.json');
const cfg = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')) : {};
const IOT_URL = process.env.IOT_URL || cfg.IOT_URL || 'http://127.0.0.1:3200';
const NETWORK = process.env.NETWORK || cfg.NETWORK || 'sepolia';
const RPC_URL = process.env.RPC_URL || cfg.RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';
const CONFIRMATIONS = parseInt(process.env.CONFIRMATIONS || cfg.CONFIRMATIONS || '1', 10);
// Naprava je zaprta s skrbniško prijavo; agent se predstavi s strojnim žetonom.
// Žeton dobiš na napravi z:  grep ZETON iot_naprava/data/admin-credentials.txt
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || cfg.ADMIN_TOKEN || '';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const MODE = has('--real') ? 'real' : 'mock';
const DEBITS = parseInt(val('--debits', '20'), 10);
const PAUSE_MS = parseInt(val('--pause-ms', '0'), 10);
const TOPUP_WEI = val('--topup-wei', '2500000000000');       // real-mode top-up value
const SECURITY = has('--security');
const X402 = has('--x402');   // NOVI vzporedni način: x402 polnitev + lokalne bremenitve v2
const OUT = val('--out', path.join(__dirname, '..', 'meritve',
  X402 ? `x402_dobroimetje_${MODE}.csv` : `dobroimetje_${MODE}.csv`));

const http = axios.create({ baseURL: IOT_URL, timeout: 90_000, validateStatus: () => true,
  headers: ADMIN_TOKEN ? { Authorization: `Bearer ${ADMIN_TOKEN}` } : {} });
const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const num = (x) => (x === null || x === undefined || Number.isNaN(x)) ? '' : (typeof x === 'number' ? x.toFixed(3) : String(x));
const hdr = (res, n) => { const v = res.headers[n.toLowerCase()]; return v !== undefined ? v : ''; };
const banner = (t) => { const l = '─'.repeat(64); console.log(`\n┌${l}┐\n│ ${t.padEnd(62)} │\n└${l}┘`); };
const mkNonce = () => `${Date.now()}-${Buffer.from(ethers.randomBytes(6)).toString('hex')}`;
const debitMessage = (payer, session, nonce, p, maxWei) => `x402-debit:${payer.toLowerCase()}:${session}:${nonce}:${p}:${maxWei}`;

let wallet, provider = null;
function makeWallet() {
  if (MODE === 'real') {
    const wf = path.join(__dirname, 'wallet.json');
    if (!fs.existsSync(wf)) { console.error('❌ wallet.json manjka (glej wallet.example.json / generate-wallet.js).'); process.exit(1); }
    provider = new ethers.JsonRpcProvider(RPC_URL);
    return new ethers.Wallet(JSON.parse(fs.readFileSync(wf, 'utf8')).privateKey, provider);
  }
  // mock: signing needs a key but no funds — an ephemeral wallet is fine.
  return ethers.Wallet.createRandom();
}

const CSV_HEADER = [
  'dogodek', 'cas_iso', 'nacin', 'vrsta',
  't_podpis_ms', 't_zahteva_ms', 'streznik_ms', 't_skupaj_ms',
  'cena_wei', 'dobroimetje_wei', 'proracun_ostanek_wei',
  'gas_enote', 'provizija_eth', 'temperatura_c', 'vlaga_pct', 'nonce', 'seja'
].join(',');
function ensureCsv(f) { fs.mkdirSync(path.dirname(f), { recursive: true }); if (!fs.existsSync(f)) fs.writeFileSync(f, CSV_HEADER + '\n'); }

// ── open a session (one on-chain top-up) ────────────────────────────────────
async function openSession(cfgData, { budgetWei, ttlSeconds, mockDepositWei } = {}) {
  banner(`FAZA A · Polnitev (1 on-chain transakcija) → odpri sejo`);
  let txHash, gasUsed = '', feeEth = '', tReq;
  const body = { payerAddress: wallet.address };
  if (budgetWei) body.budgetWei = String(budgetWei);
  if (ttlSeconds) body.ttlSeconds = ttlSeconds;

  if (MODE === 'real') {
    const tx = await wallet.sendTransaction({ to: cfgData.device, value: BigInt(TOPUP_WEI) });
    console.log(`  ✓ polnitev oddana · tx=${tx.hash}`);
    const rc = await tx.wait(CONFIRMATIONS);
    gasUsed = rc.gasUsed.toString();
    const gp = rc.gasPrice ?? tx.gasPrice ?? null;
    if (gp) feeEth = ethers.formatEther(rc.gasUsed * gp);
    txHash = tx.hash;
    console.log(`  ✓ potrjeno · blok=${rc.blockNumber} · gas=${gasUsed} · provizija=${feeEth} ETH`);
  } else {
    txHash = '0x' + Buffer.from(ethers.randomBytes(32)).toString('hex');
    if (mockDepositWei) body.mockDepositWei = String(mockDepositWei);
  }

  const t0 = performance.now();
  const r = await http.post('/session/open', { txHash, network: NETWORK, ...body });
  tReq = performance.now() - t0;
  if (r.status !== 200) throw new Error(`session/open ${r.status}: ${JSON.stringify(r.data)}`);
  const session = r.data.session;
  console.log(`  ✓ seja=${session.sessionId}\n    dobroimetje=${session.depositWei} wei · proračun=${session.budgetWei} wei · velja do=${session.expiresAt}`);
  return { session, topupRow: [
    'polnitev', nowIso(), MODE, 'topup', '', num(tReq), num(parseFloat(hdr(r, 'X-Server-Ms')) || 0), num(tReq),
    session.depositWei, session.balanceWei, session.budgetRemainingWei, gasUsed, feeEth, '', '', '', session.sessionId
  ] };
}

// ── one signed metered debit ────────────────────────────────────────────────
async function oneDebit(i, session, maxWei) {
  const nonce = mkNonce();
  const p = '/reading-metered';
  const T0 = performance.now();
  let s = performance.now();
  const sig = await wallet.signMessage(debitMessage(wallet.address, session.sessionId, nonce, p, maxWei));
  const tPodpis = performance.now() - s;

  s = performance.now();
  const r = await http.get('/reading-metered', { headers: { 'X-Payer': wallet.address, 'X-Session': session.sessionId, 'X-Nonce': nonce, 'X-Signature': sig, 'X-Max-Wei': String(maxWei) } });
  const tZahteva = performance.now() - s;
  const tSkupaj = performance.now() - T0;
  if (r.status !== 200) throw new Error(`reading-metered ${r.status}: ${JSON.stringify(r.data)}`);
  const reading = r.data.reading;
  const cena = hdr(r, 'X-Charged-Wei'), balance = hdr(r, 'X-Balance-Wei'), budgetLeft = hdr(r, 'X-Budget-Remaining-Wei');
  console.log(`  ✓ bremenitev ${String(i).padStart(2)} · T=${reading.temperature_c}°C RH=${reading.humidity_pct}% · t_podpis=${num(tPodpis)} ms · t_zahteva=${num(tZahteva)} ms · cena=${cena} wei · dobroimetje=${balance} wei`);
  return [
    `bremenitev_${i}`, nowIso(), MODE, 'debit', num(tPodpis), num(tZahteva), num(parseFloat(hdr(r, 'X-Server-Ms')) || 0), num(tSkupaj),
    cena, balance, budgetLeft, '', '', reading.temperature_c, reading.humidity_pct, nonce, session.sessionId
  ];
}

// Naprava je zaprta s skrbniško prijavo — brez veljavnega žetona ne gre nikamor.
function napakaPrijave(ukaz) {
  console.error(`
❌ Naprava je zavrnila prijavo (401). Merilni agent potrebuje strojni žeton.

   Na napravi (po SSH) poišči žeton:
     grep ZETON ${path.join('..', 'iot_naprava', 'data', 'admin-credentials.txt')}

   Nato ga podaj agentu:
     export ADMIN_TOKEN=<žeton>
     npm run ${ukaz}

   Ali v eni vrstici:
     ADMIN_TOKEN=$(grep '^ZETON=' ../iot_naprava/data/admin-credentials.txt | cut -d= -f2) npm run ${ukaz}
`);
  process.exitCode = 1;
}

async function main() {
  wallet = makeWallet();
  banner(`MERJENA SEJA · način=${MODE.toUpperCase()} · N bremenitev=${DEBITS} · naprava=${IOT_URL}`);
  const c = await http.get('/config');
  if (c.status === 401) { napakaPrijave(MODE === 'real' ? 'real' : 'mock'); return; }
  // Šele zdaj ustvari CSV: sicer bi neuspela prijava pustila datoteko s samo glavo,
  // ki bi jo analiza vzela pred vzorčnimi podatki in se sesula na prazni tabeli.
  ensureCsv(OUT);
  const cfgData = c.data;
  console.log(`  Cena/odčitek: ${cfgData.priceWeiPerCall} wei (+${cfgData.priceWeiPerByte}/zlog) · plačnik=${wallet.address}`);
  const maxWei = (BigInt(cfgData.priceWeiPerCall) + BigInt(cfgData.priceWeiPerByte) * 4096n).toString();

  const { session, topupRow } = await openSession(cfgData);
  fs.appendFileSync(OUT, topupRow.join(',') + '\n');

  banner(`FAZA B · ${DEBITS} podpisanih bremenitev (brez novih transakcij)`);
  const tPod = [], tZah = [];
  let ok = 0, cur = session;
  for (let i = 1; i <= DEBITS; i++) {
    try {
      const row = await oneDebit(i, cur, maxWei);
      fs.appendFileSync(OUT, row.join(',') + '\n');
      tPod.push(parseFloat(row[4])); tZah.push(parseFloat(row[5])); ok++;
    } catch (e) { console.error(`  ✗ bremenitev ${i}: ${e.message}`); }
    if (PAUSE_MS) await sleep(PAUSE_MS);
  }

  const st = (a) => { a = a.filter(Number.isFinite).sort((x, y) => x - y); if (!a.length) return null; const q = p => a[Math.floor(p * (a.length - 1))]; return { n: a.length, min: a[0], median: q(0.5), mean: a.reduce((s, x) => s + x, 0) / a.length, p95: q(0.95), max: a[a.length - 1] }; };
  const final = (await http.get(`/session/${session.sessionId}`)).data.session;
  banner(`POVZETEK · uspešnih ${ok}/${DEBITS} · on-chain transakcij: 1 (samo polnitev) · CSV: ${path.relative(process.cwd(), OUT)}`);
  const sp = st(tPod), sz = st(tZah);
  if (sp) console.log(`  t_podpis  (ms): median=${num(sp.median)} mean=${num(sp.mean)} p95=${num(sp.p95)} max=${num(sp.max)}`);
  if (sz) console.log(`  t_zahteva (ms): median=${num(sz.median)} mean=${num(sz.mean)} p95=${num(sz.p95)} max=${num(sz.max)}`);
  console.log(`  Končno stanje seje: dobroimetje=${final.balanceWei} wei · porabljeno=${final.spentWei} wei · proračun ostanek=${final.budgetRemainingWei} wei`);
  console.log(`  → Za ${DEBITS} odčitkov je bila potrebna SAMO 1 on-chain transakcija (primerjaj z mapo 02, kjer jih je ${DEBITS}).`);

  const jsonOut = OUT.replace(/\.csv$/, '_povzetek.json');
  fs.writeFileSync(jsonOut, JSON.stringify({ nacin: MODE, bremenitev: DEBITS, uspesnih: ok, seja: final, t_podpis_ms: sp, t_zahteva_ms: sz }, null, 2));
  console.log(`  Povzetek JSON: ${path.relative(process.cwd(), jsonOut)}`);
}

// ── SECURITY / FAILURE SUITE ────────────────────────────────────────────────
async function runSecurity() {
  wallet = makeWallet();
  banner(`VARNOSTNI IN ODPOVEDNI TESTI (merjena seja) · način=${MODE.toUpperCase()}`);
  if (MODE === 'real') { console.error('  Varnostni testi so zasnovani za --mock (uporabljajo mock polog za hitre primere). Zaženi: node agent.js --security'); process.exit(1); }
  const results = [];
  const rec = (ime, prc, dej, ok, op = '') => { results.push({ ime, prc, dej, ok, op }); console.log(`  ${ok ? '✓' : '✗'} ${ime.padEnd(44)} pričakovano=${String(prc).padEnd(8)} dejansko=${String(dej).padEnd(8)} ${op}`); };
  const cRes = await http.get('/config');
  if (cRes.status === 401) { napakaPrijave('security'); return; }
  const c = cRes.data;
  const price = BigInt(c.priceWeiPerCall);
  const maxWei = (price + BigInt(c.priceWeiPerByte) * 4096n).toString();
  const p = '/reading-metered';

  // helper to open a fresh mock session
  const open = async (opts = {}) => {
    const body = { txHash: '0x' + Buffer.from(ethers.randomBytes(32)).toString('hex'), network: NETWORK, payerAddress: wallet.address, ...opts };
    const r = await http.post('/session/open', body);
    return r.data.session;
  };
  const doDebit = async (session, { nonce = mkNonce(), signAs = wallet, claimPayer = wallet.address, mw = maxWei } = {}) => {
    const sig = await signAs.signMessage(debitMessage(claimPayer, session.sessionId, nonce, p, mw));
    return http.get('/reading-metered', { headers: { 'X-Payer': claimPayer, 'X-Session': session.sessionId, 'X-Nonce': nonce, 'X-Signature': sig, 'X-Max-Wei': String(mw) } });
  };

  // T1 — missing signed headers -> 402
  let r = await http.get('/reading-metered');
  rec('Brez podpisa (manjkajoče glave)', 402, r.status, r.status === 402);

  // T2 — valid debit -> 200
  let s = await open();
  const nonceA = mkNonce();
  r = await doDebit(s, { nonce: nonceA });
  rec('Veljavna bremenitev', 200, r.status, r.status === 200);

  // T3 — replay same nonce -> 403
  r = await doDebit(s, { nonce: nonceA });
  rec('Ponovitev nonce (replay)', 403, r.status, r.status === 403, r.data?.error || '');

  // T4 — forged signature (signed by a different wallet) -> 403
  const other = ethers.Wallet.createRandom();
  r = await doDebit(s, { signAs: other, claimPayer: wallet.address });
  rec('Ponarejen podpis (druga denarnica)', 403, r.status, r.status === 403, r.data?.error || '');

  // T5 — debit above signed maximum -> 400 (sign a max just below the min price)
  const tinyMax = (BigInt(c.minPriceWei) - 1n).toString();
  r = await doDebit(s, { mw: tinyMax });
  rec('Cena čez podpisani maksimum', 400, r.status, r.status === 400, r.data?.error || '');

  // T6 — stale nonce (timestamp far in the past) -> 400
  const staleNonce = `${Date.now() - (c.debitMaxAgeMs + 60000)}-deadbeef`;
  r = await doDebit(s, { nonce: staleNonce });
  rec('Zastarel nonce', 400, r.status, r.status === 400, r.data?.error || '');

  // T7 — budget exceeded: open session with budget = 2×price
  const sB = await open({ mockDepositWei: (price * 10n).toString(), budgetWei: (price * 2n).toString() });
  await doDebit(sB); await doDebit(sB);            // spend the 2-call budget
  r = await doDebit(sB);
  rec('Presežen proračun (proračun=2×cena)', 402, r.status, r.status === 402, r.data?.reason || '');

  // T8 — insufficient balance: deposit = 2×price, budget default = deposit
  const sC = await open({ mockDepositWei: (price * 2n).toString() });
  await doDebit(sC); await doDebit(sC);            // spend the whole deposit
  r = await doDebit(sC);
  rec('Nezadostno dobroimetje (polog=2×cena)', 402, r.status, r.status === 402, r.data?.reason || '');

  // T9 — expired session (ttl = 1s), wait, then debit -> 403
  const sE = await open({ ttlSeconds: 1 });
  await sleep(1300);
  r = await doDebit(sE);
  rec('Potekla seja (čas veljavnosti)', 403, r.status, r.status === 403, r.data?.error || '');

  const passed = results.filter(x => x.ok).length;
  banner(`REZULTAT · ${passed}/${results.length} uspešnih`);
  const out = path.join(__dirname, '..', 'meritve', `varnostni_testi_${MODE}.csv`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, 'test,pricakovano,dejansko,uspeh,opomba\n' + results.map(x => [JSON.stringify(x.ime), x.prc, x.dej, x.ok ? 'da' : 'ne', JSON.stringify(x.op)].join(',')).join('\n') + '\n');
  console.log(`  CSV: ${path.relative(process.cwd(), out)}`);
}

// ══════════ x402 v2 (VZPOREDNI NAČIN) — C2: 1 x402 polnitev + N lokalnih ════
// Faza A: ENA x402 exact poravnava (ETH, Ethereum Sepolia; testno — poravnava
// sintetična/mock) odpre sejo. Odjemalec podpiše EIP-3009 pooblastilo;
// poravnalno transakcijo odda naprava in ONA plača gas. Faza B: N bremenitev
// s podpisi EIP-191 (sporočilo v2, atomske enote) — NIČ nadaljnjih poravnav
// na verigi.
const x402o = X402 ? require('./x402-odjemalec') : null;

const X402_CSV_HEADER = [
  'dogodek', 'cas_iso', 'nacin', 'protokol', 'vrsta', 'omrezje', 'sredstvo', 'placnik_gasa',
  't_podpis_ms', 't_zahteva_ms', 'streznik_ms', 't_skupaj_ms',
  'cena_atomic', 'dobroimetje_atomic', 'proracun_ostanek_atomic', 'polog_atomic',
  'preveri_ms', 'poravnaj_ms', 'payment_id', 'tx_hash', 'sinteticni_tx',
  'blok', 'gas_enote', 'cena_gas_wei',
  'temperatura_c', 'vlaga_pct', 'nonce', 'seja', 'sporocilo_verzija'
].join(',');

function loadX402Payer() {
  const wf = path.join(__dirname, 'wallet.json');
  const wd = fs.existsSync(wf) ? JSON.parse(fs.readFileSync(wf, 'utf8')) : {};
  if (MODE === 'real' && !wd.x402PayerPrivateKey) {
    console.error('❌ Za --x402 --real vpiši x402PayerPrivateKey v wallet.json (testna ETH konfiguracija na Ethereum Sepolii — pravi tek zahteva žeton z EIP-3009)');
    process.exit(1);
  }
  return x402o.makePayer({ privateKey: MODE === 'real' ? wd.x402PayerPrivateKey : undefined });
}

const debitMessageV2 = (payer, session, nonce, p, maxAtomic, network, assetAddr) =>
  `metered-debit-v2:${payer.toLowerCase()}:${session}:${nonce}:${p}:${maxAtomic}:${network}:${assetAddr.toLowerCase()}`;

async function x402Debit({ account, cfgX, sessionId, i }) {
  const nonce = mkNonce();
  const maxAtomic = cfgX.priceAtomicPerCall;
  const t0 = performance.now();
  const msg = debitMessageV2(account.address, sessionId, nonce, cfgX.meteredEndpoint, maxAtomic, cfgX.network, cfgX.asset);
  const signature = await account.signMessage({ message: msg });   // EIP-191 personal_sign (viem)
  const tPodpis = performance.now() - t0;

  const t1 = performance.now();
  const r = await http.get(cfgX.meteredEndpoint, { headers: {
    'X-Payer': account.address, 'X-Session': sessionId, 'X-Nonce': nonce,
    'X-Signature': signature, 'X-Max-Atomic': maxAtomic
  } });
  const tZahteva = performance.now() - t1;
  return { r, nonce, tPodpis, tZahteva };
}

async function mainX402() {
  const cfgR = await http.get('/x402/config');
  if (cfgR.status === 401) { napakaPrijave(); return; }
  if (cfgR.status !== 200 || !cfgR.data || cfgR.data.mode === 'off') {
    console.error('❌ Naprava nima vklopljenega x402 načina (X402_MODE=self [+ X402_MOCK=true]).'); process.exit(1);
  }
  const cfgX = cfgR.data;
  const account = loadX402Payer();
  const client = x402o.makeClient(account);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  if (!fs.existsSync(OUT)) fs.writeFileSync(OUT, X402_CSV_HEADER + '\n');

  banner(`x402 MERJENA SEJA · 1 POLNITEV + ${DEBITS} LOKALNIH BREMENITEV · način=${MODE.toUpperCase()}`);
  console.log(`  Polog: ${cfgX.sessionDepositAtomic} atomskih enot ${cfgX.assetName} · cena/odčitek: ${cfgX.priceAtomicPerCall} · gas polnitve plača: naprava`);
  if (cfgX.mock) console.log('  ⚠ MOCK: poravnava polnitve je sintetična (0x6d6f636b6d6f636b…) — NE prava meritev.');

  // FAZA A — ena x402 poravnava odpre sejo
  banner('FAZA A · x402 polnitev (1 poravnava) → odpri sejo');
  const T0 = performance.now();
  const open = await x402o.payFlow({
    url: `${IOT_URL}/x402/session/open`, method: 'POST', account, client,
    headers: ADMIN_TOKEN ? { Authorization: `Bearer ${ADMIN_TOKEN}` } : {},
    body: {}
  });
  const tOpenSkupaj = performance.now() - T0;
  if (open.status !== 200) { console.error(`❌ polnitev ${open.status}: ${await open.res.text().catch(() => '')}`); process.exit(1); }
  const openBody = await open.res.json();
  const session = openBody.session;
  const paymentIds = new Set([open.paymentId]);
  console.log(`  ✓ seja=${session.sessionId} · polog=${session.depositAtomic} atomic · tx=${open.paymentResponse ? open.paymentResponse.txHash : '—'}${open.sinteticni ? ' (sintetični)' : ''}`);

  let blok = '', gasEnote = '', cenaGasWei = '';
  { const pv = await http.get(`/x402/payment/${open.paymentId}`);
    if (pv.status === 200) { blok = pv.data.blok ?? ''; gasEnote = pv.data.gasEnote ?? ''; cenaGasWei = pv.data.cenaGasWei ?? ''; } }
  fs.appendFileSync(OUT, [
    'polnitev', nowIso(), MODE, 'x402-self', 'topup', cfgX.network, cfgX.assetName, 'streznik',
    num(open.t.tPodpis), num(open.t.tPoravnavaHttp), num(open.serverMs), num(tOpenSkupaj),
    '', session.depositAtomic, session.budgetAtomic, session.depositAtomic,
    num(open.verifyMs), num(open.settleMs), open.paymentId,
    open.paymentResponse ? open.paymentResponse.txHash : '', open.sinteticni ? 1 : 0,
    blok, gasEnote, cenaGasWei, '', '', '', session.sessionId, ''
  ].join(',') + '\n');

  // FAZA B — N lokalnih bremenitev (NIČ poravnav na verigi)
  banner(`FAZA B · ${DEBITS} lokalnih bremenitev (EIP-191, sporočilo v2)`);
  const totals = { podpis: [], zahteva: [] };
  let ok = 0;
  for (let i = 1; i <= DEBITS; i++) {
    try {
      const { r, nonce, tPodpis, tZahteva } = await x402Debit({ account, cfgX, sessionId: session.sessionId, i });
      if (r.status !== 200) throw new Error(`${r.status}: ${JSON.stringify(r.data)}`);
      const reading = r.data.reading || {};
      fs.appendFileSync(OUT, [
        `bremenitev_${i}`, nowIso(), MODE, 'x402-self', 'debit', cfgX.network, cfgX.assetName, '',
        num(tPodpis), num(tZahteva), hdr(r, 'X-Server-Ms'), num(tPodpis + tZahteva),
        hdr(r, 'X-Charged-Atomic'), hdr(r, 'X-Balance-Atomic'), hdr(r, 'X-Budget-Remaining-Atomic'), '',
        '', '', '', '', 0, '', '', '',
        reading.temperature_c ?? '', reading.humidity_pct ?? '', nonce, session.sessionId, 'metered-debit-v2'
      ].join(',') + '\n');
      totals.podpis.push(tPodpis); totals.zahteva.push(tZahteva);
      console.log(`  ✓ bremenitev ${String(i).padStart(2)} · T=${reading.temperature_c}°C RH=${reading.humidity_pct}% · t_podpis=${num(tPodpis)} ms · t_zahteva=${num(tZahteva)} ms · dobroimetje=${hdr(r, 'X-Balance-Atomic')} atomic`);
      ok++;
    } catch (e) { console.error(`  ✗ bremenitev ${i}: ${e.message}`); }
    if (PAUSE_MS) await sleep(PAUSE_MS);
  }

  banner(`POVZETEK x402 · uspešnih ${ok}/${DEBITS} · on-chain poravnav: 1 (samo polnitev) · CSV: ${path.relative(process.cwd(), OUT)}`);
  const st = (a) => { const b = a.filter(Number.isFinite).sort((x, y) => x - y); if (!b.length) return null; const q = (p) => b[Math.min(b.length - 1, Math.floor(p * (b.length - 1)))]; return { median: q(0.5), mean: b.reduce((s2, x) => s2 + x, 0) / b.length, max: b[b.length - 1] }; };
  const sp = st(totals.podpis), sz = st(totals.zahteva);
  if (sp) console.log(`  t_podpis  (ms): median=${num(sp.median)} mean=${num(sp.mean)} max=${num(sp.max)}`);
  if (sz) console.log(`  t_zahteva (ms): median=${num(sz.median)} mean=${num(sz.mean)} max=${num(sz.max)}`);
  const view = await http.get(`/x402/session/${session.sessionId}`);
  if (view.status === 200) {
    const v = view.data.session;
    console.log(`  Končno stanje: dobroimetje=${v.balanceAtomic} atomic · porabljeno=${v.spentAtomic} atomic · bremenitev=${v.steviloBremenitev}`);
  }
  console.log(`  → ${DEBITS} odčitkov je zahtevalo ${paymentIds.size} x402 poravnavo (polnitev) in 0 dodatnih poravnav.`);
  if (paymentIds.size !== 1) { console.error('  ✗ NAPAKA: pričakovana natanko 1 poravnava'); process.exitCode = 1; }
}

// ── x402 varnostni testi (v2 sporočilo, ločitev formatov, meje) ─────────────
async function securityX402() {
  const cfgR = await http.get('/x402/config');
  if (cfgR.status === 401) { napakaPrijave(); return; }
  if (cfgR.status !== 200 || cfgR.data.mode === 'off' || !cfgR.data.mock) {
    console.error('❌ Testi zahtevajo napravo z X402_MODE=self X402_MOCK=true.'); process.exit(1);
  }
  const cfgX = cfgR.data;
  const account = loadX402Payer();
  const client = x402o.makeClient(account);
  const H = ADMIN_TOKEN ? { Authorization: `Bearer ${ADMIN_TOKEN}` } : {};
  banner('x402 VARNOSTNI TESTI (mapa 03 — financiranje seje + lokalno merjenje v2)');
  const results = [];
  const rec = (ime, prc, dej, ok, op = '') => { results.push({ ime, prc, dej, ok, op }); console.log(`  ${ok ? '✓' : '✗'} ${ime.padEnd(46)} pričakovano=${String(prc).padEnd(12)} dejansko=${String(dej).padEnd(9)} ${op}`); };

  // seja prek x402 polnitve
  const open = await x402o.payFlow({ url: `${IOT_URL}/x402/session/open`, method: 'POST', account, client, headers: H, body: {} });
  const session = open.status === 200 ? (await open.res.json()).session : null;
  rec('T1 x402 polnitev odpre sejo', 200, open.status, open.status === 200 && !!session);
  if (!session) { process.exitCode = 1; return; }

  { // T2: 5 bremenitev → 0 dodatnih poravnav (število vrstic v x402_payments se ne poveča)
    for (let i = 0; i < 5; i++) { const { r } = await x402Debit({ account, cfgX, sessionId: session.sessionId, i }); if (r.status !== 200) { rec('T2 bremenitev med testom', 200, r.status, false); break; } }
    const view = await http.get(`/x402/session/${session.sessionId}`);
    const n = view.status === 200 ? view.data.session.steviloBremenitev : -1;
    rec('T2 5 bremenitev → 0 novih poravnav', '5 lokalnih', `${n} lokalnih`, n === 5);
  }
  { // T3: v1 sporočilo (maxWei) na v2 poti → zavrnjeno
    const nonce = mkNonce();
    const maxAtomic = cfgX.priceAtomicPerCall;
    const v1msg = `x402-debit:${account.address.toLowerCase()}:${session.sessionId}:${nonce}:${cfgX.meteredEndpoint}:${maxAtomic}`;
    const sig = await account.signMessage({ message: v1msg });
    const r = await http.get(cfgX.meteredEndpoint, { headers: { 'X-Payer': account.address, 'X-Session': session.sessionId, 'X-Nonce': nonce, 'X-Signature': sig, 'X-Max-Atomic': maxAtomic } });
    rec('T3 v1 podpis na v2 poti → zavrnjen', 403, r.status, r.status === 403);
  }
  { // T4: v2 podpis z DRUGIM žetonom (asset) → zavrnjen
    const nonce = mkNonce();
    const maxAtomic = cfgX.priceAtomicPerCall;
    const msg = debitMessageV2(account.address, session.sessionId, nonce, cfgX.meteredEndpoint, maxAtomic, cfgX.network, '0x000000000000000000000000000000000000dEaD');
    const sig = await account.signMessage({ message: msg });
    const r = await http.get(cfgX.meteredEndpoint, { headers: { 'X-Payer': account.address, 'X-Session': session.sessionId, 'X-Nonce': nonce, 'X-Signature': sig, 'X-Max-Atomic': maxAtomic } });
    rec('T4 v2 podpis za drug žeton → zavrnjen', 403, r.status, r.status === 403);
  }
  { // T5: ponovitev nonce → 403
    const d1 = await x402Debit({ account, cfgX, sessionId: session.sessionId, i: 0 });
    const r = await http.get(cfgX.meteredEndpoint, { headers: { 'X-Payer': account.address, 'X-Session': session.sessionId, 'X-Nonce': d1.nonce, 'X-Signature': (await account.signMessage({ message: debitMessageV2(account.address, session.sessionId, d1.nonce, cfgX.meteredEndpoint, cfgX.priceAtomicPerCall, cfgX.network, cfgX.asset) })), 'X-Max-Atomic': cfgX.priceAtomicPerCall } });
    rec('T5 ponovitev nonce → 403 (replay)', 403, r.status, r.status === 403);
  }
  { // T6: cena nad podpisanim maksimumom → 400
    const nonce = mkNonce();
    const low = '1';
    const msg = debitMessageV2(account.address, session.sessionId, nonce, cfgX.meteredEndpoint, low, cfgX.network, cfgX.asset);
    const sig = await account.signMessage({ message: msg });
    const r = await http.get(cfgX.meteredEndpoint, { headers: { 'X-Payer': account.address, 'X-Session': session.sessionId, 'X-Nonce': nonce, 'X-Signature': sig, 'X-Max-Atomic': low } });
    rec('T6 cena nad maksimumom → 400', 400, r.status, r.status === 400);
  }
  { // T7: izčrpano dobroimetje → 402 (polog/cena = 20 klicev; 6 porabljenih zgoraj)
    let last = null;
    for (let i = 0; i < 20; i++) { const { r } = await x402Debit({ account, cfgX, sessionId: session.sessionId, i }); last = r; if (r.status !== 200) break; }
    rec('T7 izčrpano dobroimetje → 402', 402, last ? last.status : '—', !!last && last.status === 402, last && last.data && last.data.reason || '');
  }
  { // T8: ponovitev ISTE polnitve → predvajanje seje, brez nove poravnave
    const r = await x402o.payFlow({ url: `${IOT_URL}/x402/session/open`, method: 'POST', account, client, headers: H, body: {}, reuseHeaders: open.signedHeaders, paymentId: open.paymentId });
    const b = r.status === 200 ? await r.res.json() : null;
    rec('T8 ponovitev polnitve → ISTA seja (predvajanje)', session.sessionId.slice(0, 14) + '…', b && b.session ? b.session.sessionId.slice(0, 14) + '…' : r.status, !!b && b.session && b.session.sessionId === session.sessionId && r.replayed);
  }
  { // T9: pokvarjen JSON → 400 (popravek err.status)
    const r = await http.post('/session/open', '{pokvarjen', { headers: { 'Content-Type': 'application/json' } });
    rec('T9 pokvarjen JSON → 400 (ne 500)', 400, r.status, r.status === 400);
  }

  const okAll = results.filter((x) => x.ok).length;
  banner(`REZULTAT · ${okAll}/${results.length} uspešnih`);
  const csvOut = path.join(__dirname, '..', 'meritve', 'varnostni_testi_x402_mock.csv');
  fs.mkdirSync(path.dirname(csvOut), { recursive: true });
  fs.writeFileSync(csvOut, 'test,pricakovano,dejansko,uspeh,opomba\n' +
    results.map((x) => [JSON.stringify(x.ime), x.prc, x.dej, x.ok ? 1 : 0, JSON.stringify(x.op)].join(',')).join('\n') + '\n');
  console.log(`  CSV: ${path.relative(process.cwd(), csvOut)}`);
  if (okAll !== results.length) process.exitCode = 1;
}

(async () => {
  try {
    const hc = await http.get('/health'); if (hc.status >= 500) console.warn('  ⚠ /health degraded — nadaljujem');
    if (X402 && SECURITY) await securityX402();
    else if (X402) await mainX402();
    else if (SECURITY) await runSecurity();
    else await main();
  }
  catch (e) { console.error('Fatalna napaka:', e.message, '\nJe IoT naprava zagnana?  cd ../iot_naprava && npm start'); process.exit(1); }
})();
