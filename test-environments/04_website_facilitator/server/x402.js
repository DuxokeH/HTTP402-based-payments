'use strict';

// Node 18: the global WebCrypto is unconditional only from Node 19; the SDK's
// createNonce() would otherwise throw "Crypto API not available". On Node 20+ this is a no-op.
if (!globalThis.crypto) globalThis.crypto = require('node:crypto').webcrypto;

/**
 * x402 v2 — shared module for the NEW, PARALLEL payment modes (the official protocol).
 *
 * This file is byte-identical in all folders (like auth.js). The existing custom
 * protocol (402 → native ETH transaction → /verify-payment → proof_<uuid> →
 * X-Payment) is UNTOUCHED; the x402 routes live in parallel under /x402/*.
 *
 * The configuration reads EXCLUSIVELY the variables with the X402_* prefix and
 * the x402* keys from wallet.json. It never reads RPC_URL / NETWORK /
 * MIN_CONFIRMATIONS of the existing (Ethereum Sepolia) world — the chain
 * separation is deliberate and strict:
 *
 *   NATIVE ETH:  Ethereum Sepolia  (eip155:11155111)  ← existing variables
 *   X402:        Ethereum Sepolia  (eip155:11155111)  ← X402_* variables only
 *                (TEST: amounts in ETH/wei; settlement is mock-only — see the
 *                 note at `asset` below)
 *
 * Modes (X402_MODE):
 *   off          — the /x402/* routes are not mounted; the folder works as before
 *   self         — self-facilitated: THIS server verifies and settles via its
 *                  own X402_RPC_URL (folders 01, 02, 03, 05)
 *   facilitated  — verification/settlement is done by the LOCAL facilitator
 *                  (folder 04: merchant without RPC; the calls are supplied by
 *                  the caller via `remote`)
 *
 * X402_MOCK=true — the real SDK facilitator with a stub instead of the chain:
 * signatures, recipient, amount and validity are verified FOR REAL (offline),
 * while settlement returns a synthetic hash with the prefix 0x6d6f636b6d6f636b
 * ("mockmock" in ASCII), so that every measurement row is unmistakably marked
 * as simulated.
 */

const { createHash } = require('node:crypto');
const fs = require('fs');
const path = require('path');

// ── configuration ────────────────────────────────────────────────────────────

const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';

const MODE = (process.env.X402_MODE || 'off').toLowerCase();
if (!['off', 'self', 'facilitated'].includes(MODE)) {
  throw new Error(`X402_MODE must be off|self|facilitated, not "${MODE}"`);
}
// the same safety valve as MOCK_VERIFY: in production only with FORCE_MOCK=1
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
  // TEST configuration: all folders charge in ETH (wei, 18 decimals) so that the
  // amounts are directly comparable with the native flow. For a REAL settlement
  // the official `exact` scheme requires a token with EIP-3009
  // (transferWithAuthorization) — native ETH does not have it, so the address
  // below is NOT a contract and the real run is locked (safeguard under
  // `enabled`). Mock still verifies signatures FOR REAL.
  asset: process.env.X402_USDC_ADDRESS || '0x0000000000000000000000000000000000000000',
  assetName: process.env.X402_ASSET_NAME || 'ETH',
  assetVersion: process.env.X402_ASSET_VERSION || '1',
  assetDecimals: parseInt(process.env.X402_ASSET_DECIMALS || '18', 10),
  priceAtomic: process.env.X402_PRICE_ATOMIC || '100000000000',            // 0.0000001 ETH — same as the native flow
  sessionDepositAtomic: process.env.X402_SESSION_DEPOSIT_ATOMIC || '2000000000000', // 0.000002 ETH = 20 payments
  payTo: process.env.X402_MERCHANT_ADDRESS || wallet.x402Address || wallet.address || null,
  rpcUrl: process.env.X402_RPC_URL || null,
  rpcTimeoutMs: parseInt(process.env.X402_RPC_TIMEOUT_MS || '20000', 10),
  receiptTimeoutMs: parseInt(process.env.X402_SETTLE_TIMEOUT_MS || '60000', 10),
  // SEPARATE from the native flow's MIN_CONFIRMATIONS — the confirmation policy
  // is NOT inherited between the flows, even when they run on the same chain.
  confirmations: Math.max(1, parseInt(process.env.X402_MIN_CONFIRMATIONS || '1', 10)),
  pollMs: parseInt(process.env.X402_POLL_MS || '1000', 10),
  maxTimeoutSeconds: parseInt(process.env.X402_MAX_TIMEOUT_SECONDS || '300', 10),
  leaseMs: parseInt(process.env.X402_LEASE_MS || '45000', 10),
  broadcastGraceMs: parseInt(process.env.X402_BROADCAST_GRACE_MS || '180000', 10),
  retentionMs: parseInt(process.env.X402_IDEMPOTENCY_TTL_SECONDS || '86400', 10) * 1000,
  facilitatorUrl: process.env.X402_FACILITATOR_URL || null,
  // settlement key: ONLY from the environment or wallet.json; never in the log, never in /config
  settlerKey: process.env.X402_SETTLEMENT_PRIVATE_KEY || wallet.x402SettlerPrivateKey || null
});

