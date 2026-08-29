import {
  createWalletClient,
  createPublicClient,
  custom,
  http,
  parseEther,
  formatEther,
  getAddress
} from 'https://esm.sh/viem@2.21.40';
import { sepolia } from 'https://esm.sh/viem@2.21.40/chains';

const $ = (id) => document.getElementById(id);

let cfg = null;
let walletClient = null;
let publicClient = null;
let account = null;

const STEPS = ['step-request', 'step-pay', 'step-merged'];

function setStep(id, state) {
  const el = $(id);
  if (!el) return;
  el.classList.remove('active', 'done', 'fail');
  if (state) el.classList.add(state);
}

function resetSteps() {
  STEPS.forEach((id) => setStep(id, null));
  $('progress').classList.remove('hidden');
}

function showError(msg) {
  $('error-msg').textContent = msg;
  $('error-card').classList.remove('hidden');
}

function clearError() {
  $('error-card').classList.add('hidden');
  $('error-msg').textContent = '';
}

async function loadConfig() {
  const r = await fetch('/config');
  if (!r.ok) throw new Error('Failed to load /config');
  cfg = await r.json();
  $('cfg-network').textContent = cfg.network;
  $('cfg-merchant').textContent = cfg.merchant;
  $('cfg-price').textContent = `${cfg.service.price} ${cfg.service.currency}`;
  $('cfg-model').textContent = cfg.aiEnabled ? cfg.model : '(demo mode — no OPENAI_API_KEY)';
}

async function ensureSepolia() {
  if (cfg.network !== 'sepolia') return;
  const current = await window.ethereum.request({ method: 'eth_chainId' });
  if (current === cfg.chainId) return;
  try {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: cfg.chainId }]
    });
  } catch (err) {
    if (err.code === 4902) {
      await window.ethereum.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: cfg.chainId,
          chainName: 'Sepolia',
          nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
          rpcUrls: ['https://ethereum-sepolia-rpc.publicnode.com'],
          blockExplorerUrls: ['https://sepolia.etherscan.io']
        }]
      });
    } else {
      throw err;
    }
  }
}

async function connect() {
  clearError();
  if (!window.ethereum) {
    showError('MetaMask not detected. Install it from https://metamask.io and reload.');
    return;
  }
  try {
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    account = getAddress(accounts[0]);
    await ensureSepolia();
    walletClient = createWalletClient({ chain: sepolia, transport: custom(window.ethereum) });
    // Explicit RPC URL: viem's default sepolia RPC is not in the server CSP
    // connect-src allowlist, which would make getBalance/waitForReceipt fail.
    publicClient = createPublicClient({ chain: sepolia, transport: http('https://ethereum-sepolia-rpc.publicnode.com') });

    const bal = await publicClient.getBalance({ address: account });
    $('wallet-status').textContent =
      `${account.slice(0, 6)}…${account.slice(-4)} — ${formatEther(bal).slice(0, 8)} ETH`;
    $('pay-btn').disabled = false;
  } catch (err) {
    showError(`Wallet error: ${err.message}`);
  }
}

async function pay() {
  clearError();
  const prompt = $('prompt').value.trim();
  if (!prompt) { showError('Enter a prompt first.'); return; }
  if (!account) { showError('Connect your wallet first.'); return; }

  $('pay-btn').disabled = true;
  $('result-card').classList.add('hidden');
  resetSteps();

  try {
    // 1. challenge
    setStep('step-request', 'active');
    const chal = await fetch(`/service?payer=${account}`, { headers: { 'X-Payer': account } });
    if (chal.status !== 402) throw new Error(`Expected 402, got ${chal.status}`);
    const { payment } = await chal.json();
    setStep('step-request', 'done');

    // 2. send tx
    setStep('step-pay', 'active');
    const hash = await walletClient.sendTransaction({
      account,
      to: getAddress(payment.to),
      value: parseEther(payment.amount)
    });
    await publicClient.waitForTransactionReceipt({ hash });
    setStep('step-pay', 'done');

    // 3. merged exchange: proof + prompt in one POST, answer + token in one 200
    setStep('step-merged', 'active');
    const aiRes = await fetch('/service', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: payment.requestId,
        txHash: hash,
        network: payment.network,
        payerAddress: account,
        prompt
      })
    });
    const aiJson = await aiRes.json();
    if (!aiRes.ok) {
      setStep('step-merged', 'fail');
      throw new Error(aiJson.message || aiJson.error || 'Merged exchange failed');
    }
    const proofToken = aiJson.proofToken;
    sessionStorage.setItem('x402_proof', proofToken);
    setStep('step-merged', 'done');

    $('result').textContent = aiJson.response;
    $('proof-token').textContent = proofToken || '—';
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

loadConfig().catch((e) => showError(`Failed to load config: ${e.message}`));
