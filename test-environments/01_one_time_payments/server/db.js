'use strict';

/**
 * SQLite persistence layer — ONE-TIME payment flow (folder 01_one_time_payments).
 *
 * Derived from the original test-environments/00_demo/server/db.js, trimmed to the one-time
 * flow and extended with a `resource` column so that a proof token is bound to
 * the exact resource it paid for (unambiguous linking of
 * payment-request ↔ transaction ↔ proof ↔ requested resource).
 *
 * NOTE: this is a self-contained copy for the measurement harness. The original
 * project files under test-environments/00_demo/ are intentionally left untouched.
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'x402_one_time.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS payment_requests (
    request_id      TEXT PRIMARY KEY,
    resource        TEXT NOT NULL,
    recipient       TEXT NOT NULL,
    amount_eth      TEXT NOT NULL,
    currency        TEXT NOT NULL,
    network         TEXT NOT NULL,
    payer_address   TEXT,
    created_at      INTEGER NOT NULL,
    expires_at      INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS payment_proofs (
    proof_token     TEXT PRIMARY KEY,
    request_id      TEXT NOT NULL,
    resource        TEXT NOT NULL,
    tx_hash         TEXT NOT NULL,
    block_number    INTEGER NOT NULL,
    payer_address   TEXT NOT NULL,
    recipient       TEXT NOT NULL,
    amount_eth      TEXT NOT NULL,
    verified_at     INTEGER NOT NULL,
    expires_at      INTEGER NOT NULL,
    consumed_at     INTEGER
  );

  CREATE TABLE IF NOT EXISTS redeemed_tx_hashes (
    tx_hash         TEXT PRIMARY KEY,
    request_id      TEXT NOT NULL,
    redeemed_at     INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS openai_usage (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    day             TEXT NOT NULL,
    model           TEXT NOT NULL,
    prompt_tokens   INTEGER NOT NULL,
    completion_tokens INTEGER NOT NULL,
    cost_usd        REAL NOT NULL,
    created_at      INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_openai_usage_day ON openai_usage(day);
  CREATE INDEX IF NOT EXISTS idx_payment_requests_expires ON payment_requests(expires_at);
  CREATE INDEX IF NOT EXISTS idx_payment_proofs_expires ON payment_proofs(expires_at);
`);

const stmts = {
  insertRequest: db.prepare(`
    INSERT INTO payment_requests
      (request_id, resource, recipient, amount_eth, currency, network, payer_address, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getRequest: db.prepare('SELECT * FROM payment_requests WHERE request_id = ?'),
  insertProof: db.prepare(`
    INSERT INTO payment_proofs
      (proof_token, request_id, resource, tx_hash, block_number, payer_address, recipient, amount_eth, verified_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getProof: db.prepare('SELECT * FROM payment_proofs WHERE proof_token = ?'),
  consumeProof: db.prepare('UPDATE payment_proofs SET consumed_at = ? WHERE proof_token = ? AND consumed_at IS NULL'),
  isTxRedeemed: db.prepare('SELECT 1 FROM redeemed_tx_hashes WHERE tx_hash = ?'),
  redeemTx: db.prepare('INSERT INTO redeemed_tx_hashes (tx_hash, request_id, redeemed_at) VALUES (?, ?, ?)'),
  insertUsage: db.prepare(`
    INSERT INTO openai_usage (day, model, prompt_tokens, completion_tokens, cost_usd, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  sumUsageForDay: db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM openai_usage WHERE day = ?'),
  sweepRequests: db.prepare('DELETE FROM payment_requests WHERE expires_at < ?'),
  sweepProofs: db.prepare('DELETE FROM payment_proofs WHERE expires_at < ?'),
  healthCheck: db.prepare('SELECT 1 AS ok')
};

function createPaymentRequest({ requestId, resource, recipient, amountEth, currency, network, payerAddress, ttlSeconds }) {
  const now = Date.now();
  stmts.insertRequest.run(
    requestId, resource, recipient, amountEth, currency, network,
    payerAddress || null, now, now + ttlSeconds * 1000
  );
}

function getPaymentRequest(requestId) {
  const row = stmts.getRequest.get(requestId);
  if (!row) return null;
  if (row.expires_at < Date.now()) return null;
  return row;
}

// markTxRedeemed + createProof happen inside ONE SQLite transaction so a crash
// between the two writes can never mark a tx as used without minting a proof.
const finalizeVerification = db.transaction((args) => {
  const { proofToken, requestId, resource, txHash, blockNumber, payerAddress, recipient, amountEth, ttlSeconds } = args;
  stmts.redeemTx.run(txHash, requestId, Date.now());
  const now = Date.now();
  stmts.insertProof.run(
    proofToken, requestId, resource, txHash, blockNumber,
    payerAddress, recipient, amountEth, now, now + ttlSeconds * 1000
  );
});

function getProof(proofToken) {
  const row = stmts.getProof.get(proofToken);
  if (!row) return null;
  if (row.expires_at < Date.now()) return null;
  return row;
}

function consumeProof(proofToken) {
  const result = stmts.consumeProof.run(Date.now(), proofToken);
  return result.changes === 1;
}

function isTxRedeemed(txHash) {
  return !!stmts.isTxRedeemed.get(txHash);
}

function recordOpenAIUsage({ model, promptTokens, completionTokens, costUsd }) {
  const day = new Date().toISOString().slice(0, 10);
  stmts.insertUsage.run(day, model, promptTokens, completionTokens, costUsd, Date.now());
}

function getTodayOpenAISpend() {
  const day = new Date().toISOString().slice(0, 10);
  return stmts.sumUsageForDay.get(day).total;
}

function sweep() {
  const now = Date.now();
  const r = stmts.sweepRequests.run(now);
  const p = stmts.sweepProofs.run(now);
  return { requests: r.changes, proofs: p.changes };
}

function healthCheck() {
  try { return stmts.healthCheck.get().ok === 1; } catch { return false; }
}

module.exports = {
  db,
  createPaymentRequest,
  getPaymentRequest,
  finalizeVerification,
  getProof,
  consumeProof,
  isTxRedeemed,
  recordOpenAIUsage,
  getTodayOpenAISpend,
  sweep,
  healthCheck
};
