#!/usr/bin/env node
'use strict';

/**
 * ============================================================================
 *  AGENT (uporabnik storitve) — 20 poizvedb = 20 on-chain transakcij
 *  (folder 02_avtomatska_placila_transakcije)
 * ============================================================================
 *
 *  The consuming machine queries the mock IoT device N times. EACH reading is
 *  paid with its OWN Sepolia transaction (full one-time flow per query). This
 *  measures the EXPENSIVE baseline whose cumulative gas is compared against the
 *  metered/prepaid folder 03.
 *
 *  Per query it records: latency phases + gas used + fee + a running cumulative
 *  fee, plus the sensor value that was purchased.
 *
 *  USAGE:
 *    node agent.js --mock --queries 20
 *    node agent.js --real --queries 20 --pause-ms 1500
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
const IOT_URL = process.env.IOT_URL || cfg.IOT_URL || 'http://127.0.0.1:3100';
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
const QUERIES = parseInt(val('--queries', '20'), 10);
const PAUSE_MS = parseInt(val('--pause-ms', MODE === 'real' ? '1000' : '0'), 10);
const X402 = has('--x402');   // NOVI vzporedni način: uradni x402 v2 (Ethereum Sepolia, ETH — testno)
const SECURITY = has('--security');
const OUT = val('--out', path.join(__dirname, '..', 'meritve',
  X402 ? `x402_transakcije_${MODE}.csv` : `transakcije_${MODE}.csv`));

const http = axios.create({ baseURL: IOT_URL, timeout: 90_000, validateStatus: () => true,
  headers: ADMIN_TOKEN ? { Authorization: `Bearer ${ADMIN_TOKEN}` } : {} });
const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const num = (x) => (x === null || x === undefined || Number.isNaN(x)) ? '' : (typeof x === 'number' ? x.toFixed(3) : String(x));
const hdr = (res, n) => { const v = res.headers[n.toLowerCase()]; return v !== undefined ? parseFloat(v) : ''; };

let wallet = null, provider = null;
function loadWallet() {
  const wf = path.join(__dirname, 'wallet.json');
  if (!fs.existsSync(wf)) { console.error('❌ wallet.json manjka (glej wallet.example.json / generate-wallet.js).'); process.exit(1); }
  provider = new ethers.JsonRpcProvider(RPC_URL);
  wallet = new ethers.Wallet(JSON.parse(fs.readFileSync(wf, 'utf8')).privateKey, provider);
}

function banner(t) { const l = '─'.repeat(64); console.log(`\n┌${l}┐\n│ ${t.padEnd(62)} │\n└${l}┘`); }

const CSV_HEADER = [
  'poizvedba', 'cas_iso', 'nacin',
  't_izziv_ms', 't_oddaja_ms', 't_potrditev_ms', 't_preverjanje_ms', 't_odcitek_ms', 't_skupaj_ms',
  'gas_enote', 'cena_gas_wei', 'provizija_wei', 'provizija_eth', 'vrednost_wei',
  'kumulativna_provizija_eth', 'temperatura_c', 'vlaga_pct', 'blok', 'tx_hash'
].join(',');
function ensureCsv(f) { fs.mkdirSync(path.dirname(f), { recursive: true }); if (!fs.existsSync(f)) fs.writeFileSync(f, CSV_HEADER + '\n'); }

async function oneQuery(i, cumFeeEthRef) {
  const payer = MODE === 'real' ? wallet.address : ethers.Wallet.createRandom().address;
  const t = {}; const T0 = performance.now();

  // 402 challenge
  let s = performance.now();
  const ch = await http.get('/reading', { headers: { 'X-Payer': payer } });
  t.izziv = performance.now() - s;
  if (ch.status !== 402) throw new Error(`Pričakoval 402, dobil ${ch.status}`);
  const pay = ch.data.payment;

  // pay (one tx per reading) + wait
  let txHash, block = 0, gasUsed = '', gasPriceWei = '', feeWei = '', feeEth = '', valueWei = pay.priceWei || '';
  if (MODE === 'real') {
    s = performance.now();
    const tx = await wallet.sendTransaction({ to: pay.to, value: BigInt(pay.priceWei) });
    t.oddaja = performance.now() - s;
    txHash = tx.hash;
    s = performance.now();
    const rc = await tx.wait(CONFIRMATIONS);
    t.potrditev = performance.now() - s;
    block = rc.blockNumber; gasUsed = rc.gasUsed.toString();
    const gp = rc.gasPrice ?? tx.gasPrice ?? null;
    if (gp) { gasPriceWei = gp.toString(); const fee = rc.gasUsed * gp; feeWei = fee.toString(); feeEth = ethers.formatEther(fee); }
    valueWei = BigInt(pay.priceWei).toString();
  } else {
    s = performance.now();
    const d = ethers.Wallet.createRandom();
    await d.signTransaction({ to: pay.to, value: BigInt(pay.priceWei), chainId: 11155111, nonce: 0, gasLimit: 21000n, gasPrice: 1000000000n });
    t.oddaja = performance.now() - s; t.potrditev = 0;
    txHash = '0x' + Buffer.from(ethers.randomBytes(32)).toString('hex');
  }

  // verify -> proof
  s = performance.now();
  const vf = await http.post('/verify-payment', { requestId: pay.requestId, txHash, network: NETWORK, payerAddress: payer });
  t.preverjanje = performance.now() - s;
  if (vf.status !== 200) throw new Error(`verify ${vf.status}: ${JSON.stringify(vf.data)}`);
  const proof = vf.data.proofToken;

  // access reading with proof
  s = performance.now();
  const rd = await http.get('/reading', { headers: { 'X-Payment': proof } });
  t.odcitek = performance.now() - s;
  if (rd.status !== 200) throw new Error(`reading ${rd.status}: ${JSON.stringify(rd.data)}`);
  const reading = rd.data.reading;

  t.skupaj = performance.now() - T0;
  if (feeEth) cumFeeEthRef.v += parseFloat(feeEth);

  console.log(`  ✓ poizvedba ${String(i).padStart(2)} · T=${reading.temperature_c}°C RH=${reading.humidity_pct}% · t_skupaj=${num(t.skupaj)} ms · gas=${gasUsed || '(mock)'} · kumul.provizija=${cumFeeEthRef.v ? cumFeeEthRef.v.toFixed(8) : '0'} ETH`);

  return [
    i, nowIso(), MODE,
    num(t.izziv), num(t.oddaja), num(t.potrditev), num(t.preverjanje), num(t.odcitek), num(t.skupaj),
    gasUsed, gasPriceWei, feeWei, feeEth, valueWei,
    cumFeeEthRef.v ? cumFeeEthRef.v.toFixed(18) : '', reading.temperature_c, reading.humidity_pct, block, txHash
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
  if (MODE === 'real') loadWallet();
  banner(`AVTOMATSKA PLAČILA · 1 TRANSAKCIJA / POIZVEDBO · način=${MODE.toUpperCase()} · N=${QUERIES} · naprava=${IOT_URL}`);
  const h = await http.get('/config');
  if (h.status === 401) { napakaPrijave(MODE === 'real' ? 'real' : 'mock'); return; }
  // Šele zdaj ustvari CSV: sicer bi neuspela prijava pustila datoteko s samo glavo,
  // ki bi jo analiza vzela pred vzorčnimi podatki in se sesula na prazni tabeli.
  ensureCsv(OUT);
  if (h.status === 200) console.log(`  Cena/odčitek: ${h.data.priceEth} ETH (≈ ${h.data.priceEurApprox} €) · prejemnik=${h.data.device}`);
  if (MODE === 'real') { const b = await provider.getBalance(wallet.address); console.log(`  Plačnik: ${wallet.address} · saldo: ${ethers.formatEther(b)} ETH`); }

  const cum = { v: 0 };
  const totals = { skupaj: [], preverjanje: [], odcitek: [] };
  let ok = 0;
  for (let i = 1; i <= QUERIES; i++) {
    try { const row = await oneQuery(i, cum); fs.appendFileSync(OUT, row.join(',') + '\n'); ok++; }
    catch (e) { console.error(`  ✗ poizvedba ${i}: ${e.message}`); }
    if (PAUSE_MS) await sleep(PAUSE_MS);
  }

  banner(`POVZETEK · uspešnih ${ok}/${QUERIES} · transakcij na verigi: ${MODE === 'real' ? ok : '(mock)'} · CSV: ${path.relative(process.cwd(), OUT)}`);
  console.log(`  Skupaj plačanih on-chain transakcij za ${QUERIES} odčitkov: ${MODE === 'real' ? ok : QUERIES} (= N)`);
  if (cum.v) console.log(`  Skupna provizija (gas) za vse transakcije: ${cum.v.toFixed(8)} ETH  ← ta znesek narašča linearno z N`);
  console.log('  → Primerjaj z mapo 03, kjer je za enako število odčitkov potrebna SAMO 1 transakcija.');
}

// ══════════ x402 v2 (VZPOREDNI NAČIN) — N odčitkov = N poravnav ════════════
// NAMERNO brez paketne poravnave in brez dobroimetja iz mape 03: vsak odčitek
// je ena x402 exact poravnava (EIP-3009 pooblastilo → strežnik poravna (v
// testnem načinu sintetično) in plača gas). Bearer žeton ostane avtentikacija.
const x402o = X402 ? require('./x402-odjemalec') : null;

const X402_CSV_HEADER = [
  'poizvedba', 'cas_iso', 'nacin', 'protokol', 'topologija', 'omrezje', 'sredstvo', 'placnik_gasa',
  't_402_ms', 't_podpis_ms', 't_placilo_http_ms', 't_skupaj_ms',
  'streznik_ms', 'preveri_ms', 'poravnaj_ms',
  'znesek_atomic', 'decimals', 'kumulativno_atomic', 'payment_id', 'idempotenca',
  'tx_hash', 'sinteticni_tx', 'blok', 'gas_enote', 'cena_gas_wei',
  'temperatura_c', 'vlaga_pct', 'status'
].join(',');

function loadX402Payer() {
  const wf = path.join(__dirname, 'wallet.json');
  const wd = fs.existsSync(wf) ? JSON.parse(fs.readFileSync(wf, 'utf8')) : {};
  if (MODE === 'real' && !wd.x402PayerPrivateKey) {
    console.error('❌ Za --x402 --real vpiši x402PayerPrivateKey v wallet.json (pravi x402 tek zahteva žeton z EIP-3009 — testna ETH konfiguracija teče samo mock)');
    process.exit(1);
  }
  return x402o.makePayer({ privateKey: MODE === 'real' ? wd.x402PayerPrivateKey : undefined });
}

async function mainX402() {
  const cfgR = await http.get('/x402/config');
  if (cfgR.status === 401) { napakaPrijave(MODE === 'real' ? 'real' : 'mock'); return; }
  if (cfgR.status !== 200 || !cfgR.data || cfgR.data.mode === 'off') {
    console.error('❌ Naprava nima vklopljenega x402 načina (X402_MODE=self [+ X402_MOCK=true]).'); process.exit(1);
  }
  const cfgX = cfgR.data;
  const account = loadX402Payer();
  const client = x402o.makeClient(account);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  if (!fs.existsSync(OUT)) fs.writeFileSync(OUT, X402_CSV_HEADER + '\n');

  banner(`x402 AVTOMATSKA PLAČILA · 1 PORAVNAVA / POIZVEDBO · način=${MODE.toUpperCase()} · N=${QUERIES}`);
  console.log(`  Cena/odčitek: ${cfgX.priceAtomic} atomskih enot ${cfgX.assetName} · prejemnik=${cfgX.payTo} · gas plača: naprava/strežnik`);
  if (cfgX.mock) console.log('  ⚠ MOCK: poravnave so sintetične (0x6d6f636b6d6f636b…) — NE prave meritve.');

  const totals = { skupaj: [] };
  let ok = 0; let kumulativnoAtomic = 0n;
  const paymentIds = new Set(); const txHashes = new Set();
  for (let i = 1; i <= QUERIES; i++) {
    try {
      const T0 = performance.now();
      const r = await x402o.payFlow({
        url: `${IOT_URL}/x402/reading`, account, client,
        headers: ADMIN_TOKEN ? { Authorization: `Bearer ${ADMIN_TOKEN}` } : {}
      });
      const skupaj = performance.now() - T0;
      if (r.status !== 200) throw new Error(`placilo ${r.status}`);
      const body = await r.res.json();
      const reading = body.reading || {};
      kumulativnoAtomic += BigInt(cfgX.priceAtomic);
      paymentIds.add(r.paymentId);
      if (r.paymentResponse && r.paymentResponse.txHash) txHashes.add(r.paymentResponse.txHash);
      let blok = '', gasEnote = '', cenaGasWei = '';
      const pv = await http.get(`/x402/payment/${r.paymentId}`);
      if (pv.status === 200) { blok = pv.data.blok ?? ''; gasEnote = pv.data.gasEnote ?? ''; cenaGasWei = pv.data.cenaGasWei ?? ''; }
      fs.appendFileSync(OUT, [
        i, nowIso(), MODE, 'x402-self', 'neposredna', cfgX.network, cfgX.assetName, 'streznik',
        num(r.t.t402), num(r.t.tPodpis), num(r.t.tPoravnavaHttp), num(skupaj),
        num(r.serverMs), num(r.verifyMs), num(r.settleMs),
        cfgX.priceAtomic, cfgX.assetDecimals, kumulativnoAtomic.toString(), r.paymentId,
        r.replayed ? 'predvajanje' : 'novo',
        r.paymentResponse ? r.paymentResponse.txHash : '', r.sinteticni ? 1 : 0,
        blok, gasEnote, cenaGasWei,
        reading.temperature_c ?? '', reading.humidity_pct ?? '', r.status
      ].join(',') + '\n');
      totals.skupaj.push(skupaj);
      console.log(`  ✓ poizvedba ${String(i).padStart(2)} · T=${reading.temperature_c}°C RH=${reading.humidity_pct}% · t_skupaj=${num(skupaj)} ms · poravnava=${r.paymentResponse ? String(r.paymentResponse.txHash).slice(0, 18) + '…' : '—'}${r.sinteticni ? ' (sintetična)' : ''}`);
      ok++;
    } catch (e) { console.error(`  ✗ poizvedba ${i}: ${e.message}`); }
    if (PAUSE_MS) await sleep(PAUSE_MS);
  }

  banner(`POVZETEK x402 · uspešnih ${ok}/${QUERIES} · poravnav: ${txHashes.size} · CSV: ${path.relative(process.cwd(), OUT)}`);
  console.log(`  ${QUERIES} odčitkov = ${txHashes.size} ločenih x402 poravnav (payment-id-jev: ${paymentIds.size}) — NI paketne poravnave.`);
  console.log(`  Kumulativno plačilo potrošnika: ${kumulativnoAtomic} atomskih enot ${cfgX.assetName}; gas vseh poravnav plača NAPRAVA.`);
  console.log('  → Primerjaj z mapo 03, kjer je za enako število odčitkov ENA polnitev.');
  if (txHashes.size !== ok) { console.error(`  ✗ NAPAKA: odčitkov ${ok} ≠ poravnav ${txHashes.size}`); process.exitCode = 1; }
}

// ── x402 varnostni testi (osnovni; celotni nabor je v mapi 01) ──────────────
async function securityX402() {
  const cfgR = await http.get('/x402/config');
  if (cfgR.status === 401) { napakaPrijave('mock'); return; }
  if (cfgR.status !== 200 || cfgR.data.mode === 'off' || !cfgR.data.mock) {
    console.error('❌ Testi zahtevajo napravo z X402_MODE=self X402_MOCK=true.'); process.exit(1);
  }
  const account = loadX402Payer();
  const client = x402o.makeClient(account);
  const url = `${IOT_URL}/x402/reading`;
  const H = ADMIN_TOKEN ? { Authorization: `Bearer ${ADMIN_TOKEN}` } : {};
  banner('x402 VARNOSTNI TESTI (mapa 02)');
  const results = [];
  const rec = (ime, pric, dej, ok, opomba = '') => { results.push({ ime, pric, dej, ok, opomba }); console.log(`  ${ok ? '✓' : '✗'} ${ime.padEnd(46)} pričakovano=${String(pric).padEnd(12)} dejansko=${String(dej).padEnd(9)} ${opomba}`); };

  { // avtentikacija ostane ločena od plačila: brez Bearer žetona 401, KLJUB x402 plačilu
    const r1 = await fetch(url);
    rec('T1 brez prijave → 401 (avtentikacija ≠ plačilo)', 401, r1.status, r1.status === 401);
  }
  { const r = await fetch(url, { headers: H }); rec('T2 s prijavo, brez plačila → 402', 402, r.status, r.status === 402); }
  { const r = await x402o.payFlow({ url, account, client, headers: H }); rec('T3 veljavno plačilo → 200 + odčitek', 200, r.status, r.status === 200); }
  { // N=3 odčitki → 3 ločene poravnave (nič paketov)
    const hashes = new Set();
    for (let i = 0; i < 3; i++) { const r = await x402o.payFlow({ url, account, client, headers: H }); if (r.paymentResponse) hashes.add(r.paymentResponse.txHash); }
    rec('T4 3 odčitki → 3 ločene poravnave', 3, hashes.size, hashes.size === 3);
  }
  { // ponovitev istega plačila → predvajanje, brez nove poravnave
    const a = await x402o.payFlow({ url, account, client, headers: H });
    const b = await x402o.payFlow({ url, account, client, headers: H, reuseHeaders: a.signedHeaders, paymentId: a.paymentId });
    rec('T5 ponovitev → predvajanje, ista poravnava', 'replay', b.replayed ? 'replay' : b.status, b.status === 200 && b.replayed);
  }
  { const r = await fetch(`${IOT_URL}/verify-payment`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: '{pokvarjen' }); rec('T6 pokvarjen JSON → 400 (ne 500)', 400, r.status, r.status === 400); }

  const okAll = results.filter((r) => r.ok).length;
  banner(`REZULTAT · ${okAll}/${results.length} uspešnih`);
  const csvOut = path.join(__dirname, '..', 'meritve', 'varnostni_testi_x402_mock.csv');
  fs.mkdirSync(path.dirname(csvOut), { recursive: true });
  fs.writeFileSync(csvOut, 'test,pricakovano,dejansko,uspeh,opomba\n' +
    results.map((r) => [JSON.stringify(r.ime), r.pric, r.dej, r.ok ? 1 : 0, JSON.stringify(r.opomba)].join(',')).join('\n') + '\n');
  console.log(`  CSV: ${path.relative(process.cwd(), csvOut)}`);
  if (okAll !== results.length) process.exitCode = 1;
}

(async () => {
  try {
    const hc = await http.get('/health'); if (hc.status >= 500) console.warn('  ⚠ /health degraded — nadaljujem');
    if (X402 && SECURITY) await securityX402();
    else if (X402) await mainX402();
    else await main();
  }
  catch (e) { console.error('Fatalna napaka:', e.message, '\nJe IoT naprava zagnana?  cd ../iot_naprava && npm start'); process.exit(1); }
})();
