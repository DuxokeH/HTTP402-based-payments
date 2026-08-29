// X402 MERGED one-time payment — MetaMask demo client (4 HTTP messages).
// Flow: GET /service -> 402; MetaMask pays on-chain; as soon as the receipt is
// in, the client AUTOMATICALLY POSTs {requestId, txHash, ...} + prompt to
// /service and receives content AND the proof token in one 200 response.
// The proof token is saved to sessionStorage; a later GET /service with the
// X-Payment header returns the server's acknowledgment that the payment was
// already made (no second payment).
import {
  createWalletClient, createPublicClient, custom, http,
  parseEther, formatEther, getAddress
} from 'https://esm.sh/viem@2.21.40';
import { sepolia } from 'https://esm.sh/viem@2.21.40/chains';

const $ = (id) => document.getElementById(id);
const PROOF_KEY = 'x402_zdruzena_proof';
let cfg = null, walletClient = null, publicClient = null, account = null;
const STEPS = ['step-request', 'step-pay', 'step-merged'];
const setStep = (id, s) => { const el = $(id); if (!el) return; el.classList.remove('active', 'done', 'fail'); if (s) el.classList.add(s); };
const resetSteps = () => { STEPS.forEach((id) => setStep(id, null)); $('progress').classList.remove('hidden'); };
const showError = (m) => { $('error-msg').textContent = m; $('error-card').classList.remove('hidden'); };
const clearError = () => { $('error-card').classList.add('hidden'); $('error-msg').textContent = ''; };
const ms = (x) => `${x.toFixed(1)} ms`;

function loadProof() {
  try { return JSON.parse(sessionStorage.getItem(PROOF_KEY)); } catch { return null; }
}
function saveProof(p) {
  try { sessionStorage.setItem(PROOF_KEY, JSON.stringify(p)); } catch { /* zasebni način */ }
  refreshProofUi();
}
function clearProof() {
  try { sessionStorage.removeItem(PROOF_KEY); } catch { /* zasebni način */ }
  refreshProofUi();
}
function refreshProofUi() {
  const p = loadProof();
  if (p && p.proofToken) {
    $('proof-status').textContent = `Shranjeno dokazilo: ${p.proofToken.slice(0, 14)}… (tx ${String(p.txHash).slice(0, 10)}…)`;
    $('check-btn').disabled = false;
  } else {
    $('proof-status').textContent = 'Ni shranjenega dokazila.';
    $('check-btn').disabled = true;
    $('proof-result').classList.add('hidden');
  }
}

async function loadConfig() {
  const r = await fetch('/config');
  if (!r.ok) throw new Error('Napaka pri /config');
  cfg = await r.json();
  $('cfg-network').textContent = cfg.network;
  $('cfg-merchant').textContent = cfg.merchant;
  $('cfg-price').textContent = `${cfg.service.price} ${cfg.service.currency} (≈ ${cfg.priceEurApprox} €)`;
  $('cfg-model').textContent = cfg.aiEnabled ? cfg.model : 'demo način';
}

async function ensureSepolia() {
  if (cfg.network !== 'sepolia') return;
  const current = await window.ethereum.request({ method: 'eth_chainId' });
  if (current === cfg.chainId) return;
  try {
    await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: cfg.chainId }] });
  } catch (err) {
    if (err.code === 4902) {
      await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [{
        chainId: cfg.chainId, chainName: 'Sepolia',
        nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: ['https://ethereum-sepolia-rpc.publicnode.com'],
        blockExplorerUrls: ['https://sepolia.etherscan.io']
      }] });
    } else throw err;
  }
}

async function connect() {
  clearError();
  if (!window.ethereum) { showError('MetaMask ni zaznan. Namesti ga z https://metamask.io in osveži.'); return; }
  try {
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    account = getAddress(accounts[0]);
    await ensureSepolia();
    walletClient = createWalletClient({ chain: sepolia, transport: custom(window.ethereum) });
    publicClient = createPublicClient({ chain: sepolia, transport: http() });
    const bal = await publicClient.getBalance({ address: account });
    $('wallet-status').textContent = `${account.slice(0, 6)}…${account.slice(-4)} — ${formatEther(bal).slice(0, 8)} ETH`;
    $('pay-btn').disabled = false;
  } catch (err) { showError(`Napaka denarnice: ${err.message}`); }
}

