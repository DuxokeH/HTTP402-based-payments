'use strict';

/**
 * SQLite persistence — IoT provider, ONE on-chain transaction PER reading
 * (folder 02_avtomatska_placila_transakcije).
 *
 * This is the "naive M2M baseline": every sensor reading is unlocked by its own
 * Sepolia transaction. It exists to be COMPARED against the metered/prepaid
 * approach in folder 03 (cumulative gas cost for N uses).
 *
 * Self-contained copy; original testna-okolja/00_demo/ files are left untouched.
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(process.env.DB_PATH || path.join(DATA_DIR, 'iot_transakcije.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS payment_requests (
    request_id   TEXT PRIMARY KEY,
    resource     TEXT NOT NULL,
    recipient    TEXT NOT NULL,
    amount_eth   TEXT NOT NULL,
    currency     TEXT NOT NULL,
    network      TEXT NOT NULL,
    payer_address TEXT,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS payment_proofs (
    proof_token  TEXT PRIMARY KEY,
    request_id   TEXT NOT NULL,
    resource     TEXT NOT NULL,
    tx_hash      TEXT NOT NULL,
    block_number INTEGER NOT NULL,
    payer_address TEXT NOT NULL,
    recipient    TEXT NOT NULL,
    amount_eth   TEXT NOT NULL,
    verified_at  INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    consumed_at  INTEGER
  );
  CREATE TABLE IF NOT EXISTS redeemed_tx_hashes (
    tx_hash     TEXT PRIMARY KEY,
    request_id  TEXT NOT NULL,
    redeemed_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pr_expires ON payment_requests(expires_at);
  CREATE INDEX IF NOT EXISTS idx_pp_expires ON payment_proofs(expires_at);
`);

const S = {
  insReq: db.prepare(`INSERT INTO payment_requests (request_id,resource,recipient,amount_eth,currency,network,payer_address,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)`),
  getReq: db.prepare('SELECT * FROM payment_requests WHERE request_id = ?'),
  insProof: db.prepare(`INSERT INTO payment_proofs (proof_token,request_id,resource,tx_hash,block_number,payer_address,recipient,amount_eth,verified_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)`),
  getProof: db.prepare('SELECT * FROM payment_proofs WHERE proof_token = ?'),
  consumeProof: db.prepare('UPDATE payment_proofs SET consumed_at = ? WHERE proof_token = ? AND consumed_at IS NULL'),
  isRedeemed: db.prepare('SELECT 1 FROM redeemed_tx_hashes WHERE tx_hash = ?'),
  redeem: db.prepare('INSERT INTO redeemed_tx_hashes (tx_hash,request_id,redeemed_at) VALUES (?,?,?)'),
  sweepReq: db.prepare('DELETE FROM payment_requests WHERE expires_at < ?'),
  sweepProof: db.prepare('DELETE FROM payment_proofs WHERE expires_at < ?'),
  health: db.prepare('SELECT 1 AS ok')
};

function createPaymentRequest({ requestId, resource, recipient, amountEth, currency, network, payerAddress, ttlSeconds }) {
  const now = Date.now();
  S.insReq.run(requestId, resource, recipient, amountEth, currency, network, payerAddress || null, now, now + ttlSeconds * 1000);
}
function getPaymentRequest(id) { const r = S.getReq.get(id); if (!r) return null; if (r.expires_at < Date.now()) return null; return r; }

const finalizeVerification = db.transaction((a) => {
  S.redeem.run(a.txHash, a.requestId, Date.now());
  const now = Date.now();
  S.insProof.run(a.proofToken, a.requestId, a.resource, a.txHash, a.blockNumber, a.payerAddress, a.recipient, a.amountEth, now, now + a.ttlSeconds * 1000);
});
function getProof(t) { const r = S.getProof.get(t); if (!r) return null; if (r.expires_at < Date.now()) return null; return r; }
function consumeProof(t) { return S.consumeProof.run(Date.now(), t).changes === 1; }
function isTxRedeemed(t) { return !!S.isRedeemed.get(t); }
function sweep() { const n = Date.now(); return { requests: S.sweepReq.run(n).changes, proofs: S.sweepProof.run(n).changes }; }
function healthCheck() { try { return S.health.get().ok === 1; } catch { return false; } }

module.exports = { db, createPaymentRequest, getPaymentRequest, finalizeVerification, getProof, consumeProof, isTxRedeemed, sweep, healthCheck };
