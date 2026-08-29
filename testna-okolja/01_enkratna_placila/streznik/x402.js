'use strict';

// Node 18: globalni WebCrypto je brezpogojen šele od Node 19; SDK-jev
// createNonce() sicer vrže "Crypto API not available". Na Node 20+ je to no-op.
if (!globalThis.crypto) globalThis.crypto = require('node:crypto').webcrypto;

/**
 * x402 v2 — skupni modul za NOVE, VZPOREDNE plačilne načine (uradni protokol).
 *
 * Ta datoteka je bajt-identična v vseh mapah (kot auth.js). Obstoječi lastni
 * protokol (402 → domača ETH transakcija → /verify-payment → proof_<uuid> →
 * X-Payment) je NEDOTAKNJEN; x402 poti živijo vzporedno pod /x402/*.
 *
 * Konfiguracija bere IZKLJUČNO spremenljivke s predpono X402_* in ključe
 * x402* iz wallet.json. Nikoli ne bere RPC_URL / NETWORK / MIN_CONFIRMATIONS
 * obstoječega (Ethereum Sepolia) sveta — ločitev verig je namerna in stroga:
 *
 *   DOMAČI ETH:  Ethereum Sepolia  (eip155:11155111)  ← obstoječe spremenljivke
 *   X402:        Ethereum Sepolia  (eip155:11155111)  ← samo X402_* spremenljivke
 *                (TESTNO: zneski v ETH/wei; poravnava samo mock — glej opombo
 *                 pri `asset` spodaj)
 *
 * Načini (X402_MODE):
 *   off          — /x402/* poti se ne priklopijo; mapa deluje kot doslej
 *   self         — samofacilitirano: TA strežnik preverja in poravnava prek
 *                  lastnega X402_RPC_URL (mape 01, 02, 03, 05)
 *   facilitated  — preverjanje/poravnavo opravi LOKALNI posrednik (mapa 04:
 *                  trgovec brez RPC; klice mu priskrbi klicatelj prek `remote`)
 *
 * X402_MOCK=true — pravi SDK-facilitator z zamaškom namesto verige: podpisi,
 * prejemnik, znesek in veljavnost se preverijo ZARES (offline), poravnava pa
 * vrne sintetični hash s predpono 0x6d6f636b6d6f636b ("mockmock" v ASCII), da
 * je vsaka vrstica meritve nezamenljivo označena kot simulirana.
 */

const { createHash } = require('node:crypto');
const fs = require('fs');
const path = require('path');

// ── konfiguracija ────────────────────────────────────────────────────────────

const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';

const MODE = (process.env.X402_MODE || 'off').toLowerCase();
if (!['off', 'self', 'facilitated'].includes(MODE)) {
  throw new Error(`X402_MODE mora biti off|self|facilitated, ne "${MODE}"`);
}
// enak varnostni ventil kot MOCK_VERIFY: v produkciji samo s FORCE_MOCK=1
const MOCK = process.env.X402_MOCK === 'true' && (!IS_PROD || process.env.FORCE_MOCK === '1');
const MOCK_FAULTS = MOCK && process.env.X402_MOCK_FAULTS === 'true';

function readWallet() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'wallet.json'), 'utf8')); }
  catch { return {}; }
}

const wallet = readWallet();

const config = Object.freeze({
  mode: MODE,
  mock: MOCK,
  network: process.env.X402_NETWORK || 'eip155:11155111',
  // TESTNA konfiguracija: vse mape zaračunavajo v ETH (wei, 18 decimalk), da so
  // zneski neposredno primerljivi z domačim tokom. Uradna shema `exact` za PRAVO
  // poravnavo zahteva žeton z EIP-3009 (transferWithAuthorization) — native ETH
  // tega nima, zato spodnji naslov NI pogodba in je pravi tek zaklenjen
  // (varovalo pod `enabled`). Mock podpise vseeno preverja ZARES.
  asset: process.env.X402_USDC_ADDRESS || '0x0000000000000000000000000000000000000000',
  assetName: process.env.X402_ASSET_NAME || 'ETH',
  assetVersion: process.env.X402_ASSET_VERSION || '1',
  assetDecimals: parseInt(process.env.X402_ASSET_DECIMALS || '18', 10),
  priceAtomic: process.env.X402_PRICE_ATOMIC || '100000000000',            // 0.0000001 ETH — kot domači tok
  sessionDepositAtomic: process.env.X402_SESSION_DEPOSIT_ATOMIC || '2000000000000', // 0.000002 ETH = 20 plačil
  payTo: process.env.X402_MERCHANT_ADDRESS || wallet.x402Address || wallet.address || null,
  rpcUrl: process.env.X402_RPC_URL || null,
  rpcTimeoutMs: parseInt(process.env.X402_RPC_TIMEOUT_MS || '20000', 10),
  receiptTimeoutMs: parseInt(process.env.X402_SETTLE_TIMEOUT_MS || '60000', 10),
  // LOČENO od MIN_CONFIRMATIONS domačega toka — politika potrjevanja se med
  // tokovoma NE deduje, tudi kadar tečeta na isti verigi.
  confirmations: Math.max(1, parseInt(process.env.X402_MIN_CONFIRMATIONS || '1', 10)),
  pollMs: parseInt(process.env.X402_POLL_MS || '1000', 10),
  maxTimeoutSeconds: parseInt(process.env.X402_MAX_TIMEOUT_SECONDS || '300', 10),
  leaseMs: parseInt(process.env.X402_LEASE_MS || '45000', 10),
  broadcastGraceMs: parseInt(process.env.X402_BROADCAST_GRACE_MS || '180000', 10),
  retentionMs: parseInt(process.env.X402_IDEMPOTENCY_TTL_SECONDS || '86400', 10) * 1000,
  facilitatorUrl: process.env.X402_FACILITATOR_URL || null,
  // poravnalni ključ: SAMO iz okolja ali wallet.json; nikoli v dnevnik, nikoli v /config
  settlerKey: process.env.X402_SETTLEMENT_PRIVATE_KEY || wallet.x402SettlerPrivateKey || null
});