const enabled = MODE !== 'off';
const MOCK_TX_PREFIX = '0x6d6f636b6d6f636b'; // "mockmock"

// Safeguard for the test ETH configuration: without a real EIP-3009 contract a
// real run would fail only at settlement (and casually write "real" rows before
// that). So fail IMMEDIATELY at startup, with instructions.
if (enabled && !MOCK && /^0x0{40}$/i.test(config.asset)) {
  throw new Error(
    'x402: the asset is test ETH without a contract (native ETH has no EIP-3009), ' +
    'so a real run is not possible. Start with X402_MOCK=true or configure a real ' +
    'token: X402_USDC_ADDRESS + X402_ASSET_NAME/VERSION/DECIMALS.'
  );
}

/** Safe for /config and the log — no secrets. */
function summary() {
  return {
    mode: MODE, mock: MOCK, network: config.network, scheme: 'exact',
    asset: config.asset, assetName: config.assetName, assetDecimals: config.assetDecimals,
    priceAtomic: config.priceAtomic, payTo: config.payTo,
    confirmations: config.confirmations,
    facilitatorUrl: config.facilitatorUrl,
    rpc: config.rpcUrl ? 'set' : null
  };
}

// ── lazy SDK require (a folder with X402_MODE=off works without packages) ────

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

/** Canonical token data: prefer the SDK's registry over manual constants. */
function resolveAsset() {
  try {
    const a = requireSdk().getDefaultAsset(config.network);
    if (a && a.asset) {
      return { address: a.asset, name: a.name, version: a.version, decimals: a.decimals };
    }
  } catch { /* chain unknown to the SDK — keep the configured values */ }
  return { address: config.asset, name: config.assetName, version: config.assetVersion, decimals: config.assetDecimals };
}

// ── viem client (self mode only, a single instance) ──────────────────────────

let viemBits = null;
function getViemBits() {
  if (viemBits) return viemBits;
  const { viem, privateKeyToAccount, baseSepolia } = requireSdk();
  if (!config.settlerKey) {
    throw new Error('x402: missing settlement key (X402_SETTLEMENT_PRIVATE_KEY or wallet.json.x402SettlerPrivateKey)');
  }
  if (!MOCK && !config.rpcUrl) {
    throw new Error('x402: X402_MODE=self without X402_MOCK requires X402_RPC_URL');
  }
  const account = privateKeyToAccount(config.settlerKey);
  const chainId = parseInt(config.network.split(':')[1], 10);
  const chain = chainId === 84532 ? baseSepolia : { ...baseSepolia, id: chainId };
  const client = viem.createWalletClient({
    account, chain,
    // retryCount: 0 — the retry policy is OURS (the state machine);
    // a transport retry after a timeout could submit the settlement twice.
    transport: viem.http(config.rpcUrl || 'http://127.0.0.1:1', { timeout: config.rpcTimeoutMs, retryCount: 0 })
  }).extend(viem.publicActions);
  viemBits = { account, client, chain };
  return viemBits;
}

function settlerAddress() {
  if (MODE !== 'self' && !MOCK) return null;
  try { return getViemBits().account.address; } catch { return null; }
}

// ── facilitator signers ──────────────────────────────────────────────────────

