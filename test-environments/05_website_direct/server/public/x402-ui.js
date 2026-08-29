// x402 v2 — UI for the parallel x402 flows (complements app.js; app.js is untouched).
// Uses window.X402Client from the /x402-browser.js bundle (official @x402/* SDK).
const $ = (id) => document.getElementById(id);
const CHAIN_HEX = '0xaa36a7'; // Ethereum Sepolia 11155111 — same chain as app.js

let cfgX = null;
let signer = null, client = null;

async function loadCfg() {
  try {
    const r = await fetch('/x402/config');
    if (r.status !== 200) throw new Error(String(r.status));
    cfgX = await r.json();
    $('x-network').textContent = `${cfgX.network} (Ethereum Sepolia)${cfgX.mock ? ' · MOCK' : ''}`;
    $('x-price').textContent = `${cfgX.single.priceAtomic} atomic (${(cfgX.single.priceAtomic / 10 ** cfgX.assetDecimals).toFixed(cfgX.assetDecimals)} ${cfgX.assetName})`;
  } catch {
    // x402 mode is not enabled — the cards stay visible, but with a clear state
    for (const id of ['x-single-card', 'x-tx-card', 'x-m-card']) {
      const el = $(id); if (el) el.style.opacity = '0.45';
    }
    if ($('x-network')) $('x-network').textContent = 'x402 mode is not enabled (X402_MODE=self)';
    return false;
  }
  return true;
}

async function ensureSepolia() {
  const cur = await window.ethereum.request({ method: 'eth_chainId' });
  if (cur !== CHAIN_HEX) {
    try { await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_HEX }] }); }
    catch (e) {
      if (e && e.code === 4902) {
        await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [{
          chainId: CHAIN_HEX, chainName: 'Ethereum Sepolia', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
          rpcUrls: ['https://ethereum-sepolia-rpc.publicnode.com'], blockExplorerUrls: ['https://sepolia.etherscan.io']
        }] });
      } else throw e;
    }
  }
}

// ── 1 · single (MetaMask signs an EIP-3009 authorization) ──────────────────
if ($('x-connect')) $('x-connect').onclick = async () => {
  try {
    if (!window.ethereum) throw new Error('MetaMask is not available');
    await ensureSepolia();
    const [addr] = await window.ethereum.request({ method: 'eth_requestAccounts' });
    signer = window.X402Client.makeMetaMaskSigner(window.ethereum, addr);
    client = window.X402Client.makeClient(signer);
    $('x-wallet').textContent = addr.slice(0, 10) + '… (Ethereum Sepolia)';
    $('x-pay').disabled = false;
  } catch (e) { $('x-err').textContent = e.message; $('x-err').classList.remove('hidden'); }
};
if ($('x-pay')) $('x-pay').onclick = async () => {
  $('x-err').classList.add('hidden'); $('x-result').classList.add('hidden');
  try {
    const r = await window.X402Client.payFlow({ url: '/x402/single/service', client });
    $('x-t1').textContent = r.t.t402.toFixed(1) + ' ms';
    $('x-t2').textContent = (r.t.tSign || 0).toFixed(1) + ' ms';
    $('x-t3').textContent = (r.t.tPayment || 0).toFixed(1) + ' ms';
    $('x-timing').classList.remove('hidden');
    const body = await r.res.json();
    $('x-result').textContent = JSON.stringify({ status: r.status, txHash: r.txHash, synthetic: r.synthetic, response: body }, null, 2);
    $('x-result').classList.remove('hidden');
  } catch (e) { $('x-err').textContent = e.message; $('x-err').classList.remove('hidden'); }
};

// ── SSE runners (as in app.js: /run/token → EventSource) ─────────────────────
async function runToken() { const r = await fetch('/run/token'); return (await r.json()).token; }
const logLine = (el, txt) => { const d = document.createElement('div'); d.textContent = txt; el.prepend(d); };

