// X402 showcase — three tabs. Single = MetaMask (viem); tx & metered = SSE M2M.
import {
  createWalletClient, createPublicClient, custom, http as viemHttp,
  parseEther, formatEther, getAddress
} from 'https://esm.sh/viem@2.21.40';
import { sepolia } from 'https://esm.sh/viem@2.21.40/chains';
import { generatePrivateKey, privateKeyToAccount } from 'https://esm.sh/viem@2.21.40/accounts';

const $ = (id) => document.getElementById(id);
const show = (el, on = true) => el.classList[on ? 'remove' : 'add']('hidden');
const ms = (x) => `${(+x).toFixed(1)} ms`;
let CFG = null;

// ── tabs ─────────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach((btn) => btn.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
  btn.classList.add('active');
  $(`panel-${btn.dataset.tab}`).classList.add('active');
}));

// ── init ─────────────────────────────────────────────────────────────────────
async function init() {
  CFG = await (await fetch('/config')).json();
  $('mode-badge').textContent = CFG.mockVerify
    ? 'MOCK mode — no real chain (for a demo without funds)'
    : `REAL chain — ${CFG.network}`;
  $('mode-badge').classList.add(CFG.mockVerify ? 'mock' : 'real');
  // single card
  const ec = CFG.single;
  $('e-network').textContent = CFG.network;
  $('e-merchant').textContent = CFG.receiver;
  $('e-price').textContent = `${ec.priceEth} ETH (≈ ${ec.priceEurApprox} €)`;
  if (CFG.mockVerify) addDemoButton();
  refreshSeja();
}

// ── browser session (sid): correlation, not authorisation ────────────────────
// Shows what the server remembered on the first GET and what it later linked
// into the same session. If you switch networks mid-flow (a different IP), the
// "IP changes" counter goes up while the flow carries on — access is not tied
// to the IP.
const KIND_SL = { request_id: 'payment request (402)', proof_token: 'proof token', metered_session: 'metered session' };
async function refreshSeja() {
  try {
    const r = await fetch('/session', { cache: 'no-store' });
    const { session } = await r.json();
    const box = $('i-links');
    if (!session) {
      $('i-sid').textContent = '— (no cookie; the flow still works)';
      ['i-req', 'i-ipc', 'i-payer', 'i-exp'].forEach((id) => { $(id).textContent = '—'; });
      box.innerHTML = ''; return;
    }
    $('i-sid').textContent = `${session.sidShort}… (HttpOnly — not accessible to the browser)`;
    $('i-req').textContent = session.requests;
    $('i-ipc').textContent = session.ipChanges === 0 ? '0 (same IP)' : `${session.ipChanges} — access was not interrupted`;
    $('i-payer').textContent = session.payer || '— (no payment yet)';
    $('i-exp').textContent = new Date(session.expiresAt).toLocaleString('en-GB');
    box.innerHTML = '';
    if (!session.links.length) logLine(box, 'muted', 'No linked events yet — start one of the flows.');
    for (const l of session.links) logLine(box, '', `${new Date(l.at).toLocaleTimeString('en-GB')} · ${KIND_SL[l.kind] || l.kind} · ${l.ref}`);
  } catch (err) {
    $('i-hint').textContent = `Could not read the session: ${err.message}`;
  }
}
$('i-refresh').addEventListener('click', refreshSeja);

// ── logout ───────────────────────────────────────────────────────────────────
$('logout').addEventListener('click', async () => {
  try { await fetch('/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' } }); } catch { /* redirect anyway */ }
  location.href = '/login';
});

// ════════════════════════════ 1) SINGLE (MetaMask) ══════════════════════════
let walletClient = null, publicClient = null, account = null;
const setStep = (id, s) => { const el = $(id); if (!el) return; el.classList.remove('active', 'done', 'fail'); if (s) el.classList.add(s); };
const eErr = (m) => { $('e-err').textContent = m; show($('e-err'), true); };