/**
 * Real signer (self mode). `onBroadcast` is called with the submitted hash
 * BEFORE waiting for the receipt — if the wait times out, the hash is NOT lost
 * and reconciliation can read the receipt instead of blindly submitting again.
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
      if (onReceipt && rc) onReceipt(rc); // gas/block for measurements
      return rc;
    }
  });
}

/**
 * Stub for MOCK: the real SDK facilitator, but all chain reads are stubs and
 * the "broadcast" returns a synthetic hash. Signatures/recipient/amount/validity
 * are verified for real (offline viem.verifyTypedData for an EOA).
 */
function mockSigner(onBroadcast, fault, onReceipt) {
  const { toFacilitatorEvmSigner, viem, privateKeyToAccount } = requireSdk();
  const asset = resolveAsset();
  // deterministic "settlement account" for mock (not a secret, holds no funds)
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
        default: return 0n; // incl. the transferWithAuthorization simulation
      }
    },
    verifyTypedData: async (a) => viem.verifyTypedData(a),
    writeContract: async (a) => {
      if (fault === 'revert') {
        const e = new Error('mock: settlement reverted'); e.name = 'ContractFunctionExecutionError'; throw e;
      }
      // seed = ALL arguments (they contain the EIP-3009 nonce) → hash unique per payment
      const hash = synthetic(JSON.stringify(a.args || a, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
      if (onBroadcast) onBroadcast(hash);
      if (fault === 'timeout') {
        const e = new Error('mock: timed out while waiting for transaction receipt'); e.name = 'WaitForTransactionReceiptTimeoutError'; throw e;
      }
      return hash;
    },
    sendTransaction: async () => { throw new Error('mock: sendTransaction is not used'); },
    waitForTransactionReceipt: async ({ hash }) => {
      const rc = { status: 'success', transactionHash: hash, blockNumber: 1n,
        gasUsed: 65000n, effectiveGasPrice: 1000000n };
      if (onReceipt) onReceipt(rc);
      return rc;
    }
  });
}

/** One facilitator per settlement ATTEMPT — onBroadcast is bound to exactly one payment. */
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

// ── payment identity ─────────────────────────────────────────────────────────

const sha256hex = (s) => createHash('sha256').update(s).digest('hex');

function authOf(payload) {
  return (payload && payload.payload && payload.payload.authorization) || null;
}

/** EIP-3009 authorization key: chain|token|payer|nonce (the contract is authoritative). */
function authKey(payload, requirements) {
  const a = authOf(payload);
  if (!a) return null;
  return sha256hex([requirements.network, String(requirements.asset).toLowerCase(),
    String(a.from).toLowerCase(), a.nonce].join('|'));
}

/**
 * Fingerprint: protocol fields + the signed authorization, WITHOUT the signature
 * (a re-signed identical authorization settles identically — caching is
 * correct) and WITHOUT the request body.
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

/** Payment identity: the payment-identifier extension, otherwise the authorization key. */
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

// ── chain reads for reconciliation ───────────────────────────────────────────

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

/** Has the payer's EIP-3009 authorization already been used on chain? (null = no access) */
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

// ── settlement state machine ─────────────────────────────────────────────────

const pendingFaults = new Map(); // paymentKey -> 'revert'|'timeout' (X402_MOCK_FAULTS only)

function noteFault(paymentKey, fault) {
  if (MOCK_FAULTS && (fault === 'revert' || fault === 'timeout')) pendingFaults.set(paymentKey, fault);
}

/**
 * Settlement with idempotency. Flow:
 *   lease (synchronous transaction) → await settle OUTSIDE the transaction → CAS write.
 * Never submits a second time unless the outcome of the previous submission is
 * provably "unused".
 * `remote` (folder 04, merchant): { settle(payload, requirements), reconcile({txHash}|{from,nonce}) }.
 */
