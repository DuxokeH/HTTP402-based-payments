// X402 one-time payment — MetaMask demo client with in-browser phase timing.
// The timing panel lets you screenshot latency alongside a Wireshark capture.
import {
  createWalletClient, createPublicClient, custom, http,
  parseEther, formatEther, getAddress
} from 'https://esm.sh/viem@2.21.40';
import { sepolia } from 'https://esm.sh/viem@2.21.40/chains';

const $ = (id) => document.getElementById(id);
let cfg = null, walletClient = null, publicClient = null, account = null;
const STEPS = ['step-request', 'step-pay', 'step-verify', 'step-ai'];
const setStep = (id, s) => { const el = $(id); if (!el) return; el.classList.remove('active', 'done', 'fail'); if (s) el.classList.add(s); };
const resetSteps = () => { STEPS.forEach((id) => setStep(id, null)); $('progress').classList.remove('hidden'); };
const showError = (m) => { $('error-msg').textContent = m; $('error-card').classList.remove('hidden'); };
const clearError = () => { $('error-card').classList.add('hidden'); $('error-msg').textContent = ''; };
const ms = (x) => `${x.toFixed(1)} ms`;

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
    // 1 — challenge
    setStep('step-request', 'active');
    let s = now();
    const chal = await fetch(`/service?payer=${account}`, { headers: { 'X-Payer': account } });
    if (chal.status !== 402) throw new Error(`Expected 402, got ${chal.status}`);
    const { payment } = await chal.json();
    T.challenge = now() - s; $('t-challenge').textContent = ms(T.challenge);
    setStep('step-request', 'done');

    // 2 — send tx + wait
    setStep('step-pay', 'active');
    s = now();
    const hash = await walletClient.sendTransaction({ account, to: getAddress(payment.to), value: parseEther(payment.amount) });
    await publicClient.waitForTransactionReceipt({ hash });
    T.confirm = now() - s; $('t-confirm').textContent = ms(T.confirm);
    setStep('step-pay', 'done');

    // 3 — verify
    setStep('step-verify', 'active');
    s = now();
    const verifyRes = await fetch('/verify-payment', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: payment.requestId, txHash: hash, network: payment.network, payerAddress: account })
    });
    const verifyJson = await verifyRes.json();
    if (!verifyRes.ok) { setStep('step-verify', 'fail'); throw new Error(verifyJson.message || verifyJson.error || 'Verification failed'); }
    T.verify = now() - s; $('t-verify').textContent = ms(T.verify);
    const proofToken = verifyJson.proofToken;
    setStep('step-verify', 'done');

    // 4 — access
    setStep('step-ai', 'active');
    s = now();
    const aiRes = await fetch('/service', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Payment': proofToken },
      body: JSON.stringify({ prompt })
    });
    const aiJson = await aiRes.json();
    if (!aiRes.ok) { setStep('step-ai', 'fail'); throw new Error(aiJson.message || aiJson.error || 'Access failed'); }
    T.access = now() - s; $('t-access').textContent = ms(T.access);
    setStep('step-ai', 'done');

    T.total = now() - T0; $('t-total').innerHTML = `<strong>${ms(T.total)}</strong>`;
    $('result').textContent = aiJson.response;
    const explorer = `https://sepolia.etherscan.io/tx/${hash}`;
    $('tx-link').href = explorer;
    $('tx-link').textContent = `${hash.slice(0, 10)}…${hash.slice(-8)}`;
    $('result-card').classList.remove('hidden');
  } catch (err) {
    showError(err.message || String(err));
  } finally {
    $('pay-btn').disabled = false;
  }
}

$('connect-btn').addEventListener('click', connect);
$('pay-btn').addEventListener('click', pay);
loadConfig().catch((e) => showError(`Error loading the configuration: ${e.message}`));
