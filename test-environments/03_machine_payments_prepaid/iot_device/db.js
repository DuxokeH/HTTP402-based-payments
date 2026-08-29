'use strict';

/**
 * SQLite persistence — METERED PREPAID SESSION with credit + budget + validity
 * (folder 03_avtomatska_placila_dobroimetje).
 *
 * Implements a
 *   "predplačniška merjena seja z omejenim dobroimetjem, proračunom in časom
 *    veljavnosti" (prepaid metered session with limited credit, budget and TTL).
 *
 * The original testna-okolja/00_demo credit tab keyed a balance to a payer ADDRESS with no
 * budget cap and no expiry. Here every top-up opens an explicit SESSION:
 *
 *   deposit_wei   funded credit (dobroimetje)          — remaining = deposit-spent
 *   budget_wei    spend cap for the session (proračun) — spent may never exceed it
 *   expires_at    validity window (čas veljavnosti)    — debits rejected afterwards
 *   spent_wei     running total of authorized debits
 *
 * All wei math is BigInt over TEXT columns. Top-up and debit run inside SQLite
 * transactions; the UNIQUE nonce column makes replayed debits fail atomically.
 *
 * Self-contained copy; original testna-okolja/00_demo/ files are left untouched.
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(process.env.DB_PATH || path.join(DATA_DIR, 'iot_dobroimetje.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    session_id    TEXT PRIMARY KEY,
    payer_address TEXT NOT NULL,
    resource      TEXT NOT NULL,
    deposit_wei   TEXT NOT NULL,
    budget_wei    TEXT NOT NULL,
    spent_wei     TEXT NOT NULL,
    topup_tx_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    expires_at    INTEGER NOT NULL,
    closed_at     INTEGER
  );
  CREATE TABLE IF NOT EXISTS session_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   TEXT NOT NULL,
    kind         TEXT NOT NULL,          -- 'topup' | 'debit'
    amount_wei   TEXT NOT NULL,
    tx_hash      TEXT,
    request_path TEXT,
    bytes        INTEGER,
    nonce        TEXT UNIQUE,
    created_at   INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS redeemed_tx_hashes (
    tx_hash     TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL,
    redeemed_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_payer ON sessions(payer_address);
  CREATE INDEX IF NOT EXISTS idx_events_session ON session_events(session_id);
`);

const S = {
  insSession: db.prepare(`INSERT INTO sessions (session_id,payer_address,resource,deposit_wei,budget_wei,spent_wei,topup_tx_hash,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)`),
  getSession: db.prepare('SELECT * FROM sessions WHERE session_id = ?'),
  updSpent: db.prepare('UPDATE sessions SET spent_wei = ? WHERE session_id = ?'),
  closeSession: db.prepare('UPDATE sessions SET closed_at = ? WHERE session_id = ?'),
  insEvent: db.prepare(`INSERT INTO session_events (session_id,kind,amount_wei,tx_hash,request_path,bytes,nonce,created_at) VALUES (?,?,?,?,?,?,?,?)`),
  isNonceUsed: db.prepare('SELECT 1 FROM session_events WHERE nonce = ?'),
  isRedeemed: db.prepare('SELECT 1 FROM redeemed_tx_hashes WHERE tx_hash = ?'),
  redeem: db.prepare('INSERT INTO redeemed_tx_hashes (tx_hash,session_id,redeemed_at) VALUES (?,?,?)'),
  oldSessions: db.prepare('SELECT session_id FROM sessions WHERE expires_at < ?'),
  delSession: db.prepare('DELETE FROM sessions WHERE session_id = ?'),
  delEvents: db.prepare('DELETE FROM session_events WHERE session_id = ?'),
  health: db.prepare('SELECT 1 AS ok')
};

// Remove sessions that expired long ago plus their debit/topup events.
// redeemed_tx_hashes is intentionally KEPT forever (permanent replay protection).
const _sweep = db.transaction((cutoff) => {
  const rows = S.oldSessions.all(cutoff);
  for (const r of rows) { S.delEvents.run(r.session_id); S.delSession.run(r.session_id); }
  return rows.length;
});
function sweep(olderThanMs = 3_600_000) { return { sessions: _sweep(Date.now() - olderThanMs) }; }

function isTxRedeemed(t) { return !!S.isRedeemed.get(t); }
function getSession(id) { return S.getSession.get(id); }

// Open a session from a verified on-chain top-up. Atomic: redeem tx + insert
// session + record the topup event together.
const openSession = db.transaction(({ sessionId, payerAddress, resource, depositWei, budgetWei, txHash, ttlSeconds }) => {
  S.redeem.run(txHash, sessionId, Date.now());
  const now = Date.now();
  S.insSession.run(sessionId, payerAddress.toLowerCase(), resource, depositWei.toString(), budgetWei.toString(), '0', txHash, now, now + ttlSeconds * 1000);
  S.insEvent.run(sessionId, 'topup', depositWei.toString(), txHash, null, null, null, now);
  return getSession(sessionId);
});

/**
 * Authorize one metered debit against a session.
 * Enforces, in order: nonce uniqueness, session exists/open, validity (TTL),
 * budget cap (proračun), and remaining credit (dobroimetje).
 * Returns { ok, balanceWei, budgetRemainingWei, spentWei } or { ok:false, reason, ... }.
 */