async function settleWithIdempotency({ dbx, payload, requirements, resourceKey, logger, remote, pending, onSettled }) {
  const paymentKey = paymentKeyOf(payload, requirements);
  const fp = fingerprint(payload, requirements, resourceKey);
  const aKey = authKey(payload, requirements);
  const a = authOf(payload) || {};
  const respond = (settleResponse, http) => {
    if (pending) pending.delete(paymentKey); // the deferred body must not leak (the success path consumes it earlier)
    return { paymentKey, settleResponse, http };
  };

  // authorization already seen with a DIFFERENT payment → deterministic 409 without spending gas
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

  // at most two rounds: a second round is possible only when reconciliation
  // PROVES that the authorization is unused (the row becomes FAILED/retryable → OWNER)
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
        continue; // provably unused → a new claim takes over as OWNER
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

  // ── owner: a single settlement ─────────────────────────────────────────────
  const fault = pendingFaults.get(paymentKey); pendingFaults.delete(paymentKey);
  let settleResponse;
  let lastReceipt = null;
  const tSettle0 = performance.now();
  try {
    if (remote) {
      // folder 04 (merchant): remote settlement; the facilitator runs ITS OWN
      // state machine — here we only record the outcome for response replay.
      settleResponse = await remote.settle(payload, requirements);
      if (settleResponse && settleResponse.success && settleResponse.transaction) {
        dbx.markBroadcast(paymentKey, settleResponse.transaction);
      }
    } else {
      const facilitator = buildFacilitator(
        (hash) => dbx.markBroadcast(paymentKey, hash),  // synchronous CAS BEFORE waiting
        fault,
        (rc) => { lastReceipt = rc; }                   // gas/block for measurements
      );
      settleResponse = await facilitator.settle(payload, requirements);
    }
  } catch (err) {
    const row = dbx.getPayment(paymentKey);
    if (row && row.tx_hash) {
      // submitted, outcome unknown → BROADCAST persists; NEVER a blind second submission
      (logger || console).warn
        ? logger.warn({ paymentKey, txHash: row.tx_hash }, 'x402: receipt wait timed out — settlement stays BROADCAST')
        : console.warn('x402: receipt wait timed out', paymentKey);
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
    // The EIP-3009 "authorization" flow settles AFTER the handler: the response
    // body has already been produced by the handler (waiting in `pending`),
    // while side effects with real impact (e.g. opening a session in folder 03)
    // are triggered only by a SUCCESSFUL settlement — here.
    const entry = pending && pending.get(paymentKey);
    if (onSettled) {
      try { await onSettled({ paymentKey, payload, requirements, settleResponse, plan: entry && entry.plan }); }
      catch (e) { (logger && logger.error) ? logger.error({ err: e.message, paymentKey }, 'x402 onSettled hook failed') : console.error(e); }
    }
    if (entry) {
      if (entry.body != null) dbx.cacheResponse(paymentKey, entry.status || 200, entry.body);
      try { if (entry.res && !entry.res.headersSent) entry.res.setHeader('X-Settle-Ms', (performance.now() - tSettle0).toFixed(3)); } catch { /* the header is not critical */ }
      pending.delete(paymentKey);
    }
    return respond(settleResponse, { status: 200, paymentResponse: pr });
  }
  // A failure AFTER submission is not necessarily final: the SDK also catches a
  // receipt-wait timeout and returns it as success:false. If the hash is already
  // recorded and a revert is NOT proven, the row stays BROADCAST — reconciliation
  // resolves it later; a final FAILED would, if the settlement actually
  // succeeded, take the money without serving the resource.
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
  // transient outcomes (the remote facilitator is still waiting) are NOT final failures
  const transient = ['settlement_pending', 'payment_in_progress', 'settlement_indeterminate'].includes(failCode);
  dbx.markFailed(paymentKey, {
    code: failCode,
    message: settleResponse && settleResponse.errorMessage || '', retryable: transient ? 1 : 0
  });
  return respond(settleResponse || { success: false, errorReason: failCode, network: requirements.network },
    transient ? { status: 409, code: failCode, retryAfter: 2 } : { status: 402, code: failCode });
}

/** BROADCAST row: read the receipt; with no receipt on the network, stay idle until the grace period expires. */
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
    dbx.markFailed(row.payment_id, { code: 'settlement_reverted', message: 'transaction reverted on chain', retryable: 0 });
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
  // grace period expired, no receipt → transaction lost? The authorization state decides.
  return resolveIndeterminate({ dbx, row, requirements, remote, logger });
}

