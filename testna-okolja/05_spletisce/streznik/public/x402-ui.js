// x402 v2 — UI za vzporedne x402 tokove (dopolnjuje app.js; app.js je nedotaknjen).
// Uporablja window.X402Klient iz svežnja /x402-klient.js (uradni @x402/* SDK).
const $ = (id) => document.getElementById(id);
const CHAIN_HEX = '0xaa36a7'; // Ethereum Sepolia 11155111 — ista veriga kot app.js

let cfgX = null;
let signer = null, client = null;

async function loadCfg() {
  try {
    const r = await fetch('/x402/config');
    if (r.status !== 200) throw new Error(String(r.status));
    cfgX = await r.json();
    $('x-network').textContent = `${cfgX.network} (Ethereum Sepolia)${cfgX.mock ? ' · MOCK' : ''}`;
    $('x-price').textContent = `${cfgX.enkratno.priceAtomic} atomic (${(cfgX.enkratno.priceAtomic / 10 ** cfgX.assetDecimals).toFixed(cfgX.assetDecimals)} ${cfgX.assetName})`;
  } catch {
    // x402 način ni vklopljen — kartice ostanejo, a z jasnim stanjem
    for (const id of ['x-enkratno-card', 'x-tx-card', 'x-m-card']) {
      const el = $(id); if (el) el.style.opacity = '0.45';
    }
    if ($('x-network')) $('x-network').textContent = 'x402 način ni vklopljen (X402_MODE=self)';
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

// ── 1 · enkratno (MetaMask podpiše EIP-3009 pooblastilo) ─────────────────────
if ($('x-connect')) $('x-connect').onclick = async () => {
  try {
    if (!window.ethereum) throw new Error('MetaMask ni na voljo');
    await ensureSepolia();
    const [addr] = await window.ethereum.request({ method: 'eth_requestAccounts' });
    signer = window.X402Klient.makeMetaMaskSigner(window.ethereum, addr);
    client = window.X402Klient.makeClient(signer);
    $('x-wallet').textContent = addr.slice(0, 10) + '… (Ethereum Sepolia)';
    $('x-pay').disabled = false;
  } catch (e) { $('x-err').textContent = e.message; $('x-err').classList.remove('hidden'); }
};
if ($('x-pay')) $('x-pay').onclick = async () => {
  $('x-err').classList.add('hidden'); $('x-result').classList.add('hidden');
  try {
    const r = await window.X402Klient.payFlow({ url: '/x402/enkratno/service', client });
    $('x-t1').textContent = r.t.t402.toFixed(1) + ' ms';
    $('x-t2').textContent = (r.t.tPodpis || 0).toFixed(1) + ' ms';
    $('x-t3').textContent = (r.t.tPlacilo || 0).toFixed(1) + ' ms';
    $('x-timing').classList.remove('hidden');
    const body = await r.res.json();
    $('x-result').textContent = JSON.stringify({ status: r.status, txHash: r.txHash, sinteticni: r.sinteticni, odgovor: body }, null, 2);
    $('x-result').classList.remove('hidden');
  } catch (e) { $('x-err').textContent = e.message; $('x-err').classList.remove('hidden'); }
};

// ── SSE zaganjalnika (kot app.js: /run/zeton → EventSource) ──────────────────
async function runToken() { const r = await fetch('/run/zeton'); return (await r.json()).zeton; }
const logLine = (el, txt) => { const d = document.createElement('div'); d.textContent = txt; el.prepend(d); };

let xtxES = null;
if ($('xtx-run')) $('xtx-run').onclick = async () => {
  const n = parseInt($('xtx-n').value || '20', 10);
  const zeton = await runToken();
  $('xtx-run').disabled = true; $('xtx-stop').disabled = false;
  $('xtx-count').textContent = '0'; $('xtx-settled').textContent = '0'; $('xtx-sum').textContent = '0';
  $('xtx-log').innerHTML = '';
  xtxES = new EventSource(`/run/x402-tx?queries=${n}&zeton=${encodeURIComponent(zeton)}`);
  xtxES.addEventListener('zacetek', (e) => { const d = JSON.parse(e.data); logLine($('xtx-log'), `▶ x402 ${d.nacin} · ${d.omrezje} · plačnik ${d.placnik.slice(0, 10)}… · gas plača ${d.placnikGasa}`); });
  xtxES.addEventListener('poizvedba', (e) => {
    const d = JSON.parse(e.data);
    $('xtx-count').textContent = d.i; $('xtx-settled').textContent = d.i;
    $('xtx-sum').textContent = d.kumulativnoAtomic;
    logLine($('xtx-log'), `✓ ${d.i} · T=${d.reading ? d.reading.temperature_c : '—'}°C · poravnava ${d.txHash ? d.txHash.slice(0, 16) + '…' : '—'}${d.sinteticni ? ' (sintetična)' : ''}`);
  });
  xtxES.addEventListener('povzetek', (e) => { const d = JSON.parse(e.data); logLine($('xtx-log'), `■ uspešnih ${d.uspesnih}/${d.poizvedb} · poravnav ${d.poravnav} · skupaj ${d.skupajAtomic} atomic · gas: ${d.placnikGasa}`); });
  xtxES.addEventListener('napaka', (e) => { const d = JSON.parse(e.data); logLine($('xtx-log'), `✗ ${d.message}`); });
  xtxES.addEventListener('konec', () => { $('xtx-run').disabled = false; $('xtx-stop').disabled = true; xtxES.close(); });
  xtxES.onerror = () => { $('xtx-run').disabled = false; $('xtx-stop').disabled = true; try { xtxES.close(); } catch {} };
};
if ($('xtx-stop')) $('xtx-stop').onclick = () => { try { xtxES.close(); } catch {} $('xtx-run').disabled = false; $('xtx-stop').disabled = true; };

let xmES = null;
if ($('xm-run')) $('xm-run').onclick = async () => {
  const n = parseInt($('xm-n').value || '20', 10);
  const zeton = await runToken();
  $('xm-run').disabled = true; $('xm-stop').disabled = false;
  $('xm-count').textContent = '0'; $('xm-onchain').textContent = '0'; $('xm-bal').textContent = '—';
  $('xm-log').innerHTML = ''; $('xm-session').classList.add('hidden');
  xmES = new EventSource(`/run/x402-merjeno?debits=${n}&zeton=${encodeURIComponent(zeton)}`);
  xmES.addEventListener('zacetek', (e) => { const d = JSON.parse(e.data); logLine($('xm-log'), `▶ x402 ${d.nacin} · ${d.omrezje} · plačnik ${d.placnik.slice(0, 10)}…`); });
  xmES.addEventListener('seja', (e) => {
    const d = JSON.parse(e.data);
    $('xm-sid').textContent = d.sessionId; $('xm-dep').textContent = d.depositAtomic + ' atomic';
    $('xm-tx').textContent = (d.txHash || '—').slice(0, 22) + (d.sinteticni ? '… (sintetična)' : '…');
    $('xm-onchain').textContent = '1';
    $('xm-session').classList.remove('hidden');
    logLine($('xm-log'), `⛓ ON-CHAIN POLNITEV · seja ${d.sessionId.slice(0, 16)}… · polog ${d.depositAtomic} atomic`);
  });
  xmES.addEventListener('bremenitev', (e) => {
    const d = JSON.parse(e.data);
    $('xm-count').textContent = d.i; $('xm-bal').textContent = d.balanceAtomic;
    logLine($('xm-log'), `✎ OFF-CHAIN bremenitev ${d.i} · ${d.chargedAtomic} atomic · ostane ${d.balanceAtomic} · (brez verige)`);
  });
  xmES.addEventListener('povzetek', (e) => { const d = JSON.parse(e.data); logLine($('xm-log'), `■ ${d.sporocilo || `uspešnih ${d.uspesnih}`} · on-chain poravnav: ${d.poravnav}`); });
  xmES.addEventListener('napaka', (e) => { const d = JSON.parse(e.data); logLine($('xm-log'), `✗ ${d.message}`); });
  xmES.addEventListener('konec', () => { $('xm-run').disabled = false; $('xm-stop').disabled = true; xmES.close(); });
  xmES.onerror = () => { $('xm-run').disabled = false; $('xm-stop').disabled = true; try { xmES.close(); } catch {} };
};
if ($('xm-stop')) $('xm-stop').onclick = () => { try { xmES.close(); } catch {} $('xm-run').disabled = false; $('xm-stop').disabled = true; };

loadCfg();
