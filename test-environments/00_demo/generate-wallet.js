#!/usr/bin/env node

/**
 * Ethereum wallet generator for the X402 protocol
 * Creates two separate wallets: one for the merchant (server) and one for the client
 */

import { Wallet } from 'ethers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('\n╔════════════════════════════════════════════════════════════╗');
console.log('║   ETHEREUM WALLETS - Generator                            ║');
console.log('╚════════════════════════════════════════════════════════════╝\n');

// Check whether the wallets already exist
const merchantPath = path.join(__dirname, 'server', 'wallet.json');
const clientPath = path.join(__dirname, 'client', 'wallet.json');

const merchantExists = fs.existsSync(merchantPath);
const clientExists = fs.existsSync(clientPath);

if (merchantExists || clientExists) {
  console.log('⚠️  WARNING: Wallets already exist!\n');
  
  if (merchantExists) {
    const existing = JSON.parse(fs.readFileSync(merchantPath, 'utf-8'));
    console.log('   Merchant wallet:', existing.address);
  }
  
  if (clientExists) {
    const existing = JSON.parse(fs.readFileSync(clientPath, 'utf-8'));
    console.log('   Client wallet:', existing.address);
  }
  
  console.log('\n❌ ABORT: To create new wallets:');
  console.log('   1. Safely back up the existing wallet.json files');
  console.log('   2. Delete them manually');
  console.log('   3. Run this script again\n');
  console.log('⚠️  CAUTION: Losing the privateKey = losing access to the funds!\n');
  process.exit(1);
}

// Create the merchant wallet
console.log('Creating the MERCHANT wallet...');
const merchantWallet = Wallet.createRandom();
const merchantData = {
  address: merchantWallet.address,
  privateKey: merchantWallet.privateKey,
  mnemonic: merchantWallet.mnemonic.phrase,
  createdAt: new Date().toISOString()
};

// Save the merchant wallet
fs.writeFileSync(merchantPath, JSON.stringify(merchantData, null, 2), { mode: 0o600 });
console.log('✓ Merchant wallet saved to:', merchantPath);
console.log('  Address:', merchantData.address);

// Create the client wallet
console.log('\nCreating the CLIENT wallet...');
const clientWallet = Wallet.createRandom();
const clientData = {
  address: clientWallet.address,
  privateKey: clientWallet.privateKey,
  mnemonic: clientWallet.mnemonic.phrase,
  createdAt: new Date().toISOString()
};

// Save the client wallet
fs.writeFileSync(clientPath, JSON.stringify(clientData, null, 2), { mode: 0o600 });
console.log('✓ Client wallet saved to:', clientPath);
console.log('  Address:', clientData.address);

console.log('\n╔════════════════════════════════════════════════════════════╗');
console.log('║   WALLETS CREATED SUCCESSFULLY!                           ║');
console.log('╚════════════════════════════════════════════════════════════╝\n');

console.log('⚠️  IMPORTANT - Store these safely:');
console.log('   - Merchant address:', merchantData.address);
console.log('   - Client address:', clientData.address);
console.log('');
console.log('📝 NEXT STEPS:');
console.log('   1. Go to the Sepolia faucet: https://sepoliafaucet.com');
console.log('   2. Fund the client wallet with testnet ETH');
console.log('   3. Wait ~1 minute for the ETH to appear');
console.log('   4. Check the balance at: https://sepolia.etherscan.io');
console.log('');
console.log('💰 How much ETH you need:');
console.log('   - Client: ~0.01 ETH (for transactions + gas)');
console.log('   - Merchant: 0 ETH (only receives payments)');
console.log('');