/** Outcome unknown: ask the chain whether the authorization has been used. Never guess. */
async function resolveIndeterminate({ dbx, row, requirements, payload, remote }) {
  const from = row.payer;
  const nonce = row.auth_nonce || (payload && authOf(payload) && authOf(payload).nonce);
  const used = remote && remote.reconcile
    ? await remote.reconcile({ from, nonce }).then((r) => (r ? r.authorizationUsed : null)).catch(() => null)
    : await isAuthorizationUsed({ from, nonce });
  if (used === true) {
    // the money moved, the hash is unknown → be honest: SETTLED_UNVERIFIED, no second debit
    const settleResponse = { success: true, transaction: row.tx_hash || null, network: row.network, payer: row.payer };
    const pr = encodePaymentResponse(settleResponse);
    dbx.markSettledUnverified(row.payment_id, pr);
    return { settleResponse, http: { status: 200, paymentResponse: pr, unverified: true } };
  }
  if (used === false) {
    // provably unused → a safe (not blind) re-settlement
    dbx.reclaimAfterProvenUnused(row.payment_id);
    return { resettle: true };
  }
  return {
    settleResponse: { success: false, errorReason: 'settlement_indeterminate', network: row.network },
    http: { status: 409, code: 'settlement_indeterminate', retryAfter: 5 }
  };
}

// ── resource server / Express binding ────────────────────────────────────────

/**
 * Configuration of a single x402 route for paymentMiddleware: an explicit
 * TokenAmount (atomic units), not "$0.01" — the price must be pinned in the
 * file, not in the SDK's table. The payment-identifier extension is always
 * advertised.
 */
