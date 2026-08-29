#!/usr/bin/env node
'use strict';

/**
 * ============================================================================
 *  AGENT (service consumer) — METERED PREPAID SESSION
 *  (folder 03_machine_payments_prepaid)
 * ============================================================================
 *
 *  ONE on-chain top-up opens a prepaid session; then N readings are each paid
 *  with a local EIP-191 signature (no new transaction). This is the efficient
 *  counterpart of folder 02: the metered prepaid-session model.
 *
 *  Per debit it records: t_sign (client signing) + t_request (round trip) +
 *  server time, the charged price, remaining credit and remaining budget.
 *
 *  USAGE:
 *    node agent.js --mock --debits 20
 *    node agent.js --real --debits 20 --topup-wei 2500000000000 --pause-ms 200
 *    node agent.js --security          (failure / abuse suite)
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
const IOT_URL = process.env.IOT_URL || cfg.IOT_URL || 'http://127.0.0.1:3200';
const NETWORK = process.env.NETWORK || cfg.NETWORK || 'sepolia';
const RPC_URL = process.env.RPC_URL || cfg.RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';
const CONFIRMATIONS = parseInt(process.env.CONFIRMATIONS || cfg.CONFIRMATIONS || '1', 10);
// The device is locked down with an admin login; the agent identifies itself with
// a machine token. Obtain it on the device with:  grep TOKEN iot_device/data/admin-credentials.txt
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || cfg.ADMIN_TOKEN || '';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const MODE = has('--real') ? 'real' : 'mock';
const DEBITS = parseInt(val('--debits', '20'), 10);
const PAUSE_MS = parseInt(val('--pause-ms', '0'), 10);
const TOPUP_WEI = val('--topup-wei', '2500000000000');       // real-mode top-up value
const SECURITY = has('--security');
const X402 = has('--x402');   // NEW parallel mode: x402 top-up + local v2 debits
const OUT = val('--out', path.join(__dirname, '..', 'measurements',
  X402 ? `x402_dobroimetje_${MODE}.csv` : `credit_${MODE}.csv`));

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
    if (!fs.existsSync(wf)) { console.error('❌ wallet.json is missing (see wallet.example.json / generate-wallet.js).'); process.exit(1); }
    provider = new ethers.JsonRpcProvider(RPC_URL);
    return new ethers.Wallet(JSON.parse(fs.readFileSync(wf, 'utf8')).privateKey, provider);
  }
  // mock: signing needs a key but no funds — an ephemeral wallet is fine.
  return ethers.Wallet.createRandom();
}

const CSV_HEADER = [
  'event', 'timestamp_iso', 'mode', 'kind',
  't_sign_ms', 't_request_ms', 'server_ms', 't_total_ms',
  'price_wei', 'credit_wei', 'budget_remaining_wei',
  'gas_units', 'fee_eth', 'temperature_c', 'humidity_pct', 'nonce', 'session'
].join(',');
function ensureCsv(f) { fs.mkdirSync(path.dirname(f), { recursive: true }); if (!fs.existsSync(f)) fs.writeFileSync(f, CSV_HEADER + '\n'); }

// ── open a session (one on-chain top-up) ────────────────────────────────────
async function openSession(cfgData, { budgetWei, ttlSeconds, mockDepositWei } = {}) {
  banner(`PHASE A · Top-up (1 on-chain transaction) → open session`);
  let txHash, gasUsed = '', feeEth = '', tReq;
  const body = { payerAddress: wallet.address };
  if (budgetWei) body.budgetWei = String(budgetWei);
  if (ttlSeconds) body.ttlSeconds = ttlSeconds;

  if (MODE === 'real') {
    const tx = await wallet.sendTransaction({ to: cfgData.device, value: BigInt(TOPUP_WEI) });
    console.log(`  ✓ top-up submitted · tx=${tx.hash}`);
    const rc = await tx.wait(CONFIRMATIONS);
    gasUsed = rc.gasUsed.toString();
    const gp = rc.gasPrice ?? tx.gasPrice ?? null;
    if (gp) feeEth = ethers.formatEther(rc.gasUsed * gp);
    txHash = tx.hash;
    console.log(`  ✓ confirmed · block=${rc.blockNumber} · gas=${gasUsed} · fee=${feeEth} ETH`);
  } else {
    txHash = '0x' + Buffer.from(ethers.randomBytes(32)).toString('hex');
    if (mockDepositWei) body.mockDepositWei = String(mockDepositWei);
  }

  const t0 = performance.now();
  const r = await http.post('/session/open', { txHash, network: NETWORK, ...body });
  tReq = performance.now() - t0;
  if (r.status !== 200) throw new Error(`session/open ${r.status}: ${JSON.stringify(r.data)}`);
  const session = r.data.session;
  console.log(`  ✓ session=${session.sessionId}\n    credit=${session.depositWei} wei · budget=${session.budgetWei} wei · valid until=${session.expiresAt}`);
  return { session, topupRow: [
    'topup', nowIso(), MODE, 'topup', '', num(tReq), num(parseFloat(hdr(r, 'X-Server-Ms')) || 0), num(tReq),
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
  console.log(`  ✓ debit ${String(i).padStart(2)} · T=${reading.temperature_c}°C RH=${reading.humidity_pct}% · t_sign=${num(tPodpis)} ms · t_request=${num(tZahteva)} ms · price=${cena} wei · credit=${balance} wei`);
  return [
    `debit_${i}`, nowIso(), MODE, 'debit', num(tPodpis), num(tZahteva), num(parseFloat(hdr(r, 'X-Server-Ms')) || 0), num(tSkupaj),
    cena, balance, budgetLeft, '', '', reading.temperature_c, reading.humidity_pct, nonce, session.sessionId
  ];
}

// The device is locked down with an admin login — nothing works without a valid token.
function napakaPrijave(ukaz) {
  console.error(`
❌ The device rejected the login (401). The measurement agent needs a machine token.

   On the device (via SSH) find the token:
     grep TOKEN ${path.join('..', 'iot_device', 'data', 'admin-credentials.txt')}

   Then pass it to the agent:
     export ADMIN_TOKEN=<token>
     npm run ${ukaz}

   Or in one line:
     ADMIN_TOKEN=$(grep '^TOKEN=' ../iot_device/data/admin-credentials.txt | cut -d= -f2) npm run ${ukaz}
`);
  process.exitCode = 1;
}

async function main() {
  wallet = makeWallet();
  banner(`METERED SESSION · mode=${MODE.toUpperCase()} · N debits=${DEBITS} · device=${IOT_URL}`);
  const c = await http.get('/config');
  if (c.status === 401) { napakaPrijave(MODE === 'real' ? 'real' : 'mock'); return; }
  // Create the CSV only now: otherwise a failed login would leave a header-only
  // file, which the analysis would pick over the sample data and crash on the empty table.
  ensureCsv(OUT);
  const cfgData = c.data;
  console.log(`  Price/reading: ${cfgData.priceWeiPerCall} wei (+${cfgData.priceWeiPerByte}/byte) · payer=${wallet.address}`);
  const maxWei = (BigInt(cfgData.priceWeiPerCall) + BigInt(cfgData.priceWeiPerByte) * 4096n).toString();

  const { session, topupRow } = await openSession(cfgData);
  fs.appendFileSync(OUT, topupRow.join(',') + '\n');

  banner(`PHASE B · ${DEBITS} signed debits (no new transactions)`);
  const tPod = [], tZah = [];
  let ok = 0, cur = session;
  for (let i = 1; i <= DEBITS; i++) {
    try {
      const row = await oneDebit(i, cur, maxWei);
      fs.appendFileSync(OUT, row.join(',') + '\n');
      tPod.push(parseFloat(row[4])); tZah.push(parseFloat(row[5])); ok++;
    } catch (e) { console.error(`  ✗ debit ${i}: ${e.message}`); }
    if (PAUSE_MS) await sleep(PAUSE_MS);
  }

  const st = (a) => { a = a.filter(Number.isFinite).sort((x, y) => x - y); if (!a.length) return null; const q = p => a[Math.floor(p * (a.length - 1))]; return { n: a.length, min: a[0], median: q(0.5), mean: a.reduce((s, x) => s + x, 0) / a.length, p95: q(0.95), max: a[a.length - 1] }; };
  const final = (await http.get(`/session/${session.sessionId}`)).data.session;
  banner(`SUMMARY · ${ok}/${DEBITS} succeeded · on-chain transactions: 1 (top-up only) · CSV: ${path.relative(process.cwd(), OUT)}`);
  const sp = st(tPod), sz = st(tZah);
  if (sp) console.log(`  t_sign    (ms): median=${num(sp.median)} mean=${num(sp.mean)} p95=${num(sp.p95)} max=${num(sp.max)}`);
  if (sz) console.log(`  t_request (ms): median=${num(sz.median)} mean=${num(sz.mean)} p95=${num(sz.p95)} max=${num(sz.max)}`);
  console.log(`  Final session state: credit=${final.balanceWei} wei · spent=${final.spentWei} wei · budget remaining=${final.budgetRemainingWei} wei`);
  console.log(`  → ${DEBITS} readings required ONLY 1 on-chain transaction (compare with folder 02, which needs ${DEBITS}).`);

  const jsonOut = OUT.replace(/\.csv$/, '_summary.json');
  fs.writeFileSync(jsonOut, JSON.stringify({ mode: MODE, debit: DEBITS, succeeded: ok, session: final, t_sign_ms: sp, t_request_ms: sz }, null, 2));
  console.log(`  JSON summary: ${path.relative(process.cwd(), jsonOut)}`);
}

// ── SECURITY / FAILURE SUITE ────────────────────────────────────────────────
async function runSecurity() {
  wallet = makeWallet();
  banner(`SECURITY AND FAILURE TESTS (metered session) · mode=${MODE.toUpperCase()}`);
  if (MODE === 'real') { console.error('  The security tests are designed for --mock (they use a mock deposit for quick cases). Run: node agent.js --security'); process.exit(1); }
  const results = [];
  const rec = (ime, prc, dej, ok, op = '') => { results.push({ ime, prc, dej, ok, op }); console.log(`  ${ok ? '✓' : '✗'} ${ime.padEnd(44)} expected=${String(prc).padEnd(8)} actual=${String(dej).padEnd(8)} ${op}`); };
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
  rec('No signature (missing headers)', 402, r.status, r.status === 402);

  // T2 — valid debit -> 200
  let s = await open();
  const nonceA = mkNonce();
  r = await doDebit(s, { nonce: nonceA });
  rec('Valid debit', 200, r.status, r.status === 200);

  // T3 — replay same nonce -> 403
  r = await doDebit(s, { nonce: nonceA });
  rec('Nonce replay', 403, r.status, r.status === 403, r.data?.error || '');

  // T4 — forged signature (signed by a different wallet) -> 403
  const other = ethers.Wallet.createRandom();
  r = await doDebit(s, { signAs: other, claimPayer: wallet.address });
  rec('Forged signature (different wallet)', 403, r.status, r.status === 403, r.data?.error || '');

  // T5 — debit above signed maximum -> 400 (sign a max just below the min price)
  const tinyMax = (BigInt(c.minPriceWei) - 1n).toString();
  r = await doDebit(s, { mw: tinyMax });
  rec('Price above the signed maximum', 400, r.status, r.status === 400, r.data?.error || '');

  // T6 — stale nonce (timestamp far in the past) -> 400
  const staleNonce = `${Date.now() - (c.debitMaxAgeMs + 60000)}-deadbeef`;
  r = await doDebit(s, { nonce: staleNonce });
  rec('Stale nonce', 400, r.status, r.status === 400, r.data?.error || '');

  // T7 — budget exceeded: open session with budget = 2×price
  const sB = await open({ mockDepositWei: (price * 10n).toString(), budgetWei: (price * 2n).toString() });
  await doDebit(sB); await doDebit(sB);            // spend the 2-call budget
  r = await doDebit(sB);
  rec('Budget exceeded (budget=2×price)', 402, r.status, r.status === 402, r.data?.reason || '');

  // T8 — insufficient balance: deposit = 2×price, budget default = deposit
  const sC = await open({ mockDepositWei: (price * 2n).toString() });
  await doDebit(sC); await doDebit(sC);            // spend the whole deposit
  r = await doDebit(sC);
  rec('Insufficient credit (deposit=2×price)', 402, r.status, r.status === 402, r.data?.reason || '');

  // T9 — expired session (ttl = 1s), wait, then debit -> 403
  const sE = await open({ ttlSeconds: 1 });
  await sleep(1300);
  r = await doDebit(sE);
  rec('Expired session (validity window)', 403, r.status, r.status === 403, r.data?.error || '');

  const passed = results.filter(x => x.ok).length;
  banner(`RESULT · ${passed}/${results.length} passed`);
  const out = path.join(__dirname, '..', 'measurements', `security_tests_${MODE}.csv`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, 'test,expected,actual,passed,note\n' + results.map(x => [JSON.stringify(x.ime), x.prc, x.dej, x.ok ? 'yes' : 'no', JSON.stringify(x.op)].join(',')).join('\n') + '\n');
  console.log(`  CSV: ${path.relative(process.cwd(), out)}`);
}

// ══════════ x402 v2 (PARALLEL MODE) — C2: 1 x402 top-up + N local debits ════
// Phase A: ONE x402 exact settlement (ETH, Ethereum Sepolia; test — the
// settlement is synthetic/mock) opens the session. The client signs an EIP-3009
// authorization; the device submits the settlement transaction and IT pays the
// gas. Phase B: N debits with EIP-191 signatures (v2 message, atomic units) —
// NO further settlements on chain.
const x402o = X402 ? require('./x402-client') : null;

const X402_CSV_HEADER = [
  'event', 'timestamp_iso', 'mode', 'protocol', 'kind', 'network', 'asset', 'gas_payer',
  't_sign_ms', 't_request_ms', 'server_ms', 't_total_ms',
  'price_atomic', 'credit_atomic', 'budget_remaining_atomic', 'deposit_atomic',
  'verify_ms', 'settle_ms', 'payment_id', 'tx_hash', 'synthetic_tx',
  'block', 'gas_units', 'gas_price_wei',
  'temperature_c', 'humidity_pct', 'nonce', 'session', 'message_version'
].join(',');

function loadX402Payer() {
  const wf = path.join(__dirname, 'wallet.json');
  const wd = fs.existsSync(wf) ? JSON.parse(fs.readFileSync(wf, 'utf8')) : {};
  if (MODE === 'real' && !wd.x402PayerPrivateKey) {
    console.error('❌ For --x402 --real put x402PayerPrivateKey into wallet.json (test ETH configuration on Ethereum Sepolia — a real run requires a token with EIP-3009)');
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
    console.error('❌ The device does not have x402 mode enabled (X402_MODE=self [+ X402_MOCK=true]).'); process.exit(1);
  }
  const cfgX = cfgR.data;
  const account = loadX402Payer();
  const client = x402o.makeClient(account);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  if (!fs.existsSync(OUT)) fs.writeFileSync(OUT, X402_CSV_HEADER + '\n');

  banner(`x402 METERED SESSION · 1 TOP-UP + ${DEBITS} LOCAL DEBITS · mode=${MODE.toUpperCase()}`);
  console.log(`  Deposit: ${cfgX.sessionDepositAtomic} atomic units of ${cfgX.assetName} · price/reading: ${cfgX.priceAtomicPerCall} · top-up gas paid by: the device`);
  if (cfgX.mock) console.log('  ⚠ MOCK: the top-up settlement is synthetic (0x6d6f636b6d6f636b…) — NOT a real measurement.');

  // PHASE A — one x402 settlement opens the session
  banner('PHASE A · x402 top-up (1 settlement) → open session');
  const T0 = performance.now();
  const open = await x402o.payFlow({
    url: `${IOT_URL}/x402/session/open`, method: 'POST', account, client,
    headers: ADMIN_TOKEN ? { Authorization: `Bearer ${ADMIN_TOKEN}` } : {},
    body: {}
  });
  const tOpenSkupaj = performance.now() - T0;
  if (open.status !== 200) { console.error(`❌ top-up ${open.status}: ${await open.res.text().catch(() => '')}`); process.exit(1); }
  const openBody = await open.res.json();
  const session = openBody.session;
  const paymentIds = new Set([open.paymentId]);
  console.log(`  ✓ session=${session.sessionId} · deposit=${session.depositAtomic} atomic · tx=${open.paymentResponse ? open.paymentResponse.txHash : '—'}${open.synthetic ? ' (synthetic)' : ''}`);

  let block = '', gasUnits = '', gasPriceWei = '';
  { const pv = await http.get(`/x402/payment/${open.paymentId}`);
    if (pv.status === 200) { block = pv.data.block ?? ''; gasUnits = pv.data.gasUnits ?? ''; gasPriceWei = pv.data.gasPriceWei ?? ''; } }
  fs.appendFileSync(OUT, [
    'topup', nowIso(), MODE, 'x402-self', 'topup', cfgX.network, cfgX.assetName, 'server',
    num(open.t.tPodpis), num(open.t.tPoravnavaHttp), num(open.serverMs), num(tOpenSkupaj),
    '', session.depositAtomic, session.budgetAtomic, session.depositAtomic,
    num(open.verifyMs), num(open.settleMs), open.paymentId,
    open.paymentResponse ? open.paymentResponse.txHash : '', open.synthetic ? 1 : 0,
    block, gasUnits, gasPriceWei, '', '', '', session.sessionId, ''
  ].join(',') + '\n');

  // PHASE B — N local debits (NO settlements on chain)
  banner(`PHASE B · ${DEBITS} local debits (EIP-191, v2 message)`);
  const totals = { podpis: [], zahteva: [] };
  let ok = 0;
  for (let i = 1; i <= DEBITS; i++) {
    try {
      const { r, nonce, tPodpis, tZahteva } = await x402Debit({ account, cfgX, sessionId: session.sessionId, i });
      if (r.status !== 200) throw new Error(`${r.status}: ${JSON.stringify(r.data)}`);
      const reading = r.data.reading || {};
      fs.appendFileSync(OUT, [
        `debit_${i}`, nowIso(), MODE, 'x402-self', 'debit', cfgX.network, cfgX.assetName, '',
        num(tPodpis), num(tZahteva), hdr(r, 'X-Server-Ms'), num(tPodpis + tZahteva),
        hdr(r, 'X-Charged-Atomic'), hdr(r, 'X-Balance-Atomic'), hdr(r, 'X-Budget-Remaining-Atomic'), '',
        '', '', '', '', 0, '', '', '',
        reading.temperature_c ?? '', reading.humidity_pct ?? '', nonce, session.sessionId, 'metered-debit-v2'
      ].join(',') + '\n');
      totals.podpis.push(tPodpis); totals.zahteva.push(tZahteva);
      console.log(`  ✓ debit ${String(i).padStart(2)} · T=${reading.temperature_c}°C RH=${reading.humidity_pct}% · t_sign=${num(tPodpis)} ms · t_request=${num(tZahteva)} ms · credit=${hdr(r, 'X-Balance-Atomic')} atomic`);
      ok++;
    } catch (e) { console.error(`  ✗ debit ${i}: ${e.message}`); }
    if (PAUSE_MS) await sleep(PAUSE_MS);
  }

  banner(`x402 SUMMARY · ${ok}/${DEBITS} succeeded · on-chain settlements: 1 (top-up only) · CSV: ${path.relative(process.cwd(), OUT)}`);
  const st = (a) => { const b = a.filter(Number.isFinite).sort((x, y) => x - y); if (!b.length) return null; const q = (p) => b[Math.min(b.length - 1, Math.floor(p * (b.length - 1)))]; return { median: q(0.5), mean: b.reduce((s2, x) => s2 + x, 0) / b.length, max: b[b.length - 1] }; };
  const sp = st(totals.podpis), sz = st(totals.zahteva);
  if (sp) console.log(`  t_sign    (ms): median=${num(sp.median)} mean=${num(sp.mean)} max=${num(sp.max)}`);
  if (sz) console.log(`  t_request (ms): median=${num(sz.median)} mean=${num(sz.mean)} max=${num(sz.max)}`);
  const view = await http.get(`/x402/session/${session.sessionId}`);
  if (view.status === 200) {
    const v = view.data.session;
    console.log(`  Final state: credit=${v.balanceAtomic} atomic · spent=${v.spentAtomic} atomic · debits=${v.debitCount}`);
  }
  console.log(`  → ${DEBITS} readings required ${paymentIds.size} x402 settlement (the top-up) and 0 additional settlements.`);
  if (paymentIds.size !== 1) { console.error('  ✗ ERROR: exactly 1 settlement expected'); process.exitCode = 1; }
}

// ── x402 security tests (v2 message, format separation, limits) ─────────────
async function securityX402() {
  const cfgR = await http.get('/x402/config');
  if (cfgR.status === 401) { napakaPrijave(); return; }
  if (cfgR.status !== 200 || cfgR.data.mode === 'off' || !cfgR.data.mock) {
    console.error('❌ The tests require a device with X402_MODE=self X402_MOCK=true.'); process.exit(1);
  }
  const cfgX = cfgR.data;
  const account = loadX402Payer();
  const client = x402o.makeClient(account);
  const H = ADMIN_TOKEN ? { Authorization: `Bearer ${ADMIN_TOKEN}` } : {};
  banner('x402 SECURITY TESTS (folder 03 — session funding + local v2 metering)');
  const results = [];
  const rec = (ime, prc, dej, ok, op = '') => { results.push({ ime, prc, dej, ok, op }); console.log(`  ${ok ? '✓' : '✗'} ${ime.padEnd(46)} expected=${String(prc).padEnd(12)} actual=${String(dej).padEnd(9)} ${op}`); };

  // session via an x402 top-up
  const open = await x402o.payFlow({ url: `${IOT_URL}/x402/session/open`, method: 'POST', account, client, headers: H, body: {} });
  const session = open.status === 200 ? (await open.res.json()).session : null;
  rec('T1 x402 top-up opens a session', 200, open.status, open.status === 200 && !!session);
  if (!session) { process.exitCode = 1; return; }

  { // T2: 5 debits → 0 additional settlements (the x402_payments row count does not grow)
    for (let i = 0; i < 5; i++) { const { r } = await x402Debit({ account, cfgX, sessionId: session.sessionId, i }); if (r.status !== 200) { rec('T2 debit during the test', 200, r.status, false); break; } }
    const view = await http.get(`/x402/session/${session.sessionId}`);
    const n = view.status === 200 ? view.data.session.debitCount : -1;
    rec('T2 5 debits → 0 new settlements', '5 local', `${n} local`, n === 5);
  }
  { // T3: v1 message (maxWei) on the v2 path → rejected
    const nonce = mkNonce();
    const maxAtomic = cfgX.priceAtomicPerCall;
    const v1msg = `x402-debit:${account.address.toLowerCase()}:${session.sessionId}:${nonce}:${cfgX.meteredEndpoint}:${maxAtomic}`;
    const sig = await account.signMessage({ message: v1msg });
    const r = await http.get(cfgX.meteredEndpoint, { headers: { 'X-Payer': account.address, 'X-Session': session.sessionId, 'X-Nonce': nonce, 'X-Signature': sig, 'X-Max-Atomic': maxAtomic } });
    rec('T3 v1 signature on the v2 path → rejected', 403, r.status, r.status === 403);
  }
  { // T4: v2 signature with a DIFFERENT token (asset) → rejected
    const nonce = mkNonce();
    const maxAtomic = cfgX.priceAtomicPerCall;
    const msg = debitMessageV2(account.address, session.sessionId, nonce, cfgX.meteredEndpoint, maxAtomic, cfgX.network, '0x000000000000000000000000000000000000dEaD');
    const sig = await account.signMessage({ message: msg });
    const r = await http.get(cfgX.meteredEndpoint, { headers: { 'X-Payer': account.address, 'X-Session': session.sessionId, 'X-Nonce': nonce, 'X-Signature': sig, 'X-Max-Atomic': maxAtomic } });
    rec('T4 v2 signature for a different token → rejected', 403, r.status, r.status === 403);
  }
  { // T5: nonce replay → 403
    const d1 = await x402Debit({ account, cfgX, sessionId: session.sessionId, i: 0 });
    const r = await http.get(cfgX.meteredEndpoint, { headers: { 'X-Payer': account.address, 'X-Session': session.sessionId, 'X-Nonce': d1.nonce, 'X-Signature': (await account.signMessage({ message: debitMessageV2(account.address, session.sessionId, d1.nonce, cfgX.meteredEndpoint, cfgX.priceAtomicPerCall, cfgX.network, cfgX.asset) })), 'X-Max-Atomic': cfgX.priceAtomicPerCall } });
    rec('T5 nonce replay → 403', 403, r.status, r.status === 403);
  }
  { // T6: price above the signed maximum → 400
    const nonce = mkNonce();
    const low = '1';
    const msg = debitMessageV2(account.address, session.sessionId, nonce, cfgX.meteredEndpoint, low, cfgX.network, cfgX.asset);
    const sig = await account.signMessage({ message: msg });
    const r = await http.get(cfgX.meteredEndpoint, { headers: { 'X-Payer': account.address, 'X-Session': session.sessionId, 'X-Nonce': nonce, 'X-Signature': sig, 'X-Max-Atomic': low } });
    rec('T6 price above the maximum → 400', 400, r.status, r.status === 400);
  }
  { // T7: credit exhausted → 402 (deposit/price = 20 calls; 6 spent above)
    let last = null;
    for (let i = 0; i < 20; i++) { const { r } = await x402Debit({ account, cfgX, sessionId: session.sessionId, i }); last = r; if (r.status !== 200) break; }
    rec('T7 credit exhausted → 402', 402, last ? last.status : '—', !!last && last.status === 402, last && last.data && last.data.reason || '');
  }
  { // T8: replaying the SAME top-up → session replay, no new settlement
    const r = await x402o.payFlow({ url: `${IOT_URL}/x402/session/open`, method: 'POST', account, client, headers: H, body: {}, reuseHeaders: open.signedHeaders, paymentId: open.paymentId });
    const b = r.status === 200 ? await r.res.json() : null;
    rec('T8 top-up replay → the SAME session (replayed)', session.sessionId.slice(0, 14) + '…', b && b.session ? b.session.sessionId.slice(0, 14) + '…' : r.status, !!b && b.session && b.session.sessionId === session.sessionId && r.replayed);
  }
  { // T9: malformed JSON → 400 (err.status fix)
    const r = await http.post('/session/open', '{pokvarjen', { headers: { 'Content-Type': 'application/json' } });
    rec('T9 malformed JSON → 400 (not 500)', 400, r.status, r.status === 400);
  }

  const okAll = results.filter((x) => x.ok).length;
  banner(`RESULT · ${okAll}/${results.length} passed`);
  const csvOut = path.join(__dirname, '..', 'measurements', 'security_tests_x402_mock.csv');
  fs.mkdirSync(path.dirname(csvOut), { recursive: true });
  fs.writeFileSync(csvOut, 'test,expected,actual,passed,note\n' +
    results.map((x) => [JSON.stringify(x.ime), x.prc, x.dej, x.ok ? 1 : 0, JSON.stringify(x.op)].join(',')).join('\n') + '\n');
  console.log(`  CSV: ${path.relative(process.cwd(), csvOut)}`);
  if (okAll !== results.length) process.exitCode = 1;
}

(async () => {
  try {
    const hc = await http.get('/health'); if (hc.status >= 500) console.warn('  ⚠ /health degraded — continuing');
    if (X402 && SECURITY) await securityX402();
    else if (X402) await mainX402();
    else if (SECURITY) await runSecurity();
    else await main();
  }
  catch (e) { console.error('Fatal error:', e.message, '\nIs the IoT device running?  cd ../iot_device && npm start'); process.exit(1); }
})();