const enabled = MODE !== 'off';
const MOCK_TX_PREFIX = '0x6d6f636b6d6f636b'; // "mockmock"

// Varovalo testne ETH konfiguracije: brez prave EIP-3009 pogodbe bi pravi tek
// odpovedal šele pri poravnavi (in prej mimogrede zapisal "real" vrstice).
// Zato odpovej TAKOJ ob zagonu, z navodilom.
if (enabled && !MOCK && /^0x0{40}$/i.test(config.asset)) {
  throw new Error(
    'x402: sredstvo je testni ETH brez pogodbe (native ETH nima EIP-3009), ' +
    'pravi tek zato ni mogoč. Zaženi z X402_MOCK=true ali pa nastavi pravi ' +
    'žeton: X402_USDC_ADDRESS + X402_ASSET_NAME/VERSION/DECIMALS.'
  );
}

/** Varno za /config in dnevnik — brez skrivnosti. */
function summary() {
  return {
    mode: MODE, mock: MOCK, network: config.network, scheme: 'exact',
    asset: config.asset, assetName: config.assetName, assetDecimals: config.assetDecimals,
    priceAtomic: config.priceAtomic, payTo: config.payTo,
    confirmations: config.confirmations,
    facilitatorUrl: config.facilitatorUrl,
    rpc: config.rpcUrl ? 'nastavljen' : null
  };
}

// ── lene zahteve SDK-ja (mapa z X402_MODE=off deluje brez paketov) ───────────

let sdk = null;
function requireSdk() {
  if (sdk) return sdk;
  const { x402Facilitator } = require('@x402/core/facilitator');
  const { x402ResourceServer, x402HTTPResourceServer, paymentMiddlewareFromHTTPServer } = require('@x402/express');
  const { toFacilitatorEvmSigner, getDefaultAsset } = require('@x402/evm');
  const { registerExactEvmScheme } = require('@x402/evm/exact/facilitator');
  const { ExactEvmScheme: ExactEvmServerScheme } = require('@x402/evm/exact/server');
  const { declarePaymentIdentifierExtension, extractPaymentIdentifier, PAYMENT_IDENTIFIER } =
    require('@x402/extensions/payment-identifier');
  const viem = require('viem');
  const { privateKeyToAccount } = require('viem/accounts');
  const { baseSepolia } = require('viem/chains');
  sdk = {
    x402Facilitator, x402ResourceServer, x402HTTPResourceServer, paymentMiddlewareFromHTTPServer,
    toFacilitatorEvmSigner, getDefaultAsset, registerExactEvmScheme, ExactEvmServerScheme,
    declarePaymentIdentifierExtension, extractPaymentIdentifier, PAYMENT_IDENTIFIER,
    viem, privateKeyToAccount, baseSepolia
  };
  return sdk;
}

/** Kanonični podatki žetona: raje SDK-jev register kot ročne konstante. */
function resolveAsset() {
  try {
    const a = requireSdk().getDefaultAsset(config.network);
    if (a && a.asset) {
      return { address: a.asset, name: a.name, version: a.version, decimals: a.decimals };
    }
  } catch { /* neznana veriga v SDK — obdrži konfigurirano */ }
  return { address: config.asset, name: config.assetName, version: config.assetVersion, decimals: config.assetDecimals };
}

// ── viem odjemalec (samo self način, en sam) ─────────────────────────────────

let viemBits = null;
function getViemBits() {
  if (viemBits) return viemBits;
  const { viem, privateKeyToAccount, baseSepolia } = requireSdk();
  if (!config.settlerKey) {
    throw new Error('x402: manjka poravnalni ključ (X402_SETTLEMENT_PRIVATE_KEY ali wallet.json.x402SettlerPrivateKey)');
  }
  if (!MOCK && !config.rpcUrl) {
    throw new Error('x402: X402_MODE=self brez X402_MOCK zahteva X402_RPC_URL');
  }
  const account = privateKeyToAccount(config.settlerKey);
  const chainId = parseInt(config.network.split(':')[1], 10);
  const chain = chainId === 84532 ? baseSepolia : { ...baseSepolia, id: chainId };
  const client = viem.createWalletClient({
    account, chain,
    // retryCount: 0 — politika ponovnih poskusov je NAŠA (statusni stroj);
    // transportna ponovitev po timeoutu bi lahko poravnavo oddala dvakrat.
    transport: viem.http(config.rpcUrl || 'http://127.0.0.1:1', { timeout: config.rpcTimeoutMs, retryCount: 0 })
  }).extend(viem.publicActions);
  viemBits = { account, client, chain };
  return viemBits;
}

function settlerAddress() {
  if (MODE !== 'self' && !MOCK) return null;
  try { return getViemBits().account.address; } catch { return null; }
}

// ── podpisniki facilitatorja ─────────────────────────────────────────────────