let xtxES = null;
if ($('xtx-run')) $('xtx-run').onclick = async () => {
  const n = parseInt($('xtx-n').value || '20', 10);
  const token = await runToken();
  $('xtx-run').disabled = true; $('xtx-stop').disabled = false;
  $('xtx-count').textContent = '0'; $('xtx-settled').textContent = '0'; $('xtx-sum').textContent = '0';
  $('xtx-log').innerHTML = '';
  xtxES = new EventSource(`/run/x402-tx?queries=${n}&token=${encodeURIComponent(token)}`);
  xtxES.addEventListener('start', (e) => { const d = JSON.parse(e.data); logLine($('xtx-log'), `▶ x402 ${d.mode} · ${d.network} · payer ${d.payer.slice(0, 10)}… · gas paid by ${d.gasPayer}`); });
  xtxES.addEventListener('query', (e) => {
    const d = JSON.parse(e.data);
    $('xtx-count').textContent = d.i; $('xtx-settled').textContent = d.i;
    $('xtx-sum').textContent = d.cumulativeAtomic;
    logLine($('xtx-log'), `✓ ${d.i} · T=${d.reading ? d.reading.temperature_c : '—'}°C · settlement ${d.txHash ? d.txHash.slice(0, 16) + '…' : '—'}${d.synthetic ? ' (synthetic)' : ''}`);
  });
  xtxES.addEventListener('summary', (e) => { const d = JSON.parse(e.data); logLine($('xtx-log'), `■ succeeded ${d.succeeded}/${d.queryCount} · settlements ${d.settlements} · total ${d.totalAtomic} atomic · gas: ${d.gasPayer}`); });
  xtxES.addEventListener('error', (e) => { const d = JSON.parse(e.data); logLine($('xtx-log'), `✗ ${d.message}`); });
  xtxES.addEventListener('end', () => { $('xtx-run').disabled = false; $('xtx-stop').disabled = true; xtxES.close(); });
  xtxES.onerror = () => { $('xtx-run').disabled = false; $('xtx-stop').disabled = true; try { xtxES.close(); } catch {} };
};
if ($('xtx-stop')) $('xtx-stop').onclick = () => { try { xtxES.close(); } catch {} $('xtx-run').disabled = false; $('xtx-stop').disabled = true; };

let xmES = null;
if ($('xm-run')) $('xm-run').onclick = async () => {
  const n = parseInt($('xm-n').value || '20', 10);
  const token = await runToken();
  $('xm-run').disabled = true; $('xm-stop').disabled = false;
  $('xm-count').textContent = '0'; $('xm-onchain').textContent = '0'; $('xm-bal').textContent = '—';
  $('xm-log').innerHTML = ''; $('xm-session').classList.add('hidden');
  xmES = new EventSource(`/run/x402-metered?debits=${n}&token=${encodeURIComponent(token)}`);
  xmES.addEventListener('start', (e) => { const d = JSON.parse(e.data); logLine($('xm-log'), `▶ x402 ${d.mode} · ${d.network} · payer ${d.payer.slice(0, 10)}…`); });
  xmES.addEventListener('session', (e) => {
    const d = JSON.parse(e.data);
    $('xm-sid').textContent = d.sessionId; $('xm-dep').textContent = d.depositAtomic + ' atomic';
    $('xm-tx').textContent = (d.txHash || '—').slice(0, 22) + (d.synthetic ? '… (synthetic)' : '…');
    $('xm-onchain').textContent = '1';
    $('xm-session').classList.remove('hidden');
    logLine($('xm-log'), `⛓ ON-CHAIN TOP-UP · session ${d.sessionId.slice(0, 16)}… · deposit ${d.depositAtomic} atomic`);
  });
  xmES.addEventListener('debit', (e) => {
    const d = JSON.parse(e.data);
    $('xm-count').textContent = d.i; $('xm-bal').textContent = d.balanceAtomic;
    logLine($('xm-log'), `✎ OFF-CHAIN debit ${d.i} · ${d.chargedAtomic} atomic · remaining ${d.balanceAtomic} · (no on-chain tx)`);
  });
  xmES.addEventListener('summary', (e) => { const d = JSON.parse(e.data); logLine($('xm-log'), `■ ${d.message || `succeeded ${d.succeeded}`} · on-chain settlements: ${d.settlements}`); });
  xmES.addEventListener('error', (e) => { const d = JSON.parse(e.data); logLine($('xm-log'), `✗ ${d.message}`); });
  xmES.addEventListener('end', () => { $('xm-run').disabled = false; $('xm-stop').disabled = true; xmES.close(); });
  xmES.onerror = () => { $('xm-run').disabled = false; $('xm-stop').disabled = true; try { xmES.close(); } catch {} };
};
if ($('xm-stop')) $('xm-stop').onclick = () => { try { xmES.close(); } catch {} $('xm-run').disabled = false; $('xm-stop').disabled = true; };

loadCfg();
