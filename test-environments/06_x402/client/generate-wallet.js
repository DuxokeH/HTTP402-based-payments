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
  console.error(`⚠ wallet.json že obstaja (naslov ${w.address}). Za novo denarnico ga najprej varno shrani in izbriši.`);
  process.exit(1);
}
const w = Wallet.createRandom();
fs.writeFileSync(out, JSON.stringify({
  address: w.address,
  privateKey: w.privateKey,
  mnemonic: w.mnemonic.phrase,
  createdAt: new Date().toISOString()
}, null, 2), { mode: 0o600 });

console.log('✓ Nova denarnica plačnika:', w.address);
console.log('  Napolni jo s testnim ETH (Sepolia faucet), nato zaženi: npm run real');
console.log('  Faucet: https://sepoliafaucet.com  ·  https://www.alchemy.com/faucets/ethereum-sepolia');
