#!/usr/bin/env node
'use strict';

/**
 * ============================================================================
 *  MERILNI AGENT — POSREDNIŠKA VEJA (topologija (b))
 *  (mapa 04_spletisce_posrednik/agent)
 * ============================================================================
 *
 *  Zunanji plačnik, ki merjeno prehodi posredniški protokol. Ker teče kot LOČEN
 *  proces (ne v strežniku kot `runner.js`), z njim lahko dokažeš tudi, da
 *  trgovec verige res ne potrebuje: trgovcu nastavi pokvarjen `RPC_URL`,
 *  agentu pa pravega — plačila morajo še vedno delovati.
 *
 *  Dva naslova, ker sta v tej topologiji dve nasprotni strani:
 *    --merchant-url    trgovec  (402 izziv, dostop do vira, merjene bremenitve)
 *    --posrednik-url   posrednik (prijava plačila, dokazni žeton)
 *
 *  POSKUSI:
 *    plačilo na odčitek, mock   node agent.js --mock --tx --queries 20
 *    plačilo na odčitek, real   node agent.js --real --tx --queries 20     (Sepolia)
 *    merjena seja               node agent.js --mock --merjeno --debits 20
 *                               node agent.js --real --merjeno --debits 20
 *    štetje sporočil            ./count-proxy.js (glej ../README.md)
 *    varnostni testi            node agent.js --security   (5 popravljenih napak + zloraba)
 *
 *  Vsaka vrstica CSV loči TRI čase, ker se prav v tem loči od neposredne veje:
 *    t_*_ms          kar meri odjemalec (celoten obhod)
 *    trgovec_*_ms    `X-Server-Ms` — koliko je porabil trgovec
 *    posrednik_*_ms  `X-Downstream-Ms` — koliko od tega je bilo čakanje na posrednika
 *  V neposredni veji je zadnji stolpec vedno 0. Razlika je strošek topologije.
 *
 *  Koda in komentarji angleško-slovensko mešano kot drugod v paketu; konzola in
 *  glave CSV so slovenske, enako kot v ostalih merilnih okoljih.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const axios = require('axios');
const { ethers } = require('ethers');

const cfgFile = path.join(__dirname, 'config.json');
const cfg = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')) : {};

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const MERCHANT_URL = val('--merchant-url', process.env.MERCHANT_URL || cfg.MERCHANT_URL || 'http://127.0.0.1:8081');
const POSREDNIK_URL = val('--posrednik-url', process.env.POSREDNIK_URL || cfg.POSREDNIK_URL || 'http://127.0.0.1:4000');
const NETWORK = process.env.NETWORK || cfg.NETWORK || 'sepolia';
const RPC_URL = val('--rpc-url', process.env.RPC_URL || cfg.RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com');
// Globino potrditev privzeto prevzamemo od POSREDNIKA (on je tisti, ki bere verigo).
// Če bi agent čakal manj potrditev, kot jih posrednik zahteva, bi vsako preverjanje
// odpovedalo — in to šele po tem, ko je prava transakcija že plačana.
let CONFIRMATIONS = parseInt(val('--confirmations', process.env.CONFIRMATIONS || cfg.CONFIRMATIONS || '0'), 10) || 0;
async function uskladiPotrditve(pcfg) {
  if (CONFIRMATIONS > 0) return CONFIRMATIONS;
  CONFIRMATIONS = (pcfg && parseInt(pcfg.minConfirmations, 10)) || 1;
  return CONFIRMATIONS;
}
// Trgovec je zaprt s skrbniško prijavo; agent se predstavi s strojnim žetonom.
//   grep ZETON ../streznik/data/admin-credentials.txt
// Posrednikova pot /submit-payment je javna, zato tam žetona ne rabimo.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || cfg.ADMIN_TOKEN || '';

const MODE = has('--real') ? 'real' : 'mock';
const TOK = has('--merjeno') ? 'merjeno' : 'tx';
const QUERIES = parseInt(val('--queries', '20'), 10);
const DEBITS = parseInt(val('--debits', '20'), 10);
const PAUSE_MS = parseInt(val('--pause-ms', '0'), 10);
const TOPUP_WEI = val('--topup-wei', '2500000000000');
const SECURITY = has('--security');
const X402 = has('--x402');   // vzporedni način: x402 exact prek lokalnega posrednika
const OUT = val('--out', path.join(__dirname, '..', 'meritve',
  X402 ? `x402_posrednik_tx_${MODE}.csv` : `posrednik_${TOK}_${MODE}.csv`));

const trgovec = axios.create({ baseURL: MERCHANT_URL, timeout: 120_000, validateStatus: () => true,
  headers: { 'X-Demo-Agent': 'agent', ...(ADMIN_TOKEN ? { Authorization: `Bearer ${ADMIN_TOKEN}` } : {}) } });
const posrednik = axios.create({ baseURL: POSREDNIK_URL, timeout: 120_000, validateStatus: () => true,
  headers: { 'X-Demo-Agent': 'agent' } });

const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const num = (x) => (x === null || x === undefined || Number.isNaN(x)) ? '' : (typeof x === 'number' ? x.toFixed(3) : String(x));
const hdrNum = (res, n) => { const v = parseFloat(res.headers[n.toLowerCase()]); return Number.isFinite(v) ? v : 0; };
const hdr = (res, n) => { const v = res.headers[n.toLowerCase()]; return v !== undefined ? v : ''; };
const banner = (t) => { const l = '─'.repeat(70); console.log(`\n┌${l}┐\n│ ${t.padEnd(68)} │\n└${l}┘`); };
const mkNonce = () => `${Date.now()}-${Buffer.from(ethers.randomBytes(6)).toString('hex')}`;
const randTxHash = () => '0x' + Buffer.from(ethers.randomBytes(32)).toString('hex');
const debitMessage = (payer, session, nonce, p, maxWei) => `x402-debit:${payer.toLowerCase()}:${session}:${nonce}:${p}:${maxWei}`;

let wallet, provider = null;
function makeWallet() {
  if (MODE === 'real') {
    const wf = path.join(__dirname, 'wallet.json');
    if (!fs.existsSync(wf)) { console.error('❌ wallet.json manjka (glej wallet.example.json).'); process.exit(1); }
    provider = new ethers.JsonRpcProvider(RPC_URL);
    return new ethers.Wallet(JSON.parse(fs.readFileSync(wf, 'utf8')).privateKey, provider);
  }
  // mock: podpisovanje potrebuje ključ, ne pa sredstev — enkratna denarnica zadošča.
  return ethers.Wallet.createRandom();
}

const CSV_TX = [
  'dogodek', 'cas_iso', 'nacin', 'topologija',
  't_izziv_ms', 't_veriga_ms', 't_prijava_ms', 't_dostop_ms', 't_skupaj_ms',
  'trgovec_izziv_ms', 'trgovec_dostop_ms',
  'posrednik_izziv_ms', 'posrednik_dostop_ms', 'posrednik_prijava_ms', 'posrednik_veriga_ms',
  'cena_wei', 'gas_enote', 'provizija_eth', 'kum_provizija_eth',
  'temperatura_c', 'vlaga_pct', 'tx_hash', 'request_id'
].join(',');
const CSV_MERJENO = [
  'dogodek', 'cas_iso', 'nacin', 'topologija', 'vrsta',
  't_podpis_ms', 't_zahteva_ms', 'streznik_ms', 'posrednik_ms', 't_skupaj_ms',
  'cena_wei', 'dobroimetje_wei', 'proracun_ostanek_wei',
  'gas_enote', 'provizija_eth', 'temperatura_c', 'vlaga_pct', 'nonce', 'seja'
].join(',');
function ensureCsv(f, header) { fs.mkdirSync(path.dirname(f), { recursive: true }); if (!fs.existsSync(f)) fs.writeFileSync(f, header + '\n'); }

// Trgovec je zaprt s skrbniško prijavo — brez veljavnega žetona ne gre nikamor.
function napakaPrijave() {
  console.error(`
❌ Trgovec je zavrnil prijavo (401). Merilni agent potrebuje strojni žeton.

   Na strežniku (po SSH) poišči žeton:
     grep ZETON ../streznik/data/admin-credentials.txt

   Nato ga podaj agentu:
     ADMIN_TOKEN=$(grep '^ZETON=' ../streznik/data/admin-credentials.txt | cut -d= -f2) node agent.js ${args.join(' ')}
`);
  process.exitCode = 1;
}
function napakaPosrednika(r) {
  console.error(`
❌ Posrednik (${POSREDNIK_URL}) ni dosegljiv${r && r.status ? ` (status ${r.status})` : ''}.

   V tej topologiji trgovec brez posrednika ne more sprejeti nobenega plačila —
   to ni napaka merjenja, ampak lastnost arhitekture (b) — v literaturi znana
   kot „odvisnost od razpoložljivosti".

   Poženi posrednika:  cd ../posrednik && npm run mock
`);
  process.exitCode = 1;
}

// ══════════ Plačilo za vsak odčitek prek posrednika ══════════════════════════
async function runTx() {
  banner(`POSREDNIK, PLAČILO NA ODČITEK · način=${MODE.toUpperCase()} · N=${QUERIES}`);
  console.log(`  trgovec=${MERCHANT_URL} · posrednik=${POSREDNIK_URL} · plačnik=${wallet.address}`);

  const h = await posrednik.get('/health');
  if (h.status !== 200) return napakaPosrednika(h);
  await uskladiPotrditve(h.data);
  const c = await trgovec.get('/config');
  if (c.status === 401) return napakaPrijave();
  if (c.status !== 200) { console.error(`  ✗ /config ${c.status}`); process.exitCode = 1; return; }
  if (!!c.data.mockVerify !== !!h.data.mockVerify) {
    console.error(`\n❌ Neskladje načina: trgovec mockVerify=${c.data.mockVerify}, posrednik mockVerify=${h.data.mockVerify}.`);
    console.error('   Meritev bi bila neveljavna. Uskladi MOCK_VERIFY v obeh .env.\n');
    process.exitCode = 1; return;
  }
  ensureCsv(OUT, CSV_TX);

  let cumFee = 0, ok = 0;
  const tSkupaj = [], tPosr = [];
  for (let i = 1; i <= QUERIES; i++) {
    const T0 = performance.now();
    try {
      // 1) 402 izziv (trgovec ga odpre pri posredniku: M→F, F→M)
      let s = performance.now();
      const ch = await trgovec.get('/tx/reading', { headers: { 'X-Payer': wallet.address } });
      const tIzziv = performance.now() - s;
      if (ch.status === 401) return napakaPrijave();
      if (ch.status === 502) return napakaPosrednika(ch);
      if (ch.status !== 402) throw new Error(`pričakoval 402, dobil ${ch.status}`);
      const pay = ch.data.payment;

      // 2) plačilo na verigi (C→B)
      let txHash, gasUsed = '', feeEth = '', tVeriga = 0;
      s = performance.now();
      if (MODE === 'real') {
        const tx = await wallet.sendTransaction({ to: pay.to, value: BigInt(pay.priceWei) });
        const rc = await tx.wait(CONFIRMATIONS);
        txHash = tx.hash; gasUsed = rc.gasUsed.toString();
        const gp = rc.gasPrice ?? tx.gasPrice ?? null;
        if (gp) { feeEth = ethers.formatEther(rc.gasUsed * gp); cumFee += parseFloat(feeEth); }
      } else { txHash = randTxHash(); }
      tVeriga = performance.now() - s;

      // 3) prijava plačila POSREDNIKU (C→F) — edini klic, ki gre mimo trgovca
      s = performance.now();
      const sp = await posrednik.post('/submit-payment', { requestId: pay.requestId, txHash, network: NETWORK, payerAddress: wallet.address });
      const tPrijava = performance.now() - s;
      if (sp.status !== 200) throw new Error(`submit-payment ${sp.status}: ${JSON.stringify(sp.data)}`);
      const proofToken = sp.data.proofToken || (sp.data.proof && sp.data.proof.token);

      // 4) dostop pri trgovcu (C→M; trgovec žeton unovči pri posredniku, M→F)
      s = performance.now();
      const rd = await trgovec.get('/tx/reading', { headers: { 'X-Payment': proofToken } });
      const tDostop = performance.now() - s;
      if (rd.status !== 200) throw new Error(`reading ${rd.status}: ${JSON.stringify(rd.data)}`);

      const skupaj = performance.now() - T0;
      const posrIzziv = hdrNum(ch, 'X-Downstream-Ms'), posrDostop = hdrNum(rd, 'X-Downstream-Ms');
      const posrPrijava = hdrNum(sp, 'X-Server-Ms'), posrVeriga = hdrNum(sp, 'X-Chain-Read-Ms');
      const reading = rd.data.reading;
      fs.appendFileSync(OUT, [
        `poizvedba_${i}`, nowIso(), MODE, 'posredniska',
        num(tIzziv), num(tVeriga), num(tPrijava), num(tDostop), num(skupaj),
        num(hdrNum(ch, 'X-Server-Ms')), num(hdrNum(rd, 'X-Server-Ms')),
        num(posrIzziv), num(posrDostop), num(posrPrijava), num(posrVeriga),
        pay.priceWei, gasUsed, feeEth, cumFee ? cumFee.toFixed(8) : '',
        reading.temperature_c, reading.humidity_pct, txHash, pay.requestId
      ].join(',') + '\n');
      ok++; tSkupaj.push(skupaj); tPosr.push(posrIzziv + posrDostop + posrPrijava);
      console.log(`  ✓ ${String(i).padStart(3)} · skupaj=${num(skupaj)} ms · izziv=${num(tIzziv)} · veriga=${num(tVeriga)} · prijava=${num(tPrijava)} · dostop=${num(tDostop)} ms  [posrednik ${num(posrIzziv + posrDostop + posrPrijava)} ms]`);
    } catch (e) { console.error(`  ✗ ${i}: ${e.message}`); }
    if (PAUSE_MS) await sleep(PAUSE_MS);
  }
  povzetek('placilo na odcitek', { ok, n: QUERIES, tSkupaj, tPosr, onChain: ok, cumFee });
}

// ══════════ Merjena seja prek posrednika ═════════════════════════════════════
async function runMerjeno() {
  banner(`POSREDNIK × MERJENA SEJA · način=${MODE.toUpperCase()} · N bremenitev=${DEBITS}`);
  console.log(`  trgovec=${MERCHANT_URL} · posrednik=${POSREDNIK_URL} · plačnik=${wallet.address}`);

  const h = await posrednik.get('/health');
  if (h.status !== 200) return napakaPosrednika(h);
  await uskladiPotrditve(h.data);
  const c = await trgovec.get('/config');
  if (c.status === 401) return napakaPrijave();
  if (c.status !== 200) { console.error(`  ✗ /config ${c.status}`); process.exitCode = 1; return; }
  ensureCsv(OUT, CSV_MERJENO);
  const m = c.data.merjeno;
  const price = BigInt(m.priceWeiPerCall);
  const maxWei = (price + BigInt(m.priceWeiPerByte) * 4096n).toString();
  console.log(`  Cena/odčitek: ${m.priceWeiPerCall} wei (+${m.priceWeiPerByte}/zlog)`);

  // FAZA A — ena polnitev na verigi odpre sejo (trgovec jo odpre pri posredniku)
  banner('FAZA A · Polnitev (1 on-chain transakcija) → seja pri posredniku');
  let txHash, gasUsed = '', feeEth = '';
  const body = { payerAddress: wallet.address };
  if (MODE === 'real') {
    const tx = await wallet.sendTransaction({ to: c.data.receiver, value: BigInt(TOPUP_WEI) });
    console.log(`  ✓ polnitev oddana · tx=${tx.hash}`);
    const rc = await tx.wait(CONFIRMATIONS);
    gasUsed = rc.gasUsed.toString();
    const gp = rc.gasPrice ?? tx.gasPrice ?? null;
    if (gp) feeEth = ethers.formatEther(rc.gasUsed * gp);
    txHash = tx.hash;
    console.log(`  ✓ potrjeno · blok=${rc.blockNumber} · gas=${gasUsed} · provizija=${feeEth} ETH`);
  } else {
    txHash = randTxHash();
    body.mockDepositWei = (price * BigInt(DEBITS + 5)).toString();
  }
  let s = performance.now();
  const op = await trgovec.post('/merjeno/session/open', { txHash, ...body });
  const tOpen = performance.now() - s;
  if (op.status === 502) return napakaPosrednika(op);
  if (op.status !== 200) { console.error(`  ✗ session/open ${op.status}: ${JSON.stringify(op.data)}`); process.exitCode = 1; return; }
  const session = op.data.session;
  console.log(`  ✓ seja=${session.sessionId} · dobroimetje=${session.depositWei} wei · velja do=${session.expiresAt}`);
  fs.appendFileSync(OUT, [
    'polnitev', nowIso(), MODE, 'posredniska', 'topup', '', num(tOpen),
    num(hdrNum(op, 'X-Server-Ms')), num(hdrNum(op, 'X-Downstream-Ms')), num(tOpen),
    session.depositWei, session.balanceWei, session.budgetRemainingWei,
    gasUsed, feeEth, '', '', '', session.sessionId
  ].join(',') + '\n');

  // FAZA B — N podpisanih bremenitev; vsaka gre pri trgovcu skozi posrednika
  banner(`FAZA B · ${DEBITS} podpisanih bremenitev (brez novih transakcij)`);
  const tPod = [], tZah = [], tPos = []; let ok = 0;
  for (let i = 1; i <= DEBITS; i++) {
    const T0 = performance.now();
    try {
      const nonce = mkNonce();
      let t = performance.now();
      const sig = await wallet.signMessage(debitMessage(wallet.address, session.sessionId, nonce, m.resource, maxWei));
      const tPodpis = performance.now() - t;
      t = performance.now();
      const r = await trgovec.get('/merjeno/reading-metered', { headers: { 'X-Payer': wallet.address, 'X-Session': session.sessionId, 'X-Nonce': nonce, 'X-Signature': sig, 'X-Max-Wei': maxWei } });
      const tZahteva = performance.now() - t;
      if (r.status === 502) return napakaPosrednika(r);
      if (r.status !== 200) throw new Error(`${r.status}: ${JSON.stringify(r.data)}`);
      const reading = r.data.reading;
      const pos = hdrNum(r, 'X-Downstream-Ms');
      fs.appendFileSync(OUT, [
        `bremenitev_${i}`, nowIso(), MODE, 'posredniska', 'debit',
        num(tPodpis), num(tZahteva), num(hdrNum(r, 'X-Server-Ms')), num(pos), num(performance.now() - T0),
        hdr(r, 'X-Charged-Wei'), hdr(r, 'X-Balance-Wei'), hdr(r, 'X-Budget-Remaining-Wei'),
        '', '', reading.temperature_c, reading.humidity_pct, nonce, session.sessionId
      ].join(',') + '\n');
      ok++; tPod.push(tPodpis); tZah.push(tZahteva); tPos.push(pos);
      console.log(`  ✓ bremenitev ${String(i).padStart(2)} · T=${reading.temperature_c}°C RH=${reading.humidity_pct}% · t_podpis=${num(tPodpis)} ms · t_zahteva=${num(tZahteva)} ms  [posrednik ${num(pos)} ms] · dobroimetje=${hdr(r, 'X-Balance-Wei')} wei`);
    } catch (e) { console.error(`  ✗ bremenitev ${i}: ${e.message}`); }
    if (PAUSE_MS) await sleep(PAUSE_MS);
  }
  const fin = (await trgovec.get(`/merjeno/session/${session.sessionId}`)).data.session;
  povzetek('merjena seja', { ok, n: DEBITS, tSkupaj: tZah, tPosr: tPos, onChain: 1, cumFee: parseFloat(feeEth || '0'), extra: { tPod, fin } });
}

function st(a) {
  a = a.filter(Number.isFinite).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const q = p => a[Math.floor(p * (a.length - 1))];
  return { n: a.length, min: a[0], median: q(0.5), mean: a.reduce((s, x) => s + x, 0) / a.length, p95: q(0.95), max: a[a.length - 1] };
}
function povzetek(exp, { ok, n, tSkupaj, tPosr, onChain, cumFee, extra }) {
  const s1 = st(tSkupaj), s2 = st(tPosr);
  banner(`POVZETEK ${exp} · uspešnih ${ok}/${n} · on-chain transakcij: ${onChain} · CSV: ${path.relative(process.cwd(), OUT)}`);
  if (extra && extra.tPod) { const sp = st(extra.tPod); if (sp) console.log(`  t_podpis   (ms): median=${num(sp.median)} mean=${num(sp.mean)} p95=${num(sp.p95)}`); }
  if (s1) console.log(`  obhod      (ms): median=${num(s1.median)} mean=${num(s1.mean)} p95=${num(s1.p95)} max=${num(s1.max)}`);
  if (s2) console.log(`  posrednik  (ms): median=${num(s2.median)} mean=${num(s2.mean)} p95=${num(s2.p95)} max=${num(s2.max)}   ← v neposredni veji (mapa 05) je to 0`);
  if (cumFee) console.log(`  kumulativna provizija: ${cumFee.toFixed(8)} ETH`);
  if (extra && extra.fin) console.log(`  Končno stanje seje: dobroimetje=${extra.fin.balanceWei} wei · porabljeno=${extra.fin.spentWei} wei`);
  const jsonOut = OUT.replace(/\.csv$/, '_povzetek.json');
  fs.writeFileSync(jsonOut, JSON.stringify({ poskus: exp, nacin: MODE, topologija: 'posredniska', n, uspesnih: ok,
    onChainTransakcij: onChain, obhod_ms: s1, posrednik_ms: s2,
    ...(extra && extra.tPod ? { t_podpis_ms: st(extra.tPod) } : {}), ...(extra && extra.fin ? { seja: extra.fin } : {}) }, null, 2));
  console.log(`  Povzetek JSON: ${path.relative(process.cwd(), jsonOut)}`);
}

// ══════════ VARNOSTNI TESTI — pet popravljenih napak stare izvedbe ═══════════
async function runSecurity() {
  banner('VARNOSTNI IN ODPOVEDNI TESTI (posredniška veja)');
  if (MODE === 'real') { console.error('  Varnostni testi so za --mock. Zaženi: node agent.js --security'); process.exit(1); }
  const results = [];
  const rec = (ime, prc, dej, ok, op = '') => { results.push({ ime, prc, dej, ok }); console.log(`  ${ok ? '✓' : '✗'} ${ime.padEnd(50)} pričakovano=${String(prc).padEnd(9)} dejansko=${String(dej).padEnd(9)} ${op}`); };

  const h = await posrednik.get('/health');
  if (h.status !== 200) return napakaPosrednika(h);
  const c = await trgovec.get('/config');
  if (c.status === 401) return napakaPrijave();
  const price = BigInt(c.data.tx.priceWei);
  const m = c.data.merjeno;
  const maxWei = (BigInt(m.priceWeiPerCall) + BigInt(m.priceWeiPerByte) * 4096n).toString();

  // pomožno: cel potek do dokaznega žetona
  const doIzziv = async () => (await trgovec.get('/tx/reading', { headers: { 'X-Payer': wallet.address } })).data.payment;
  const doSubmit = (requestId, txHash, over) => posrednik.post('/submit-payment', { requestId, txHash, network: NETWORK, payerAddress: wallet.address, ...over });

  // ── T1: trgovec res nima verige ───────────────────────────────────────────
  const th = await trgovec.get('/health');
  rec('Trgovec poroča „brez dostopa do verige"', 'da', th.data.veriga === 'ni dostopa (samo posrednik)' ? 'da' : 'ne', th.data.veriga === 'ni dostopa (samo posrednik)');

  // ── T2: odpadli poti ──────────────────────────────────────────────────────
  const tv = await trgovec.post('/tx/verify', { requestId: '00000000-0000-4000-8000-000000000000', txHash: randTxHash(), network: NETWORK, payerAddress: wallet.address });
  rec('Pri trgovcu ni več /tx/verify (plačilo se prijavi posredniku)', 404, tv.status, tv.status === 404);

  // ── T3: NAPAKA 1 — dokazni žeton je enkraten ──────────────────────────────
  let pay = await doIzziv();
  let sp = await doSubmit(pay.requestId, randTxHash());
  rec('Prijava plačila → dokazni žeton', 200, sp.status, sp.status === 200);
  const tok = sp.data.proofToken;
  let a1 = await trgovec.get('/tx/reading', { headers: { 'X-Payment': tok } });
  rec('Prva uporaba dokazila', 200, a1.status, a1.status === 200);
  let a2 = await trgovec.get('/tx/reading', { headers: { 'X-Payment': tok } });
  rec('NAPAKA 1 · druga uporaba istega dokazila', 403, a2.status, a2.status === 403, a2.data?.error || '');

  // ── T4: NAPAKA 2 — ista transakcija ne unovči dveh zahtev ─────────────────
  const skupniTx = randTxHash();
  const p1 = await doIzziv(); const r1 = await doSubmit(p1.requestId, skupniTx);
  const p2 = await doIzziv(); const r2 = await doSubmit(p2.requestId, skupniTx);
  rec('NAPAKA 2 · ista transakcija za drugo zahtevo', 400, r2.status, r1.status === 200 && r2.status === 400, r2.data?.error || '');

  // ── T5: NAPAKA 3 — premalo za 1 wei je premalo (celoštevilska primerjava) ──
  const p3 = await doIzziv();
  const r3 = await doSubmit(p3.requestId, randTxHash(), { mockValueWei: (price - 1n).toString() });
  rec('NAPAKA 3 · plačilo za 1 wei prenizko', 400, r3.status, r3.status === 400, r3.data?.error || '');
  const p4 = await doIzziv();
  const r4 = await doSubmit(p4.requestId, randTxHash(), { mockValueWei: price.toString() });
  rec('NAPAKA 3 · plačilo točno v znesku', 200, r4.status, r4.status === 200);

  // ── T6: posrednik zavrne neznano/poteklo zahtevo ──────────────────────────
  const r5 = await doSubmit('00000000-0000-4000-8000-000000000000', randTxHash());
  rec('Neznana plačilna zahteva', 400, r5.status, r5.status === 400, r5.data?.error || '');

  // ── T7: NAPAKA 5 — posrednik je avtenticiran ──────────────────────────────
  const anon = axios.create({ baseURL: POSREDNIK_URL, validateStatus: () => true, timeout: 20_000 });
  const r6 = await anon.post('/payment-request', { resource: '/x', recipient: wallet.address, amountWei: '1' });
  rec('NAPAKA 5 · /payment-request brez žetona', 401, r6.status, r6.status === 401);
  const r7 = await anon.post('/verify-proof', { token: 'proof_x' });
  rec('NAPAKA 5 · /verify-proof brez žetona', 401, r7.status, r7.status === 401);
  const r8 = await anon.get('/health');
  rec('/health ostaja javen (healthcheck vsebnika)', 200, r8.status, r8.status === 200);

  // ── T8–T13: merjena seja skozi posrednika ─────────────────────────────────
  const openS = async (over = {}) => {
    const r = await trgovec.post('/merjeno/session/open', { txHash: randTxHash(), payerAddress: wallet.address, mockDepositWei: (BigInt(m.priceWeiPerCall) * 10n).toString(), ...over });
    return r.data.session;
  };
  const doDebit = async (session, { nonce = mkNonce(), signAs = wallet, claimPayer = wallet.address, mw = maxWei } = {}) => {
    const sig = await signAs.signMessage(debitMessage(claimPayer, session.sessionId, nonce, m.resource, mw));
    return trgovec.get('/merjeno/reading-metered', { headers: { 'X-Payer': claimPayer, 'X-Session': session.sessionId, 'X-Nonce': nonce, 'X-Signature': sig, 'X-Max-Wei': String(mw) } });
  };
  let r = await trgovec.get('/merjeno/reading-metered');
  rec('Brez podpisa (manjkajoče glave)', 402, r.status, r.status === 402);
  const sA = await openS();
  const nA = mkNonce();
  r = await doDebit(sA, { nonce: nA });
  rec('Veljavna bremenitev prek posrednika', 200, r.status, r.status === 200);
  r = await doDebit(sA, { nonce: nA });
  rec('Ponovitev nonce (replay)', 403, r.status, r.status === 403, r.data?.error || '');
  const other = ethers.Wallet.createRandom();
  r = await doDebit(sA, { signAs: other });
  rec('Ponarejen podpis (druga denarnica)', 403, r.status, r.status === 403, r.data?.error || '');
  r = await doDebit(sA, { nonce: `${Date.now() - 10 * 60 * 1000}-deadbeef` });
  rec('Zastarel nonce', 400, r.status, r.status === 400, r.data?.error || '');
  const sB = await openS({ mockDepositWei: (BigInt(m.priceWeiPerCall) * 10n).toString(), budgetWei: (BigInt(m.priceWeiPerCall) * 2n).toString() });
  await doDebit(sB); await doDebit(sB);
  r = await doDebit(sB);
  rec('Presežen proračun (proračun=2×cena)', 402, r.status, r.status === 402, r.data?.reason || '');
  const sC = await openS({ mockDepositWei: (BigInt(m.priceWeiPerCall) * 2n).toString() });
  await doDebit(sC); await doDebit(sC);
  r = await doDebit(sC);
  rec('Izčrpano dobroimetje', 402, r.status, r.status === 402, r.data?.reason || '');
  const sD = await openS();
  const sE = await openS();
  const sigCross = await wallet.signMessage(debitMessage(wallet.address, sD.sessionId, mkNonce(), m.resource, maxWei));
  r = await trgovec.get('/merjeno/reading-metered', { headers: { 'X-Payer': wallet.address, 'X-Session': sE.sessionId, 'X-Nonce': mkNonce(), 'X-Signature': sigCross, 'X-Max-Wei': maxWei } });
  rec('Podpis za drugo sejo', 403, r.status, r.status === 403, r.data?.error || '');

  const ok = results.filter(x => x.ok).length;
  banner(`REZULTAT: ${ok}/${results.length} testov uspešnih`);
  const out = path.join(__dirname, '..', 'meritve', 'posrednik_varnost.csv');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, 'test,pricakovano,dejansko,uspeh\n' + results.map(x => `"${x.ime}",${x.prc},${x.dej},${x.ok ? 1 : 0}`).join('\n') + '\n');
  console.log(`  CSV: ${path.relative(process.cwd(), out)}`);
  if (ok !== results.length) process.exitCode = 1;
}

// ── main ─────────────────────────────────────────────────────────────────────
// ══════════ x402 v2 (VZPOREDNI NAČIN) — facilitirano prek posrednika ═════════
// Odjemalec podpiše EIP-3009 pooblastilo in NE odda nobene transakcije;
// trgovec delegira preverjanje/poravnavo POSREDNIKU, ki plača gas. Meri se
// celotni obhod pri trgovcu + posrednikova stran prek vpogleda
// /x402/payment/:id.
const x402o = X402 ? require('./x402-odjemalec') : null;

const X402_CSV_HEADER = [
  'dogodek', 'cas_iso', 'nacin', 'protokol', 'topologija', 'omrezje', 'sredstvo', 'placnik_gasa',
  't_402_ms', 't_podpis_ms', 't_placilo_http_ms', 't_skupaj_ms',
  'trgovec_ms', 'trgovec_downstream_ms', 'preveri_ms', 'poravnaj_ms',
  'znesek_atomic', 'decimals', 'kumulativno_atomic', 'payment_id', 'idempotenca',
  'tx_hash', 'sinteticni_tx', 'blok', 'gas_enote', 'cena_gas_wei',
  'temperatura_c', 'vlaga_pct', 'status'
].join(',');

function loadX402Payer() {
  const wf = path.join(__dirname, 'wallet.json');
  const wd = fs.existsSync(wf) ? JSON.parse(fs.readFileSync(wf, 'utf8')) : {};
  if (MODE === 'real' && !wd.x402PayerPrivateKey) {
    console.error('❌ Za --x402 --real vpiši x402PayerPrivateKey v wallet.json (x402 veja je testna ETH konfiguracija; pravi tek zahteva EIP-3009 žeton, npr. USDC).');
    process.exit(1);
  }
  return x402o.makePayer({ privateKey: MODE === 'real' ? wd.x402PayerPrivateKey : undefined });
}

async function runX402Tx() {
  const c = await trgovec.get('/x402/config');
  if (c.status === 401) return napakaPrijave();
  if (c.status !== 200 || !c.data || c.data.mode === 'off') {
    console.error('❌ Trgovec nima vklopljenega x402 načina (X402_MODE=facilitated na trgovcu, X402_MODE=self na posredniku).'); process.exit(1);
  }
  const cfgX = c.data;
  const account = loadX402Payer();
  const client = x402o.makeClient(account);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  if (!fs.existsSync(OUT)) fs.writeFileSync(OUT, X402_CSV_HEADER + '\n');

  banner(`x402 PREK POSREDNIKA · 1 PORAVNAVA / POIZVEDBO · način=${MODE.toUpperCase()} · N=${QUERIES}`);
  console.log(`  Trgovec=${MERCHANT_URL} · posrednik=${cfgX.posrednik} · prejemnik=${cfgX.payTo}`);
  console.log(`  Cena/odčitek: ${cfgX.priceAtomic} atomskih enot ${cfgX.assetName} · gas plača: POSREDNIK`);
  if (cfgX.mock) console.log('  ⚠ MOCK: poravnave so sintetične (0x6d6f636b6d6f636b…) — NE prave meritve.');

  let ok = 0; let kumulativnoAtomic = 0n;
  const txHashes = new Set();
  for (let i = 1; i <= QUERIES; i++) {
    try {
      const T0 = performance.now();
      const r = await x402o.payFlow({
        url: `${MERCHANT_URL}/x402/tx/reading`, account, client,
        headers: ADMIN_TOKEN ? { Authorization: `Bearer ${ADMIN_TOKEN}`, 'X-Demo-Agent': 'agent' } : { 'X-Demo-Agent': 'agent' }
      });
      const skupaj = performance.now() - T0;
      if (r.status !== 200) throw new Error(`placilo ${r.status}`);
      const body = await r.res.json();
      const reading = body.reading || {};
      kumulativnoAtomic += BigInt(cfgX.priceAtomic);
      if (r.paymentResponse && r.paymentResponse.txHash) txHashes.add(r.paymentResponse.txHash);
      const downMs = parseFloat(r.res.headers.get('X-Downstream-Ms') || '') || '';
      let blok = '', gasEnote = '', cenaGasWei = '';
      const pv = await trgovec.get(`/x402/payment/${r.paymentId}`);
      if (pv.status === 200 && pv.data) { blok = pv.data.blok ?? ''; gasEnote = pv.data.gasEnote ?? ''; cenaGasWei = pv.data.cenaGasWei ?? ''; }
      fs.appendFileSync(OUT, [
        `poizvedba_${i}`, nowIso(), MODE, 'x402-facilitated', 'posredniska', cfgX.network, cfgX.assetName, 'posrednik',
        num(r.t.t402), num(r.t.tPodpis), num(r.t.tPoravnavaHttp), num(skupaj),
        num(r.serverMs), num(downMs), num(r.verifyMs), num(r.settleMs),
        cfgX.priceAtomic, cfgX.assetDecimals, kumulativnoAtomic.toString(), r.paymentId,
        r.replayed ? 'predvajanje' : 'novo',
        r.paymentResponse ? r.paymentResponse.txHash : '', r.sinteticni ? 1 : 0,
        blok, gasEnote, cenaGasWei,
        reading.temperature_c ?? '', reading.humidity_pct ?? '', r.status
      ].join(',') + '\n');
      console.log(`  ✓ ${String(i).padStart(3)} · skupaj=${num(skupaj)} ms · trgovec=${num(r.serverMs)} ms (od tega posrednik=${num(downMs)} ms) · tx=${r.paymentResponse ? String(r.paymentResponse.txHash).slice(0, 18) + '…' : '—'}${r.sinteticni ? ' (sintetični)' : ''}`);
      ok++;
    } catch (e) { console.error(`  ✗ ${i}: ${e.message}`); }
    if (PAUSE_MS) await sleep(PAUSE_MS);
  }

  banner(`POVZETEK x402-posrednik · uspešnih ${ok}/${QUERIES} · poravnav: ${txHashes.size} · CSV: ${path.relative(process.cwd(), OUT)}`);
  console.log(`  ${QUERIES} odčitkov = ${txHashes.size} x402 poravnav; poravnalno transakcijo odda in gas plača POSREDNIK.`);
  console.log('  Trgovec med tem NIKOLI ne govori z verigo (enaka nespremenljivka kot pri lastnem protokolu).');
  if (txHashes.size !== ok) { console.error('  ✗ NAPAKA: odčitki ≠ poravnave'); process.exitCode = 1; }
}

async function runX402Security() {
  const c = await trgovec.get('/x402/config');
  if (c.status === 401) return napakaPrijave();
  const posrednikMock = !!(c.data && ((c.data.posrednikX402 && c.data.posrednikX402.mock) || c.data.mock));
  if (c.status !== 200 || c.data.mode === 'off' || !posrednikMock) {
    console.error('❌ Testi zahtevajo: trgovec X402_MODE=facilitated + posrednik X402_MODE=self X402_MOCK=true.'); process.exit(1);
  }
  const cfgX = c.data;
  const account = loadX402Payer();
  const client = x402o.makeClient(account);
  const H = { ...(ADMIN_TOKEN ? { Authorization: `Bearer ${ADMIN_TOKEN}` } : {}), 'X-Demo-Agent': 'agent' };
  const url = `${MERCHANT_URL}/x402/tx/reading`;
  banner('x402 VARNOSTNI TESTI (mapa 04 — facilitirana topologija)');
  const results = [];
  const rec = (ime, prc, dej, ok, op = '') => { results.push({ ime, prc, dej, ok, op }); console.log(`  ${ok ? '✓' : '✗'} ${ime.padEnd(50)} pričakovano=${String(prc).padEnd(12)} dejansko=${String(dej).padEnd(10)} ${op}`); };

  { // topološka nespremenljivka: trgovec brez verige tudi v x402 načinu
    const h = await trgovec.get('/health');
    rec('T1 trgovec brez dostopa do verige', 'da', h.data && h.data.veriga === 'ni dostopa (samo posrednik)' ? 'da' : 'ne', h.data && h.data.veriga === 'ni dostopa (samo posrednik)');
  }
  { // odkrivanje: /x402/supported javno na posredniku
    const r = await posrednik.get('/x402/supported');
    const okKind = r.status === 200 && (r.data.kinds || []).some((k) => k.scheme === 'exact' && k.network === cfgX.network);
    rec('T2 posrednik /x402/supported javno + exact', '200+exact', `${r.status}${okKind ? '+exact' : ''}`, okKind);
  }
  { // facilitatorski poti zahtevata žeton (trgovec-kot-stranka)
    const r = await axios.post(`${POSREDNIK_URL}/x402/settle`, { a: 1 }, { validateStatus: () => true });
    rec('T3 /x402/settle brez žetona → 401', 401, r.status, r.status === 401);
  }
  { const r = await axios.get(url, { validateStatus: () => true }); rec('T4 brez prijave → 401 (avtentikacija ≠ plačilo)', 401, r.status, r.status === 401); }
  { const r = await trgovec.get('/x402/tx/reading'); rec('T5 s prijavo, brez plačila → 402 + PAYMENT-REQUIRED', 402, r.status, r.status === 402 && !!r.headers['payment-required']); }
  let prvi;
  { prvi = await x402o.payFlow({ url, account, client, headers: H }); rec('T6 veljavno plačilo prek posrednika → 200', 200, prvi.status, prvi.status === 200); }
  { // odjemalec NI oddal transakcije; poravnavo je oddal posrednik
    const pv = await trgovec.get(`/x402/payment/${prvi.paymentId}`);
    const okTx = pv.status === 200 && pv.data && pv.data.posrednik && pv.data.posrednik.status && ['SETTLED', 'SETTLED_UNVERIFIED'].includes(pv.data.posrednik.status);
    rec('T7 poravnavo vodi POSREDNIK (njegova evidenca)', 'SETTLED', pv.data && pv.data.posrednik ? pv.data.posrednik.status : pv.status, okTx);
  }
  { // ponovitev → predvajanje pri trgovcu, posrednik ne poravna drugič
    const r = await x402o.payFlow({ url, account, client, headers: H, reuseHeaders: prvi.signedHeaders, paymentId: prvi.paymentId });
    rec('T8 ponovitev → predvajanje, ista poravnava', 'replay', r.replayed ? 'replay' : r.status, r.status === 200 && r.replayed && r.paymentResponse && r.paymentResponse.txHash === prvi.paymentResponse.txHash);
  }
  { // pokvarjen podpis → 402
    const r = await x402o.payFlow({ url, account, client, headers: H, mutateAuthorization: (a) => { a.value = '1'; } });
    rec('T9 pokvarjeno pooblastilo → 402', 402, r.status, r.status === 402);
  }
  { // sočasni dvojniki → ena poravnava
    const sig = await x402o.payFlow({ url, account, client, headers: H });
    const runs = await Promise.all(Array.from({ length: 4 }, () => x402o.payFlow({ url, account, client, headers: H, reuseHeaders: sig.signedHeaders, paymentId: sig.paymentId })));
    const hashes = new Set([sig.paymentResponse && sig.paymentResponse.txHash, ...runs.map((r) => r.paymentResponse && r.paymentResponse.txHash)].filter(Boolean));
    rec('T10 sočasni dvojniki → ena poravnava', '1 hash', `${hashes.size} hash`, hashes.size === 1);
  }
  { // nedosegljiv posrednik → jasna napaka, brez sesutja trgovca
    // (simulacija: neposredno vprašamo trgovca, ki naj vrne 402 z razlogom, če posrednik pade —
    //  tu preverimo le, da trgovec preživi neveljaven payload)
    const r = await trgovec.get('/x402/tx/reading', { headers: { 'PAYMENT-SIGNATURE': 'ne-base64!' } });
    rec('T11 neveljaven PAYMENT-SIGNATURE → 402, ne 500', 402, r.status, r.status === 402);
  }

  const okAll = results.filter((x) => x.ok).length;
  banner(`REZULTAT · ${okAll}/${results.length} uspešnih`);
  const csvOut = path.join(__dirname, '..', 'meritve', 'x402_posrednik_varnost.csv');
  fs.mkdirSync(path.dirname(csvOut), { recursive: true });
  fs.writeFileSync(csvOut, 'test,pricakovano,dejansko,uspeh,opomba\n' +
    results.map((x) => [JSON.stringify(x.ime), x.prc, x.dej, x.ok ? 1 : 0, JSON.stringify(x.op)].join(',')).join('\n') + '\n');
  console.log(`  CSV: ${path.relative(process.cwd(), csvOut)}`);
  if (okAll !== results.length) process.exitCode = 1;
}

(async () => {
  wallet = makeWallet();
  try {
    if (X402 && SECURITY) await runX402Security();
    else if (X402) await runX402Tx();
    else if (SECURITY) await runSecurity();
    else if (TOK === 'merjeno') await runMerjeno();
    else await runTx();
  } catch (e) {
    console.error(`\n❌ ${e.message}`);
    if (e.code === 'ECONNREFUSED') console.error(`   Ali tečeta oba procesa? trgovec=${MERCHANT_URL} posrednik=${POSREDNIK_URL}`);
    process.exitCode = 1;
  }
})();
