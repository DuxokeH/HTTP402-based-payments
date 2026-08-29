#!/usr/bin/env node
'use strict';

/**
 * ============================================================================
 *  MEASUREMENT CLIENT — MERGED ONE-TIME PAYMENTS  (folder 06_x402)
 * ============================================================================
 *
 *  Headless client for the MERGED 4-message one-time payment flow (see
 *  ../README.md). Same measurement harness as folder 01, but the verification
 *  and access exchanges are fused into ONE POST:
 *
 *  PHASES measured per run (wall clock, ms):
 *    t_challenge   GET /service            -> 402 challenge         (msg 1+2)
 *    t_submit      sign + broadcast tx     -> tx hash returned by RPC
 *    t_confirm     wait for confirmation   -> receipt (block, gas)   [chain]
 *    t_merged      POST /service {txHash + prompt}
 *                                          -> 200 + content + proof (msg 3+4)
 *    t_total       end-to-end wall clock
 *
 *  The measured flow sends NOTHING beyond these 4 messages. The proof-token
 *  acknowledgment (GET with X-Payment) is exercised only in the security
 *  suite (and by the browser client's button) — never automatically here.
 *
 *  MODES:
 *    --mock   no real chain. Uses server MOCK_VERIFY; t_potrditev = 0 and gas is
 *             left empty. Hundreds of repeatable runs of pure PROTOCOL latency.
 *    --real   real Sepolia transactions (needs a funded wallet.json). Gives the
 *             real confirmation time + real gas, and clean Wireshark captures.
 *
 *  USAGE:
 *    node measurement_client.js --mock --runs 50
 *    node measurement_client.js --real --runs 5 --pause-ms 1500
 *    node measurement_client.js --security          (failure / abuse test suite)
 *
 *  Code, comments, console output and CSV headers: English.
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
const MERCHANT_URL = process.env.MERCHANT_URL || cfg.MERCHANT_URL || 'http://127.0.0.1:3300';
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
const PROMPT = val('--prompt', 'Hello, world! This is a test prompt for the measurement.');
const X402 = has('--x402');   // parallel mode: official x402 v2 (Ethereum Sepolia, test ETH)
const OUT = val('--out', path.join(__dirname, '..', 'measurements',
  X402 ? `x402_zdruzena_${MODE}.csv` : `merged_${MODE}.csv`));
const SECURITY = has('--security');

const http = axios.create({ baseURL: MERCHANT_URL, timeout: 60_000, validateStatus: () => true });

// ── wallet (real mode) ─────────────────────────────────────────────────────
let wallet = null, provider = null;
function loadWallet() {
  const wf = path.join(__dirname, 'wallet.json');
  if (!fs.existsSync(wf)) { console.error('❌ wallet.json is missing. Create it (see wallet.example.json) or run: node generate-wallet.js'); process.exit(1); }
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
  'seq', 'timestamp_iso', 'mode',
  't_challenge_ms', 't_submit_ms', 't_confirm_ms', 't_merged_ms', 't_total_ms',
  'server_merged_ms', 'chain_read_ms', 'external_api_ms',
  'gas_units', 'gas_price_wei', 'fee_wei', 'fee_eth', 'block', 'tx_hash', 'status'
].join(',');

function ensureCsv(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, CSV_HEADER + '\n');
}
function appendCsv(file, row) { fs.appendFileSync(file, row.join(',') + '\n'); }

// ── x402 v2 (parallel mode) ────────────────────────────────────────────────
// Separate file and separate header: x402 measurements are NEVER mixed with the
// existing merged_*.csv. Amounts are in atomic units of the asset (test ETH:
// wei). `gas_payer=server`: the client only signs the authorization; the
// settlement transaction is submitted and paid for by the server.
const X402_CSV_HEADER = [
  'seq', 'timestamp_iso', 'mode', 'protocol', 'topology', 'network', 'asset', 'gas_payer',
  't_402_ms', 't_sign_ms', 't_payment_http_ms', 't_total_ms',
  'server_ms', 'verify_ms', 'settle_ms',
  'amount_atomic', 'decimals', 'payment_id', 'idempotency', 'tx_hash', 'synthetic_tx',
  'block', 'gas_units', 'gas_price_wei', 'status'
].join(',');
function ensureX402Csv(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, X402_CSV_HEADER + '\n');
}

// ── ONE full merged flow, fully instrumented ───────────────────────────────
async function oneRun(i) {
  const payer = MODE === 'real' ? wallet.address : ethers.Wallet.createRandom().address;
  const t = {}; const T0 = performance.now();

  // Phase 1 — 402 challenge (messages 1 + 2)
  banner(`RUN ${i} · PHASE 1/4 · 402 challenge (GET ${ENDPOINT})`);
  let s = performance.now();
  const chRes = await http.get(ENDPOINT, { headers: { 'X-Payer': payer } });
  t.izziv = performance.now() - s;
  if (chRes.status !== 402) throw new Error(`Expected 402, got ${chRes.status}`);
  const pay = chRes.data.payment;
  console.log(`  ✓ 402 · requestId=${pay.requestId} · amount=${pay.amount} ${pay.currency} · resource=${pay.resource} · server=${hdr(chRes, 'X-Server-Ms')} ms`);
  if (PAUSE_MS) await sleep(PAUSE_MS);

  // Phase 2 + 3 — broadcast + confirmation (off-HTTP)
  let txHash, blockNumber = 0, gasUsed = '', gasPriceWei = '', feeWei = '', feeEth = '';
  banner(`RUN ${i} · PHASE 2/4 · Broadcasting the transaction on ${NETWORK}`);
  if (MODE === 'real') {
    s = performance.now();
    const tx = await wallet.sendTransaction({ to: pay.to, value: ethers.parseEther(String(pay.amount)) });
    t.oddaja = performance.now() - s;
    txHash = tx.hash;
    console.log(`  ✓ broadcast · tx=${txHash}\n    https://sepolia.etherscan.io/tx/${txHash}`);
    banner(`RUN ${i} · PHASE 3/4 · Waiting for confirmation (${CONFIRMATIONS} block)`);
    s = performance.now();
    const rc = await tx.wait(CONFIRMATIONS);
    t.potrditev = performance.now() - s;
    blockNumber = rc.blockNumber;
    gasUsed = rc.gasUsed.toString();
    const gp = rc.gasPrice ?? (tx.gasPrice ?? null);
    if (gp) { gasPriceWei = gp.toString(); const fee = rc.gasUsed * gp; feeWei = fee.toString(); feeEth = ethers.formatEther(fee); }
    console.log(`  ✓ confirmed · block=${blockNumber} · gas=${gasUsed} · fee=${feeEth} ETH`);
  } else {
    // MOCK: measure only local signing of a dummy legacy tx (no broadcast),
    // no confirmation. t_submit here reflects local signing cost only.
    s = performance.now();
    const dummy = ethers.Wallet.createRandom();
    await dummy.signTransaction({ to: pay.to, value: ethers.parseEther(String(pay.amount)), chainId: 11155111, nonce: 0, gasLimit: 21000n, gasPrice: 1000000000n });
    t.oddaja = performance.now() - s;
    t.potrditev = 0; // no chain in mock — excluded from protocol-only latency
    txHash = '0x' + Buffer.from(ethers.randomBytes(32)).toString('hex');
    console.log(`  ✓ (mock) local signing · t_submit=${num(t.oddaja)} ms · confirmation skipped`);
  }
  if (PAUSE_MS) await sleep(PAUSE_MS);

  // Phase 4 — THE MERGED EXCHANGE (messages 3 + 4): payment proof + order in,
  // content + proof token out. This replaces folder 01's phases 4 AND 5.
  banner(`RUN ${i} · PHASE 4/4 · Merged exchange (POST ${ENDPOINT}: txHash + prompt)`);
  s = performance.now();
  const zdRes = await http.post(ENDPOINT, { requestId: pay.requestId, txHash, network: NETWORK, payerAddress: payer, prompt: PROMPT });
  t.zdruzeno = performance.now() - s;
  if (zdRes.status !== 200) throw new Error(`merged exchange ${zdRes.status}: ${JSON.stringify(zdRes.data)}`);
  const proofToken = zdRes.data.proofToken;
  console.log(`  ✓ 200 OK · content + proof token=${proofToken} · server=${hdr(zdRes, 'X-Server-Ms')} ms · chain=${hdr(zdRes, 'X-Chain-Read-Ms')} ms · external_api=${hdr(zdRes, 'X-Downstream-Ms')} ms`);

  t.skupaj = performance.now() - T0;

  const row = [
    i, nowIso(), MODE,
    num(t.izziv), num(t.oddaja), num(t.potrditev), num(t.zdruzeno), num(t.skupaj),
    num(hdr(zdRes, 'X-Server-Ms')), num(hdr(zdRes, 'X-Chain-Read-Ms')), num(hdr(zdRes, 'X-Downstream-Ms')),
    gasUsed, gasPriceWei, feeWei, feeEth, blockNumber, txHash, zdRes.status
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
  banner(`MERGED PAYMENT MEASUREMENT (4 messages) · mode=${MODE.toUpperCase()} · runs=${RUNS} · server=${MERCHANT_URL}`);
  if (MODE === 'real') {
    const bal = await provider.getBalance(wallet.address);
    console.log(`  Payer wallet: ${wallet.address}  ·  balance: ${ethers.formatEther(bal)} ETH`);
  }

  const collected = { izziv: [], oddaja: [], potrditev: [], zdruzeno: [], skupaj: [] };
  let ok = 0; const fees = [];
  for (let i = 1; i <= RUNS; i++) {
    try {
      const { t, row, feeEth } = await oneRun(i);
      appendCsv(OUT, row);
      for (const k of Object.keys(collected)) collected[k].push(t[k]);
      if (feeEth) fees.push(parseFloat(feeEth));
      ok++;
    } catch (e) {
      console.error(`  ✗ RUN ${i} error: ${e.message}`);
    }
    if (PAUSE_MS) await sleep(PAUSE_MS);
  }

  banner(`SUMMARY · succeeded ${ok}/${RUNS} · CSV: ${path.relative(process.cwd(), OUT)}`);
  const label = { izziv: 't_challenge (402)', oddaja: 't_submit', potrditev: 't_confirm', zdruzeno: 't_merged (proof+delivery)', skupaj: 't_total' };
  console.log('  phase'.padEnd(30) + 'n    min      median   mean     p95      max   [ms]');
  for (const k of Object.keys(collected)) {
    const st = stats(collected[k]); if (!st) continue;
    console.log('  ' + label[k].padEnd(28) + `${String(st.n).padEnd(5)}${num(st.min).padEnd(9)}${num(st.median).padEnd(9)}${num(st.mean).padEnd(9)}${num(st.p95).padEnd(9)}${num(st.max)}`);
  }
  if (fees.length) {
    const f = stats(fees);
    console.log(`\n  fee/tx (ETH): median=${f.median} · mean=${f.mean} · min=${f.min} · max=${f.max}  (n=${f.n})`);
  }
  // JSON summary next to the CSV
  const jsonOut = OUT.replace(/\.csv$/, '_summary.json');
  const summary = { mode: MODE, potek: 'merged-4-messages', ponovitev: RUNS, succeeded: ok, server: MERCHANT_URL, faze: {} };
  for (const k of Object.keys(collected)) summary.faze[k] = stats(collected[k]);
  if (fees.length) summary.fee_eth = stats(fees);
  fs.writeFileSync(jsonOut, JSON.stringify(summary, null, 2));
  console.log(`\n  Summary JSON: ${path.relative(process.cwd(), jsonOut)}`);
}

// ── x402 v2: MEASUREMENT ───────────────────────────────────────────────────
// Phases: t_402 (challenge) · t_sign (EIP-3009 authorization) · t_payment_http
// (the paid request: verify + settle + resource). The server breaks its own side
// down in the X-Verify-Ms / X-Settle-Ms / X-Server-Ms headers. In a real run the
// gas/block is added by a GET /x402/payment/:id query AFTER the measurement has
// finished (so it does not disturb the phases).
const x402o = X402 ? require('./x402-client') : null;

function loadX402Payer() {
  const wf = path.join(__dirname, 'wallet.json');
  const wd = fs.existsSync(wf) ? JSON.parse(fs.readFileSync(wf, 'utf8')) : {};
  if (MODE === 'real' && !wd.x402PayerPrivateKey) {
    console.error('❌ For --x402 --real, set x402PayerPrivateKey in wallet.json (a real x402 run requires a token with EIP-3009 — the test-ETH configuration only runs in mock)');
    process.exit(1);
  }
  return x402o.makePayer({ privateKey: MODE === 'real' ? wd.x402PayerPrivateKey : undefined });
}

async function x402Cfg() {
  const r = await http.get('/x402/config');
  if (r.status !== 200 || !r.data || r.data.mode === 'off') {
    console.error('❌ The server does not have x402 mode enabled. Start it with X402_MODE=self (and X402_MOCK=true for mock).');
    process.exit(1);
  }
  return r.data;
}

async function runX402Measurement() {
  const cfgX = await x402Cfg();
  const account = loadX402Payer();
  const client = x402o.makeClient(account);
  ensureX402Csv(OUT);
  banner(`x402 v2 MEASUREMENT (exact · ${cfgX.network} · ${cfgX.assetName}) · mode=${MODE.toUpperCase()} · runs=${RUNS}`);
  console.log(`  Payer (authorization signer): ${account.address} · recipient: ${cfgX.payTo}`);
  console.log(`  Price: ${cfgX.priceAtomic} atomic units (${(parseInt(cfgX.priceAtomic, 10) / 10 ** cfgX.assetDecimals).toFixed(cfgX.assetDecimals)} ${cfgX.assetName}) · gas paid by: server`);
  if (cfgX.mock) console.log('  ⚠ MOCK: settlements are synthetic (tx hash with the 0x6d6f636b6d6f636b prefix) — NOT real measurements.');

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
      if (r.status !== 200) throw new Error(`payment ${r.status}: ${JSON.stringify(await r.res.text().catch(() => ''))}`);
      // gas/block from the server's records (after the measurement, does not affect the phases)
      let block = '', gasUnits = '', gasPriceWei = '';
      const pv = await http.get(`/x402/payment/${r.paymentId}`);
      if (pv.status === 200) { block = pv.data.block ?? ''; gasUnits = pv.data.gasUnits ?? ''; gasPriceWei = pv.data.gasPriceWei ?? ''; }
      appendCsv(OUT, [
        i, nowIso(), MODE, 'x402-self', 'direct', cfgX.network, cfgX.assetName, 'server',
        num(r.t.t402), num(r.t.tPodpis), num(r.t.tPoravnavaHttp), num(skupaj),
        num(r.serverMs), num(r.verifyMs), num(r.settleMs),
        cfgX.priceAtomic, cfgX.assetDecimals, r.paymentId, r.replayed ? 'predvajanje' : 'novo',
        r.paymentResponse ? r.paymentResponse.txHash : '', r.synthetic ? 1 : 0,
        block, gasUnits, gasPriceWei, r.status
      ]);
      collected.t402.push(r.t.t402); collected.podpis.push(r.t.tPodpis);
      collected.placilo.push(r.t.tPoravnavaHttp); collected.skupaj.push(skupaj);
      console.log(`  ✓ ${String(i).padStart(3)} · t_402=${num(r.t.t402)} ms · t_sign=${num(r.t.tPodpis)} ms · t_payment=${num(r.t.tPoravnavaHttp)} ms · tx=${r.paymentResponse ? String(r.paymentResponse.txHash).slice(0, 18) : '—'}…${r.synthetic ? ' (synthetic)' : ''}`);
      ok++;
    } catch (e) {
      console.error(`  ✗ RUN ${i} error: ${e.message}`);
    }
    if (PAUSE_MS) await sleep(PAUSE_MS);
  }

  banner(`x402 SUMMARY · succeeded ${ok}/${RUNS} · CSV: ${path.relative(process.cwd(), OUT)}`);
  const label = { t402: 't_402 (challenge)', podpis: 't_sign (EIP-3009)', placilo: 't_payment (verify+settle+res)', skupaj: 't_total' };
  console.log('  phase'.padEnd(32) + 'n    min      median   mean     p95      max   [ms]');
  for (const k of Object.keys(collected)) {
    const st = stats(collected[k]); if (!st) continue;
    console.log('  ' + label[k].padEnd(30) + `${String(st.n).padEnd(5)}${num(st.min).padEnd(9)}${num(st.median).padEnd(9)}${num(st.mean).padEnd(9)}${num(st.p95).padEnd(9)}${num(st.max)}`);
  }
  console.log('\n  ⚠ Note for the analysis: both flows now run on the SAME network (Ethereum Sepolia)');
  console.log('    and in the SAME denomination (ETH). The remaining differences: the protocol, the kind of');
  console.log('    transaction (an EIP-3009 authorization with a synthetic settlement in the test ≠ a real ETH');
  console.log('    transfer) AND the gas payer (server ≠ client). Do NOT attribute the differences to the x402');
  console.log('    protocol alone.');
  const jsonOut = OUT.replace(/\.csv$/, '_summary.json');
  const summary = { mode: MODE, protocol: 'x402-self', network: cfgX.network, asset: cfgX.assetName, gas_payer: 'server', ponovitev: RUNS, succeeded: ok, faze: {} };
  for (const k of Object.keys(collected)) summary.faze[k] = stats(collected[k]);
  fs.writeFileSync(jsonOut, JSON.stringify(summary, null, 2));
  console.log(`  Summary JSON: ${path.relative(process.cwd(), jsonOut)}`);
}

// ── x402 v2: SECURITY TESTS ────────────────────────────────────────────────
async function runX402Security() {
  const cfgX = await x402Cfg();
  if (MODE === 'real') { console.error('  The x402 security tests are for mock mode (a server with X402_MOCK=true).'); process.exit(1); }
  const account = loadX402Payer();
  const client = x402o.makeClient(account);
  const url = `${MERCHANT_URL}/x402/service`;
  banner(`x402 SECURITY AND FAILURE TESTS · server=${MERCHANT_URL}`);
  const results = [];
  const rec = (ime, expected, actual, ok, note = '') => {
    results.push({ ime, expected, actual, ok, note });
    console.log(`  ${ok ? '✓' : '✗'} ${ime.padEnd(44)} expected=${String(expected).padEnd(18)} actual=${String(actual).padEnd(9)} ${note}`);
  };

  // T1: no payment → 402 with the PAYMENT-REQUIRED header (x402 v2)
  {
    const r = await fetch(url);
    const pr = r.headers.get('PAYMENT-REQUIRED');
    const j = pr ? x402o.decodeB64Json(pr) : null;
    rec('T1 402 challenge + PAYMENT-REQUIRED (v2)', '402/v2', `${r.status}/${j ? 'v' + j.x402Version : 'none'}`,
      r.status === 402 && !!j && j.x402Version === 2);
  }
  // T2: valid payment → 200 + PAYMENT-RESPONSE (+ a synthetic hash in mock)
  let prvi;
  {
    prvi = await x402o.payFlow({ url, account, client });
    rec('T2 valid payment', 200, prvi.status, prvi.status === 200 && !!prvi.paymentResponse,
      prvi.synthetic ? 'synthetic tx (mock)' : '');
  }
  // T3: repeat of the SAME signed payment → cached response, no new settlement
  {
    const r = await x402o.payFlow({ url, account, client, reuseHeaders: prvi.signedHeaders, paymentId: prvi.paymentId });
    rec('T3 repeat → idempotent replay', '200+replay', `${r.status}${r.replayed ? '+replay' : ''}`,
      r.status === 200 && r.replayed);
  }
  // T4: same payment-id, DIFFERENT signature → 409 conflict
  {
    const r = await x402o.payFlow({ url, account, client, paymentId: prvi.paymentId });
    rec('T4 same payment-id, other authorization', 409, r.status, r.status === 409);
  }
  // T5: wrong recipient (payTo tampered with after signing) → 402
  {
    const r = await x402o.payFlow({ url, account, client, mutateAuthorization: (a) => { a.to = '0x000000000000000000000000000000000000dEaD'; } });
    rec('T5 wrong recipient', 402, r.status, r.status === 402);
  }
  // T6: wrong amount (value tampered with after signing → the signature is void) → 402
  {
    const r = await x402o.payFlow({ url, account, client, mutateAuthorization: (a) => { a.value = '1'; } });
    rec('T6 tampered amount → invalid signature', 402, r.status, r.status === 402);
  }
  // T7: expired authorization (validBefore in the past, tampered with after signing) → 402
  {
    const r = await x402o.payFlow({ url, account, client, mutateAuthorization: (a) => { a.validBefore = '1000'; } });
    rec('T7 expired/tampered authorization', 402, r.status, r.status === 402);
  }
  // T8: a foreign signer impersonating the payer → 402
  {
    const vsiljivec = x402o.makePayer({});
    const clientV = x402o.makeClient(vsiljivec);
    const r = await x402o.payFlow({ url, account: vsiljivec, client: clientV, mutateAuthorization: (a) => { a.from = account.address; } });
    rec('T8 forged payer (foreign signature)', 402, r.status, r.status === 402);
  }
  // T9: concurrent duplicate — the SAME signed payment 5×: exactly one settlement
  {
    const sig = await x402o.payFlow({ url, account, client });   // fresh payment
    const stmt = await Promise.all(Array.from({ length: 5 }, () =>
      x402o.payFlow({ url, account, client, reuseHeaders: sig.signedHeaders, paymentId: sig.paymentId })));
    const okNum = stmt.filter((r) => r.status === 200).length;
    const hashes = new Set(stmt.filter((r) => r.paymentResponse && r.paymentResponse.txHash).map((r) => r.paymentResponse.txHash));
    if (sig.paymentResponse && sig.paymentResponse.txHash) hashes.add(sig.paymentResponse.txHash);
    rec('T9 concurrent duplicates → one settlement', '1 hash', `${hashes.size} hash`, hashes.size === 1, `${okNum}/5 → 200`);
  }
  // T10: an authorization for one resource does not unlock another (payment-id bound to the resource)
  {
    const r = await fetch(`${MERCHANT_URL}/x402/payment/ne-obstaja`, {});
    rec('T10 unknown payment → 404', 404, r.status, r.status === 404);
  }
  // T11: simulated settlement revert → 402, a repeat does NOT settle a second time
  {
    const r = await x402o.payFlow({ url, account, client, fault: 'revert' });
    const retry = r.status === 402 ? await x402o.payFlow({ url, account, client, reuseHeaders: r.signedHeaders, paymentId: r.paymentId }) : null;
    rec('T11 settlement revert → final failure', '402/402', `${r.status}/${retry ? retry.status : '—'}`,
      r.status === 402 && retry && retry.status === 402, 'requires X402_MOCK_FAULTS=true');
  }
  // T12: simulated RPC timeout → submitted-without-receipt; a repeat does NOT submit a second time,
  //      reconciliation (mock receipt) returns 200 with the SAME tx hash
  {
    const r = await x402o.payFlow({ url, account, client, fault: 'timeout' });
    const retry = await x402o.payFlow({ url, account, client, reuseHeaders: r.signedHeaders, paymentId: r.paymentId });
    const tx1 = await http.get(`/x402/payment/${r.paymentId}`);
    rec('T12 timeout → PENDING, reconcile without resend', '402→200', `${r.status}→${retry.status}`,
      r.status === 402 && retry.status === 200 && tx1.status === 200 && !!tx1.data.txHash,
      'requires X402_MOCK_FAULTS=true');
  }
  // T13: lost response → the repeat returns the CACHED response (same body)
  {
    const a = await x402o.payFlow({ url: url + '?prompt=lost-response', account, client });
    const b = await x402o.payFlow({ url: url + '?prompt=lost-response', account, client, reuseHeaders: a.signedHeaders, paymentId: a.paymentId });
    const bodyA = await a.res.text(); const bodyB = await b.res.text();
    rec('T13 lost response → same body from the cache', 'same', bodyA === bodyB ? 'same' : 'different',
      a.status === 200 && b.status === 200 && b.replayed && bodyA === bodyB);
  }
  // T14: malformed JSON on a POST path → 400, not 500 (local path: the merged /service)
  {
    const r = await fetch(`${MERCHANT_URL}/service`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{malformed' });
    rec('T14 malformed JSON → 4xx (not 500)', '400', r.status, r.status === 400);
  }

  const okAll = results.filter((r) => r.ok).length;
  banner(`x402 SECURITY TEST RESULT · ${okAll}/${results.length} passed`);
  const csvOut = path.join(__dirname, '..', 'measurements', `security_tests_x402_${MODE}.csv`);
  fs.mkdirSync(path.dirname(csvOut), { recursive: true });
  fs.writeFileSync(csvOut, 'test,expected,actual,passed,note\n' +
    results.map((r) => [JSON.stringify(r.ime), r.expected, r.actual, r.ok ? 1 : 0, JSON.stringify(r.note)].join(',')).join('\n') + '\n');
  console.log(`  CSV: ${path.relative(process.cwd(), csvOut)}`);
  if (okAll !== results.length) process.exitCode = 1;
}

// ── SECURITY / FAILURE SUITE ───────────────────────────────────────────────
// Each test crafts an invalid or replayed artifact and asserts the server
// rejects it. Targets the MERGED protocol: malformed claims go to POST /service
// (there is no /verify-payment). Real-only tests are skipped in mock mode.
async function runSecurity() {
  banner(`VARNOSTNI IN ODPOVEDNI TESTI · način=${MODE.toUpperCase()} · server=${MERCHANT_URL}`);
  const results = [];
  const rec = (ime, expected, actual, ok, note = '') => {
    results.push({ ime, expected, actual, ok, note });
    console.log(`  ${ok ? '✓' : '✗'} ${ime.padEnd(42)} pričakovano=${String(expected).padEnd(18)} actual=${actual} ${note}`);
  };

  // T1 — access without payment must be 402
  let r = await http.get(ENDPOINT);
  rec('Dostop brez plačila', 402, r.status, r.status === 402);

  // T2 — malformed txHash in the merged POST must be 400
  const ch = await http.get(ENDPOINT, { headers: { 'X-Payer': ethers.Wallet.createRandom().address } });
  const reqId = ch.data.payment.requestId;
  r = await http.post(ENDPOINT, { requestId: reqId, txHash: '0xdeadbeef', network: NETWORK, payerAddress: ethers.Wallet.createRandom().address, prompt: 'x' });
  rec('Napačen format txHash', 400, r.status, r.status === 400);

  // T3 — unknown requestId must be 400
  r = await http.post(ENDPOINT, { requestId: '00000000-0000-4000-8000-000000000000', txHash: '0x' + 'ab'.repeat(32), network: NETWORK, payerAddress: ethers.Wallet.createRandom().address, prompt: 'x' });
  rec('Neobstoječ requestId', 400, r.status, r.status === 400);

  // T4 — invalid proof token on POST /service (fallback path) must be 403
  r = await http.post(ENDPOINT, { prompt: 'x' }, { headers: { 'X-Payment': 'proof_ponaredek' } });
  rec('Ponarejen dokazni žeton', 403, r.status, r.status === 403);

  // T5 — invalid proof token on GET acknowledgment must be 403
  r = await http.get(ENDPOINT, { headers: { 'X-Payment': 'proof_ponaredek' } });
  rec('Ponarejeno dokazilo (GET)', 403, r.status, r.status === 403);

  // T6 — malformed JSON body must be 400, not 500
  r = await http.post(ENDPOINT, '{pokvarjen', { headers: { 'Content-Type': 'application/json' } });
  rec('Pokvarjen JSON', 400, r.status, r.status === 400);

  if (MODE === 'mock') {
    // In mock the server fabricates the tx from the request, so we CAN exercise
    // the merged flow + replay + acknowledgment without a real chain.
    const payer = ethers.Wallet.createRandom().address;
    const c1 = await http.get(ENDPOINT, { headers: { 'X-Payer': payer } });
    const rid = c1.data.payment.requestId;
    const txh = '0x' + Buffer.from(ethers.randomBytes(32)).toString('hex');
    const z1 = await http.post(ENDPOINT, { requestId: rid, txHash: txh, network: NETWORK, payerAddress: payer, prompt: 'ok' });
    const proof = z1.data.proofToken;

    // T7 — the merged exchange itself must be 200 with content AND proof
    rec('Združena izmenjava (200 + žeton)', 200, z1.status, z1.status === 200 && !!proof && !!z1.data.response);

    // T8 — replay same txHash (new request) must be 400 "already redeemed"
    const c2 = await http.get(ENDPOINT, { headers: { 'X-Payer': payer } });
    const z2 = await http.post(ENDPOINT, { requestId: c2.data.payment.requestId, txHash: txh, network: NETWORK, payerAddress: payer, prompt: 'spet' });
    rec('Ponovitev txHash (replay)', 400, z2.status, z2.status === 400, z2.data?.error || '');

    // T9 — acknowledgment GET with the earned proof must be 200 (consumed=true)
    const a1 = await http.get(ENDPOINT, { headers: { 'X-Payment': proof } });
    rec('Potrditev dokazila (GET)', 200, a1.status, a1.status === 200 && a1.data.authorized === true && a1.data.consumed === true);

    // T10 — re-redeeming the consumed proof via the fallback POST must be 403
    const a2 = await http.post(ENDPOINT, { prompt: 'spet' }, { headers: { 'X-Payment': proof } });
    rec('Ponovna poraba žetona', 403, a2.status, a2.status === 403);
  } else {
    rec('Napačen prejemnik', 400, 'preskočeno', true, '(real: pošlji tx na napačen naslov)');
    rec('Prenizek znesek', 400, 'preskočeno', true, '(real: pošlji manj kot cena)');
    rec('Neujemanje plačnika', 400, 'preskočeno', true, '(real: plačaj z druge denarnice)');
  }

  const passed = results.filter(x => x.ok).length;
  banner(`REZULTAT VARNOSTNIH TESTOV · ${passed}/${results.length} uspešnih`);
  const out = path.join(__dirname, '..', 'measurements', `security_tests_${MODE}.csv`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, 'test,expected,actual,passed,note\n' +
    results.map(x => [JSON.stringify(x.ime), x.expected, x.actual, x.ok ? 'da' : 'ne', JSON.stringify(x.note)].join(',')).join('\n') + '\n');
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
    console.error('Je strežnik zagnan?  cd ../server && npm start');
    process.exit(1);
  }
})();
