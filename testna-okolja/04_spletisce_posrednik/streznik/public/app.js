// X402 showcase — POSREDNISKA VEJA (mapa 04_spletisce_posrednik).
// Three tabs. Enkratno = MetaMask (viem); tx & merjeno = SSE M2M.
// Razlika proti mapi 05: korak 3 (prijava placila) gre NEPOSREDNO posredniku,
// ne trgovcu — glej opis posredniškega protokola v ../README.md.
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
    ? 'MOCK način — brez prave verige (za demo brez sredstev)'
    : `PRAVA veriga — ${CFG.network}`;
  $('mode-badge').classList.add(CFG.mockVerify ? 'mock' : 'real');
  // enkratno card
  const ec = CFG.enkratno;
  $('e-network').textContent = CFG.network;
  $('e-merchant').textContent = CFG.receiver;
  $('e-price').textContent = `${ec.priceEth} ETH (≈ ${ec.priceEurApprox} €)`;
  if (CFG.mockVerify) addDemoButton();
  refreshSeja();
}

// ── seja brskalnika (sid): korelacija, ne avtorizacija ───────────────────────
// Prikaže, kaj si je strežnik zapomnil ob prvem GET in kaj je kasneje povezal v
// isto sejo. Če med potekom zamenjaš omrežje (drug IP), se števec „menjav IP“
// poveča, potek pa se nemoteno nadaljuje — dostop na IP ni vezan.
const KIND_SL = { request_id: 'plačilna zahteva (402)', proof_token: 'dokazni žeton', metered_session: 'merjena seja' };
async function refreshSeja() {
  try {
    const r = await fetch('/seja', { cache: 'no-store' });
    const { seja } = await r.json();
    const box = $('i-links');
    if (!seja) {
      $('i-sid').textContent = '— (brez piškotka; potek vseeno deluje)';
      ['i-req', 'i-ipc', 'i-payer', 'i-exp'].forEach((id) => { $(id).textContent = '—'; });
      box.innerHTML = ''; return;
    }
    $('i-sid').textContent = `${seja.sidShort}… (HttpOnly — brskalniku ni dostopen)`;
    $('i-req').textContent = seja.requests;
    $('i-ipc').textContent = seja.ipChanges === 0 ? '0 (isti IP)' : `${seja.ipChanges} — dostop se ni prekinil`;
    $('i-payer').textContent = seja.payer || '— (še ni plačila)';
    $('i-exp').textContent = new Date(seja.expiresAt).toLocaleString('sl-SI');
    box.innerHTML = '';
    if (!seja.links.length) logLine(box, 'muted', 'Ni še povezanih dogodkov — začni enega od potekov.');
    for (const l of seja.links) logLine(box, '', `${new Date(l.at).toLocaleTimeString('sl-SI')} · ${KIND_SL[l.kind] || l.kind} · ${l.ref}`);
  } catch (err) {
    $('i-hint').textContent = `Seje ni bilo mogoče prebrati: ${err.message}`;
  }
}
$('i-refresh').addEventListener('click', refreshSeja);

// ── odjava ───────────────────────────────────────────────────────────────────
$('logout').addEventListener('click', async () => {
  try { await fetch('/odjava', { method: 'POST', headers: { 'Content-Type': 'application/json' } }); } catch { /* vseeno preusmeri */ }
  location.href = '/prijava';
});

// ════════════════════════════ 1) ENKRATNO (MetaMask) ════════════════════════
let walletClient = null, publicClient = null, account = null;
const setStep = (id, s) => { const el = $(id); if (!el) return; el.classList.remove('active', 'done', 'fail'); if (s) el.classList.add(s); };
const eErr = (m) => { $('e-err').textContent = m; show($('e-err'), true); };

$('e-connect').addEventListener('click', async () => {
  show($('e-err'), false);
  if (!window.ethereum) { eErr('MetaMask ni zaznan. Namesti ga z https://metamask.io in osveži.'); return; }
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
  } catch (err) { eErr(`Napaka denarnice: ${err.message}`); }
});

$('e-pay').addEventListener('click', () => payEnkratno(false));

function addDemoButton() {
  if ($('e-demo')) return;
  const b = document.createElement('button');
  b.id = 'e-demo'; b.className = 'ghost'; b.textContent = 'Demo (mock, brez MetaMask)';
  b.addEventListener('click', () => payEnkratno(true));
  $('e-pay').insertAdjacentElement('afterend', b);
}