function routeConfig(description, amountAtomic) {
  const { declarePaymentIdentifierExtension, PAYMENT_IDENTIFIER } = requireSdk();
  const asset = resolveAsset();
  return {
    accepts: [{
      scheme: 'exact',
      network: config.network,
      // The SDK's AssetAmount shape: asset is an ADDRESS (string), the EIP-712 domain goes into extra
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
 * Builds the Express middleware for the given routes.
 *  routes:  { 'GET /x402/service': routeConfig(...), ... }
 *  remote:  folder 04 (merchant): { verify, settle, getSupported, reconcile } via the facilitator
 * Returns { middleware, x402Route } — x402Route wraps the final handler with
 * replay of cached responses and body capture (see README).
 */
function buildMiddleware({ dbx, routes, logger, remote, onSettled }) {
  const { x402ResourceServer, x402HTTPResourceServer, paymentMiddlewareFromHTTPServer } = requireSdk();
  const { ExactEvmServerScheme } = requireSdk();

  const timings = new Map(); // paymentKey -> { verifyMs } for X-Verify-Ms
  // The "authorization" (EIP-3009) flow settles AFTER the handler; the handler
  // therefore defers the body and res here, and the settlement path reads them
  // on success (caches the body, adds X-Settle-Ms, triggers onSettled).
  // Key: paymentKey.
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

  // The idempotency interceptor runs BEFORE verify: a replay of an already
  // settled payment must get the cached response, not a re-verification — on a
  // real chain the repeated verify would fail (the authorization is already
  // used) and reconciliation would never happen.
  httpServer.onProtectedRequest(async (context) => {
    if (!context.paymentHeader) return; // plain 402 challenge
    const payload = decodePaymentHeader(context.paymentHeader);
    if (!payload) return;
    const adapter = context.adapter;
    const req = adapter && adapter.req;
    if (!req) return;

    const key = reqPaymentKey(req);
    if (!key) return;

    if (MOCK_FAULTS && req.headers['x-x402-mock-fault']) {
      // faults are injected by payment identity, not by body — the fingerprint stays clean
      noteFault(key, String(req.headers['x-x402-mock-fault']));
    }

    const row = dbx.getPayment(key);
    if (!row) return; // fresh payment → the usual verify+settle flow

    const resourceKey = normResource(req.originalUrl || req.url);
    if (row.resource !== resourceKey) {
      req.x402 = { outcome: 'spor', koda: 'payment_id_resource_mismatch', paymentKey: key };
      return { grantAccess: true };
    }
    // same resource, a different signature/authorization under the same payment-id → conflict
    const reqs = { scheme: row.scheme, network: row.network, asset: row.asset, amount: row.amount_atomic, payTo: row.pay_to };
    if (fingerprint(payload, reqs, resourceKey) !== row.fingerprint) {
      req.x402 = { outcome: 'spor', koda: 'payment_id_payload_mismatch', paymentKey: key };
      return { grantAccess: true };
    }

    if (['SETTLED', 'SETTLED_UNVERIFIED'].includes(row.status)) {
      req.x402 = row.response_body != null
        ? { outcome: 'predvajanje', row, paymentKey: key }
        : { outcome: 'poravnano_brez_telesa', row, paymentKey: key };
      return { grantAccess: true };
    }
    if (row.status === 'SETTLING' && row.lease_until >= Date.now()) {
      req.x402 = { outcome: 'v_teku', koda: 'payment_in_progress', paymentKey: key };
      return { grantAccess: true };
    }
    if (row.status === 'BROADCAST' || row.status === 'INDETERMINATE' ||
        (row.status === 'SETTLING' && row.lease_until < Date.now())) {
      // outcome unknown → reconcile HERE (before verify): receipt / authorization state
      const out = row.status === 'BROADCAST'
        ? await reconcile({ dbx, row, requirements: reqs, remote, logger })
        : await resolveIndeterminate({ dbx, row, requirements: reqs, payload, remote });
      if (out.resettle) {
        // provably unused → marked for a safe re-lease; fall through to the usual flow
        return;
      }
      if (out.http && out.http.status === 200) {
        const fresh = dbx.getPayment(key);
        req.x402 = fresh.response_body != null
          ? { outcome: 'predvajanje', row: fresh, paymentKey: key }
          : { outcome: 'poravnano_brez_telesa', row: fresh, paymentKey: key };
        return { grantAccess: true };
      }
      req.x402 = {
        outcome: out.http && out.http.status === 409 ? 'v_teku' : 'neuspeh',
        koda: out.http && out.http.code || 'settlement_failed',
        retryAfter: out.http && out.http.retryAfter, paymentKey: key
      };
      return { grantAccess: true };
    }
    // FAILED → let the settle path return the recorded failure (402)
    return;
  });

  const middleware = paymentMiddlewareFromHTTPServer(httpServer);

  /**
   * Wrapper for the final handler of an x402 route:
   *  - conflict → 409; in progress → 409 + Retry-After; reconciliation failure → 402,
   *  - replay → the cached response + the original PAYMENT-RESPONSE + a marker,
   *  - fresh/successful → run the handler and cache the body for future replays.
   */
  function x402Route(handler) {
    return async (req, res, next) => {
      const st = req.x402;
      if (st && st.outcome === 'spor') {
        return res.status(409).json({ error: 'Payment identifier conflict', code: st.koda });
      }
      if (st && st.outcome === 'v_teku') {
        res.setHeader('Retry-After', String(st.retryAfter || 2));
        return res.status(409).json({ error: 'Payment not final', code: st.koda });
      }
      if (st && st.outcome === 'neuspeh') {
        return res.status(402).json({ error: 'Payment failed', code: st.koda });
      }
      if (st && st.outcome === 'predvajanje') {
        if (st.row.payment_response) res.setHeader('PAYMENT-RESPONSE', st.row.payment_response);
        res.setHeader('X-X402-Idempotent-Replay', '1');
        res.type('application/json');
        return res.status(st.row.response_status || 200).send(st.row.response_body);
      }
      // fresh payment or settled-without-body: run the handler and capture the body
      if (st && st.outcome === 'poravnano_brez_telesa' && st.row.payment_response) {
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
            entry.plan = req.x402Plan || null; // side effects only on successful settlement
          }
        } catch { /* deferring the body must not break the response */ }
        return origJson(body);
      };
      return handler(req, res, next);
    };
  }

  return { middleware, x402Route, facilitatorLike, httpServer };
}

/** Resource path without scheme/host and query string — a stable binding key. */
function normResource(u) {
  try {
    const url = new URL(u, 'http://x');
    return url.pathname;
  } catch { return String(u).split('?')[0]; }
}

// ── health ───────────────────────────────────────────────────────────────────

async function health() {
  if (!enabled) return { mode: 'off' };
  if (MOCK) return { mode: MODE, mock: true, network: config.network, rpc: 'mock' };
  if (MODE === 'facilitated') return { mode: MODE, network: config.network, rpc: 'facilitator' };
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
