// x402 v2 UI for folder 01 (complements app.js; app.js is untouched).
// Uses window.X402Client from the /x402-browser.js bundle (official @x402/* SDK).
const $ = (id) => document.getElementById(id);
const CHAIN_HEX = '0xaa36a7'; // Ethereum Sepolia 11155111 — same chain as app.js
let client = null;

async function init() {
  try {
    const r = await fetch('/x402/config');
    if (r.status !== 200) throw new Error();
    const c = await r.json();
    $('x-status').textContent = `${c.network} · price ${c.priceAtomic} atomic (${(c.priceAtomic / 10 ** c.assetDecimals).toFixed(c.assetDecimals)} ${c.assetName})${c.mock ? ' · MOCK' : ''}`;
  } catch {
    $('x-status').textContent = 'x402 mode is not enabled (start the server with X402_MODE=self)';
    $('x402-card').style.opacity = '0.5';
  }
}

$('x-connect').onclick = async () => {
  try {
    if (!window.ethereum) throw new Error('MetaMask is not available');
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
    const [addr] = await window.ethereum.request({ method: 'eth_requestAccounts' });
    client = window.X402Client.makeClient(window.X402Client.makeMetaMaskSigner(window.ethereum, addr));
    $('x-status').textContent = `connected: ${addr.slice(0, 10)}… (Ethereum Sepolia)`;
    $('x-pay').disabled = false;
  } catch (e) { $('x-status').textContent = 'error: ' + e.message; }
};

$('x-pay').onclick = async () => {
  try {
    const prompt = (document.getElementById('prompt') && document.getElementById('prompt').value) || 'Hello, x402!';
    const r = await window.X402Client.payFlow({ url: '/x402/service?prompt=' + encodeURIComponent(prompt), client });
    const body = await r.res.json();
    $('x-result').textContent = JSON.stringify({
      status: r.status, t_402_ms: +r.t.t402.toFixed(1), t_sign_ms: +(r.t.tSign || 0).toFixed(1),
      t_payment_ms: +(r.t.tPayment || 0).toFixed(1), txHash: r.txHash, synthetic: r.synthetic, response: body
    }, null, 2);
    $('x-result').classList.remove('hidden');
  } catch (e) { $('x-result').textContent = 'error: ' + e.message; $('x-result').classList.remove('hidden'); }
};

init();
