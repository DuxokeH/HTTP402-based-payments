// X402 MERGED one-time payment — MetaMask demo client (4 HTTP messages).
// Flow: GET /service -> 402; MetaMask pays on-chain; as soon as the receipt is
// in, the client AUTOMATICALLY POSTs {requestId, txHash, ...} + prompt to
// /service and receives content AND the proof token in one 200 response.
// The proof token is saved to sessionStorage; a later GET /service with the
// X-Payment header returns the server's confirmation that the payment was
// already made (no second payment).
import {
  createWalletClient, createPublicClient, custom, http,
  parseEther, formatEther, getAddress
} from 'https://esm.sh/viem@2.21.40';
import { sepolia } from 'https://esm.sh/viem@2.21.40/chains';

const $ = (id) => document.getElementById(id);
const PROOF_KEY = 'x402_merged_proof';
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
  try { sessionStorage.setItem(PROOF_KEY, JSON.stringify(p)); } catch { /* private mode */ }
  refreshProofUi();
}
function clearProof() {
  try { sessionStorage.removeItem(PROOF_KEY); } catch { /* private mode */ }
  refreshProofUi();
}
function refreshProofUi() {
  const p = loadProof();
  if (p && p.proofToken) {
    $('proof-status').textContent = `Stored proof: ${p.proofToken.slice(0, 14)}… (tx ${String(p.txHash).slice(0, 10)}…)`;
    $('check-btn').disabled = false;
  } else {
    $('proof-status').textContent = 'No stored proof.';
    $('check-btn').disabled = true;
    $('proof-result').classList.add('hidden');
  }
}

async function loadConfig() {
  const r = await fetch('/config');
  if (!r.ok) throw new Error('Error fetching /config');
  cfg = await r.json();
  $('cfg-network').textContent = cfg.network;
  $('cfg-merchant').textContent = cfg.merchant;
  $('cfg-price').textContent = `${cfg.service.price} ${cfg.service.currency} (≈ ${cfg.priceEurApprox} €)`;
  $('cfg-model').textContent = cfg.aiEnabled ? cfg.model : 'demo mode';
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
  if (!window.ethereum) { showError('MetaMask not detected. Install it from https://metamask.io and refresh.'); return; }
  try {
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    account = getAddress(accounts[0]);
    await ensureSepolia();
    walletClient = createWalletClient({ chain: sepolia, transport: custom(window.ethereum) });
    publicClient = createPublicClient({ chain: sepolia, transport: http() });
    const bal = await publicClient.getBalance({ address: account });
    $('wallet-status').textContent = `${account.slice(0, 6)}…${account.slice(-4)} — ${formatEther(bal).slice(0, 8)} ETH`;
    $('pay-btn').disabled = false;
  } catch (err) { showError(`Wallet error: ${err.message}`); }
}

async function pay() {
  clearError();
  const prompt = $('prompt').value.trim();
  if (!prompt) { showError('Enter a prompt first.'); return; }
  if (!account) { showError('Connect the wallet first.'); return; }

  $('pay-btn').disabled = true;
  $('result-card').classList.add('hidden');
  resetSteps();
  $('timing-card').classList.remove('hidden');
  const T = {}; const now = () => performance.now(); const T0 = now();

  try {
    // 1 — challenge (messages 1 and 2)
    setStep('step-request', 'active');
    let s = now();
    const chal = await fetch(`/service?payer=${account}`, { headers: { 'X-Payer': account } });
    if (chal.status !== 402) throw new Error(`Expected 402, got ${chal.status}`);
    const { payment } = await chal.json();
    T.challenge = now() - s; $('t-challenge').textContent = ms(T.challenge);
    setStep('step-request', 'done');

    // 2 — send tx + wait (outside HTTP)
    setStep('step-pay', 'active');
    s = now();
    const hash = await walletClient.sendTransaction({ account, to: getAddress(payment.to), value: parseEther(payment.amount) });
    await publicClient.waitForTransactionReceipt({ hash });
    T.confirm = now() - s; $('t-confirm').textContent = ms(T.confirm);
    setStep('step-pay', 'done');

    // 3 — MERGED exchange (messages 3 and 4): the tx hash from MetaMask goes
    // AUTOMATICALLY to the server together with the order; content AND the token come back.
    setStep('step-merged', 'active');
    s = now();
    const res = await fetch('/service', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: payment.requestId, txHash: hash, network: payment.network, payerAddress: account, prompt })
    });
    const json = await res.json();
    if (!res.ok) { setStep('step-merged', 'fail'); throw new Error(json.message || json.error || 'The merged exchange failed'); }
    T.merged = now() - s; $('t-merged').textContent = ms(T.merged);
    setStep('step-merged', 'done');

    T.total = now() - T0; $('t-total').innerHTML = `<strong>${ms(T.total)}</strong>`;
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

// Repeated GET with the proof: the server confirms that the payment has already been made.
async function checkProof() {
  clearError();
  const p = loadProof();
  if (!p || !p.proofToken) { showError('No stored proof — pay first.'); return; }
  try {
    const r = await fetch('/service', { headers: { 'X-Payment': p.proofToken } });
    const json = await r.json();
    if (!r.ok) {
      $('proof-result').textContent = JSON.stringify(json, null, 2);
      $('proof-result').classList.remove('hidden');
      if (r.status === 403) { clearProof(); showError('The proof is no longer valid (expired) — the server rejected it.'); }
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
loadConfig().catch((e) => showError(`Error loading the configuration: ${e.message}`));
