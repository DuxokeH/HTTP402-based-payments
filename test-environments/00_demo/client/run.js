#!/usr/bin/env node

/**
 * X402 Client - END-TO-END Implementation (ZDRUŽENI TOK)
 *
 * Klient za X402 plačilni protokol z PRAVIMI Ethereum transakcijami na Sepolia testnet.
 * BREZ facilitatorja - direktna komunikacija s hosting serverjem.
 *
 * Združeni tok: na žici sta natanko DVA para zahteva/odgovor:
 *   1. GET /service                          → 402 Payment Required (JSON račun)
 *   2. POST /service {requestId, txHash, prompt} → 200 OK {response, proofToken}
 *
 * Argumenti:
 *   --prompt <besedilo>   vprašanje za AI (privzeto demo vprašanje)
 *   --pause-ms <n>        premor med izmenjavama (preglednejši zajem v Wiresharku)
 *   --mock                brez prave transakcije (par s strežnikovim MOCK_VERIFY=true)
 *   --ack                 opcijski 3. par: GET + X-Payment → potrditev avtorizacije
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ethers } = require('ethers');

// ============================================================================
// KONFIGURACIJA
// ============================================================================
const configFile = path.join(__dirname, 'config.json');
let config = {
  MERCHANT_URL: 'http://127.0.0.1:3000',
  ENDPOINT: '/service',
  NETWORK: 'sepolia',
  RPC_URL: 'https://ethereum-sepolia-rpc.publicnode.com'
};

if (fs.existsSync(configFile)) {
  config = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
}

const MERCHANT_URL = process.env.MERCHANT_URL || config.MERCHANT_URL;
const endpoint = process.env.ENDPOINT || config.ENDPOINT;
const NETWORK = config.NETWORK || 'sepolia';
const RPC_URL = config.RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';

// Argumenti ukazne vrstice
const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const val = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};

const MOCK = has('--mock');
const ACK = has('--ack');
const PAUSE_MS = parseInt(val('--pause-ms', '0'), 10) || 0;
const PROMPT = val('--prompt', 'Pozdravljen! V enem stavku povzemi, kaj je protokol x402.');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pause = async (label) => {
  if (PAUSE_MS > 0) {
    console.log(`⏸  Premor ${PAUSE_MS} ms (${label})...`);
    await sleep(PAUSE_MS);
  }
};

// Naloži denarnico
const walletFile = path.join(__dirname, 'wallet.json');
if (!fs.existsSync(walletFile)) {
  console.error('❌ Napaka: wallet.json ne obstaja!');
  console.error('   Zaženi: node ../generate-wallet.js');
  process.exit(1);
}

const walletData = JSON.parse(fs.readFileSync(walletFile, 'utf-8'));
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(walletData.privateKey, provider);

console.log('\n╔════════════════════════════════════════════════════════════╗');
console.log('║   X402 Klient - ZDRUŽENI TOK (brez facilitatorja)        ║');
console.log('╚════════════════════════════════════════════════════════════╝\n');

console.log('Konfigurirano:');
console.log(`  Merchant:    ${MERCHANT_URL}`);
console.log(`  Endpoint:    ${endpoint}`);
console.log(`  Omrežje:     ${NETWORK}`);
console.log(`  Denarnica:   ${wallet.address}`);
console.log(`  Način:       ${MOCK ? 'MOCK (brez prave transakcije)' : 'REALNO (Sepolia)'}`);
console.log(`  Prompt:      ${PROMPT}`);
console.log('');

async function runPayment() {
  if (!MOCK) {
    console.log('════════════════════════════════════════════════════════════');
    console.log('KORAK 1: Preveri balance denarnice');
    console.log('════════════════════════════════════════════════════════════\n');

    const balance = await provider.getBalance(wallet.address);
    const balanceEth = ethers.formatEther(balance);
    console.log(`Trenutni balance: ${balanceEth} ETH`);

    if (parseFloat(balanceEth) < 0.001) {
      console.error('\n❌ Napaka: Premalo ETH v denarnici!');
      console.error(`   Tvoj naslov: ${wallet.address}`);
      console.error('   Naloži vsaj 0.01 ETH iz faucet-a:');
      console.error('   https://sepoliafaucet.com');
      process.exit(1);
    }
  }

  console.log('\n════════════════════════════════════════════════════════════');
  console.log('KORAK 2: Zahtevaj zaščiten vir (brez plačila) → 402');
  console.log('════════════════════════════════════════════════════════════\n');

  let payment;
  try {
    // Poskusi dostopati brez plačila - pričakujemo 402
    await axios.get(`${MERCHANT_URL}${endpoint}`, {
      headers: { 'X-Payer': wallet.address }
    });
    console.error('❌ Napaka: Dobil 200 OK namesto 402 Payment Required!');
    process.exit(1);
  } catch (err) {
    if (!err.response || err.response.status !== 402) {
      console.error('❌ Napaka pri dostopu do strežnika:', err.message);
      console.error('\nPreverite:');
      console.error('  1. Ali je strežnik zagnan?');
      console.error('  2. Ali je IP naslov pravilen?');
      console.error('  3. Ali firewall dovoli povezave?');
      process.exit(1);
    }

    console.log('✓ Prejeto: 402 Payment Required');
    console.log('\nPlačilni podatki:');
    console.log(JSON.stringify(err.response.data.payment || err.response.data, null, 2));

    payment = err.response.data.payment || err.response.data;
  }

  const requestId = payment.requestId;
  const to = payment.to || payment.recipient;
  const amountStr = String(payment.amount || payment.price || '0');

  console.log('\n════════════════════════════════════════════════════════════');
  console.log(`KORAK 3: ${MOCK ? 'MOCK transakcija (brez verige)' : 'Pošlji PRAVO transakcijo na blockchain'}`);
  console.log('════════════════════════════════════════════════════════════\n');

  let txHash;
  let blockNumber = null;
  if (MOCK) {
    // Fabriciran hash — strežnik z MOCK_VERIFY=true verige ne bere
    txHash = '0x' + crypto.randomBytes(32).toString('hex');
    console.log(`✓ Fabriciran TX hash (mock): ${txHash}`);
  } else {
    console.log(`Pošiljam ${amountStr} ETH na ${to}...`);
    console.log('Čakam na potrditev transakcije...\n');

    // Pošlji PRAVO transakcijo (direktno na verigo, mimo merchant strežnika)
    const tx = await wallet.sendTransaction({
      to: to,
      value: ethers.parseEther(amountStr)
    });

    console.log(`✓ Transakcija poslana!`);
    console.log(`  TX Hash: ${tx.hash}`);
    console.log(`  Ogled: https://sepolia.etherscan.io/tx/${tx.hash}`);
    console.log('\n⏳ Čakam na potrditev...');

    const receipt = await tx.wait();
    console.log(`✓ Transakcija potrjena! (Block: ${receipt.blockNumber})`);
    txHash = tx.hash;
    blockNumber = receipt.blockNumber;
  }

  await pause('pred združeno izmenjavo');

  console.log('\n════════════════════════════════════════════════════════════');
  console.log('KORAK 4: ZDRUŽENA IZMENJAVA — POST txHash + prompt → 200 OK');
  console.log('════════════════════════════════════════════════════════════\n');

  console.log('Pošiljam dokazilo in vprašanje v ENEM zahtevku...');
  const serviceResp = await axios.post(`${MERCHANT_URL}${endpoint}`, {
    requestId: requestId,
    txHash: txHash,
    network: payment.network || NETWORK,
    payerAddress: wallet.address,
    prompt: PROMPT
  });

  console.log('\n✓ Server je preveril transakcijo in vrnil vsebino + žeton:');
  console.log(JSON.stringify(serviceResp.data, null, 2));

  const proofToken = serviceResp.data.proofToken;
  if (!proofToken) {
    console.error('\n❌ Server ni vrnil proof tokena!');
    process.exit(1);
  }

  console.log('\n─── AI ODGOVOR ─────────────────────────────────────────────');
  console.log(serviceResp.data.response);
  console.log('────────────────────────────────────────────────────────────');
  console.log(`\n✓ Proof token: ${proofToken}`);

  if (ACK) {
    await pause('pred potrditvijo avtorizacije');

    console.log('\n════════════════════════════════════════════════════════════');
    console.log('KORAK 5 (opcijski): GET + X-Payment → potrditev avtorizacije');
    console.log('════════════════════════════════════════════════════════════\n');

    const ackResp = await axios.get(`${MERCHANT_URL}${endpoint}`, {
      headers: {
        'X-Payment': proofToken,
        'X-Payment-Proof': proofToken
      }
    });

    console.log('✓ Potrditev avtorizacije:');
    console.log(JSON.stringify(ackResp.data, null, 2));
  }

  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║   ✓ PLAČILO USPEŠNO ZAKLJUČENO! (ZDRUŽENI TOK)           ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  if (!MOCK) {
    console.log('Transakcija na blockchain:');
    console.log(`  ${txHash}`);
    console.log(`  https://sepolia.etherscan.io/tx/${txHash}`);
    console.log('');
  }
  console.log('Poti HTTP zahtevkov (ZDRUŽENI TOK):');
  console.log(`  1. Klient → Merchant: GET → 402 Payment Required (JSON račun)`);
  console.log(`  2. Klient → Blockchain: TX → potrditev (direktno v merchant wallet)${MOCK ? ' [MOCK: preskočeno]' : ''}`);
  console.log(`  3. Klient → Merchant: POST txHash + prompt → verifikacija on-chain → 200 OK (odgovor + žeton)`);
  if (ACK) {
    console.log(`  4. Klient → Merchant: GET + X-Payment → potrditev avtorizacije`);
  }
  console.log('');
  console.log('⚡ Brez posrednika - samo 2 komponenti, 2 para HTTP sporočil!');
  console.log('');
}

// Zaženi
runPayment().catch(err => {
  if (err.response) {
    console.error(`Fatal error: HTTP ${err.response.status}`);
    console.error(JSON.stringify(err.response.data, null, 2));
  } else {
    console.error('Fatal error:', err);
  }
  process.exit(1);
});
