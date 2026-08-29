#!/usr/bin/env node
'use strict';

/**
 * ============================================================================
 *  AGENT (service consumer) — 20 queries = 20 on-chain transactions
 *  (folder 02_machine_payments_per_request)
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
 *  Code, comments, console output and CSV headers in English.
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
// The device is closed behind an admin login; the agent identifies itself with a
// machine token. Get the token on the device with:
//   grep TOKEN iot_device/data/admin-credentials.txt
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || cfg.ADMIN_TOKEN || '';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const MODE = has('--real') ? 'real' : 'mock';
const QUERIES = parseInt(val('--queries', '20'), 10);
const PAUSE_MS = parseInt(val('--pause-ms', MODE === 'real' ? '1000' : '0'), 10);
const X402 = has('--x402');   // NEW parallel mode: official x402 v2 (Ethereum Sepolia, ETH — testnet)
const SECURITY = has('--security');
const OUT = val('--out', path.join(__dirname, '..', 'measurements',
  X402 ? `x402_transakcije_${MODE}.csv` : `transactions_${MODE}.csv`));

const http = axios.create({ baseURL: IOT_URL, timeout: 90_000, validateStatus: () => true,
  headers: ADMIN_TOKEN ? { Authorization: `Bearer ${ADMIN_TOKEN}` } : {} });
const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const num = (x) => (x === null || x === undefined || Number.isNaN(x)) ? '' : (typeof x === 'number' ? x.toFixed(3) : String(x));
const hdr = (res, n) => { const v = res.headers[n.toLowerCase()]; return v !== undefined ? parseFloat(v) : ''; };

let wallet = null, provider = null;
function loadWallet() {
  const wf = path.join(__dirname, 'wallet.json');
  if (!fs.existsSync(wf)) { console.error('❌ wallet.json is missing (see wallet.example.json / generate-wallet.js).'); process.exit(1); }
  provider = new ethers.JsonRpcProvider(RPC_URL);
  wallet = new ethers.Wallet(JSON.parse(fs.readFileSync(wf, 'utf8')).privateKey, provider);
}

function banner(t) { const l = '─'.repeat(64); console.log(`\n┌${l}┐\n│ ${t.padEnd(62)} │\n└${l}┘`); }

const CSV_HEADER = [
  'query', 'timestamp_iso', 'mode',
  't_challenge_ms', 't_submit_ms', 't_confirm_ms', 't_verify_ms', 't_reading_ms', 't_total_ms',
  'gas_units', 'gas_price_wei', 'fee_wei', 'fee_eth', 'value_wei',
  'cumulative_fee_eth', 'temperature_c', 'humidity_pct', 'block', 'tx_hash'
].join(',');
function ensureCsv(f) { fs.mkdirSync(path.dirname(f), { recursive: true }); if (!fs.existsSync(f)) fs.writeFileSync(f, CSV_HEADER + '\n'); }

async function oneQuery(i, cumFeeEthRef) {
  const payer = MODE === 'real' ? wallet.address : ethers.Wallet.createRandom().address;
  const t = {}; const T0 = performance.now();

  // 402 challenge
  let s = performance.now();
  const ch = await http.get('/reading', { headers: { 'X-Payer': payer } });
  t.izziv = performance.now() - s;
  if (ch.status !== 402) throw new Error(`Expected 402, got ${ch.status}`);
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

  console.log(`  ✓ query ${String(i).padStart(2)} · T=${reading.temperature_c}°C RH=${reading.humidity_pct}% · t_total=${num(t.skupaj)} ms · gas=${gasUsed || '(mock)'} · cum.fee=${cumFeeEthRef.v ? cumFeeEthRef.v.toFixed(8) : '0'} ETH`);

  return [
    i, nowIso(), MODE,
    num(t.izziv), num(t.oddaja), num(t.potrditev), num(t.preverjanje), num(t.odcitek), num(t.skupaj),
    gasUsed, gasPriceWei, feeWei, feeEth, valueWei,
    cumFeeEthRef.v ? cumFeeEthRef.v.toFixed(18) : '', reading.temperature_c, reading.humidity_pct, block, txHash
  ];
}

// The device is closed behind an admin login — nothing works without a valid token.
function napakaPrijave(ukaz) {
  console.error(`
❌ The device rejected the login (401). The measurement agent needs a machine token.

   Find the token on the device (over SSH):
     grep TOKEN ${path.join('..', 'iot_device', 'data', 'admin-credentials.txt')}

   Then pass it to the agent:
     export ADMIN_TOKEN=<token>
     npm run ${ukaz}

   Or in a single line:
     ADMIN_TOKEN=$(grep '^TOKEN=' ../iot_device/data/admin-credentials.txt | cut -d= -f2) npm run ${ukaz}
`);
  process.exitCode = 1;
}

async function main() {
  if (MODE === 'real') loadWallet();
  banner(`MACHINE PAYMENTS · 1 TRANSACTION / QUERY · mode=${MODE.toUpperCase()} · N=${QUERIES} · device=${IOT_URL}`);
  const h = await http.get('/config');
  if (h.status === 401) { napakaPrijave(MODE === 'real' ? 'real' : 'mock'); return; }
  // Create the CSV only now: otherwise a failed login would leave a header-only
  // file, which the analysis would pick over the sample data and crash on an empty table.
  ensureCsv(OUT);
  if (h.status === 200) console.log(`  Price/reading: ${h.data.priceEth} ETH (≈ ${h.data.priceEurApprox} €) · recipient=${h.data.device}`);
  if (MODE === 'real') { const b = await provider.getBalance(wallet.address); console.log(`  Payer: ${wallet.address} · balance: ${ethers.formatEther(b)} ETH`); }

  const cum = { v: 0 };
  const totals = { skupaj: [], preverjanje: [], odcitek: [] };
  let ok = 0;
  for (let i = 1; i <= QUERIES; i++) {
    try { const row = await oneQuery(i, cum); fs.appendFileSync(OUT, row.join(',') + '\n'); ok++; }
    catch (e) { console.error(`  ✗ query ${i}: ${e.message}`); }
    if (PAUSE_MS) await sleep(PAUSE_MS);
  }

  banner(`SUMMARY · successful ${ok}/${QUERIES} · on-chain transactions: ${MODE === 'real' ? ok : '(mock)'} · CSV: ${path.relative(process.cwd(), OUT)}`);
  console.log(`  Total on-chain transactions paid for ${QUERIES} readings: ${MODE === 'real' ? ok : QUERIES} (= N)`);
  if (cum.v) console.log(`  Total fee (gas) for all transactions: ${cum.v.toFixed(8)} ETH  ← this amount grows linearly with N`);
  console.log('  → Compare with folder 03, where the same number of readings needs ONLY 1 transaction.');
}

// ══════════ x402 v2 (PARALLEL MODE) — N readings = N settlements ═══════════
// DELIBERATELY no batch settlement and no credit from folder 03: each reading
// is one x402 exact settlement (EIP-3009 authorization → the server settles (in
// test mode synthetically) and pays the gas). The Bearer token remains authentication.
const x402o = X402 ? require('./x402-client') : null;

const X402_CSV_HEADER = [
  'query', 'timestamp_iso', 'mode', 'protocol', 'topology', 'network', 'asset', 'gas_payer',
  't_402_ms', 't_sign_ms', 't_payment_http_ms', 't_total_ms',
  'server_ms', 'verify_ms', 'settle_ms',
  'amount_atomic', 'decimals', 'cumulative_atomic', 'payment_id', 'idempotency',
  'tx_hash', 'synthetic_tx', 'block', 'gas_units', 'gas_price_wei',
  'temperature_c', 'humidity_pct', 'status'
].join(',');

function loadX402Payer() {
  const wf = path.join(__dirname, 'wallet.json');
  const wd = fs.existsSync(wf) ? JSON.parse(fs.readFileSync(wf, 'utf8')) : {};
  if (MODE === 'real' && !wd.x402PayerPrivateKey) {
    console.error('❌ For --x402 --real set x402PayerPrivateKey in wallet.json (a real x402 run requires a token with EIP-3009 — the ETH testnet configuration runs mock only)');
    process.exit(1);
  }
  return x402o.makePayer({ privateKey: MODE === 'real' ? wd.x402PayerPrivateKey : undefined });
}

async function mainX402() {
  const cfgR = await http.get('/x402/config');
  if (cfgR.status === 401) { napakaPrijave(MODE === 'real' ? 'real' : 'mock'); return; }
  if (cfgR.status !== 200 || !cfgR.data || cfgR.data.mode === 'off') {
    console.error('❌ The device does not have x402 mode enabled (X402_MODE=self [+ X402_MOCK=true]).'); process.exit(1);
  }
  const cfgX = cfgR.data;
  const account = loadX402Payer();
  const client = x402o.makeClient(account);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  if (!fs.existsSync(OUT)) fs.writeFileSync(OUT, X402_CSV_HEADER + '\n');

  banner(`x402 MACHINE PAYMENTS · 1 SETTLEMENT / QUERY · mode=${MODE.toUpperCase()} · N=${QUERIES}`);
  console.log(`  Price/reading: ${cfgX.priceAtomic} atomic units of ${cfgX.assetName} · recipient=${cfgX.payTo} · gas paid by: device/server`);
  if (cfgX.mock) console.log('  ⚠ MOCK: settlements are synthetic (0x6d6f636b6d6f636b…) — NOT real measurements.');

  const totals = { skupaj: [] };
  let ok = 0; let cumulativeAtomic = 0n;
  const paymentIds = new Set(); const txHashes = new Set();
  for (let i = 1; i <= QUERIES; i++) {
    try {
      const T0 = performance.now();
      const r = await x402o.payFlow({
        url: `${IOT_URL}/x402/reading`, account, client,
        headers: ADMIN_TOKEN ? { Authorization: `Bearer ${ADMIN_TOKEN}` } : {}
      });
      const skupaj = performance.now() - T0;
      if (r.status !== 200) throw new Error(`payment ${r.status}`);
      const body = await r.res.json();
      const reading = body.reading || {};
      cumulativeAtomic += BigInt(cfgX.priceAtomic);
      paymentIds.add(r.paymentId);
      if (r.paymentResponse && r.paymentResponse.txHash) txHashes.add(r.paymentResponse.txHash);
      let block = '', gasUnits = '', gasPriceWei = '';
      const pv = await http.get(`/x402/payment/${r.paymentId}`);
      if (pv.status === 200) { block = pv.data.block ?? ''; gasUnits = pv.data.gasUnits ?? ''; gasPriceWei = pv.data.gasPriceWei ?? ''; }
      fs.appendFileSync(OUT, [
        i, nowIso(), MODE, 'x402-self', 'direct', cfgX.network, cfgX.assetName, 'server',
        num(r.t.t402), num(r.t.tPodpis), num(r.t.tPoravnavaHttp), num(skupaj),
        num(r.serverMs), num(r.verifyMs), num(r.settleMs),
        cfgX.priceAtomic, cfgX.assetDecimals, cumulativeAtomic.toString(), r.paymentId,
        r.replayed ? 'replay' : 'new',
        r.paymentResponse ? r.paymentResponse.txHash : '', r.synthetic ? 1 : 0,
        block, gasUnits, gasPriceWei,
        reading.temperature_c ?? '', reading.humidity_pct ?? '', r.status
      ].join(',') + '\n');
      totals.skupaj.push(skupaj);
      console.log(`  ✓ query ${String(i).padStart(2)} · T=${reading.temperature_c}°C RH=${reading.humidity_pct}% · t_total=${num(skupaj)} ms · settlement=${r.paymentResponse ? String(r.paymentResponse.txHash).slice(0, 18) + '…' : '—'}${r.synthetic ? ' (synthetic)' : ''}`);
      ok++;
    } catch (e) { console.error(`  ✗ query ${i}: ${e.message}`); }
    if (PAUSE_MS) await sleep(PAUSE_MS);
  }

  banner(`x402 SUMMARY · successful ${ok}/${QUERIES} · settlements: ${txHashes.size} · CSV: ${path.relative(process.cwd(), OUT)}`);
  console.log(`  ${QUERIES} readings = ${txHashes.size} separate x402 settlements (payment ids: ${paymentIds.size}) — NO batch settlement.`);
  console.log(`  Cumulative consumer payment: ${cumulativeAtomic} atomic units of ${cfgX.assetName}; the gas for all settlements is paid by the DEVICE.`);
  console.log('  → Compare with folder 03, where the same number of readings needs ONE top-up.');
  if (txHashes.size !== ok) { console.error(`  ✗ ERROR: readings ${ok} ≠ settlements ${txHashes.size}`); process.exitCode = 1; }
}

// ── x402 security tests (basic; the full set lives in folder 01) ────────────
async function securityX402() {
  const cfgR = await http.get('/x402/config');
  if (cfgR.status === 401) { napakaPrijave('mock'); return; }
  if (cfgR.status !== 200 || cfgR.data.mode === 'off' || !cfgR.data.mock) {
    console.error('❌ The tests require a device with X402_MODE=self X402_MOCK=true.'); process.exit(1);
  }
  const account = loadX402Payer();
  const client = x402o.makeClient(account);
  const url = `${IOT_URL}/x402/reading`;
  const H = ADMIN_TOKEN ? { Authorization: `Bearer ${ADMIN_TOKEN}` } : {};
  banner('x402 SECURITY TESTS (folder 02)');
  const results = [];
  const rec = (ime, pric, dej, ok, note = '') => { results.push({ ime, pric, dej, ok, note }); console.log(`  ${ok ? '✓' : '✗'} ${ime.padEnd(46)} expected=${String(pric).padEnd(12)} actual=${String(dej).padEnd(9)} ${note}`); };

  { // authentication stays separate from payment: without a Bearer token 401, DESPITE an x402 payment
    const r1 = await fetch(url);
    rec('T1 no login → 401 (authentication ≠ payment)', 401, r1.status, r1.status === 401);
  }
  { const r = await fetch(url, { headers: H }); rec('T2 with login, without payment → 402', 402, r.status, r.status === 402); }
  { const r = await x402o.payFlow({ url, account, client, headers: H }); rec('T3 valid payment → 200 + reading', 200, r.status, r.status === 200); }
  { // N=3 readings → 3 separate settlements (no batching)
    const hashes = new Set();
    for (let i = 0; i < 3; i++) { const r = await x402o.payFlow({ url, account, client, headers: H }); if (r.paymentResponse) hashes.add(r.paymentResponse.txHash); }
    rec('T4 3 readings → 3 separate settlements', 3, hashes.size, hashes.size === 3);
  }
  { // repeating the same payment → replay, no new settlement
    const a = await x402o.payFlow({ url, account, client, headers: H });
    const b = await x402o.payFlow({ url, account, client, headers: H, reuseHeaders: a.signedHeaders, paymentId: a.paymentId });
    rec('T5 repeat → replay, same settlement', 'replay', b.replayed ? 'replay' : b.status, b.status === 200 && b.replayed);
  }
  { const r = await fetch(`${IOT_URL}/verify-payment`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: '{broken' }); rec('T6 malformed JSON → 400 (not 500)', 400, r.status, r.status === 400); }

  const okAll = results.filter((r) => r.ok).length;
  banner(`RESULT · ${okAll}/${results.length} passed`);
  const csvOut = path.join(__dirname, '..', 'measurements', 'security_tests_x402_mock.csv');
  fs.mkdirSync(path.dirname(csvOut), { recursive: true });
  fs.writeFileSync(csvOut, 'test,expected,actual,passed,note\n' +
    results.map((r) => [JSON.stringify(r.ime), r.pric, r.dej, r.ok ? 1 : 0, JSON.stringify(r.note)].join(',')).join('\n') + '\n');
  console.log(`  CSV: ${path.relative(process.cwd(), csvOut)}`);
  if (okAll !== results.length) process.exitCode = 1;
}

(async () => {
  try {
    const hc = await http.get('/health'); if (hc.status >= 500) console.warn('  ⚠ /health degraded — continuing');
    if (X402 && SECURITY) await securityX402();
    else if (X402) await mainX402();
    else await main();
  }
  catch (e) { console.error('Fatal error:', e.message, '\nIs the IoT device running?  cd ../iot_device && npm start'); process.exit(1); }
})();
