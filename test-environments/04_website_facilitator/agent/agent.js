#!/usr/bin/env node
'use strict';

/**
 * ============================================================================
 *  MEASUREMENT AGENT — FACILITATOR BRANCH (topology (b))
 *  (folder 04_website_facilitator/agent)
 * ============================================================================
 *
 *  An external payer that walks the facilitator protocol under measurement. Because it
 *  runs as a SEPARATE process (not inside the server like `runner.js`), it also lets you
 *  prove that the merchant really does not need the chain: give the merchant a broken
 *  `RPC_URL` and the agent a working one — payments must still go through.
 *
 *  Two URLs, because this topology has two opposing sides:
 *    --merchant-url    merchant  (402 challenge, resource access, metered debits)
 *    --facilitator-url   facilitator (payment report, proof token)
 *
 *  EXPERIMENTS:
 *    payment per reading, mock  node agent.js --mock --tx --queries 20
 *    payment per reading, real  node agent.js --real --tx --queries 20     (Sepolia)
 *    metered session            node agent.js --mock --metered --debits 20
 *                               node agent.js --real --metered --debits 20
 *    message counting           ./count-proxy.js (see ../README.md)
 *    security tests             node agent.js --security   (5 fixed bugs + abuse)
 *
 *  Every CSV row separates THREE times, because that is exactly what sets it apart
 *  from the direct branch:
 *    t_*_ms            what the client measures (the whole round trip)
 *    merchant_*_ms     `X-Server-Ms` — how long the merchant spent
 *    facilitator_*_ms  `X-Downstream-Ms` — how much of that was waiting on the facilitator
 *  In the direct branch the last column is always 0. The difference is the cost of the topology.
 *
 *  Code, comments, console output and CSV headers follow the same conventions as the
 *  other measurement environments in this package.
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
const FACILITATOR_URL = val('--facilitator-url', process.env.FACILITATOR_URL || cfg.FACILITATOR_URL || 'http://127.0.0.1:4000');
const NETWORK = process.env.NETWORK || cfg.NETWORK || 'sepolia';
const RPC_URL = val('--rpc-url', process.env.RPC_URL || cfg.RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com');
// By default we take the confirmation depth from the FACILITATOR (it is the one reading the chain).
// If the agent waited for fewer confirmations than the facilitator requires, every verification
// would fail — and only after the real transaction had already been paid for.
let CONFIRMATIONS = parseInt(val('--confirmations', process.env.CONFIRMATIONS || cfg.CONFIRMATIONS || '0'), 10) || 0;
async function syncConfirmations(pcfg) {
  if (CONFIRMATIONS > 0) return CONFIRMATIONS;
  CONFIRMATIONS = (pcfg && parseInt(pcfg.minConfirmations, 10)) || 1;
  return CONFIRMATIONS;
}
// The merchant is closed behind an admin login; the agent identifies itself with a machine token.
//   grep TOKEN ../server/data/admin-credentials.txt
// The facilitator's /submit-payment route is public, so no token is needed there.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || cfg.ADMIN_TOKEN || '';

const MODE = has('--real') ? 'real' : 'mock';
const FLOW = has('--metered') ? 'metered' : 'tx';
const QUERIES = parseInt(val('--queries', '20'), 10);
const DEBITS = parseInt(val('--debits', '20'), 10);
const PAUSE_MS = parseInt(val('--pause-ms', '0'), 10);
const TOPUP_WEI = val('--topup-wei', '2500000000000');
const SECURITY = has('--security');
const X402 = has('--x402');   // parallel mode: x402 exact via the local facilitator
const OUT = val('--out', path.join(__dirname, '..', 'measurements',
  X402 ? `x402_facilitator_tx_${MODE}.csv` : `facilitator_${FLOW}_${MODE}.csv`));

const merchant = axios.create({ baseURL: MERCHANT_URL, timeout: 120_000, validateStatus: () => true,
  headers: { 'X-Demo-Agent': 'agent', ...(ADMIN_TOKEN ? { Authorization: `Bearer ${ADMIN_TOKEN}` } : {}) } });
const facilitator = axios.create({ baseURL: FACILITATOR_URL, timeout: 120_000, validateStatus: () => true,
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
    if (!fs.existsSync(wf)) { console.error('❌ wallet.json is missing (see wallet.example.json).'); process.exit(1); }
    provider = new ethers.JsonRpcProvider(RPC_URL);
    return new ethers.Wallet(JSON.parse(fs.readFileSync(wf, 'utf8')).privateKey, provider);
  }
  // mock: signing needs a key but no funds — a one-off wallet is enough.
  return ethers.Wallet.createRandom();
}

const CSV_TX = [
  'event', 'timestamp_iso', 'mode', 'topology',
  't_challenge_ms', 't_chain_ms', 't_report_ms', 't_access_ms', 't_total_ms',
  'merchant_challenge_ms', 'merchant_access_ms',
  'facilitator_challenge_ms', 'facilitator_access_ms', 'facilitator_report_ms', 'facilitator_chain_ms',
  'price_wei', 'gas_units', 'fee_eth', 'cum_fee_eth',
  'temperature_c', 'humidity_pct', 'tx_hash', 'request_id'
].join(',');
const CSV_METERED = [
  'event', 'timestamp_iso', 'mode', 'topology', 'kind',
  't_sign_ms', 't_request_ms', 'server_ms', 'facilitator_ms', 't_total_ms',
  'price_wei', 'credit_wei', 'budget_remaining_wei',
  'gas_units', 'fee_eth', 'temperature_c', 'humidity_pct', 'nonce', 'session'
].join(',');
function ensureCsv(f, header) { fs.mkdirSync(path.dirname(f), { recursive: true }); if (!fs.existsSync(f)) fs.writeFileSync(f, header + '\n'); }

// The merchant is closed behind an admin login — without a valid token nothing gets through.
function loginError() {
  console.error(`
❌ The merchant rejected the login (401). The measurement agent needs a machine token.

   On the server (over SSH) find the token:
     grep TOKEN ../server/data/admin-credentials.txt

   Then pass it to the agent:
     ADMIN_TOKEN=$(grep '^TOKEN=' ../server/data/admin-credentials.txt | cut -d= -f2) node agent.js ${args.join(' ')}
`);
  process.exitCode = 1;
}
function facilitatorError(r) {
  console.error(`
❌ The facilitator (${FACILITATOR_URL}) is unreachable${r && r.status ? ` (status ${r.status})` : ''}.

   In this topology the merchant cannot accept any payment without the facilitator —
   this is not a measurement error but a property of architecture (b) — known in the
   literature as "availability dependence".

   Start the facilitator:  cd ../facilitator && npm run mock
`);
  process.exitCode = 1;
}

// ══════════ Payment per reading via the facilitator ══════════════════════════
async function runTx() {
  banner(`FACILITATOR, PAYMENT PER READING · mode=${MODE.toUpperCase()} · N=${QUERIES}`);
  console.log(`  merchant=${MERCHANT_URL} · facilitator=${FACILITATOR_URL} · payer=${wallet.address}`);

  const h = await facilitator.get('/health');
  if (h.status !== 200) return facilitatorError(h);
  await syncConfirmations(h.data);
  const c = await merchant.get('/config');
  if (c.status === 401) return loginError();
  if (c.status !== 200) { console.error(`  ✗ /config ${c.status}`); process.exitCode = 1; return; }
  if (!!c.data.mockVerify !== !!h.data.mockVerify) {
    console.error(`\n❌ Mode mismatch: merchant mockVerify=${c.data.mockVerify}, facilitator mockVerify=${h.data.mockVerify}.`);
    console.error('   The measurement would be invalid. Align MOCK_VERIFY in both .env files.\n');
    process.exitCode = 1; return;
  }
  ensureCsv(OUT, CSV_TX);

  let cumFee = 0, ok = 0;
  const tTotal = [], tFacilitator = [];
  for (let i = 1; i <= QUERIES; i++) {
    const T0 = performance.now();
    try {
      // 1) 402 challenge (the merchant opens it at the facilitator: M→F, F→M)
      let s = performance.now();
      const ch = await merchant.get('/tx/reading', { headers: { 'X-Payer': wallet.address } });
      const tChallenge = performance.now() - s;
      if (ch.status === 401) return loginError();
      if (ch.status === 502) return facilitatorError(ch);
      if (ch.status !== 402) throw new Error(`expected 402, got ${ch.status}`);
      const pay = ch.data.payment;

      // 2) payment on the chain (C→B)
      let txHash, gasUsed = '', feeEth = '', tChain = 0;
      s = performance.now();
      if (MODE === 'real') {
        const tx = await wallet.sendTransaction({ to: pay.to, value: BigInt(pay.priceWei) });
        const rc = await tx.wait(CONFIRMATIONS);
        txHash = tx.hash; gasUsed = rc.gasUsed.toString();
        const gp = rc.gasPrice ?? tx.gasPrice ?? null;
        if (gp) { feeEth = ethers.formatEther(rc.gasUsed * gp); cumFee += parseFloat(feeEth); }
      } else { txHash = randTxHash(); }
      tChain = performance.now() - s;

      // 3) report the payment to the FACILITATOR (C→F) — the only call that bypasses the merchant
      s = performance.now();
      const sp = await facilitator.post('/submit-payment', { requestId: pay.requestId, txHash, network: NETWORK, payerAddress: wallet.address });
      const tReport = performance.now() - s;
      if (sp.status !== 200) throw new Error(`submit-payment ${sp.status}: ${JSON.stringify(sp.data)}`);
      const proofToken = sp.data.proofToken || (sp.data.proof && sp.data.proof.token);

      // 4) access at the merchant (C→M; the merchant redeems the token at the facilitator, M→F)
      s = performance.now();
      const rd = await merchant.get('/tx/reading', { headers: { 'X-Payment': proofToken } });
      const tAccess = performance.now() - s;
      if (rd.status !== 200) throw new Error(`reading ${rd.status}: ${JSON.stringify(rd.data)}`);

      const total = performance.now() - T0;
      const facChallenge = hdrNum(ch, 'X-Downstream-Ms'), facAccess = hdrNum(rd, 'X-Downstream-Ms');
      const facReport = hdrNum(sp, 'X-Server-Ms'), facChain = hdrNum(sp, 'X-Chain-Read-Ms');
      const reading = rd.data.reading;
      fs.appendFileSync(OUT, [
        `query_${i}`, nowIso(), MODE, 'facilitator',
        num(tChallenge), num(tChain), num(tReport), num(tAccess), num(total),
        num(hdrNum(ch, 'X-Server-Ms')), num(hdrNum(rd, 'X-Server-Ms')),
        num(facChallenge), num(facAccess), num(facReport), num(facChain),
        pay.priceWei, gasUsed, feeEth, cumFee ? cumFee.toFixed(8) : '',
        reading.temperature_c, reading.humidity_pct, txHash, pay.requestId
      ].join(',') + '\n');
      ok++; tTotal.push(total); tFacilitator.push(facChallenge + facAccess + facReport);
      console.log(`  ✓ ${String(i).padStart(3)} · total=${num(total)} ms · challenge=${num(tChallenge)} · chain=${num(tChain)} · report=${num(tReport)} · access=${num(tAccess)} ms  [facilitator ${num(facChallenge + facAccess + facReport)} ms]`);
    } catch (e) { console.error(`  ✗ ${i}: ${e.message}`); }
    if (PAUSE_MS) await sleep(PAUSE_MS);
  }
  writeSummary('payment per reading', { ok, n: QUERIES, tTotal, tFacilitator, onChain: ok, cumFee });
}

// ══════════ Metered session via the facilitator ══════════════════════════════
async function runMetered() {
  banner(`FACILITATOR × METERED SESSION · mode=${MODE.toUpperCase()} · N debits=${DEBITS}`);
  console.log(`  merchant=${MERCHANT_URL} · facilitator=${FACILITATOR_URL} · payer=${wallet.address}`);

  const h = await facilitator.get('/health');
  if (h.status !== 200) return facilitatorError(h);
  await syncConfirmations(h.data);
  const c = await merchant.get('/config');
  if (c.status === 401) return loginError();
  if (c.status !== 200) { console.error(`  ✗ /config ${c.status}`); process.exitCode = 1; return; }
  ensureCsv(OUT, CSV_METERED);
  const m = c.data.metered;
  const price = BigInt(m.priceWeiPerCall);
  const maxWei = (price + BigInt(m.priceWeiPerByte) * 4096n).toString();
  console.log(`  Price/reading: ${m.priceWeiPerCall} wei (+${m.priceWeiPerByte}/byte)`);

  // PHASE A — one on-chain top-up opens the session (the merchant opens it at the facilitator)
  banner('PHASE A · Top-up (1 on-chain transaction) → session at facilitator');
  let txHash, gasUsed = '', feeEth = '';
  const body = { payerAddress: wallet.address };
  if (MODE === 'real') {
    const tx = await wallet.sendTransaction({ to: c.data.receiver, value: BigInt(TOPUP_WEI) });
    console.log(`  ✓ top-up submitted · tx=${tx.hash}`);
    const rc = await tx.wait(CONFIRMATIONS);
    gasUsed = rc.gasUsed.toString();
    const gp = rc.gasPrice ?? tx.gasPrice ?? null;
    if (gp) feeEth = ethers.formatEther(rc.gasUsed * gp);
    txHash = tx.hash;
    console.log(`  ✓ confirmed · block=${rc.blockNumber} · gas=${gasUsed} · fee=${feeEth} ETH`);
  } else {
    txHash = randTxHash();
    body.mockDepositWei = (price * BigInt(DEBITS + 5)).toString();
  }
  let s = performance.now();
  const op = await merchant.post('/metered/session/open', { txHash, ...body });
  const tOpen = performance.now() - s;
  if (op.status === 502) return facilitatorError(op);
  if (op.status !== 200) { console.error(`  ✗ session/open ${op.status}: ${JSON.stringify(op.data)}`); process.exitCode = 1; return; }
  const session = op.data.session;
  console.log(`  ✓ session=${session.sessionId} · credit=${session.depositWei} wei · valid until=${session.expiresAt}`);
  fs.appendFileSync(OUT, [
    'topup', nowIso(), MODE, 'facilitator', 'topup', '', num(tOpen),
    num(hdrNum(op, 'X-Server-Ms')), num(hdrNum(op, 'X-Downstream-Ms')), num(tOpen),
    session.depositWei, session.balanceWei, session.budgetRemainingWei,
    gasUsed, feeEth, '', '', '', session.sessionId
  ].join(',') + '\n');

  // PHASE B — N signed debits; at the merchant each one goes through the facilitator
  banner(`PHASE B · ${DEBITS} signed debits (no new transactions)`);
  const tSignAll = [], tRequestAll = [], tFacilitatorAll = []; let ok = 0;
  for (let i = 1; i <= DEBITS; i++) {
    const T0 = performance.now();
    try {
      const nonce = mkNonce();
      let t = performance.now();
      const sig = await wallet.signMessage(debitMessage(wallet.address, session.sessionId, nonce, m.resource, maxWei));
      const tSign = performance.now() - t;
      t = performance.now();
      const r = await merchant.get('/metered/reading-metered', { headers: { 'X-Payer': wallet.address, 'X-Session': session.sessionId, 'X-Nonce': nonce, 'X-Signature': sig, 'X-Max-Wei': maxWei } });
      const tRequest = performance.now() - t;
      if (r.status === 502) return facilitatorError(r);
      if (r.status !== 200) throw new Error(`${r.status}: ${JSON.stringify(r.data)}`);
      const reading = r.data.reading;
      const fac = hdrNum(r, 'X-Downstream-Ms');
      fs.appendFileSync(OUT, [
        `debit_${i}`, nowIso(), MODE, 'facilitator', 'debit',
        num(tSign), num(tRequest), num(hdrNum(r, 'X-Server-Ms')), num(fac), num(performance.now() - T0),
        hdr(r, 'X-Charged-Wei'), hdr(r, 'X-Balance-Wei'), hdr(r, 'X-Budget-Remaining-Wei'),
        '', '', reading.temperature_c, reading.humidity_pct, nonce, session.sessionId
      ].join(',') + '\n');
      ok++; tSignAll.push(tSign); tRequestAll.push(tRequest); tFacilitatorAll.push(fac);
      console.log(`  ✓ debit ${String(i).padStart(2)} · T=${reading.temperature_c}°C RH=${reading.humidity_pct}% · t_sign=${num(tSign)} ms · t_request=${num(tRequest)} ms  [facilitator ${num(fac)} ms] · credit=${hdr(r, 'X-Balance-Wei')} wei`);
    } catch (e) { console.error(`  ✗ debit ${i}: ${e.message}`); }
    if (PAUSE_MS) await sleep(PAUSE_MS);
  }
  const fin = (await merchant.get(`/metered/session/${session.sessionId}`)).data.session;
  writeSummary('metered session', { ok, n: DEBITS, tTotal: tRequestAll, tFacilitator: tFacilitatorAll, onChain: 1, cumFee: parseFloat(feeEth || '0'), extra: { tSignAll, fin } });
}

function st(a) {
  a = a.filter(Number.isFinite).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const q = p => a[Math.floor(p * (a.length - 1))];
  return { n: a.length, min: a[0], median: q(0.5), mean: a.reduce((s, x) => s + x, 0) / a.length, p95: q(0.95), max: a[a.length - 1] };
}
function writeSummary(experiment, { ok, n, tTotal, tFacilitator, onChain, cumFee, extra }) {
  const s1 = st(tTotal), s2 = st(tFacilitator);
  banner(`SUMMARY ${experiment} · succeeded ${ok}/${n} · on-chain transactions: ${onChain} · CSV: ${path.relative(process.cwd(), OUT)}`);
  if (extra && extra.tSignAll) { const sp = st(extra.tSignAll); if (sp) console.log(`  t_sign      (ms): median=${num(sp.median)} mean=${num(sp.mean)} p95=${num(sp.p95)}`); }
  if (s1) console.log(`  round trip  (ms): median=${num(s1.median)} mean=${num(s1.mean)} p95=${num(s1.p95)} max=${num(s1.max)}`);
  if (s2) console.log(`  facilitator (ms): median=${num(s2.median)} mean=${num(s2.mean)} p95=${num(s2.p95)} max=${num(s2.max)}   ← in the direct branch (folder 05) this is 0`);
  if (cumFee) console.log(`  cumulative fee: ${cumFee.toFixed(8)} ETH`);
  if (extra && extra.fin) console.log(`  Final session state: credit=${extra.fin.balanceWei} wei · spent=${extra.fin.spentWei} wei`);
  const jsonOut = OUT.replace(/\.csv$/, '_summary.json');
  fs.writeFileSync(jsonOut, JSON.stringify({ experiment: experiment, mode: MODE, topology: 'facilitator', n, succeeded: ok,
    onChainTransactions: onChain, roundtrip_ms: s1, facilitator_ms: s2,
    ...(extra && extra.tSignAll ? { t_sign_ms: st(extra.tSignAll) } : {}), ...(extra && extra.fin ? { session: extra.fin } : {}) }, null, 2));
  console.log(`  JSON summary: ${path.relative(process.cwd(), jsonOut)}`);
}

// ══════════ SECURITY TESTS — five fixed bugs of the old implementation ═══════
async function runSecurity() {
  banner('SECURITY AND FAILURE TESTS (facilitator branch)');
  if (MODE === 'real') { console.error('  The security tests are meant for --mock. Run: node agent.js --security'); process.exit(1); }
  const results = [];
  const rec = (name, expected, actual, ok, note = '') => { results.push({ name, expected, actual, ok }); console.log(`  ${ok ? '✓' : '✗'} ${name.padEnd(50)} expected=${String(expected).padEnd(9)} actual=${String(actual).padEnd(9)} ${note}`); };

  const h = await facilitator.get('/health');
  if (h.status !== 200) return facilitatorError(h);
  const c = await merchant.get('/config');
  if (c.status === 401) return loginError();
  const price = BigInt(c.data.tx.priceWei);
  const m = c.data.metered;
  const maxWei = (BigInt(m.priceWeiPerCall) + BigInt(m.priceWeiPerByte) * 4096n).toString();

  // helper: the whole flow up to the proof token
  const doChallenge = async () => (await merchant.get('/tx/reading', { headers: { 'X-Payer': wallet.address } })).data.payment;
  const doSubmit = (requestId, txHash, over) => facilitator.post('/submit-payment', { requestId, txHash, network: NETWORK, payerAddress: wallet.address, ...over });

  // ── T1: the merchant really has no chain ──────────────────────────────────
  const th = await merchant.get('/health');
  rec('Merchant reports "no chain access"', 'yes', th.data.chain === 'no access (facilitator only)' ? 'yes' : 'no', th.data.chain === 'no access (facilitator only)');

  // ── T2: dropped routes ────────────────────────────────────────────────────
  const tv = await merchant.post('/tx/verify', { requestId: '00000000-0000-4000-8000-000000000000', txHash: randTxHash(), network: NETWORK, payerAddress: wallet.address });
  rec('Merchant no longer has /tx/verify (payment is reported to the facilitator)', 404, tv.status, tv.status === 404);

  // ── T3: BUG 1 — the proof token is single-use ─────────────────────────────
  let pay = await doChallenge();
  let sp = await doSubmit(pay.requestId, randTxHash());
  rec('Payment report → proof token', 200, sp.status, sp.status === 200);
  const tok = sp.data.proofToken;
  let a1 = await merchant.get('/tx/reading', { headers: { 'X-Payment': tok } });
  rec('First use of the proof', 200, a1.status, a1.status === 200);
  let a2 = await merchant.get('/tx/reading', { headers: { 'X-Payment': tok } });
  rec('BUG 1 · second use of the same proof', 403, a2.status, a2.status === 403, a2.data?.error || '');

  // ── T4: BUG 2 — one transaction cannot redeem two requests ────────────────
  const sharedTx = randTxHash();
  const p1 = await doChallenge(); const r1 = await doSubmit(p1.requestId, sharedTx);
  const p2 = await doChallenge(); const r2 = await doSubmit(p2.requestId, sharedTx);
  rec('BUG 2 · same transaction for a second request', 400, r2.status, r1.status === 200 && r2.status === 400, r2.data?.error || '');

  // ── T5: BUG 3 — one wei short is short (integer comparison) ────────────────
  const p3 = await doChallenge();
  const r3 = await doSubmit(p3.requestId, randTxHash(), { mockValueWei: (price - 1n).toString() });
  rec('BUG 3 · payment 1 wei too low', 400, r3.status, r3.status === 400, r3.data?.error || '');
  const p4 = await doChallenge();
  const r4 = await doSubmit(p4.requestId, randTxHash(), { mockValueWei: price.toString() });
  rec('BUG 3 · payment exactly the amount', 200, r4.status, r4.status === 200);

  // ── T6: the facilitator rejects an unknown/expired request ────────────────
  const r5 = await doSubmit('00000000-0000-4000-8000-000000000000', randTxHash());
  rec('Unknown payment request', 400, r5.status, r5.status === 400, r5.data?.error || '');

  // ── T7: BUG 5 — the facilitator is authenticated ──────────────────────────
  const anon = axios.create({ baseURL: FACILITATOR_URL, validateStatus: () => true, timeout: 20_000 });
  const r6 = await anon.post('/payment-request', { resource: '/x', recipient: wallet.address, amountWei: '1' });
  rec('BUG 5 · /payment-request without a token', 401, r6.status, r6.status === 401);
  const r7 = await anon.post('/verify-proof', { token: 'proof_x' });
  rec('BUG 5 · /verify-proof without a token', 401, r7.status, r7.status === 401);
  const r8 = await anon.get('/health');
  rec('/health stays public (container healthcheck)', 200, r8.status, r8.status === 200);

  // ── T8–T13: metered session through the facilitator ───────────────────────
  const openS = async (over = {}) => {
    const r = await merchant.post('/metered/session/open', { txHash: randTxHash(), payerAddress: wallet.address, mockDepositWei: (BigInt(m.priceWeiPerCall) * 10n).toString(), ...over });
    return r.data.session;
  };
  const doDebit = async (session, { nonce = mkNonce(), signAs = wallet, claimPayer = wallet.address, mw = maxWei } = {}) => {
    const sig = await signAs.signMessage(debitMessage(claimPayer, session.sessionId, nonce, m.resource, mw));
    return merchant.get('/metered/reading-metered', { headers: { 'X-Payer': claimPayer, 'X-Session': session.sessionId, 'X-Nonce': nonce, 'X-Signature': sig, 'X-Max-Wei': String(mw) } });
  };
  let r = await merchant.get('/metered/reading-metered');
  rec('No signature (missing headers)', 402, r.status, r.status === 402);
  const sA = await openS();
  const nA = mkNonce();
  r = await doDebit(sA, { nonce: nA });
  rec('Valid debit via the facilitator', 200, r.status, r.status === 200);
  r = await doDebit(sA, { nonce: nA });
  rec('Nonce reuse (replay)', 403, r.status, r.status === 403, r.data?.error || '');
  const other = ethers.Wallet.createRandom();
  r = await doDebit(sA, { signAs: other });
  rec('Forged signature (different wallet)', 403, r.status, r.status === 403, r.data?.error || '');
  r = await doDebit(sA, { nonce: `${Date.now() - 10 * 60 * 1000}-deadbeef` });
  rec('Stale nonce', 400, r.status, r.status === 400, r.data?.error || '');
  const sB = await openS({ mockDepositWei: (BigInt(m.priceWeiPerCall) * 10n).toString(), budgetWei: (BigInt(m.priceWeiPerCall) * 2n).toString() });
  await doDebit(sB); await doDebit(sB);
  r = await doDebit(sB);
  rec('Budget exceeded (budget=2×price)', 402, r.status, r.status === 402, r.data?.reason || '');
  const sC = await openS({ mockDepositWei: (BigInt(m.priceWeiPerCall) * 2n).toString() });
  await doDebit(sC); await doDebit(sC);
  r = await doDebit(sC);
  rec('Credit exhausted', 402, r.status, r.status === 402, r.data?.reason || '');
  const sD = await openS();
  const sE = await openS();
  const sigCross = await wallet.signMessage(debitMessage(wallet.address, sD.sessionId, mkNonce(), m.resource, maxWei));
  r = await merchant.get('/metered/reading-metered', { headers: { 'X-Payer': wallet.address, 'X-Session': sE.sessionId, 'X-Nonce': mkNonce(), 'X-Signature': sigCross, 'X-Max-Wei': maxWei } });
  rec('Signature for a different session', 403, r.status, r.status === 403, r.data?.error || '');

  const ok = results.filter(x => x.ok).length;
  banner(`RESULT: ${ok}/${results.length} tests passed`);
  const out = path.join(__dirname, '..', 'measurements', 'facilitator_security.csv');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, 'test,expected,actual,passed\n' + results.map(x => `"${x.name}",${x.expected},${x.actual},${x.ok ? 1 : 0}`).join('\n') + '\n');
  console.log(`  CSV: ${path.relative(process.cwd(), out)}`);
  if (ok !== results.length) process.exitCode = 1;
}

// ── main ─────────────────────────────────────────────────────────────────────
// ══════════ x402 v2 (PARALLEL MODE) — facilitated via the facilitator ════════
// The client signs an EIP-3009 authorization and submits NO transaction of its own;
// the merchant delegates verification/settlement to the FACILITATOR, which pays the
// gas. What is measured is the whole round trip at the merchant + the facilitator's
// side, via the /x402/payment/:id lookup.
const x402o = X402 ? require('./x402-client') : null;

const X402_CSV_HEADER = [
  'event', 'timestamp_iso', 'mode', 'protocol', 'topology', 'network', 'asset', 'gas_payer',
  't_402_ms', 't_sign_ms', 't_payment_http_ms', 't_total_ms',
  'merchant_ms', 'merchant_downstream_ms', 'verify_ms', 'settle_ms',
  'amount_atomic', 'decimals', 'cumulative_atomic', 'payment_id', 'idempotency',
  'tx_hash', 'synthetic_tx', 'block', 'gas_units', 'gas_price_wei',
  'temperature_c', 'humidity_pct', 'status'
].join(',');

function loadX402Payer() {
  const wf = path.join(__dirname, 'wallet.json');
  const wd = fs.existsSync(wf) ? JSON.parse(fs.readFileSync(wf, 'utf8')) : {};
  if (MODE === 'real' && !wd.x402PayerPrivateKey) {
    console.error('❌ For --x402 --real put x402PayerPrivateKey into wallet.json (the x402 branch is a test ETH configuration; a real run needs an EIP-3009 token, e.g. USDC).');
    process.exit(1);
  }
  return x402o.makePayer({ privateKey: MODE === 'real' ? wd.x402PayerPrivateKey : undefined });
}

async function runX402Tx() {
  const c = await merchant.get('/x402/config');
  if (c.status === 401) return loginError();
  if (c.status !== 200 || !c.data || c.data.mode === 'off') {
    console.error('❌ The merchant does not have x402 mode enabled (X402_MODE=facilitated on the merchant, X402_MODE=self on the facilitator).'); process.exit(1);
  }
  const cfgX = c.data;
  const account = loadX402Payer();
  const client = x402o.makeClient(account);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  if (!fs.existsSync(OUT)) fs.writeFileSync(OUT, X402_CSV_HEADER + '\n');

  banner(`x402 VIA THE FACILITATOR · 1 SETTLEMENT / QUERY · mode=${MODE.toUpperCase()} · N=${QUERIES}`);
  console.log(`  Merchant=${MERCHANT_URL} · facilitator=${cfgX.facilitator} · recipient=${cfgX.payTo}`);
  console.log(`  Price/reading: ${cfgX.priceAtomic} atomic units of ${cfgX.assetName} · gas paid by: FACILITATOR`);
  if (cfgX.mock) console.log('  ⚠ MOCK: settlements are synthetic (0x6d6f636b6d6f636b…) — NOT real measurements.');

  let ok = 0; let cumulativeAtomic = 0n;
  const txHashes = new Set();
  for (let i = 1; i <= QUERIES; i++) {
    try {
      const T0 = performance.now();
      const r = await x402o.payFlow({
        url: `${MERCHANT_URL}/x402/tx/reading`, account, client,
        headers: ADMIN_TOKEN ? { Authorization: `Bearer ${ADMIN_TOKEN}`, 'X-Demo-Agent': 'agent' } : { 'X-Demo-Agent': 'agent' }
      });
      const total = performance.now() - T0;
      if (r.status !== 200) throw new Error(`payment ${r.status}`);
      const body = await r.res.json();
      const reading = body.reading || {};
      cumulativeAtomic += BigInt(cfgX.priceAtomic);
      if (r.paymentResponse && r.paymentResponse.txHash) txHashes.add(r.paymentResponse.txHash);
      const downMs = parseFloat(r.res.headers.get('X-Downstream-Ms') || '') || '';
      let block = '', gasUnits = '', gasPriceWei = '';
      const pv = await merchant.get(`/x402/payment/${r.paymentId}`);
      if (pv.status === 200 && pv.data) { block = pv.data.block ?? ''; gasUnits = pv.data.gasUnits ?? ''; gasPriceWei = pv.data.gasPriceWei ?? ''; }
      fs.appendFileSync(OUT, [
        `query_${i}`, nowIso(), MODE, 'x402-facilitated', 'facilitator', cfgX.network, cfgX.assetName, 'facilitator',
        num(r.t.t402), num(r.t.tSign), num(r.t.tPaymentHttp), num(total),
        num(r.serverMs), num(downMs), num(r.verifyMs), num(r.settleMs),
        cfgX.priceAtomic, cfgX.assetDecimals, cumulativeAtomic.toString(), r.paymentId,
        r.replayed ? 'replay' : 'new',
        r.paymentResponse ? r.paymentResponse.txHash : '', r.synthetic ? 1 : 0,
        block, gasUnits, gasPriceWei,
        reading.temperature_c ?? '', reading.humidity_pct ?? '', r.status
      ].join(',') + '\n');
      console.log(`  ✓ ${String(i).padStart(3)} · total=${num(total)} ms · merchant=${num(r.serverMs)} ms (of which facilitator=${num(downMs)} ms) · tx=${r.paymentResponse ? String(r.paymentResponse.txHash).slice(0, 18) + '…' : '—'}${r.synthetic ? ' (synthetic)' : ''}`);
      ok++;
    } catch (e) { console.error(`  ✗ ${i}: ${e.message}`); }
    if (PAUSE_MS) await sleep(PAUSE_MS);
  }

  banner(`SUMMARY x402-facilitator · succeeded ${ok}/${QUERIES} · settlements: ${txHashes.size} · CSV: ${path.relative(process.cwd(), OUT)}`);
  console.log(`  ${QUERIES} readings = ${txHashes.size} x402 settlements; the settlement transaction is submitted, and its gas paid, by the FACILITATOR.`);
  console.log('  Meanwhile the merchant NEVER talks to the chain (the same invariant as with the custom protocol).');
  if (txHashes.size !== ok) { console.error('  ✗ ERROR: readings ≠ settlements'); process.exitCode = 1; }
}

async function runX402Security() {
  const c = await merchant.get('/x402/config');
  if (c.status === 401) return loginError();
  const facilitatorMock = !!(c.data && ((c.data.facilitatorX402 && c.data.facilitatorX402.mock) || c.data.mock));
  if (c.status !== 200 || c.data.mode === 'off' || !facilitatorMock) {
    console.error('❌ The tests require: merchant X402_MODE=facilitated + facilitator X402_MODE=self X402_MOCK=true.'); process.exit(1);
  }
  const cfgX = c.data;
  const account = loadX402Payer();
  const client = x402o.makeClient(account);
  const H = { ...(ADMIN_TOKEN ? { Authorization: `Bearer ${ADMIN_TOKEN}` } : {}), 'X-Demo-Agent': 'agent' };
  const url = `${MERCHANT_URL}/x402/tx/reading`;
  banner('x402 SECURITY TESTS (folder 04 — facilitated topology)');
  const results = [];
  const rec = (name, expected, actual, ok, note = '') => { results.push({ name, expected, actual, ok, note }); console.log(`  ${ok ? '✓' : '✗'} ${name.padEnd(50)} expected=${String(expected).padEnd(12)} actual=${String(actual).padEnd(10)} ${note}`); };

  { // topological invariant: the merchant has no chain in x402 mode either
    const h = await merchant.get('/health');
    rec('T1 merchant without chain access', 'yes', h.data && h.data.chain === 'no access (facilitator only)' ? 'yes' : 'no', h.data && h.data.chain === 'no access (facilitator only)');
  }
  { // discovery: /x402/supported is public on the facilitator
    const r = await facilitator.get('/x402/supported');
    const okKind = r.status === 200 && (r.data.kinds || []).some((k) => k.scheme === 'exact' && k.network === cfgX.network);
    rec('T2 facilitator /x402/supported public + exact', '200+exact', `${r.status}${okKind ? '+exact' : ''}`, okKind);
  }
  { // the facilitator routes require a token (merchant-as-client)
    const r = await axios.post(`${FACILITATOR_URL}/x402/settle`, { a: 1 }, { validateStatus: () => true });
    rec('T3 /x402/settle without a token → 401', 401, r.status, r.status === 401);
  }
  { const r = await axios.get(url, { validateStatus: () => true }); rec('T4 without login → 401 (authentication ≠ payment)', 401, r.status, r.status === 401); }
  { const r = await merchant.get('/x402/tx/reading'); rec('T5 with login, without payment → 402 + PAYMENT-REQUIRED', 402, r.status, r.status === 402 && !!r.headers['payment-required']); }
  let first;
  { first = await x402o.payFlow({ url, account, client, headers: H }); rec('T6 valid payment via the facilitator → 200', 200, first.status, first.status === 200); }
  { // the client did NOT submit a transaction; the facilitator submitted the settlement
    const pv = await merchant.get(`/x402/payment/${first.paymentId}`);
    const okTx = pv.status === 200 && pv.data && pv.data.facilitator && pv.data.facilitator.status && ['SETTLED', 'SETTLED_UNVERIFIED'].includes(pv.data.facilitator.status);
    rec('T7 the FACILITATOR performs the settlement (its own record)', 'SETTLED', pv.data && pv.data.facilitator ? pv.data.facilitator.status : pv.status, okTx);
  }
  { // repeat → replay at the merchant, the facilitator does not settle a second time
    const r = await x402o.payFlow({ url, account, client, headers: H, reuseHeaders: first.signedHeaders, paymentId: first.paymentId });
    rec('T8 repeat → replay, same settlement', 'replay', r.replayed ? 'replay' : r.status, r.status === 200 && r.replayed && r.paymentResponse && r.paymentResponse.txHash === first.paymentResponse.txHash);
  }
  { // corrupted signature → 402
    const r = await x402o.payFlow({ url, account, client, headers: H, mutateAuthorization: (a) => { a.value = '1'; } });
    rec('T9 corrupted authorization → 402', 402, r.status, r.status === 402);
  }
  { // concurrent duplicates → one settlement
    const sig = await x402o.payFlow({ url, account, client, headers: H });
    const runs = await Promise.all(Array.from({ length: 4 }, () => x402o.payFlow({ url, account, client, headers: H, reuseHeaders: sig.signedHeaders, paymentId: sig.paymentId })));
    const hashes = new Set([sig.paymentResponse && sig.paymentResponse.txHash, ...runs.map((r) => r.paymentResponse && r.paymentResponse.txHash)].filter(Boolean));
    rec('T10 concurrent duplicates → one settlement', '1 hash', `${hashes.size} hash`, hashes.size === 1);
  }
  { // unreachable facilitator → a clear error, without crashing the merchant
    // (simulation: we ask the merchant directly, which should return 402 with a reason if the facilitator goes down —
    //  here we only check that the merchant survives an invalid payload)
    const r = await merchant.get('/x402/tx/reading', { headers: { 'PAYMENT-SIGNATURE': 'not-base64!' } });
    rec('T11 invalid PAYMENT-SIGNATURE → 402, not 500', 402, r.status, r.status === 402);
  }

  const okAll = results.filter((x) => x.ok).length;
  banner(`RESULT · ${okAll}/${results.length} passed`);
  const csvOut = path.join(__dirname, '..', 'measurements', 'x402_facilitator_security.csv');
  fs.mkdirSync(path.dirname(csvOut), { recursive: true });
  fs.writeFileSync(csvOut, 'test,expected,actual,passed,note\n' +
    results.map((x) => [JSON.stringify(x.name), x.expected, x.actual, x.ok ? 1 : 0, JSON.stringify(x.note)].join(',')).join('\n') + '\n');
  console.log(`  CSV: ${path.relative(process.cwd(), csvOut)}`);
  if (okAll !== results.length) process.exitCode = 1;
}

(async () => {
  wallet = makeWallet();
  try {
    if (X402 && SECURITY) await runX402Security();
    else if (X402) await runX402Tx();
    else if (SECURITY) await runSecurity();
    else if (FLOW === 'metered') await runMetered();
    else await runTx();
  } catch (e) {
    console.error(`\n❌ ${e.message}`);
    if (e.code === 'ECONNREFUSED') console.error(`   Are both processes running? merchant=${MERCHANT_URL} facilitator=${FACILITATOR_URL}`);
    process.exitCode = 1;
  }
})();
