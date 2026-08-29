#!/usr/bin/env node
'use strict';
/**
 * Generate a fresh payer wallet.json for the headless client (real-mode runs).
 * Refuses to overwrite an existing wallet.json.
 *   node generate-wallet.js
 */
const { Wallet } = require('ethers');
const fs = require('fs');
const path = require('path');

const out = path.join(__dirname, 'wallet.json');
if (fs.existsSync(out)) {
  const w = JSON.parse(fs.readFileSync(out, 'utf8'));
  console.error(`⚠ wallet.json already exists (address ${w.address}). To create a new wallet, back it up safely and delete it first.`);
  process.exit(1);
}
const w = Wallet.createRandom();
fs.writeFileSync(out, JSON.stringify({
  address: w.address,
  privateKey: w.privateKey,
  mnemonic: w.mnemonic.phrase,
  createdAt: new Date().toISOString()
}, null, 2), { mode: 0o600 });

console.log('✓ New payer wallet:', w.address);
console.log('  Fund it with testnet ETH (Sepolia faucet), then run: npm run real');
console.log('  Faucet: https://sepoliafaucet.com  ·  https://www.alchemy.com/faucets/ethereum-sepolia');
