#!/usr/bin/env node

/**
 * X402 Client - END-TO-END Implementation (MERGED FLOW)
 *
 * Client for the X402 payment protocol with REAL Ethereum transactions on the Sepolia testnet.
 * WITHOUT a facilitator - direct communication with the hosting server.
 *
 * Merged flow: exactly TWO request/response pairs go over the wire:
 *   1. GET /service                          → 402 Payment Required (JSON invoice)
 *   2. POST /service {requestId, txHash, prompt} → 200 OK {response, proofToken}
 *
 * Arguments:
 *   --prompt <text>       question for the AI (defaults to the demo question)
 *   --pause-ms <n>        pause between exchanges (cleaner capture in Wireshark)
 *   --mock                no real transaction (pair with the server's MOCK_VERIFY=true)
 *   --ack                 optional 3rd pair: GET + X-Payment → authorization confirmation
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ethers } = require('ethers');

// ============================================================================
// CONFIGURATION
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

// Command-line arguments
const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const val = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};

const MOCK = has('--mock');
const ACK = has('--ack');
const PAUSE_MS = parseInt(val('--pause-ms', '0'), 10) || 0;
const PROMPT = val('--prompt', 'Hello! In one sentence, summarise what the x402 protocol is.');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pause = async (label) => {
  if (PAUSE_MS > 0) {
    console.log(`⏸  Pausing ${PAUSE_MS} ms (${label})...`);
    await sleep(PAUSE_MS);
  }
};

// Load the wallet
const walletFile = path.join(__dirname, 'wallet.json');
if (!fs.existsSync(walletFile)) {
  console.error('❌ Error: wallet.json does not exist!');
  console.error('   Run: node ../generate-wallet.js');
  process.exit(1);
}

const walletData = JSON.parse(fs.readFileSync(walletFile, 'utf-8'));
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(walletData.privateKey, provider);

console.log('\n╔════════════════════════════════════════════════════════════╗');
console.log('║   X402 Client - MERGED FLOW (no facilitator)              ║');
console.log('╚════════════════════════════════════════════════════════════╝\n');

console.log('Configuration:');
console.log(`  Merchant:    ${MERCHANT_URL}`);
console.log(`  Endpoint:    ${endpoint}`);
console.log(`  Network:     ${NETWORK}`);
console.log(`  Wallet:      ${wallet.address}`);
console.log(`  Mode:        ${MOCK ? 'MOCK (no real transaction)' : 'REAL (Sepolia)'}`);
console.log(`  Prompt:      ${PROMPT}`);
console.log('');

async function runPayment() {
  if (!MOCK) {
    console.log('════════════════════════════════════════════════════════════');
    console.log('STEP 1: Check the wallet balance');
    console.log('════════════════════════════════════════════════════════════\n');

    const balance = await provider.getBalance(wallet.address);
    const balanceEth = ethers.formatEther(balance);
    console.log(`Current balance: ${balanceEth} ETH`);

    if (parseFloat(balanceEth) < 0.001) {
      console.error('\n❌ Error: Not enough ETH in the wallet!');
      console.error(`   Your address: ${wallet.address}`);
      console.error('   Load at least 0.01 ETH from a faucet:');
      console.error('   https://sepoliafaucet.com');
      process.exit(1);
    }
  }

  console.log('\n════════════════════════════════════════════════════════════');
  console.log('STEP 2: Request the protected resource (no payment) → 402');
  console.log('════════════════════════════════════════════════════════════\n');

  let payment;
  try {
    // Try to access without payment - we expect 402
    await axios.get(`${MERCHANT_URL}${endpoint}`, {
      headers: { 'X-Payer': wallet.address }
    });
    console.error('❌ Error: Got 200 OK instead of 402 Payment Required!');
    process.exit(1);
  } catch (err) {
    if (!err.response || err.response.status !== 402) {
      console.error('❌ Error accessing the server:', err.message);
      console.error('\nCheck:');
      console.error('  1. Is the server running?');
      console.error('  2. Is the IP address correct?');
      console.error('  3. Does the firewall allow connections?');
      process.exit(1);
    }

    console.log('✓ Received: 402 Payment Required');
    console.log('\nPayment details:');
    console.log(JSON.stringify(err.response.data.payment || err.response.data, null, 2));

    payment = err.response.data.payment || err.response.data;
  }

  const requestId = payment.requestId;
  const to = payment.to || payment.recipient;
  const amountStr = String(payment.amount || payment.price || '0');

  console.log('\n════════════════════════════════════════════════════════════');
  console.log(`STEP 3: ${MOCK ? 'MOCK transaction (no chain)' : 'Send a REAL transaction to the blockchain'}`);
  console.log('════════════════════════════════════════════════════════════\n');

  let txHash;
  let blockNumber = null;
  if (MOCK) {
    // Fabricated hash — a server with MOCK_VERIFY=true does not read the chain
    txHash = '0x' + crypto.randomBytes(32).toString('hex');
    console.log(`✓ Fabricated TX hash (mock): ${txHash}`);
  } else {
    console.log(`Sending ${amountStr} ETH to ${to}...`);
    console.log('Waiting for transaction confirmation...\n');

    // Send a REAL transaction (directly to the chain, bypassing the merchant server)
    const tx = await wallet.sendTransaction({
      to: to,
      value: ethers.parseEther(amountStr)
    });

    console.log(`✓ Transaction sent!`);
    console.log(`  TX Hash: ${tx.hash}`);
    console.log(`  View: https://sepolia.etherscan.io/tx/${tx.hash}`);
    console.log('\n⏳ Waiting for confirmation...');

    const receipt = await tx.wait();
    console.log(`✓ Transaction confirmed! (Block: ${receipt.blockNumber})`);
    txHash = tx.hash;
    blockNumber = receipt.blockNumber;
  }

  await pause('before the merged exchange');

  console.log('\n════════════════════════════════════════════════════════════');
  console.log('STEP 4: MERGED EXCHANGE — POST txHash + prompt → 200 OK');
  console.log('════════════════════════════════════════════════════════════\n');

  console.log('Sending the proof and the question in ONE request...');
  const serviceResp = await axios.post(`${MERCHANT_URL}${endpoint}`, {
    requestId: requestId,
    txHash: txHash,
    network: payment.network || NETWORK,
    payerAddress: wallet.address,
    prompt: PROMPT
  });

  console.log('\n✓ The server verified the transaction and returned the content + token:');
  console.log(JSON.stringify(serviceResp.data, null, 2));

  const proofToken = serviceResp.data.proofToken;
  if (!proofToken) {
    console.error('\n❌ The server did not return a proof token!');
    process.exit(1);
  }

  console.log('\n─── AI RESPONSE ────────────────────────────────────────────');
  console.log(serviceResp.data.response);
  console.log('────────────────────────────────────────────────────────────');
  console.log(`\n✓ Proof token: ${proofToken}`);

  if (ACK) {
    await pause('before the authorization confirmation');

    console.log('\n════════════════════════════════════════════════════════════');
    console.log('STEP 5 (optional): GET + X-Payment → authorization confirmation');
    console.log('════════════════════════════════════════════════════════════\n');

    const ackResp = await axios.get(`${MERCHANT_URL}${endpoint}`, {
      headers: {
        'X-Payment': proofToken,
        'X-Payment-Proof': proofToken
      }
    });

    console.log('✓ Authorization confirmation:');
    console.log(JSON.stringify(ackResp.data, null, 2));
  }

  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║   ✓ PAYMENT COMPLETED SUCCESSFULLY! (MERGED FLOW)         ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  if (!MOCK) {
    console.log('Transaction on the blockchain:');
    console.log(`  ${txHash}`);
    console.log(`  https://sepolia.etherscan.io/tx/${txHash}`);
    console.log('');
  }
  console.log('HTTP request paths (MERGED FLOW):');
  console.log(`  1. Client → Merchant: GET → 402 Payment Required (JSON invoice)`);
  console.log(`  2. Client → Blockchain: TX → confirmation (directly into the merchant wallet)${MOCK ? ' [MOCK: skipped]' : ''}`);
  console.log(`  3. Client → Merchant: POST txHash + prompt → on-chain verification → 200 OK (response + token)`);
  if (ACK) {
    console.log(`  4. Client → Merchant: GET + X-Payment → authorization confirmation`);
  }
  console.log('');
  console.log('⚡ No facilitator - just 2 components, 2 pairs of HTTP messages!');
  console.log('');
}

// Run
runPayment().catch(err => {
  if (err.response) {
    console.error(`Fatal error: HTTP ${err.response.status}`);
    console.error(JSON.stringify(err.response.data, null, 2));
  } else {
    console.error('Fatal error:', err);
  }
  process.exit(1);
});