/**
 * Pravi podpisnik (self način). `onBroadcast` se pokliče z odd. hashem PRED
 * čakanjem na potrdilo — če čakanje poteče, hash NI izgubljen in uskladitev
 * lahko prebere potrdilo, namesto da bi slepo oddajala drugič.
 */
function realSigner(onBroadcast, onReceipt) {
  const { toFacilitatorEvmSigner } = requireSdk();
  const { account, client } = getViemBits();
  return toFacilitatorEvmSigner({
    address: account.address,
    getCode: (a) => client.getCode(a),
    readContract: (a) => client.readContract({ ...a, args: a.args || [] }),
    verifyTypedData: (a) => client.verifyTypedData(a),
    writeContract: async (a) => {
      const hash = await client.writeContract({ ...a, args: a.args || [] });
      if (onBroadcast) onBroadcast(hash);
      return hash;
    },
    sendTransaction: async (a) => {
      const hash = await client.sendTransaction(a);
      if (onBroadcast) onBroadcast(hash);
      return hash;
    },
    waitForTransactionReceipt: async (a) => {
      const rc = await client.waitForTransactionReceipt({
        ...a, confirmations: config.confirmations,
        timeout: config.receiptTimeoutMs, pollingInterval: config.pollMs
      });
      if (onReceipt && rc) onReceipt(rc); // gas/blok za meritve
      return rc;
    }
  });
}

/**
 * Zamašek za MOCK: pravi SDK-facilitator, a vsa branja verige so zamaški in
 * "oddaja" vrne sintetični hash. Podpisi/prejemnik/znesek/veljavnost se
 * preverijo zares (offline viem.verifyTypedData za EOA).
 */