async function pay() {
  clearError();
  const prompt = $('prompt').value.trim();
  if (!prompt) { showError('Najprej vpiši poziv.'); return; }
  if (!account) { showError('Najprej poveži denarnico.'); return; }

  $('pay-btn').disabled = true;
  $('result-card').classList.add('hidden');
  resetSteps();
  $('timing-card').classList.remove('hidden');
  const T = {}; const now = () => performance.now(); const T0 = now();

  try {
    // 1 — challenge (sporočili 1 in 2)
    setStep('step-request', 'active');
    let s = now();
    const chal = await fetch(`/service?payer=${account}`, { headers: { 'X-Payer': account } });
    if (chal.status !== 402) throw new Error(`Pričakoval 402, dobil ${chal.status}`);
    const { payment } = await chal.json();
    T.izziv = now() - s; $('t-izziv').textContent = ms(T.izziv);
    setStep('step-request', 'done');

    // 2 — send tx + wait (izven HTTP)
    setStep('step-pay', 'active');
    s = now();
    const hash = await walletClient.sendTransaction({ account, to: getAddress(payment.to), value: parseEther(payment.amount) });
    await publicClient.waitForTransactionReceipt({ hash });
    T.potrditev = now() - s; $('t-potrditev').textContent = ms(T.potrditev);
    setStep('step-pay', 'done');

    // 3 — MERGED exchange (sporočili 3 in 4): tx hash od MetaMaska gre
    // SAMODEJNO na strežnik skupaj z naročilom; nazaj prideta vsebina IN žeton.
    setStep('step-merged', 'active');
    s = now();
    const res = await fetch('/service', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: payment.requestId, txHash: hash, network: payment.network, payerAddress: account, prompt })
    });
    const json = await res.json();
    if (!res.ok) { setStep('step-merged', 'fail'); throw new Error(json.message || json.error || 'Združena izmenjava ni uspela'); }
    T.zdruzeno = now() - s; $('t-zdruzeno').textContent = ms(T.zdruzeno);
    setStep('step-merged', 'done');

    T.skupaj = now() - T0; $('t-skupaj').innerHTML = `<strong>${ms(T.skupaj)}</strong>`;
    $('result').textContent = json.response;
    const explorer = `https://sepolia.etherscan.io/tx/${hash}`;
    $('tx-link').href = explorer;
    $('tx-link').textContent = `${hash.slice(0, 10)}…${hash.slice(-8)}`;
    $('result-card').classList.remove('hidden');

    saveProof({ proofToken: json.proofToken, txHash: hash, savedAt: new Date().toISOString() });
  } catch (err) {
    showError(err.message || String(err));
  } finally {
    $('pay-btn').disabled = false;
  }
}

// Ponovni GET z dokazilom: strežnik potrdi, da je plačilo že bilo opravljeno.
async function checkProof() {
  clearError();
  const p = loadProof();
  if (!p || !p.proofToken) { showError('Ni shranjenega dokazila — najprej plačaj.'); return; }
  try {
    const r = await fetch('/service', { headers: { 'X-Payment': p.proofToken } });
    const json = await r.json();
    if (!r.ok) {
      $('proof-result').textContent = JSON.stringify(json, null, 2);
      $('proof-result').classList.remove('hidden');
      if (r.status === 403) { clearProof(); showError('Dokazilo ni več veljavno (poteklo) — strežnik ga je zavrnil.'); }
      return;
    }
    $('proof-result').textContent = JSON.stringify(json, null, 2);
    $('proof-result').classList.remove('hidden');
  } catch (err) { showError(err.message || String(err)); }
}

$('connect-btn').addEventListener('click', connect);
$('pay-btn').addEventListener('click', pay);
$('check-btn').addEventListener('click', checkProof);
refreshProofUi();
loadConfig().catch((e) => showError(`Napaka pri nalaganju konfiguracije: ${e.message}`));
