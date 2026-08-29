// x402 v2 UI za mapo 01 (dopolnjuje app.js; app.js je nedotaknjen).
// Uporablja window.X402Klient iz svežnja /x402-klient.js (uradni @x402/* SDK).
const $ = (id) => document.getElementById(id);
const CHAIN_HEX = '0xaa36a7'; // Ethereum Sepolia 11155111 — ista veriga kot app.js
let client = null;

async function init() {
  try {
    const r = await fetch('/x402/config');
    if (r.status !== 200) throw new Error();
    const c = await r.json();
    $('x-status').textContent = `${c.network} · cena ${c.priceAtomic} atomic (${(c.priceAtomic / 10 ** c.assetDecimals).toFixed(c.assetDecimals)} ${c.assetName})${c.mock ? ' · MOCK' : ''}`;
  } catch {
    $('x-status').textContent = 'x402 način ni vklopljen (zaženi strežnik z X402_MODE=self)';
    $('x402-card').style.opacity = '0.5';
  }
}

$('x-connect').onclick = async () => {
  try {
    if (!window.ethereum) throw new Error('MetaMask ni na voljo');
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
    client = window.X402Klient.makeClient(window.X402Klient.makeMetaMaskSigner(window.ethereum, addr));
    $('x-status').textContent = `povezan: ${addr.slice(0, 10)}… (Ethereum Sepolia)`;
    $('x-pay').disabled = false;
  } catch (e) { $('x-status').textContent = 'napaka: ' + e.message; }
};

$('x-pay').onclick = async () => {
  try {
    const prompt = (document.getElementById('prompt') && document.getElementById('prompt').value) || 'Pozdravljen, x402!';
    const r = await window.X402Klient.payFlow({ url: '/x402/service?prompt=' + encodeURIComponent(prompt), client });
    const body = await r.res.json();
    $('x-result').textContent = JSON.stringify({
      status: r.status, t_402_ms: +r.t.t402.toFixed(1), t_podpis_ms: +(r.t.tPodpis || 0).toFixed(1),
      t_placilo_ms: +(r.t.tPlacilo || 0).toFixed(1), txHash: r.txHash, sinteticni: r.sinteticni, odgovor: body
    }, null, 2);
    $('x-result').classList.remove('hidden');
  } catch (e) { $('x-result').textContent = 'napaka: ' + e.message; $('x-result').classList.remove('hidden'); }
};

init();
