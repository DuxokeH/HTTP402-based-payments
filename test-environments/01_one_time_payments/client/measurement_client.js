#!/usr/bin/env node
'use strict';

/**
 * ============================================================================
 *  MERILNI KLIENT — ENKRATNA PLAČILA  (folder 01_enkratna_placila)
 * ============================================================================
 *
 *  Headless client that drives the full one-time payment flow and measures the
 *  latency of every phase. It is the automated (M2M) payer of this scenario and
 *  produces the data for the latency and gas figures.
 *
 *  PHASES measured per run (wall clock, ms):
 *    t_izziv       GET /service            -> 402 challenge
 *    t_oddaja      sign + broadcast tx     -> tx hash returned by RPC
 *    t_potrditev   wait for confirmation   -> receipt (block, gas)   [chain]
 *    t_preverjanje POST /verify-payment    -> proof token
 *    t_dostop      POST /service (proof)   -> 200 + content
 *    t_skupaj      end-to-end wall clock
 *
 *  MODES:
 *    --mock   no real chain. Uses server MOCK_VERIFY; t_potrditev = 0 and gas is
 *             left empty. Hundreds of repeatable runs of pure PROTOCOL latency.
 *    --real   real Sepolia transactions (needs a funded wallet.json). Gives the
 *             real confirmation time + real gas, and clean Wireshark captures.
 *
 *  USAGE:
 *    node merilni_klient.js --mock --runs 50
 *    node merilni_klient.js --real --runs 5 --pause-ms 1500
 *    node merilni_klient.js --security          (failure / abuse test suite)
 *
 *  Code/comments English; all console output + CSV headers Slovenian.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const axios = require('axios');
const { ethers } = require('ethers');

// ── config ─────────────────────────────────────────────────────────────────
const cfgFile = path.join(__dirname, 'config.json');
const cfg = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')) : {};
const MERCHANT_URL = process.env.MERCHANT_URL || cfg.MERCHANT_URL || 'http://127.0.0.1:3000';
const ENDPOINT     = process.env.ENDPOINT || cfg.ENDPOINT || '/service';
const NETWORK      = process.env.NETWORK || cfg.NETWORK || 'sepolia';
const RPC_URL      = process.env.RPC_URL || cfg.RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';
const CONFIRMATIONS = parseInt(process.env.CONFIRMATIONS || cfg.CONFIRMATIONS || '1', 10);

// ── CLI args ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const MODE = has('--real') ? 'real' : 'mock';
const RUNS = parseInt(val('--runs', '30'), 10);
const PAUSE_MS = parseInt(val('--pause-ms', MODE === 'real' ? '1000' : '0'), 10);
const PROMPT = val('--prompt', 'Pozdravljen, svet! To je testni poziv za meritev.');
const X402 = has('--x402');   // NOVI vzporedni način: uradni x402 v2 (Ethereum Sepolia, ETH — testno)
const OUT = val('--out', path.join(__dirname, '..', 'meritve',
  X402 ? `x402_enkratna_${MODE}.csv` : `enkratna_${MODE}.csv`));
const SECURITY = has('--security');

const http = axios.create({ baseURL: MERCHANT_URL, timeout: 60_000, validateStatus: () => true });

// ── wallet (real mode) ─────────────────────────────────────────────────────
let wallet = null, provider = null;
function loadWallet() {
  const wf = path.join(__dirname, 'wallet.json');
  if (!fs.existsSync(wf)) { console.error('❌ wallet.json manjka. Ustvari ga (glej wallet.example.json) ali zaženi: node generate-wallet.js'); process.exit(1); }
  const wd = JSON.parse(fs.readFileSync(wf, 'utf8'));
  provider = new ethers.JsonRpcProvider(RPC_URL);
  wallet = new ethers.Wallet(wd.privateKey, provider);
}

// ── helpers ────────────────────────────────────────────────────────────────
const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const num = (x) => (x === null || x === undefined || Number.isNaN(x)) ? '' : (typeof x === 'number' ? x.toFixed(3) : String(x));
const hdr = (res, name) => { const v = res.headers[name.toLowerCase()]; return v !== undefined ? parseFloat(v) : ''; };

function banner(title) {
  const line = '─'.repeat(64);
  console.log(`\n┌${line}┐`);
  console.log(`│ ${title.padEnd(62)} │`);
  console.log(`└${line}┘`);
}

const CSV_HEADER = [
  'zap', 'cas_iso', 'nacin',
  't_izziv_ms', 't_oddaja_ms', 't_potrditev_ms', 't_preverjanje_ms', 't_dostop_ms', 't_skupaj_ms',
  'streznik_preverjanje_ms', 'veriga_branje_ms', 'streznik_dostop_ms', 'zunanji_api_ms',
  'gas_enote', 'cena_gas_wei', 'provizija_wei', 'provizija_eth', 'blok', 'tx_hash', 'status'
].join(',');

function ensureCsv(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, CSV_HEADER + '\n');
}
function appendCsv(file, row) { fs.appendFileSync(file, row.join(',') + '\n'); }

// ── x402 v2 (vzporedni način) ──────────────────────────────────────────────
// Ločena datoteka in ločena glava: meritve x402 se NIKOLI ne mešajo z
// obstoječimi enkratna_*.csv. Zneski so v atomskih enotah sredstva (testni ETH:
// wei). `placnik_gasa=streznik`: odjemalec le podpiše pooblastilo,
// poravnalno transakcijo odda in plača strežnik.
const X402_CSV_HEADER = [
  'zap', 'cas_iso', 'nacin', 'protokol', 'topologija', 'omrezje', 'sredstvo', 'placnik_gasa',
  't_402_ms', 't_podpis_ms', 't_placilo_http_ms', 't_skupaj_ms',
  'streznik_ms', 'preveri_ms', 'poravnaj_ms',
  'znesek_atomic', 'decimals', 'payment_id', 'idempotenca', 'tx_hash', 'sinteticni_tx',
  'blok', 'gas_enote', 'cena_gas_wei', 'status'
].join(',');
function ensureX402Csv(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, X402_CSV_HEADER + '\n');
}

// ── ONE full one-time flow, fully instrumented ─────────────────────────────
async function oneRun(i) {
  const payer = MODE === 'real' ? wallet.address : ethers.Wallet.createRandom().address;
  const t = {}; const T0 = performance.now();

  // Phase 1 — 402 challenge
  banner(`ZAP ${i} · FAZA 1/5 · Izziv 402 (GET ${ENDPOINT})`);
  let s = performance.now();
  const chRes = await http.get(ENDPOINT, { headers: { 'X-Payer': payer } });
  t.izziv = performance.now() - s;
  if (chRes.status !== 402) throw new Error(`Pričakoval 402, dobil ${chRes.status}`);
  const pay = chRes.data.payment;
  console.log(`  ✓ 402 · requestId=${pay.requestId} · znesek=${pay.amount} ${pay.currency} · vir=${pay.resource} · streznik=${hdr(chRes, 'X-Server-Ms')} ms`);
  if (PAUSE_MS) await sleep(PAUSE_MS);

  // Phase 2 + 3 — broadcast + confirmation
  let txHash, blockNumber = 0, gasUsed = '', gasPriceWei = '', feeWei = '', feeEth = '';
  banner(`ZAP ${i} · FAZA 2/5 · Oddaja transakcije na ${NETWORK}`);
  if (MODE === 'real') {
    s = performance.now();
    const tx = await wallet.sendTransaction({ to: pay.to, value: ethers.parseEther(String(pay.amount)) });
    t.oddaja = performance.now() - s;
    txHash = tx.hash;
    console.log(`  ✓ oddano · tx=${txHash}\n    https://sepolia.etherscan.io/tx/${txHash}`);
    banner(`ZAP ${i} · FAZA 3/5 · Čakam na potrditev (${CONFIRMATIONS} blok)`);
    s = performance.now();
    const rc = await tx.wait(CONFIRMATIONS);
    t.potrditev = performance.now() - s;
    blockNumber = rc.blockNumber;
    gasUsed = rc.gasUsed.toString();
    const gp = rc.gasPrice ?? (tx.gasPrice ?? null);
    if (gp) { gasPriceWei = gp.toString(); const fee = rc.gasUsed * gp; feeWei = fee.toString(); feeEth = ethers.formatEther(fee); }
    console.log(`  ✓ potrjeno · blok=${blockNumber} · gas=${gasUsed} · provizija=${feeEth} ETH`);
  } else {
    // MOCK: measure only local signing of a dummy legacy tx (no broadcast),
    // no confirmation. t_oddaja here reflects local signing cost only.
    s = performance.now();
    const dummy = ethers.Wallet.createRandom();
    await dummy.signTransaction({ to: pay.to, value: ethers.parseEther(String(pay.amount)), chainId: 11155111, nonce: 0, gasLimit: 21000n, gasPrice: 1000000000n });
    t.oddaja = performance.now() - s;
    t.potrditev = 0; // no chain in mock — excluded from protocol-only latency
    txHash = '0x' + Buffer.from(ethers.randomBytes(32)).toString('hex');
    console.log(`  ✓ (mock) podpis lokalno · t_oddaja=${num(t.oddaja)} ms · potrditev preskočena`);
  }
  if (PAUSE_MS) await sleep(PAUSE_MS);

  // Phase 4 — verify-payment
  banner(`ZAP ${i} · FAZA 4/5 · Preverjanje (POST /verify-payment)`);
  s = performance.now();
  const vfRes = await http.post('/verify-payment', { requestId: pay.requestId, txHash, network: NETWORK, payerAddress: payer });
  t.preverjanje = performance.now() - s;
  if (vfRes.status !== 200) throw new Error(`verify-payment ${vfRes.status}: ${JSON.stringify(vfRes.data)}`);
  const proofToken = vfRes.data.proofToken;
  console.log(`  ✓ dokazni žeton=${proofToken} · streznik=${hdr(vfRes, 'X-Server-Ms')} ms · veriga=${hdr(vfRes, 'X-Chain-Read-Ms')} ms`);
  if (PAUSE_MS) await sleep(PAUSE_MS);

  // Phase 5 — access
  banner(`ZAP ${i} · FAZA 5/5 · Dostop (POST ${ENDPOINT}, X-Payment)`);
  s = performance.now();
  const acRes = await http.post(ENDPOINT, { prompt: PROMPT }, { headers: { 'X-Payment': proofToken } });
  t.dostop = performance.now() - s;
  if (acRes.status !== 200) throw new Error(`service ${acRes.status}: ${JSON.stringify(acRes.data)}`);
  console.log(`  ✓ 200 OK · streznik=${hdr(acRes, 'X-Server-Ms')} ms · zunanji_api=${hdr(acRes, 'X-Downstream-Ms')} ms`);

  t.skupaj = performance.now() - T0;

  const row = [
    i, nowIso(), MODE,
    num(t.izziv), num(t.oddaja), num(t.potrditev), num(t.preverjanje), num(t.dostop), num(t.skupaj),
    num(hdr(vfRes, 'X-Server-Ms')), num(hdr(vfRes, 'X-Chain-Read-Ms')), num(hdr(acRes, 'X-Server-Ms')), num(hdr(acRes, 'X-Downstream-Ms')),
    gasUsed, gasPriceWei, feeWei, feeEth, blockNumber, txHash, acRes.status
  ];
  return { t, row, feeEth };
}

// ── aggregate stats ────────────────────────────────────────────────────────
function stats(arr) {
  const a = arr.filter(x => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const q = (p) => a[Math.min(a.length - 1, Math.floor(p * (a.length - 1)))];
  const mean = a.reduce((s, x) => s + x, 0) / a.length;
  return { n: a.length, min: a[0], median: q(0.5), mean, p95: q(0.95), max: a[a.length - 1] };
}

async function runMeasurement() {
  if (MODE === 'real') loadWallet();
  ensureCsv(OUT);
  banner(`MERITEV ENKRATNIH PLAČIL · način=${MODE.toUpperCase()} · ponovitev=${RUNS} · streznik=${MERCHANT_URL}`);
  if (MODE === 'real') {
    const bal = await provider.getBalance(wallet.address);
    console.log(`  Denarnica plačnika: ${wallet.address}  ·  saldo: ${ethers.formatEther(bal)} ETH`);
  }

  const collected = { izziv: [], oddaja: [], potrditev: [], preverjanje: [], dostop: [], skupaj: [] };
  let ok = 0; const fees = [];
  for (let i = 1; i <= RUNS; i++) {
    try {
      const { t, row, feeEth } = await oneRun(i);
      appendCsv(OUT, row);
      for (const k of Object.keys(collected)) collected[k].push(t[k]);
      if (feeEth) fees.push(parseFloat(feeEth));
      ok++;
    } catch (e) {
      console.error(`  ✗ ZAP ${i} napaka: ${e.message}`);
    }
    if (PAUSE_MS) await sleep(PAUSE_MS);
  }

  banner(`POVZETEK · uspešnih ${ok}/${RUNS} · CSV: ${path.relative(process.cwd(), OUT)}`);
  const label = { izziv: 't_izziv (402)', oddaja: 't_oddaja', potrditev: 't_potrditev', preverjanje: 't_preverjanje', dostop: 't_dostop', skupaj: 't_skupaj' };
  console.log('  faza'.padEnd(24) + 'n    min      median   mean     p95      max   [ms]');
  for (const k of Object.keys(collected)) {
    const st = stats(collected[k]); if (!st) continue;
    console.log('  ' + label[k].padEnd(22) + `${String(st.n).padEnd(5)}${num(st.min).padEnd(9)}${num(st.median).padEnd(9)}${num(st.mean).padEnd(9)}${num(st.p95).padEnd(9)}${num(st.max)}`);
  }
  if (fees.length) {
    const f = stats(fees);
    console.log(`\n  provizija/tx (ETH): median=${f.median} · mean=${f.mean} · min=${f.min} · max=${f.max}  (n=${f.n})`);
  }
  // JSON summary next to the CSV
  const jsonOut = OUT.replace(/\.csv$/, '_povzetek.json');
  const summary = { nacin: MODE, ponovitev: RUNS, uspesnih: ok, streznik: MERCHANT_URL, faze: {} };
  for (const k of Object.keys(collected)) summary.faze[k] = stats(collected[k]);
  if (fees.length) summary.provizija_eth = stats(fees);
  fs.writeFileSync(jsonOut, JSON.stringify(summary, null, 2));
  console.log(`\n  Povzetek JSON: ${path.relative(process.cwd(), jsonOut)}`);
}

// ── x402 v2: MERITEV ───────────────────────────────────────────────────────
// Faze: t_402 (izziv) · t_podpis (EIP-3009 pooblastilo) · t_placilo_http
// (plačana zahteva: verify + settle + vir). Strežnik razčleni svojo stran v
// glavah X-Verify-Ms / X-Settle-Ms / X-Server-Ms. Gas/blok pri pravem teku
// doda poizvedba GET /x402/payment/:id PO zaključeni meritvi (ne moti faz).
const x402o = X402 ? require('./x402-odjemalec') : null;

function loadX402Payer() {
  const wf = path.join(__dirname, 'wallet.json');
  const wd = fs.existsSync(wf) ? JSON.parse(fs.readFileSync(wf, 'utf8')) : {};
  if (MODE === 'real' && !wd.x402PayerPrivateKey) {
    console.error('❌ Za --x402 --real vpiši x402PayerPrivateKey v wallet.json (pravi x402 tek zahteva žeton z EIP-3009 — testna ETH konfiguracija teče samo mock)');
    process.exit(1);
  }
  return x402o.makePayer({ privateKey: MODE === 'real' ? wd.x402PayerPrivateKey : undefined });
}

async function x402Cfg() {
  const r = await http.get('/x402/config');
  if (r.status !== 200 || !r.data || r.data.mode === 'off') {
    console.error('❌ Strežnik nima vklopljenega x402 načina. Zaženi ga z X402_MODE=self (in X402_MOCK=true za mock).');
    process.exit(1);
  }
  return r.data;
}

async function runX402Measurement() {
  const cfgX = await x402Cfg();
  const account = loadX402Payer();
  const client = x402o.makeClient(account);
  ensureX402Csv(OUT);
  banner(`MERITEV x402 v2 (exact · ${cfgX.network} · ${cfgX.assetName}) · način=${MODE.toUpperCase()} · ponovitev=${RUNS}`);
  console.log(`  Plačnik (podpisnik pooblastil): ${account.address} · prejemnik: ${cfgX.payTo}`);
  console.log(`  Cena: ${cfgX.priceAtomic} atomskih enot (${(parseInt(cfgX.priceAtomic, 10) / 10 ** cfgX.assetDecimals).toFixed(cfgX.assetDecimals)} ${cfgX.assetName}) · gas plača: strežnik`);
  if (cfgX.mock) console.log('  ⚠ MOCK: poravnave so sintetične (tx hash s predpono 0x6d6f636b6d6f636b) — NE prave meritve.');

  const collected = { t402: [], podpis: [], placilo: [], skupaj: [] };
  let ok = 0;
  for (let i = 1; i <= RUNS; i++) {
    try {
      const T0 = performance.now();
      const r = await x402o.payFlow({
        url: `${MERCHANT_URL}/x402/service?prompt=${encodeURIComponent(PROMPT)}`,
        account, client
      });
      const skupaj = performance.now() - T0;
      if (r.status !== 200) throw new Error(`placilo ${r.status}: ${JSON.stringify(await r.res.text().catch(() => ''))}`);
      // gas/blok iz strežnikove evidence (po meritvi, ne vpliva na faze)
      let blok = '', gasEnote = '', cenaGasWei = '';
      const pv = await http.get(`/x402/payment/${r.paymentId}`);
      if (pv.status === 200) { blok = pv.data.blok ?? ''; gasEnote = pv.data.gasEnote ?? ''; cenaGasWei = pv.data.cenaGasWei ?? ''; }
      appendCsv(OUT, [
        i, nowIso(), MODE, 'x402-self', 'neposredna', cfgX.network, cfgX.assetName, 'streznik',
        num(r.t.t402), num(r.t.tPodpis), num(r.t.tPoravnavaHttp), num(skupaj),
        num(r.serverMs), num(r.verifyMs), num(r.settleMs),
        cfgX.priceAtomic, cfgX.assetDecimals, r.paymentId, r.replayed ? 'predvajanje' : 'novo',
        r.paymentResponse ? r.paymentResponse.txHash : '', r.sinteticni ? 1 : 0,
        blok, gasEnote, cenaGasWei, r.status
      ]);
      collected.t402.push(r.t.t402); collected.podpis.push(r.t.tPodpis);
      collected.placilo.push(r.t.tPoravnavaHttp); collected.skupaj.push(skupaj);
      console.log(`  ✓ ${String(i).padStart(3)} · t_402=${num(r.t.t402)} ms · t_podpis=${num(r.t.tPodpis)} ms · t_placilo=${num(r.t.tPoravnavaHttp)} ms · tx=${r.paymentResponse ? String(r.paymentResponse.txHash).slice(0, 18) : '—'}…${r.sinteticni ? ' (sintetični)' : ''}`);
      ok++;
    } catch (e) {
      console.error(`  ✗ ZAP ${i} napaka: ${e.message}`);
    }
    if (PAUSE_MS) await sleep(PAUSE_MS);
  }

  banner(`POVZETEK x402 · uspešnih ${ok}/${RUNS} · CSV: ${path.relative(process.cwd(), OUT)}`);
  const label = { t402: 't_402 (izziv)', podpis: 't_podpis (EIP-3009)', placilo: 't_placilo (verify+settle+vir)', skupaj: 't_skupaj' };
  console.log('  faza'.padEnd(32) + 'n    min      median   mean     p95      max   [ms]');
  for (const k of Object.keys(collected)) {
    const st = stats(collected[k]); if (!st) continue;
    console.log('  ' + label[k].padEnd(30) + `${String(st.n).padEnd(5)}${num(st.min).padEnd(9)}${num(st.median).padEnd(9)}${num(st.mean).padEnd(9)}${num(st.p95).padEnd(9)}${num(st.max)}`);
  }
  console.log('\n  ⚠ Opomba za analizo: oba tokova zdaj tečeta na ISTEM omrežju (Ethereum Sepolia)');
  console.log('    in v ISTI denominaciji (ETH). Preostale razlike: protokol, vrsta transakcije');
  console.log('    (EIP-3009 pooblastilo s sintetično poravnavo v testu ≠ pravi prenos ETH)');
  console.log('    IN plačnik gasa (strežnik ≠ odjemalec). Razlik NE pripisuj zgolj protokolu x402.');
  const jsonOut = OUT.replace(/\.csv$/, '_povzetek.json');
  const summary = { nacin: MODE, protokol: 'x402-self', omrezje: cfgX.network, sredstvo: cfgX.assetName, placnik_gasa: 'streznik', ponovitev: RUNS, uspesnih: ok, faze: {} };
  for (const k of Object.keys(collected)) summary.faze[k] = stats(collected[k]);
  fs.writeFileSync(jsonOut, JSON.stringify(summary, null, 2));
  console.log(`  Povzetek JSON: ${path.relative(process.cwd(), jsonOut)}`);
}

// ── x402 v2: VARNOSTNI TESTI ───────────────────────────────────────────────
async function runX402Security() {
  const cfgX = await x402Cfg();
  if (MODE === 'real') { console.error('  Varnostni testi x402 so za mock način (strežnik z X402_MOCK=true).'); process.exit(1); }
  const account = loadX402Payer();
  const client = x402o.makeClient(account);
  const url = `${MERCHANT_URL}/x402/service`;
  banner(`x402 VARNOSTNI IN ODPOVEDNI TESTI · streznik=${MERCHANT_URL}`);
  const results = [];
  const rec = (ime, pricakovano, dejansko, ok, opomba = '') => {
    results.push({ ime, pricakovano, dejansko, ok, opomba });
    console.log(`  ${ok ? '✓' : '✗'} ${ime.padEnd(44)} pričakovano=${String(pricakovano).padEnd(18)} dejansko=${String(dejansko).padEnd(9)} ${opomba}`);
  };

  // T1: brez plačila → 402 z glavo PAYMENT-REQUIRED (x402 v2)
  {
    const r = await fetch(url);
    const pr = r.headers.get('PAYMENT-REQUIRED');
    const j = pr ? x402o.decodeB64Json(pr) : null;
    rec('T1 izziv 402 + PAYMENT-REQUIRED (v2)', '402/v2', `${r.status}/${j ? 'v' + j.x402Version : 'brez'}`,
      r.status === 402 && !!j && j.x402Version === 2);
  }
  // T2: veljavno plačilo → 200 + PAYMENT-RESPONSE (+ sintetični hash v mock)
  let prvi;
  {
    prvi = await x402o.payFlow({ url, account, client });
    rec('T2 veljavno plačilo', 200, prvi.status, prvi.status === 200 && !!prvi.paymentResponse,
      prvi.sinteticni ? 'sintetični tx (mock)' : '');
  }
  // T3: ponovitev ISTEGA podpisanega plačila → predpomnjen odgovor, brez nove poravnave
  {
    const r = await x402o.payFlow({ url, account, client, reuseHeaders: prvi.signedHeaders, paymentId: prvi.paymentId });
    rec('T3 ponovitev → idempotentno predvajanje', '200+replay', `${r.status}${r.replayed ? '+replay' : ''}`,
      r.status === 200 && r.replayed);
  }
  // T4: isti payment-id, DRUG podpis → 409 spor
  {
    const r = await x402o.payFlow({ url, account, client, paymentId: prvi.paymentId });
    rec('T4 isti payment-id, drugo pooblastilo', 409, r.status, r.status === 409);
  }
  // T5: napačen prejemnik (payTo pokvarjen po podpisu) → 402
  {
    const r = await x402o.payFlow({ url, account, client, mutateAuthorization: (a) => { a.to = '0x000000000000000000000000000000000000dEaD'; } });
    rec('T5 napačen prejemnik', 402, r.status, r.status === 402);
  }
  // T6: napačen znesek (value pokvarjen po podpisu → podpis ne velja) → 402
  {
    const r = await x402o.payFlow({ url, account, client, mutateAuthorization: (a) => { a.value = '1'; } });
    rec('T6 pokvarjen znesek → neveljaven podpis', 402, r.status, r.status === 402);
  }
  // T7: poteklo pooblastilo (validBefore v preteklosti, pokvarjen po podpisu) → 402
  {
    const r = await x402o.payFlow({ url, account, client, mutateAuthorization: (a) => { a.validBefore = '1000'; } });
    rec('T7 poteklo/pokvarjeno pooblastilo', 402, r.status, r.status === 402);
  }
  // T8: tuj podpisnik, ki se izdaja za plačnika → 402
  {
    const vsiljivec = x402o.makePayer({});
    const clientV = x402o.makeClient(vsiljivec);
    const r = await x402o.payFlow({ url, account: vsiljivec, client: clientV, mutateAuthorization: (a) => { a.from = account.address; } });
    rec('T8 ponarejen plačnik (tuj podpis)', 402, r.status, r.status === 402);
  }
  // T9: sočasni dvojnik — ISTO podpisano plačilo 5×: natanko ena poravnava
  {
    const sig = await x402o.payFlow({ url, account, client });   // sveže plačilo
    const stmt = await Promise.all(Array.from({ length: 5 }, () =>
      x402o.payFlow({ url, account, client, reuseHeaders: sig.signedHeaders, paymentId: sig.paymentId })));
    const okNum = stmt.filter((r) => r.status === 200).length;
    const hashes = new Set(stmt.filter((r) => r.paymentResponse && r.paymentResponse.txHash).map((r) => r.paymentResponse.txHash));
    if (sig.paymentResponse && sig.paymentResponse.txHash) hashes.add(sig.paymentResponse.txHash);
    rec('T9 sočasni dvojniki → ena poravnava', '1 hash', `${hashes.size} hash`, hashes.size === 1, `${okNum}/5 → 200`);
  }
  // T10: pooblastilo enega vira ne odklene drugega (payment-id vezan na vir)
  {
    const r = await fetch(`${MERCHANT_URL}/x402/payment/ne-obstaja`, {});
    rec('T10 neznano plačilo → 404', 404, r.status, r.status === 404);
  }
  // T11: simuliran revert poravnave → 402, ponovitev NE poravna drugič
  {
    const r = await x402o.payFlow({ url, account, client, fault: 'revert' });
    const retry = r.status === 402 ? await x402o.payFlow({ url, account, client, reuseHeaders: r.signedHeaders, paymentId: r.paymentId }) : null;
    rec('T11 revert poravnave → dokončen neuspeh', '402/402', `${r.status}/${retry ? retry.status : '—'}`,
      r.status === 402 && retry && retry.status === 402, 'zahteva X402_MOCK_FAULTS=true');
  }
  // T12: simuliran RPC timeout → oddano-brez-potrdila; ponovitev NE odda drugič,
  //      uskladitev (mock potrdilo) vrne 200 z ISTIM tx hashem
  {
    const r = await x402o.payFlow({ url, account, client, fault: 'timeout' });
    const retry = await x402o.payFlow({ url, account, client, reuseHeaders: r.signedHeaders, paymentId: r.paymentId });
    const tx1 = await http.get(`/x402/payment/${r.paymentId}`);
    rec('T12 timeout → PENDING, uskladitev brez 2. oddaje', '402→200', `${r.status}→${retry.status}`,
      r.status === 402 && retry.status === 200 && tx1.status === 200 && !!tx1.data.txHash,
      'zahteva X402_MOCK_FAULTS=true');
  }
  // T13: izgubljen odgovor → ponovitev vrne PREDPOMNJEN odgovor (isto telo)
  {
    const a = await x402o.payFlow({ url: url + '?prompt=izgubljeni-odgovor', account, client });
    const b = await x402o.payFlow({ url: url + '?prompt=izgubljeni-odgovor', account, client, reuseHeaders: a.signedHeaders, paymentId: a.paymentId });
    const bodyA = await a.res.text(); const bodyB = await b.res.text();
    rec('T13 izgubljen odgovor → isto telo iz predpomnilnika', 'enako', bodyA === bodyB ? 'enako' : 'razlicno',
      a.status === 200 && b.status === 200 && b.replayed && bodyA === bodyB);
  }
  // T14: pokvarjen JSON na POST poti → 400, ne 500 (obvoz: /verify-payment je domača pot)
  {
    const r = await fetch(`${MERCHANT_URL}/verify-payment`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{pokvarjen' });
    rec('T14 pokvarjen JSON → 4xx (ne 500)', '400', r.status, r.status === 400);
  }

  const okAll = results.filter((r) => r.ok).length;
  banner(`REZULTAT x402 VARNOSTNIH TESTOV · ${okAll}/${results.length} uspešnih`);
  const csvOut = path.join(__dirname, '..', 'meritve', `varnostni_testi_x402_${MODE}.csv`);
  fs.mkdirSync(path.dirname(csvOut), { recursive: true });
  fs.writeFileSync(csvOut, 'test,pricakovano,dejansko,uspeh,opomba\n' +
    results.map((r) => [JSON.stringify(r.ime), r.pricakovano, r.dejansko, r.ok ? 1 : 0, JSON.stringify(r.opomba)].join(',')).join('\n') + '\n');
  console.log(`  CSV: ${path.relative(process.cwd(), csvOut)}`);
  if (okAll !== results.length) process.exitCode = 1;
}

// ── SECURITY / FAILURE SUITE ───────────────────────────────────────────────
// Each test crafts an invalid or replayed artifact and asserts the server
// rejects it. Real-only tests are skipped (and clearly reported) in mock mode.
async function runSecurity() {
  banner(`VARNOSTNI IN ODPOVEDNI TESTI · način=${MODE.toUpperCase()} · streznik=${MERCHANT_URL}`);
  const results = [];
  const rec = (ime, pricakovano, dejansko, ok, opomba = '') => {
    results.push({ ime, pricakovano, dejansko, ok, opomba });
    console.log(`  ${ok ? '✓' : '✗'} ${ime.padEnd(42)} pričakovano=${String(pricakovano).padEnd(18)} dejansko=${dejansko} ${opomba}`);
  };

  // T1 — access without payment must be 402
  let r = await http.get(ENDPOINT);
  rec('Dostop brez plačila', 402, r.status, r.status === 402);

  // T2 — malformed txHash must be 400
  const ch = await http.get(ENDPOINT, { headers: { 'X-Payer': ethers.Wallet.createRandom().address } });
  const reqId = ch.data.payment.requestId;
  r = await http.post('/verify-payment', { requestId: reqId, txHash: '0xdeadbeef', network: NETWORK, payerAddress: ethers.Wallet.createRandom().address });
  rec('Napačen format txHash', 400, r.status, r.status === 400);

  // T3 — unknown requestId must be 400
  r = await http.post('/verify-payment', { requestId: '00000000-0000-4000-8000-000000000000', txHash: '0x' + 'ab'.repeat(32), network: NETWORK, payerAddress: ethers.Wallet.createRandom().address });
  rec('Neobstoječ requestId', 400, r.status, r.status === 400);

  // T4 — invalid proof token on POST /service must be 403
  r = await http.post(ENDPOINT, { prompt: 'x' }, { headers: { 'X-Payment': 'proof_ponaredek' } });
  rec('Ponarejen dokazni žeton', 403, r.status, r.status === 403);

  if (MODE === 'mock') {
    // In mock the server fabricates the tx from the request, so we CAN exercise
    // replay + reused-proof + resource-binding without a real chain.
    const payer = ethers.Wallet.createRandom().address;
    const c1 = await http.get(ENDPOINT, { headers: { 'X-Payer': payer } });
    const rid = c1.data.payment.requestId;
    const txh = '0x' + Buffer.from(ethers.randomBytes(32)).toString('hex');
    const v1 = await http.post('/verify-payment', { requestId: rid, txHash: txh, network: NETWORK, payerAddress: payer });
    const proof = v1.data.proofToken;

    // T5 — replay same txHash (new request) must be 400 "already redeemed"
    const c2 = await http.get(ENDPOINT, { headers: { 'X-Payer': payer } });
    const v2 = await http.post('/verify-payment', { requestId: c2.data.payment.requestId, txHash: txh, network: NETWORK, payerAddress: payer });
    rec('Ponovitev txHash (replay)', 400, v2.status, v2.status === 400, v2.data?.error || '');

    // T6 — consume proof once (200), then reuse must be 403
    const a1 = await http.post(ENDPOINT, { prompt: 'ok' }, { headers: { 'X-Payment': proof } });
    const a2 = await http.post(ENDPOINT, { prompt: 'spet' }, { headers: { 'X-Payment': proof } });
    rec('Prva poraba žetona', 200, a1.status, a1.status === 200);
    rec('Ponovna poraba žetona', 403, a2.status, a2.status === 403);
  } else {
    rec('Napačen prejemnik', 400, 'preskočeno', true, '(real: pošlji tx na napačen naslov)');
    rec('Prenizek znesek', 400, 'preskočeno', true, '(real: pošlji manj kot cena)');
    rec('Neujemanje plačnika', 400, 'preskočeno', true, '(real: plačaj z druge denarnice)');
  }

  const passed = results.filter(x => x.ok).length;
  banner(`REZULTAT VARNOSTNIH TESTOV · ${passed}/${results.length} uspešnih`);
  const out = path.join(__dirname, '..', 'meritve', `varnostni_testi_${MODE}.csv`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, 'test,pricakovano,dejansko,uspeh,opomba\n' +
    results.map(x => [JSON.stringify(x.ime), x.pricakovano, x.dejansko, x.ok ? 'da' : 'ne', JSON.stringify(x.opomba)].join(',')).join('\n') + '\n');
  console.log(`  CSV: ${path.relative(process.cwd(), out)}`);
}

// ── main ───────────────────────────────────────────────────────────────────
(async () => {
  try {
    // sanity: server reachable
    const h = await http.get('/health');
    if (h.status >= 500 && !SECURITY) console.warn('  ⚠ /health poroča degraded — nadaljujem (mock?)');
    if (X402 && SECURITY) await runX402Security();
    else if (X402) await runX402Measurement();
    else if (SECURITY) await runSecurity();
    else await runMeasurement();
  } catch (e) {
    console.error('Fatalna napaka:', e.message);
    console.error('Je strežnik zagnan?  cd ../streznik && npm start');
    process.exit(1);
  }
})();