function mockSigner(onBroadcast, fault, onReceipt) {
  const { toFacilitatorEvmSigner, viem, privateKeyToAccount } = requireSdk();
  const asset = resolveAsset();
  // determinističen "poravnalni račun" za mock (ni skrivnost, ni sredstev)
  const account = config.settlerKey
    ? privateKeyToAccount(config.settlerKey)
    : privateKeyToAccount('0x' + '11'.repeat(32));
  const synthetic = (seed) => MOCK_TX_PREFIX + createHash('sha256').update(String(seed)).digest('hex').slice(0, 48);
  return toFacilitatorEvmSigner({
    address: account.address,
    getCode: async ({ address }) =>
      address && address.toLowerCase() === asset.address.toLowerCase() ? '0x60806040' : undefined,
    readContract: async (a) => {
      switch (a.functionName) {
        case 'balanceOf': return 10n ** 15n;
        case 'authorizationState': return false;
        case 'allowance': return 0n;
        case 'nonces': return 0n;
        default: return 0n; // vklj. simulacija transferWithAuthorization
      }
    },
    verifyTypedData: async (a) => viem.verifyTypedData(a),
    writeContract: async (a) => {
      if (fault === 'revert') {
        const e = new Error('mock: settlement reverted'); e.name = 'ContractFunctionExecutionError'; throw e;
      }
      // seme = VSI argumenti (vsebujejo EIP-3009 nonce) → hash unikaten po plačilu
      const hash = synthetic(JSON.stringify(a.args || a, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
      if (onBroadcast) onBroadcast(hash);
      if (fault === 'timeout') {
        const e = new Error('mock: timed out while waiting for transaction receipt'); e.name = 'WaitForTransactionReceiptTimeoutError'; throw e;
      }
      return hash;
    },
    sendTransaction: async () => { throw new Error('mock: sendTransaction se ne uporablja'); },
    waitForTransactionReceipt: async ({ hash }) => {
      const rc = { status: 'success', transactionHash: hash, blockNumber: 1n,
        gasUsed: 65000n, effectiveGasPrice: 1000000n };
      if (onReceipt) onReceipt(rc);
      return rc;
    }
  });
}

/** En facilitator na POSKUS poravnave — onBroadcast je vezan na točno eno plačilo. */
function buildFacilitator(onBroadcast, fault, onReceipt) {
  const { x402Facilitator, registerExactEvmScheme } = requireSdk();
  const f = new x402Facilitator();
  registerExactEvmScheme(f, {
    signer: MOCK ? mockSigner(onBroadcast, fault, onReceipt) : realSigner(onBroadcast, onReceipt),
    networks: config.network
  });
  return f;
}

let verifyFacilitator = null;
function getVerifyFacilitator() {
  if (!verifyFacilitator) verifyFacilitator = buildFacilitator(null, null);
  return verifyFacilitator;
}

// ── identiteta plačila ───────────────────────────────────────────────────────

const sha256hex = (s) => createHash('sha256').update(s).digest('hex');

function authOf(payload) {
  return (payload && payload.payload && payload.payload.authorization) || null;
}

/** Ključ EIP-3009 pooblastila: veriga|žeton|plačnik|nonce (avtoritativen je kontrakt). */
function authKey(payload, requirements) {
  const a = authOf(payload);
  if (!a) return null;
  return sha256hex([requirements.network, String(requirements.asset).toLowerCase(),
    String(a.from).toLowerCase(), a.nonce].join('|'));
}

/**
 * Prstni odtis: protokolska polja + podpisano pooblastilo, BREZ podpisa
 * (ponovno podpisano identično pooblastilo poravna identično — predpomnjenje
 * je pravilno) in BREZ telesa zahteve.
 */
function fingerprint(payload, requirements, resourceKey) {
  const a = authOf(payload) || {};
  return sha256hex(JSON.stringify([
    payload.x402Version, requirements.scheme, requirements.network,
    String(requirements.payTo).toLowerCase(), String(requirements.asset).toLowerCase(),
    String(requirements.amount ?? requirements.maxAmountRequired ?? ''),
    resourceKey,
    String(a.from || '').toLowerCase(), String(a.to || '').toLowerCase(),
    String(a.value || ''), String(a.validAfter || ''), String(a.validBefore || ''), a.nonce || ''
  ]));
}

function paymentIdOf(payload) {
  try { return requireSdk().extractPaymentIdentifier(payload) || null; } catch { return null; }
}

/** Identiteta plačila: razširitev payment-identifier, sicer ključ pooblastila. */
function paymentKeyOf(payload, requirements) {
  return paymentIdOf(payload) || ('auth_' + (authKey(payload, requirements) || sha256hex(JSON.stringify(payload))));
}

function decodePaymentHeader(headerValue) {
  try { return JSON.parse(Buffer.from(String(headerValue), 'base64').toString('utf8')); }
  catch { return null; }
}

function encodePaymentResponse(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

function readPaymentResponse(headerValue) {
  const j = decodePaymentHeader(headerValue);
  if (!j) return null;
  return { success: !!j.success, txHash: j.transaction || null, network: j.network, payer: j.payer, errorReason: j.errorReason || null };
}

// ── branja verige za uskladitev ──────────────────────────────────────────────

async function getReceipt(txHash) {
  if (MOCK) return { status: 'success', blockNumber: 1n, gasUsed: 65000n, effectiveGasPrice: 1000000n };
  const { client } = getViemBits();
  try { return await client.getTransactionReceipt({ hash: txHash }); }
  catch { return null; }
}

const EIP3009_STATE_ABI = [{
  name: 'authorizationState', type: 'function', stateMutability: 'view',
  inputs: [{ name: 'authorizer', type: 'address' }, { name: 'nonce', type: 'bytes32' }],
  outputs: [{ name: '', type: 'bool' }]
}];

/** Ali je plačnikovo EIP-3009 pooblastilo na verigi že porabljeno? (null = ni dostopa) */
async function isAuthorizationUsed({ from, nonce }) {
  if (MOCK) return false;
  try {
    const { client } = getViemBits();
    const asset = resolveAsset();
    return await client.readContract({
      address: asset.address, abi: EIP3009_STATE_ABI,
      functionName: 'authorizationState', args: [from, nonce]
    });
  } catch { return null; }
}

// ── statusni stroj poravnave ─────────────────────────────────────────────────

const pendingFaults = new Map(); // paymentKey -> 'revert'|'timeout' (samo X402_MOCK_FAULTS)

function noteFault(paymentKey, fault) {
  if (MOCK_FAULTS && (fault === 'revert' || fault === 'timeout')) pendingFaults.set(paymentKey, fault);
}

/**
 * Poravnava z idempotenco. Poteka:
 *   zakup (sinhrona transakcija) → await settle IZVEN transakcije → CAS zapis.
 * Nikoli ne odda drugič, če izid prejšnje oddaje ni dokazano "neporabljeno".
 * `remote` (mapa 04, trgovec): { settle(payload, requirements), reconcile({txHash}|{from,nonce}) }.
 */
async function settleWithIdempotency({ dbx, payload, requirements, resourceKey, logger, remote, pending, onSettled }) {
  const paymentKey = paymentKeyOf(payload, requirements);
  const fp = fingerprint(payload, requirements, resourceKey);
  const aKey = authKey(payload, requirements);
  const a = authOf(payload) || {};
  const respond = (settleResponse, http) => {
    if (pending) pending.delete(paymentKey); // odloženo telo ne sme puščati (uspešna pot ga porabi prej)
    return { paymentKey, settleResponse, http };
  };

  // pooblastilo, že videno z DRUGIM plačilom → determinističen 409 brez porabe plina
  if (aKey) {
    const seen = dbx.checkAuthorization(aKey, paymentKey);
    if (seen.seenBefore) {
      return respond({ success: false, errorReason: 'authorization_replayed', network: requirements.network },
        { status: 409, code: 'authorization_replayed' });
    }
  }

  const claimArgs = {
    paymentId: paymentKey, resource: resourceKey, fingerprint: fp,
    network: requirements.network, scheme: requirements.scheme, asset: requirements.asset,
    amountAtomic: String(requirements.amount ?? requirements.maxAmountRequired ?? ''),
    payer: a.from || null, payTo: requirements.payTo, authNonce: a.nonce || null,
    leaseMs: config.leaseMs, retentionMs: config.retentionMs
  };

  // največ dva kroga: drugi krog je možen le, ko uskladitev DOKAŽE, da
  // pooblastilo ni porabljeno (vrstica postane FAILED/retryable → OWNER)
  let owner = false;
  for (let krog = 0; krog < 2 && !owner; krog++) {
    const claim = dbx.claimPayment(claimArgs);
    switch (claim.outcome) {
      case 'CONFLICT_RESOURCE':
        return respond({ success: false, errorReason: 'payment_id_resource_mismatch', network: requirements.network },
          { status: 409, code: 'payment_id_resource_mismatch' });
      case 'CONFLICT_PAYLOAD':
        return respond({ success: false, errorReason: 'payment_id_payload_mismatch', network: requirements.network },
          { status: 409, code: 'payment_id_payload_mismatch' });
      case 'CACHED':
        return respond(JSON.parse(claim.row.payment_response || '{"success":true}'), { status: 200, cached: true, row: claim.row });
      case 'TERMINAL':
        return respond({ success: false, errorReason: claim.row.error_code || 'settlement_failed', network: requirements.network },
          { status: 402, code: claim.row.error_code || 'settlement_failed' });
      case 'BUSY':
        return respond({ success: false, errorReason: 'payment_in_progress', network: requirements.network },
          { status: 409, code: 'payment_in_progress', retryAfter: Math.ceil(config.leaseMs / 1000) });
      case 'RECONCILE': {
        const out = await reconcile({ dbx, row: claim.row, requirements, remote, logger });
        if (!out.resettle) return respond(out.settleResponse, out.http);
        continue; // dokazano neporabljeno → nov claim prevzame kot OWNER
      }
      case 'INDETERMINATE': {
        const out = await resolveIndeterminate({ dbx, row: claim.row, requirements, payload, remote, logger });
        if (!out.resettle) return respond(out.settleResponse, out.http);
        continue;
      }
      case 'OWNER':
        owner = true;
        break;
    }
  }
  if (!owner) {
    return respond({ success: false, errorReason: 'settlement_indeterminate', network: requirements.network },
      { status: 409, code: 'settlement_indeterminate', retryAfter: 5 });
  }

  // ── lastnik: ena poravnava ─────────────────────────────────────────────────
  const fault = pendingFaults.get(paymentKey); pendingFaults.delete(paymentKey);
  let settleResponse;
  let lastReceipt = null;
  const tSettle0 = performance.now();
  try {
    if (remote) {
      // mapa 04 (trgovec): oddaljena poravnava; posrednik vodi SVOJ statusni
      // stroj — tu beležimo le izid za predvajanje odgovora.
      settleResponse = await remote.settle(payload, requirements);
      if (settleResponse && settleResponse.success && settleResponse.transaction) {
        dbx.markBroadcast(paymentKey, settleResponse.transaction);
      }
    } else {
      const facilitator = buildFacilitator(
        (hash) => dbx.markBroadcast(paymentKey, hash),  // sinhron CAS PRED čakanjem
        fault,
        (rc) => { lastReceipt = rc; }                   // gas/blok za meritve
      );
      settleResponse = await facilitator.settle(payload, requirements);
    }
  } catch (err) {
    const row = dbx.getPayment(paymentKey);
    if (row && row.tx_hash) {
      // oddano, izid neznan → BROADCAST obstane; NIKOLI slepa druga oddaja
      (logger || console).warn
        ? logger.warn({ paymentKey, txHash: row.tx_hash }, 'x402: potrdilo poteklo — poravnava ostaja BROADCAST')
        : console.warn('x402: potrdilo poteklo', paymentKey);
      return respond({ success: false, errorReason: 'settlement_pending', network: requirements.network },
        { status: 409, code: 'settlement_pending', retryAfter: Math.ceil(config.pollMs / 1000) || 1 });
    }
    dbx.markFailed(paymentKey, { code: 'settlement_error', message: err.message, retryable: 1 });
    return respond({ success: false, errorReason: 'settlement_error', network: requirements.network },
      { status: 402, code: 'settlement_error' });
  }

  if (settleResponse && settleResponse.success) {
    const pr = encodePaymentResponse(settleResponse);
    dbx.markSettled(paymentKey, {
      txHash: settleResponse.transaction || null,
      blockNumber: lastReceipt && lastReceipt.blockNumber != null ? Number(lastReceipt.blockNumber) : null,
      gasUsed: lastReceipt && lastReceipt.gasUsed != null ? String(lastReceipt.gasUsed) : null,
      effectiveGasPrice: lastReceipt && lastReceipt.effectiveGasPrice != null ? String(lastReceipt.effectiveGasPrice) : null,
      paymentResponse: pr
    });
    // EIP-3009 tok "authorization" poravnava PO handlerju: telo odgovora je
    // handler že izdelal (čaka v `pending`), stranske učinke z realnim učinkom
    // (npr. odprtje seje v mapi 03) pa sproži šele USPEŠNA poravnava — tu.
    const entry = pending && pending.get(paymentKey);
    if (onSettled) {
      try { await onSettled({ paymentKey, payload, requirements, settleResponse, plan: entry && entry.plan }); }
      catch (e) { (logger && logger.error) ? logger.error({ err: e.message, paymentKey }, 'x402 onSettled hook failed') : console.error(e); }
    }
    if (entry) {
      if (entry.body != null) dbx.cacheResponse(paymentKey, entry.status || 200, entry.body);
      try { if (entry.res && !entry.res.headersSent) entry.res.setHeader('X-Settle-Ms', (performance.now() - tSettle0).toFixed(3)); } catch { /* glava ni kritična */ }
      pending.delete(paymentKey);
    }
    return respond(settleResponse, { status: 200, paymentResponse: pr });
  }
  // Neuspeh PO oddaji ni nujno dokončen: SDK ujame tudi potek čakanja na
  // potrdilo in ga vrne kot success:false. Če je hash že zabeležen in revert
  // NI dokazan, vrstica ostane BROADCAST — uskladitev jo kasneje razreši;
  // dokončni FAILED bi ob dejansko uspeli poravnavi vzel denar brez vira.
  const rowAfter = dbx.getPayment(paymentKey);
  if (rowAfter && rowAfter.tx_hash && rowAfter.status === 'BROADCAST') {
    const msg = String((settleResponse && settleResponse.errorMessage) || '').toLowerCase();
    const timeoutish = msg.includes('timed out') || msg.includes('timeout');
    let provenRevert = false;
    if (!timeoutish && !MOCK) {
      const rc = await getReceipt(rowAfter.tx_hash);
      if (rc && (rc.status === 'reverted' || rc.status === 0)) provenRevert = true;
      else if (rc && rc.status === 'success') {
        const pr = encodePaymentResponse({ success: true, transaction: rowAfter.tx_hash, network: requirements.network, payer: a.from || null });
        dbx.markSettled(paymentKey, { txHash: rowAfter.tx_hash, blockNumber: rc.blockNumber != null ? Number(rc.blockNumber) : null, gasUsed: rc.gasUsed != null ? String(rc.gasUsed) : null, effectiveGasPrice: rc.effectiveGasPrice != null ? String(rc.effectiveGasPrice) : null, paymentResponse: pr });
        return respond({ success: true, transaction: rowAfter.tx_hash, network: requirements.network }, { status: 200, paymentResponse: pr, reconciled: true });
      }
    }
    if (!provenRevert) {
      return respond({ success: false, errorReason: 'settlement_pending', network: requirements.network },
        { status: 409, code: 'settlement_pending', retryAfter: 2 });
    }
  }
  const failCode = settleResponse && settleResponse.errorReason || 'settlement_failed';
  // prehodni izidi (oddaljeni posrednik še čaka) NISO dokončni neuspehi
  const transient = ['settlement_pending', 'payment_in_progress', 'settlement_indeterminate'].includes(failCode);
  dbx.markFailed(paymentKey, {
    code: failCode,
    message: settleResponse && settleResponse.errorMessage || '', retryable: transient ? 1 : 0
  });
  return respond(settleResponse || { success: false, errorReason: failCode, network: requirements.network },
    transient ? { status: 409, code: failCode, retryAfter: 2 } : { status: 402, code: failCode });
}

/** BROADCAST vrstica: preberi potrdilo; brez potrdila v mreži miruj do izteka milosti. */
async function reconcile({ dbx, row, requirements, remote, logger }) {
  const rc = remote && remote.reconcile
    ? await remote.reconcile({ txHash: row.tx_hash })
    : await getReceipt(row.tx_hash).then((r) => r && {
        status: r.status, blockNumber: r.blockNumber, gasUsed: r.gasUsed, effectiveGasPrice: r.effectiveGasPrice
      });
  if (rc && (rc.status === 'success' || rc.status === 1)) {
    const settleResponse = { success: true, transaction: row.tx_hash, network: row.network, payer: row.payer };
    const pr = encodePaymentResponse(settleResponse);
    dbx.markSettled(row.payment_id, {
      txHash: row.tx_hash,
      blockNumber: rc.blockNumber != null ? Number(rc.blockNumber) : null,
      gasUsed: rc.gasUsed != null ? String(rc.gasUsed) : null,
      effectiveGasPrice: rc.effectiveGasPrice != null ? String(rc.effectiveGasPrice) : null,
      paymentResponse: pr
    });
    return { settleResponse, http: { status: 200, paymentResponse: pr, reconciled: true } };
  }
  if (rc && (rc.status === 'reverted' || rc.status === 0)) {
    dbx.markFailed(row.payment_id, { code: 'settlement_reverted', message: 'transakcija zavrnjena na verigi', retryable: 0 });
    return {
      settleResponse: { success: false, errorReason: 'settlement_reverted', network: row.network },
      http: { status: 402, code: 'settlement_reverted' }
    };
  }
  if (Date.now() - row.updated_at < config.broadcastGraceMs) {
    return {
      settleResponse: { success: false, errorReason: 'settlement_pending', network: row.network },
      http: { status: 409, code: 'settlement_pending', retryAfter: 2 }
    };
  }
  // milost potekla, potrdila ni → transakcija izgubljena? Odloči stanje pooblastila.
  return resolveIndeterminate({ dbx, row, requirements, remote, logger });
}

/** Izid neznan: vprašaj verigo, ali je pooblastilo porabljeno. Nikoli ne ugibaj. */
async function resolveIndeterminate({ dbx, row, requirements, payload, remote }) {
  const from = row.payer;
  const nonce = row.auth_nonce || (payload && authOf(payload) && authOf(payload).nonce);
  const used = remote && remote.reconcile
    ? await remote.reconcile({ from, nonce }).then((r) => (r ? r.authorizationUsed : null)).catch(() => null)
    : await isAuthorizationUsed({ from, nonce });
  if (used === true) {
    // denar se je premaknil, hash ni znan → pošteno: SETTLED_UNVERIFIED, brez druge bremenitve
    const settleResponse = { success: true, transaction: row.tx_hash || null, network: row.network, payer: row.payer };
    const pr = encodePaymentResponse(settleResponse);
    dbx.markSettledUnverified(row.payment_id, pr);
    return { settleResponse, http: { status: 200, paymentResponse: pr, unverified: true } };
  }
  if (used === false) {
    // dokazano neporabljeno → varna (ne slepa) ponovna poravnava
    dbx.reclaimAfterProvenUnused(row.payment_id);
    return { resettle: true };
  }
  return {
    settleResponse: { success: false, errorReason: 'settlement_indeterminate', network: row.network },
    http: { status: 409, code: 'settlement_indeterminate', retryAfter: 5 }
  };
}

// ── strežnik virov / vezava na Express ───────────────────────────────────────

/**
 * Konfiguracija ene x402 poti za paymentMiddleware: eksplicitni TokenAmount
 * (atomske enote), ne "$0.01" — cena mora biti pribita v datoteki, ne v
 * SDK-jevi tabeli. Razširitev payment-identifier je vedno oglaševana.
 */
function routeConfig(description, amountAtomic) {
  const { declarePaymentIdentifierExtension, PAYMENT_IDENTIFIER } = requireSdk();
  const asset = resolveAsset();
  return {
    accepts: [{
      scheme: 'exact',
      network: config.network,
      // AssetAmount oblika SDK-ja: asset je NASLOV (niz), EIP-712 domena gre v extra
      price: {
        amount: amountAtomic || config.priceAtomic,
        asset: asset.address,
        extra: { name: asset.name, version: asset.version }
      },
      payTo: config.payTo,
      maxTimeoutSeconds: config.maxTimeoutSeconds
    }],
    description: description || '',
    mimeType: 'application/json',
    extensions: { [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension(false) }
  };
}

/**
 * Sestavi Express middleware za podane poti.
 *  routes:  { 'GET /x402/service': routeConfig(...), ... }
 *  remote:  mapa 04 (trgovec): { verify, settle, getSupported, reconcile } prek posrednika
 * Vrne { middleware, x402Route } — x402Route ovije končni handler s
 * predvajanjem predpomnjenih odgovorov in beleženjem teles (glej README).
 */
function buildMiddleware({ dbx, routes, logger, remote, onSettled }) {
  const { x402ResourceServer, x402HTTPResourceServer, paymentMiddlewareFromHTTPServer } = requireSdk();
  const { ExactEvmServerScheme } = requireSdk();

  const timings = new Map(); // paymentKey -> { verifyMs } za X-Verify-Ms
  // Tok "authorization" (EIP-3009) poravna PO handlerju; handler zato telo in
  // res odloži sem, poravnalna pot pa ju ob uspehu prebere (predpomni telo,
  // doda X-Settle-Ms, sproži onSettled). Ključ: paymentKey.
  const pending = new Map();

  const facilitatorLike = {
    verify: async (payload, requirements) => {
      const t0 = performance.now();
      const r = remote ? await remote.verify(payload, requirements) : await getVerifyFacilitator().verify(payload, requirements);
      const key = paymentKeyOf(payload, requirements);
      timings.set(key, { ...(timings.get(key) || {}), verifyMs: performance.now() - t0 });
      return r;
    },
    settle: async (payload, requirements) => {
      const resourceKey = (payload && payload.resource && (payload.resource.url || payload.resource)) || '';
      const out = await settleWithIdempotency({
        dbx, payload, requirements, resourceKey: normResource(resourceKey),
        logger, remote, pending, onSettled
      });
      return out.settleResponse;
    },
    getSupported: async () =>
      remote ? remote.getSupported() : getVerifyFacilitator().getSupported()
  };

  const rs = new x402ResourceServer(facilitatorLike).register(config.network, new ExactEvmServerScheme());
  const httpServer = new x402HTTPResourceServer(rs, routes);

  function reqPaymentKey(req) {
    if (req.x402PaymentKey) return req.x402PaymentKey;
    const h = req.headers['payment-signature'] || req.headers['x-payment'];
    if (!h) return null;
    const payload = decodePaymentHeader(h);
    if (!payload) return null;
    const requirements0 = { network: config.network, asset: resolveAsset().address };
    const key = paymentIdOf(payload) || ('auth_' + (authKey(payload, requirements0) || ''));
    req.x402PaymentKey = key;
    return key;
  }

  // Idempotenčni prestreznik teče PRED verify: ponovitev že poravnanega
  // plačila mora dobiti predpomnjen odgovor, ne ponovnega preverjanja — na
  // pravi verigi bi ponovni verify padel (pooblastilo je že porabljeno) in
  // uskladitev se ne bi nikoli zgodila.
  httpServer.onProtectedRequest(async (context) => {
    if (!context.paymentHeader) return; // navadni 402 izziv
    const payload = decodePaymentHeader(context.paymentHeader);
    if (!payload) return;
    const adapter = context.adapter;
    const req = adapter && adapter.req;
    if (!req) return;

    const key = reqPaymentKey(req);
    if (!key) return;

    if (MOCK_FAULTS && req.headers['x-x402-mock-fault']) {
      // napake vsiljujemo po identiteti plačila, ne po telesu — prstni odtis ostane čist
      noteFault(key, String(req.headers['x-x402-mock-fault']));
    }

    const row = dbx.getPayment(key);
    if (!row) return; // sveže plačilo → običajni verify+settle tok

    const resourceKey = normResource(req.originalUrl || req.url);
    if (row.resource !== resourceKey) {
      req.x402 = { izid: 'spor', koda: 'payment_id_resource_mismatch', paymentKey: key };
      return { grantAccess: true };
    }
    // isti vir, drug podpis/pooblastilo pod istim payment-id → spor
    const reqs = { scheme: row.scheme, network: row.network, asset: row.asset, amount: row.amount_atomic, payTo: row.pay_to };
    if (fingerprint(payload, reqs, resourceKey) !== row.fingerprint) {
      req.x402 = { izid: 'spor', koda: 'payment_id_payload_mismatch', paymentKey: key };
      return { grantAccess: true };
    }

    if (['SETTLED', 'SETTLED_UNVERIFIED'].includes(row.status)) {
      req.x402 = row.response_body != null
        ? { izid: 'predvajanje', row, paymentKey: key }
        : { izid: 'poravnano_brez_telesa', row, paymentKey: key };
      return { grantAccess: true };
    }
    if (row.status === 'SETTLING' && row.lease_until >= Date.now()) {
      req.x402 = { izid: 'v_teku', koda: 'payment_in_progress', paymentKey: key };
      return { grantAccess: true };
    }
    if (row.status === 'BROADCAST' || row.status === 'INDETERMINATE' ||
        (row.status === 'SETTLING' && row.lease_until < Date.now())) {
      // izid neznan → uskladi TUKAJ (pred verify): potrdilo/stanje pooblastila
      const out = row.status === 'BROADCAST'
        ? await reconcile({ dbx, row, requirements: reqs, remote, logger })
        : await resolveIndeterminate({ dbx, row, requirements: reqs, payload, remote });
      if (out.resettle) {
        // dokazano neporabljeno → označi za varen ponovni zakup in spusti v običajni tok
        return;
      }
      if (out.http && out.http.status === 200) {
        const fresh = dbx.getPayment(key);
        req.x402 = fresh.response_body != null
          ? { izid: 'predvajanje', row: fresh, paymentKey: key }
          : { izid: 'poravnano_brez_telesa', row: fresh, paymentKey: key };
        return { grantAccess: true };
      }
      req.x402 = {
        izid: out.http && out.http.status === 409 ? 'v_teku' : 'neuspeh',
        koda: out.http && out.http.code || 'settlement_failed',
        retryAfter: out.http && out.http.retryAfter, paymentKey: key
      };
      return { grantAccess: true };
    }
    // FAILED → naj settle-pot vrne zabeleženi neuspeh (402)
    return;
  });

  const middleware = paymentMiddlewareFromHTTPServer(httpServer);

  /**
   * Ovoj končnega handlerja x402 poti:
   *  - spor → 409; v teku → 409 + Retry-After; uskladitveni neuspeh → 402,
   *  - predvajanje → predpomnjen odgovor + izvirni PAYMENT-RESPONSE + oznaka,
   *  - sveže/uspešno → izvedi handler in telo predpomni za prihodnja predvajanja.
   */
  function x402Route(handler) {
    return async (req, res, next) => {
      const st = req.x402;
      if (st && st.izid === 'spor') {
        return res.status(409).json({ error: 'Payment identifier conflict', code: st.koda });
      }
      if (st && st.izid === 'v_teku') {
        res.setHeader('Retry-After', String(st.retryAfter || 2));
        return res.status(409).json({ error: 'Payment not final', code: st.koda });
      }
      if (st && st.izid === 'neuspeh') {
        return res.status(402).json({ error: 'Payment failed', code: st.koda });
      }
      if (st && st.izid === 'predvajanje') {
        if (st.row.payment_response) res.setHeader('PAYMENT-RESPONSE', st.row.payment_response);
        res.setHeader('X-X402-Idempotent-Replay', '1');
        res.type('application/json');
        return res.status(st.row.response_status || 200).send(st.row.response_body);
      }
      // sveže plačilo ali poravnano-brez-telesa: izvedi handler in ujemi telo
      if (st && st.izid === 'poravnano_brez_telesa' && st.row.payment_response) {
        res.setHeader('PAYMENT-RESPONSE', st.row.payment_response);
        res.setHeader('X-X402-Settlement', st.row.status === 'SETTLED_UNVERIFIED' ? 'unverified' : 'reconciled');
      }
      const paymentKey = (st && st.paymentKey) || reqPaymentKey(req);
      const tm = paymentKey && timings.get(paymentKey);
      if (tm) {
        if (tm.verifyMs != null) res.setHeader('X-Verify-Ms', tm.verifyMs.toFixed(3));
        timings.delete(paymentKey);
      }
      if (paymentKey) pending.set(paymentKey, { res });
      const origJson = res.json.bind(res);
      res.json = (body) => {
        try {
          const entry = paymentKey && pending.get(paymentKey);
          if (entry && res.statusCode < 400) {
            entry.status = res.statusCode;
            entry.body = JSON.stringify(body);
            entry.plan = req.x402Plan || null; // stranski učinki šele ob uspešni poravnavi
          }
        } catch { /* odlaganje telesa ne sme podreti odgovora */ }
        return origJson(body);
      };
      return handler(req, res, next);
    };
  }

  return { middleware, x402Route, facilitatorLike, httpServer };
}

/** Pot vira brez sheme/gostitelja in poizvedbe — stabilen ključ vezave. */
function normResource(u) {
  try {
    const url = new URL(u, 'http://x');
    return url.pathname;
  } catch { return String(u).split('?')[0]; }
}

// ── zdravje ──────────────────────────────────────────────────────────────────

async function health() {
  if (!enabled) return { mode: 'off' };
  if (MOCK) return { mode: MODE, mock: true, network: config.network, rpc: 'mock' };
  if (MODE === 'facilitated') return { mode: MODE, network: config.network, rpc: 'posrednik' };
  try {
    const { client } = getViemBits();
    const block = await Promise.race([
      client.getBlockNumber(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('t/o')), 2000))
    ]);
    return { mode: MODE, network: config.network, rpc: 'ok', block: Number(block) };
  } catch (e) {
    return { mode: MODE, network: config.network, rpc: 'down', error: e.message };
  }
}

module.exports = {
  MODE, MOCK, enabled, config, summary,
  MOCK_TX_PREFIX,
  requireSdk, resolveAsset, settlerAddress,
  routeConfig, buildMiddleware,
  settleWithIdempotency,
  getVerifyFacilitator, buildFacilitator,
  fingerprint, authKey, paymentIdOf, paymentKeyOf,
  decodePaymentHeader, encodePaymentResponse, readPaymentResponse,
  getReceipt, isAuthorizationUsed,
  noteFault, normResource, health
};