const debit = db.transaction(({ sessionId, amountWei, nonce, requestPath, bytes }) => {
  if (S.isNonceUsed.get(nonce)) return { ok: false, reason: 'nonce_reused' };
  const s = getSession(sessionId);
  if (!s) return { ok: false, reason: 'no_session' };
  if (s.closed_at) return { ok: false, reason: 'session_closed' };
  if (s.expires_at < Date.now()) return { ok: false, reason: 'session_expired' };

  const amount = BigInt(amountWei);
  const deposit = BigInt(s.deposit_wei);
  const budget = BigInt(s.budget_wei);
  const spent = BigInt(s.spent_wei);

  // Deposit (credit) is checked before budget so both reasons are reachable and
  // semantically correct: 'insufficient_balance' = prepaid credit exhausted;
  // 'budget_exceeded' = credit remains but the session spend cap was hit.
  if (spent + amount > deposit) return { ok: false, reason: 'insufficient_balance', balanceWei: deposit - spent, budgetRemainingWei: budget - spent };
  if (spent + amount > budget) return { ok: false, reason: 'budget_exceeded', balanceWei: deposit - spent, budgetRemainingWei: budget - spent };

  const newSpent = spent + amount;
  S.updSpent.run(newSpent.toString(), sessionId);
  S.insEvent.run(sessionId, 'debit', amount.toString(), null, requestPath, bytes ?? null, nonce, Date.now());
  return { ok: true, balanceWei: deposit - newSpent, budgetRemainingWei: budget - newSpent, spentWei: newSpent };
});

function sessionView(s) {
  if (!s) return null;
  const deposit = BigInt(s.deposit_wei), budget = BigInt(s.budget_wei), spent = BigInt(s.spent_wei);
  return {
    sessionId: s.session_id, payer: s.payer_address, resource: s.resource,
    depositWei: deposit.toString(), budgetWei: budget.toString(), spentWei: spent.toString(),
    balanceWei: (deposit - spent).toString(), budgetRemainingWei: (budget - spent).toString(),
    createdAt: new Date(s.created_at).toISOString(), expiresAt: new Date(s.expires_at).toISOString(),
    expired: s.expires_at < Date.now(), closed: !!s.closed_at
  };
}

function healthCheck() { try { return S.health.get().ok === 1; } catch { return false; } }

module.exports = { db, isTxRedeemed, getSession, openSession, debit, sessionView, sweep, healthCheck };