async function payEnkratno(demo) {
  show($('e-err'), false); show($('e-result'), false);
  const prompt = $('e-prompt').value.trim() || 'pozdravljen';
  show($('e-steps'), true); show($('e-timing'), true);
  ['e-s1', 'e-s2', 'e-s3', 'e-s4'].forEach((s) => setStep(s, null));
  const T = {}; const now = () => performance.now(); const T0 = now();
  try {
    let payer = account;
    if (demo) payer = privateKeyToAccount(generatePrivateKey()).address;
    if (!payer) { eErr('Najprej poveži denarnico (ali uporabi Demo).'); return; }

    // 1 — challenge
    setStep('e-s1', 'active');
    let s = now();
    const chal = await fetch(`/enkratno/service?payer=${payer}`, { headers: { 'X-Payer': payer } });
    if (chal.status !== 402) throw new Error(`Pričakoval 402, dobil ${chal.status}`);
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

    // 3 — prijava plačila POSREDNIKU (puščica C→F)
    // Tu se posredniška veja loči od neposredne: plačilo se ne prijavi trgovcu,
    // ampak naravnost posredniku, ki edini bere verigo in izda dokazni žeton.
    setStep('e-s3', 'active');
    s = now();
    const fUrl = (payment.facilitatorUrl || '').replace(/\/+$/, '');
    const submitPath = payment.submitPath || '/submit-payment';
    if (!fUrl) { setStep('e-s3', 'fail'); throw new Error('Odgovor 402 ne vsebuje naslova posrednika (facilitatorUrl)'); }
    const vr = await fetch(`${fUrl}${submitPath}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: payment.requestId, txHash, network: payment.network, payerAddress: payer }) });
    const vj = await vr.json();
    if (!vr.ok) { setStep('e-s3', 'fail'); throw new Error(vj.message || vj.error || 'Posrednik plačila ni potrdil'); }
    const proofToken = vj.proofToken || (vj.proof && vj.proof.token);
    if (!proofToken) { setStep('e-s3', 'fail'); throw new Error('Posrednik ni vrnil dokaznega žetona'); }
    T.preverjanje = now() - s; $('e-t3').textContent = ms(T.preverjanje); setStep('e-s3', 'done');

    // 4 — access (trgovec žeton unovči pri posredniku, M→F)
    setStep('e-s4', 'active');
    s = now();
    const ar = await fetch('/enkratno/service', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Payment': proofToken }, body: JSON.stringify({ prompt }) });
    const aj = await ar.json();
    if (!ar.ok) { setStep('e-s4', 'fail'); throw new Error(aj.message || aj.error || 'Dostop ni uspel'); }
    T.dostop = now() - s; $('e-t4').textContent = ms(T.dostop); setStep('e-s4', 'done');
    T.skupaj = now() - T0; $('e-t5').innerHTML = `<strong>${ms(T.skupaj)}</strong>`;
    $('e-result').textContent = aj.response; show($('e-result'), true);
  } catch (err) { eErr(err.message || String(err)); }
  finally { refreshSeja(); }
}

// ════════════════════════════ 2) TX (SSE) ═══════════════════════════════════
let txES = null;
function logLine(box, cls, text) { const d = document.createElement('div'); d.className = `logline ${cls || ''}`; d.textContent = text; box.appendChild(d); box.scrollTop = box.scrollHeight; }

// Zaganjalnika porabljata denarnico, zato poleg prijave zahtevata še žeton, ki ga
// je mogoče prebrati samo z iste izvorne strani (zaščita pred CSRF).
async function runToken() {
  const r = await fetch('/run/zeton', { cache: 'no-store' });
  if (r.status === 401) { location.href = '/prijava'; throw new Error('Seja je potekla'); }
  const { zeton } = await r.json();
  if (!zeton) { location.href = '/prijava'; throw new Error('Seja je potekla'); }
  return zeton;
}

// EventSource ne pove statusne kode — ob napaki preverimo, ali je kriva potekla seja,
// da uporabnik ne obtiči brez pojasnila.
async function sseNapaka(box) {
  try {
    const r = await fetch('/seja', { cache: 'no-store' });
    if (r.status === 401) { logLine(box, 'fail', 'Seja je potekla — preusmerjam na prijavo…'); setTimeout(() => { location.href = '/prijava'; }, 1200); return; }
  } catch { /* omrežna napaka — pusti splošno sporočilo */ }
  logLine(box, 'fail', 'Povezava s strežnikom je prekinjena.');
}

$('tx-run').addEventListener('click', async () => {
  const n = Math.max(1, Math.min(200, parseInt($('tx-n').value || '20', 10)));
  $('tx-run').disabled = true; $('tx-stop').disabled = false;
  $('tx-count').textContent = '0'; $('tx-onchain').textContent = '0'; $('tx-fee').textContent = '0';
  $('tx-bar').style.width = '0%'; $('tx-log').innerHTML = '';
  let zeton;
  try { zeton = await runToken(); } catch (e) { logLine($('tx-log'), 'fail', e.message); stopTx(); return; }
  txES = new EventSource(`/run/tx?queries=${n}&zeton=${encodeURIComponent(zeton)}`);
  txES.addEventListener('zacetek', (e) => { const d = JSON.parse(e.data); logLine($('tx-log'), 'muted', `Začetek · ${d.nacin} · ${d.poizvedbe} poizvedb · plačnik ${d.placnik.slice(0, 10)}…`); });
  txES.addEventListener('poizvedba', (e) => {
    const d = JSON.parse(e.data);
    $('tx-count').textContent = d.i; $('tx-onchain').textContent = d.onChainTx;
    if (d.cumFeeEth) $('tx-fee').textContent = d.cumFeeEth.toFixed(8);
    $('tx-bar').style.width = `${(d.i / n) * 100}%`;
    logLine($('tx-log'), '', `#${d.i} · T=${d.reading.temperature_c}°C RH=${d.reading.humidity_pct}% · t_skupaj=${d.tSkupajMs} ms${d.gasUsed ? ` · gas=${d.gasUsed}` : ''}${d.feeEth ? ` · +${d.feeEth.toFixed(8)} ETH` : ''}`);
  });
  txES.addEventListener('povzetek', (e) => { const d = JSON.parse(e.data); logLine($('tx-log'), 'ok', `Povzetek · ${d.uspesnih} uspešnih · on-chain transakcij: ${d.onChainTransakcij}${d.kumulativnaProvizijaEth ? ` · skupaj gas ${d.kumulativnaProvizijaEth} ETH` : ''}`); });
  txES.addEventListener('napaka', (e) => { const d = JSON.parse(e.data); logLine($('tx-log'), 'fail', `Napaka${d.i ? ` #${d.i}` : ''}: ${d.message}`); });
  txES.addEventListener('konec', () => stopTx());
  txES.onerror = () => { sseNapaka($('tx-log')); stopTx(); };
});
function stopTx() { if (txES) { txES.close(); txES = null; } $('tx-run').disabled = false; $('tx-stop').disabled = true; refreshSeja(); }
$('tx-stop').addEventListener('click', stopTx);

// ════════════════════════════ 3) MERJENO (SSE) ══════════════════════════════
let mES = null, mDeposit = 0, mLat = [];
const median = (a) => { if (!a.length) return '—'; const b = a.slice().sort((x, y) => x - y); return b[Math.floor(b.length / 2)].toFixed(2); };

$('m-run').addEventListener('click', async () => {
  const n = Math.max(1, Math.min(200, parseInt($('m-n').value || '20', 10)));
  $('m-run').disabled = true; $('m-stop').disabled = false;
  $('m-count').textContent = '0'; $('m-onchain').textContent = '1'; $('m-lat').textContent = '—';
  $('m-bar').style.width = '100%'; $('m-log').innerHTML = ''; show($('m-session'), false); mLat = []; mDeposit = 0;
  let zeton;
  try { zeton = await runToken(); } catch (e) { logLine($('m-log'), 'fail', e.message); stopM(); return; }
  mES = new EventSource(`/run/merjeno?debits=${n}&zeton=${encodeURIComponent(zeton)}`);
  mES.addEventListener('zacetek', (e) => { const d = JSON.parse(e.data); logLine($('m-log'), 'muted', `Začetek · ${d.nacin} · ${d.bremenitve} bremenitev · plačnik ${d.placnik.slice(0, 10)}…`); });
  mES.addEventListener('seja', (e) => {
    const d = JSON.parse(e.data); mDeposit = Number(d.depositWei);
    $('m-sid').textContent = d.sessionId; $('m-dep').textContent = `${d.depositWei} wei`;
    $('m-bud').textContent = `${d.budgetWei} wei`; $('m-exp').textContent = new Date(d.expiresAt).toLocaleString('sl-SI');
    show($('m-session'), true);
    logLine($('m-log'), 'ok', `Seja odprta (1 on-chain transakcija)${d.gasUsed ? ` · gas=${d.gasUsed}` : ''}`);
  });
  mES.addEventListener('bremenitev', (e) => {
    const d = JSON.parse(e.data);
    $('m-count').textContent = d.i; mLat.push(d.tPodpisMs + d.tZahtevaMs); $('m-lat').textContent = median(mLat);
    if (mDeposit > 0 && d.dobroimetjeWei != null) $('m-bar').style.width = `${Math.max(0, (Number(d.dobroimetjeWei) / mDeposit) * 100)}%`;
    logLine($('m-log'), '', `#${d.i} · T=${d.reading.temperature_c}°C RH=${d.reading.humidity_pct}% · t_podpis=${d.tPodpisMs} ms · t_zahteva=${d.tZahtevaMs} ms · dobroimetje=${d.dobroimetjeWei} wei`);
  });
  mES.addEventListener('povzetek', (e) => { const d = JSON.parse(e.data); $('m-lat').textContent = d.medPodpisMs != null ? (d.medPodpisMs + d.medZahtevaMs).toFixed(2) : median(mLat); logLine($('m-log'), 'ok', `Povzetek · ${d.uspesnih} bremenitev · on-chain transakcij: ${d.onChainTransakcij} · končno dobroimetje ${d.koncnoDobroimetjeWei} wei`); });
  mES.addEventListener('napaka', (e) => { const d = JSON.parse(e.data); logLine($('m-log'), 'fail', `Napaka${d.i ? ` #${d.i}` : ''}: ${d.message}`); });
  mES.addEventListener('konec', () => stopM());
  mES.onerror = () => { sseNapaka($('m-log')); stopM(); };
});
function stopM() { if (mES) { mES.close(); mES = null; } $('m-run').disabled = false; $('m-stop').disabled = true; refreshSeja(); }
$('m-stop').addEventListener('click', stopM);

init().catch((e) => { $('mode-badge').textContent = `Napaka: ${e.message}`; });
