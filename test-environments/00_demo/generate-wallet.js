#!/usr/bin/env node

/**
 * Generator Ethereum denarnic za X402 protokol
 * Ustvari dve ločeni denarnici: za merchant (server) in klient
 */

import { Wallet } from 'ethers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('\n╔════════════════════════════════════════════════════════════╗');
console.log('║   ETHEREUM DENARNICE - Generator                          ║');
console.log('╚════════════════════════════════════════════════════════════╝\n');

// Preveri če denarnice že obstajajo
const merchantPath = path.join(__dirname, 'server', 'wallet.json');
const clientPath = path.join(__dirname, 'klient', 'wallet.json');

const merchantExists = fs.existsSync(merchantPath);
const clientExists = fs.existsSync(clientPath);

if (merchantExists || clientExists) {
  console.log('⚠️  OPOZORILO: Denarnice že obstajajo!\n');
  
  if (merchantExists) {
    const existing = JSON.parse(fs.readFileSync(merchantPath, 'utf-8'));
    console.log('   Merchant wallet:', existing.address);
  }
  
  if (clientExists) {
    const existing = JSON.parse(fs.readFileSync(clientPath, 'utf-8'));
    console.log('   Klient wallet:', existing.address);
  }
  
  console.log('\n❌ ABORT: Če želiš ustvariti nove denarnice:');
  console.log('   1. Varno shrani obstoječe wallet.json datoteke');
  console.log('   2. Izbriši jih ročno');
  console.log('   3. Ponovno zaženi ta skripta\n');
  console.log('⚠️  POZOR: Izguba privateKey = izguba dostopa do sredstev!\n');
  process.exit(1);
}

// Ustvari merchant denarnico
console.log('Ustvarjam MERCHANT denarnico...');
const merchantWallet = Wallet.createRandom();
const merchantData = {
  address: merchantWallet.address,
  privateKey: merchantWallet.privateKey,
  mnemonic: merchantWallet.mnemonic.phrase,
  createdAt: new Date().toISOString()
};

// Shrani merchant wallet
fs.writeFileSync(merchantPath, JSON.stringify(merchantData, null, 2), { mode: 0o600 });
console.log('✓ Merchant denarnica shranjena v:', merchantPath);
console.log('  Naslov:', merchantData.address);

// Ustvari klient denarnico
console.log('\nUstvarjam KLIENT denarnico...');
const clientWallet = Wallet.createRandom();
const clientData = {
  address: clientWallet.address,
  privateKey: clientWallet.privateKey,
  mnemonic: clientWallet.mnemonic.phrase,
  createdAt: new Date().toISOString()
};

// Shrani klient wallet
fs.writeFileSync(clientPath, JSON.stringify(clientData, null, 2), { mode: 0o600 });
console.log('✓ Klient denarnica shranjena v:', clientPath);
console.log('  Naslov:', clientData.address);

console.log('\n╔════════════════════════════════════════════════════════════╗');
console.log('║   DENARNICE USPEŠNO USTVARJENE!                           ║');
console.log('╚════════════════════════════════════════════════════════════╝\n');

console.log('⚠️  POMEMBNO - Shrani varno:');
console.log('   - Merchant naslov:', merchantData.address);
console.log('   - Klient naslov:', clientData.address);
console.log('');
console.log('📝 NASLEDNJI KORAKI:');
console.log('   1. Pojdi na Sepolia faucet: https://sepoliafaucet.com');
console.log('   2. Naloži klient denarnico z testnet ETH');
console.log('   3. Počakaj ~1 minuto da se ETH pojavi');
console.log('   4. Preveri balance na: https://sepolia.etherscan.io');
console.log('');
console.log('💰 Koliko ETH potrebuješ:');
console.log('   - Klient: ~0.01 ETH (za transakcije + gas)');
console.log('   - Merchant: 0 ETH (samo prejema plačila)');
console.log('');