$('e-connect').addEventListener('click', async () => {
  show($('e-err'), false);
  if (!window.ethereum) { eErr('MetaMask not detected. Install it from https://metamask.io and refresh.'); return; }
  try {
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    account = getAddress(accounts[0]);
    const cur = await window.ethereum.request({ method: 'eth_chainId' });
    if (cur !== '0xaa36a7') { try { await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0xaa36a7' }] }); } catch {} }
    walletClient = createWalletClient({ chain: sepolia, transport: custom(window.ethereum) });
    // Use the server's configured RPC (whitelisted in CSP) instead of viem's default.
    publicClient = createPublicClient({ chain: sepolia, transport: viemHttp(CFG.rpcUrl || 'https://ethereum-sepolia-rpc.publicnode.com') });
    const bal = await publicClient.getBalance({ address: account });
    $('e-wallet').textContent = `${account.slice(0, 6)}…${account.slice(-4)} — ${formatEther(bal).slice(0, 8)} ETH`;
    $('e-pay').disabled = false;
  } catch (err) { eErr(`Wallet error: ${err.message}`); }
});

$('e-pay').addEventListener('click', () => payEnkratno(false));

function addDemoButton() {
  if ($('e-demo')) return;
  const b = document.createElement('button');
  b.id = 'e-demo'; b.className = 'ghost'; b.textContent = 'Demo (mock, no MetaMask)';
  b.addEventListener('click', () => payEnkratno(true));
  $('e-pay').insertAdjacentElement('afterend', b);
}

async function payEnkratno(demo) {
  show($('e-err'), false); show($('e-result'), false);
  const prompt = $('e-prompt').value.trim() || 'hello';
  show($('e-steps'), true); show($('e-timing'), true);
  ['e-s1', 'e-s2', 'e-s3', 'e-s4'].forEach((s) => setStep(s, null));
  const T = {}; const now = () => performance.now(); const T0 = now();
  try {
    let payer = account;
    if (demo) payer = privateKeyToAccount(generatePrivateKey()).address;
    if (!payer) { eErr('Connect a wallet first (or use Demo).'); return; }

    // 1 — challenge
    setStep('e-s1', 'active');
    let s = now();
    const chal = await fetch(`/single/service?payer=${payer}`, { headers: { 'X-Payer': payer } });
    if (chal.status !== 402) throw new Error(`Expected 402, got ${chal.status}`);
    const { payment } = await chal.json();
    T.izziv = now() - s; $('e-t1').textContent = ms(T.izziv); setStep('e-s1', 'done');

    // 2 — pay
    setStep('e-s2', 'active');
    let txHash;
    s = now();
    if (demo) { txHash = '0x' + [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join(''); $('e-t2').textContent = '(mock)'; }
    else {
      txHash = await walletClient.sendTransaction({ account, to: getAddress(payment.to), value: parseEther(payment.amount) });
      await publicClient.waitForTransactionReceipt({ hash: txHash });
      T.potrditev = now() - s; $('e-t2').textContent = ms(T.potrditev);
    }
    setStep('e-s2', 'done');

    // 3 — verify
    setStep('e-s3', 'active');
    s = now();
    const vr = await fetch('/single/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: payment.requestId, txHash, network: payment.network, payerAddress: payer }) });
    const vj = await vr.json();
    if (!vr.ok) { setStep('e-s3', 'fail'); throw new Error(vj.message || vj.error || 'Verification failed'); }
    T.preverjanje = now() - s; $('e-t3').textContent = ms(T.preverjanje); setStep('e-s3', 'done');

    // 4 — access
    setStep('e-s4', 'active');
    s = now();
    const ar = await fetch('/single/service', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Payment': vj.proofToken }, body: JSON.stringify({ prompt }) });
    const aj = await ar.json();
    if (!ar.ok) { setStep('e-s4', 'fail'); throw new Error(aj.message || aj.error || 'Access failed'); }
    T.dostop = now() - s; $('e-t4').textContent = ms(T.dostop); setStep('e-s4', 'done');
    T.skupaj = now() - T0; $('e-t5').innerHTML = `<strong>${ms(T.skupaj)}</strong>`;
    $('e-result').textContent = aj.response; show($('e-result'), true);
  } catch (err) { eErr(err.message || String(err)); }
  finally { refreshSeja(); }
}

// ════════════════════════════ 2) TX (SSE) ═══════════════════════════════════
let txES = null;
function logLine(box, cls, text) { const d = document.createElement('div'); d.className = `logline ${cls || ''}`; d.textContent = text; box.appendChild(d); box.scrollTop = box.scrollHeight; }

// Both runners spend from the wallet, so on top of a login they also require a
// token that can only be read from the same origin (CSRF protection).
async function runToken() {
  const r = await fetch('/run/token', { cache: 'no-store' });
  if (r.status === 401) { location.href = '/login'; throw new Error('The session has expired'); }
  const { token } = await r.json();
  if (!token) { location.href = '/login'; throw new Error('The session has expired'); }
  return token;
}

// EventSource does not report the status code — on an error we check whether an
// expired session is to blame, so the user is not left without an explanation.
async function sseNapaka(box) {
  try {
    const r = await fetch('/session', { cache: 'no-store' });
    if (r.status === 401) { logLine(box, 'fail', 'The session has expired — redirecting to the login page…'); setTimeout(() => { location.href = '/login'; }, 1200); return; }
  } catch { /* network error — leave the generic message */ }
  logLine(box, 'fail', 'The connection to the server has been lost.');
}

$('tx-run').addEventListener('click', async () => {
  const n = Math.max(1, Math.min(200, parseInt($('tx-n').value || '20', 10)));
  $('tx-run').disabled = true; $('tx-stop').disabled = false;
  $('tx-count').textContent = '0'; $('tx-onchain').textContent = '0'; $('tx-fee').textContent = '0';
  $('tx-bar').style.width = '0%'; $('tx-log').innerHTML = '';
  let token;
  try { token = await runToken(); } catch (e) { logLine($('tx-log'), 'fail', e.message); stopTx(); return; }
  txES = new EventSource(`/run/tx?queries=${n}&token=${encodeURIComponent(token)}`);
  txES.addEventListener('start', (e) => { const d = JSON.parse(e.data); logLine($('tx-log'), 'muted', `Start · ${d.mode} · ${d.queries} queries · payer ${d.payer.slice(0, 10)}…`); });
  txES.addEventListener('query', (e) => {
    const d = JSON.parse(e.data);
    $('tx-count').textContent = d.i; $('tx-onchain').textContent = d.onChainTx;
    if (d.cumFeeEth) $('tx-fee').textContent = d.cumFeeEth.toFixed(8);
    $('tx-bar').style.width = `${(d.i / n) * 100}%`;
    logLine($('tx-log'), '', `#${d.i} · T=${d.reading.temperature_c}°C RH=${d.reading.humidity_pct}% · t_total=${d.tTotalMs} ms${d.gasUsed ? ` · gas=${d.gasUsed}` : ''}${d.feeEth ? ` · +${d.feeEth.toFixed(8)} ETH` : ''}`);
  });
  txES.addEventListener('summary', (e) => { const d = JSON.parse(e.data); logLine($('tx-log'), 'ok', `Summary · ${d.succeeded} successful · on-chain transactions: ${d.onChainTransactions}${d.cumulativeFeeEth ? ` · total gas ${d.cumulativeFeeEth} ETH` : ''}`); });
  txES.addEventListener('error', (e) => { const d = JSON.parse(e.data); logLine($('tx-log'), 'fail', `Error${d.i ? ` #${d.i}` : ''}: ${d.message}`); });
  txES.addEventListener('end', () => stopTx());
  txES.onerror = () => { sseNapaka($('tx-log')); stopTx(); };
});
function stopTx() { if (txES) { txES.close(); txES = null; } $('tx-run').disabled = false; $('tx-stop').disabled = true; refreshSeja(); }
$('tx-stop').addEventListener('click', stopTx);

// ════════════════════════════ 3) METERED (SSE) ══════════════════════════════
let mES = null, mDeposit = 0, mLat = [];
const median = (a) => { if (!a.length) return '—'; const b = a.slice().sort((x, y) => x - y); return b[Math.floor(b.length / 2)].toFixed(2); };

$('m-run').addEventListener('click', async () => {
  const n = Math.max(1, Math.min(200, parseInt($('m-n').value || '20', 10)));
  $('m-run').disabled = true; $('m-stop').disabled = false;
  $('m-count').textContent = '0'; $('m-onchain').textContent = '1'; $('m-lat').textContent = '—';
  $('m-bar').style.width = '100%'; $('m-log').innerHTML = ''; show($('m-session'), false); mLat = []; mDeposit = 0;
  let token;
  try { token = await runToken(); } catch (e) { logLine($('m-log'), 'fail', e.message); stopM(); return; }
  mES = new EventSource(`/run/metered?debits=${n}&token=${encodeURIComponent(token)}`);
  mES.addEventListener('start', (e) => { const d = JSON.parse(e.data); logLine($('m-log'), 'muted', `Start · ${d.mode} · ${d.debits} debits · payer ${d.payer.slice(0, 10)}…`); });
  mES.addEventListener('session', (e) => {
    const d = JSON.parse(e.data); mDeposit = Number(d.depositWei);
    $('m-sid').textContent = d.sessionId; $('m-dep').textContent = `${d.depositWei} wei`;
    $('m-bud').textContent = `${d.budgetWei} wei`; $('m-exp').textContent = new Date(d.expiresAt).toLocaleString('en-GB');
    show($('m-session'), true);
    logLine($('m-log'), 'ok', `Session opened (1 on-chain transaction)${d.gasUsed ? ` · gas=${d.gasUsed}` : ''}`);
  });
  mES.addEventListener('debit', (e) => {
    const d = JSON.parse(e.data);
    $('m-count').textContent = d.i; mLat.push(d.tSignMs + d.tRequestMs); $('m-lat').textContent = median(mLat);
    if (mDeposit > 0 && d.creditWei != null) $('m-bar').style.width = `${Math.max(0, (Number(d.creditWei) / mDeposit) * 100)}%`;
    logLine($('m-log'), '', `#${d.i} · T=${d.reading.temperature_c}°C RH=${d.reading.humidity_pct}% · t_sign=${d.tSignMs} ms · t_request=${d.tRequestMs} ms · credit=${d.creditWei} wei`);
  });
  mES.addEventListener('summary', (e) => { const d = JSON.parse(e.data); $('m-lat').textContent = d.medSignMs != null ? (d.medSignMs + d.medRequestMs).toFixed(2) : median(mLat); logLine($('m-log'), 'ok', `Summary · ${d.succeeded} debits · on-chain transactions: ${d.onChainTransactions} · final credit ${d.finalCreditWei} wei`); });
  mES.addEventListener('error', (e) => { const d = JSON.parse(e.data); logLine($('m-log'), 'fail', `Error${d.i ? ` #${d.i}` : ''}: ${d.message}`); });
  mES.addEventListener('end', () => stopM());
  mES.onerror = () => { sseNapaka($('m-log')); stopM(); };
});
function stopM() { if (mES) { mES.close(); mES = null; } $('m-run').disabled = false; $('m-stop').disabled = true; refreshSeja(); }
$('m-stop').addEventListener('click', stopM);

init().catch((e) => { $('mode-badge').textContent = `Error: ${e.message}`; });
