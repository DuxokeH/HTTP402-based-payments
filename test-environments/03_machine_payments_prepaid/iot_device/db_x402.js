'use strict';

/**
 * SQLite storage for the NEW x402 v2 modes (idempotency + settlement state + sessions).
 *
 * DELIBERATELY a separate file and a separate database (`data/x402_payments.db`):
 *  - the existing tables and databases of the measured experiments stay byte-for-byte unchanged,
 *  - this module is byte-identical across all folders (like auth.js) — one md5 for all copies,
 *  - no migrations: CREATE TABLE IF NOT EXISTS on its own file.
 *
 * IRON RULE: no function passed to db.transaction is async or contains
 * await. better-sqlite3 is synchronous; a transaction that wrapped an await
 * would silently close before the promise resolves. All awaits live OUTSIDE
 * transactions (see x402.js).
 *
 * Settlement status machine (x402_payments.status):
 *   SETTLING       — the request owner is settling (lease `lease_until`)
 *   BROADCAST      — sent to the chain, confirmation not yet known (tx_hash recorded BEFORE waiting)
 *   SETTLED        — settled successfully
 *   SETTLED_UNVERIFIED — authorization provably spent on chain, hash lost
 *   FAILED         — definitively failed (error_retryable=0) or safely retryable (=1)
 *   INDETERMINATE  — outcome unknown; resolved by reconciliation, never by blind re-submission
 *
 * Amounts: `amount_atomic` values are ATOMIC UNITS of the asset (test ETH: 18 decimals,
 * i.e. wei; USDC would have 6) as an integer string and never a float.
 *
 * The cryptographically authoritative replay protection IS the
 * EIP-3009 nonce in the token contract on chain. The x402_authorizations table
 * is only a local fast filter + audit trail; x402_payments provides application-level
 * idempotency, binding to the resource, and recovery after a lost response.
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.X402_DB_PATH || path.join(DATA_DIR, 'x402_payments.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS x402_payments (
    payment_id          TEXT PRIMARY KEY,
    resource            TEXT NOT NULL,
    fingerprint         TEXT NOT NULL,
    status              TEXT NOT NULL,
    attempt             INTEGER NOT NULL DEFAULT 1,
    lease_until         INTEGER NOT NULL,
    network             TEXT NOT NULL,
    scheme              TEXT NOT NULL,
    asset               TEXT NOT NULL,
    amount_atomic       TEXT NOT NULL,
    payer               TEXT,
    pay_to              TEXT NOT NULL,
    auth_nonce          TEXT,
    tx_hash             TEXT,
    block_number        INTEGER,
    gas_used            TEXT,
    effective_gas_price TEXT,
    error_code          TEXT,
    error_message       TEXT,
    error_retryable     INTEGER NOT NULL DEFAULT 0,
    response_status     INTEGER,
    response_body       TEXT,
    payment_response    TEXT,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL,
    expires_at          INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS ux_x402_payments_tx
    ON x402_payments(tx_hash) WHERE tx_hash IS NOT NULL;
  CREATE INDEX IF NOT EXISTS ix_x402_payments_lease ON x402_payments(status, lease_until);
  CREATE INDEX IF NOT EXISTS ix_x402_payments_expires ON x402_payments(expires_at);

  CREATE TABLE IF NOT EXISTS x402_authorizations (
    auth_key   TEXT PRIMARY KEY,
    payment_id TEXT NOT NULL,
    first_seen INTEGER NOT NULL
  );

  -- Sessions with credit in atomic units of the asset (folders 03 and 05/04 — elsewhere these tables sit idle).
  -- Deliberately SEPARATE from the existing sessions/session_events tables: there the
  -- amounts are in wei (ETH), here in atomic units of the token. Mixing units in the
  -- same columns is exactly the mistake this separation avoids.
  CREATE TABLE IF NOT EXISTS x402_sessions (
    session_id     TEXT PRIMARY KEY,
    payer_address  TEXT NOT NULL,
    resource       TEXT NOT NULL,
    network        TEXT NOT NULL,
    asset          TEXT NOT NULL,
    asset_decimals INTEGER NOT NULL,
    deposit_atomic TEXT NOT NULL,
    budget_atomic  TEXT NOT NULL,
    spent_atomic   TEXT NOT NULL,
    settle_tx_hash TEXT NOT NULL,
    payment_id     TEXT,
    created_at     INTEGER NOT NULL,
    expires_at     INTEGER NOT NULL,
    closed_at      INTEGER
  );
  CREATE TABLE IF NOT EXISTS x402_session_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    TEXT NOT NULL,
    kind          TEXT NOT NULL,
    amount_atomic TEXT NOT NULL,
    tx_hash       TEXT,
    request_path  TEXT,
    bytes         INTEGER,
    nonce         TEXT UNIQUE,
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ix_x402_ev_session ON x402_session_events(session_id);
`);

const S = {
  insPayment: db.prepare(`
    INSERT INTO x402_payments (payment_id, resource, fingerprint, status, attempt, lease_until,
      network, scheme, asset, amount_atomic, payer, pay_to, auth_nonce,
      created_at, updated_at, expires_at)
    VALUES (@paymentId, @resource, @fingerprint, 'SETTLING', 1, @leaseUntil,
      @network, @scheme, @asset, @amountAtomic, @payer, @payTo, @authNonce,
      @now, @now, @expiresAt)
    ON CONFLICT(payment_id) DO NOTHING`),
  getPayment: db.prepare('SELECT * FROM x402_payments WHERE payment_id = ?'),
  reclaim: db.prepare(`
    UPDATE x402_payments SET status='SETTLING', attempt=attempt+1, lease_until=?, updated_at=?
    WHERE payment_id=? AND status=?`),
  toIndeterminate: db.prepare(`
    UPDATE x402_payments SET status='INDETERMINATE', updated_at=?
    WHERE payment_id=? AND status='SETTLING' AND lease_until < ?`),
  markBroadcast: db.prepare(`
    UPDATE x402_payments SET status='BROADCAST', tx_hash=?, updated_at=?
    WHERE payment_id=? AND status='SETTLING'`),
  markSettled: db.prepare(`
    UPDATE x402_payments SET status='SETTLED', tx_hash=COALESCE(?, tx_hash), block_number=?,
      gas_used=?, effective_gas_price=?, payment_response=?, updated_at=?
    WHERE payment_id=? AND status IN ('SETTLING','BROADCAST','INDETERMINATE')`),
  markSettledUnverified: db.prepare(`
    UPDATE x402_payments SET status='SETTLED_UNVERIFIED', payment_response=?, updated_at=?
    WHERE payment_id=? AND status IN ('SETTLING','BROADCAST','INDETERMINATE')`),
  markFailed: db.prepare(`
    UPDATE x402_payments SET status='FAILED', error_code=?, error_message=?, error_retryable=?, updated_at=?
    WHERE payment_id=? AND status IN ('SETTLING','BROADCAST','INDETERMINATE')`),
  cacheResponse: db.prepare(`
    UPDATE x402_payments SET response_status=?, response_body=?, updated_at=?
    WHERE payment_id=? AND status IN ('SETTLED','SETTLED_UNVERIFIED')`),
  insAuth: db.prepare(`
    INSERT INTO x402_authorizations (auth_key, payment_id, first_seen)
    VALUES (?, ?, ?) ON CONFLICT(auth_key) DO NOTHING`),
  getAuth: db.prepare('SELECT * FROM x402_authorizations WHERE auth_key = ?'),
  countPayments: db.prepare('SELECT COUNT(*) AS n FROM x402_payments'),
  countSettled: db.prepare("SELECT COUNT(*) AS n FROM x402_payments WHERE status IN ('SETTLED','SETTLED_UNVERIFIED')"),
  sweepLeases: db.prepare(`
    UPDATE x402_payments SET status='INDETERMINATE', updated_at=?
    WHERE status='SETTLING' AND lease_until < ?`),
  sweepOld: db.prepare(`
    DELETE FROM x402_payments WHERE expires_at < ? AND status IN ('SETTLED','SETTLED_UNVERIFIED','FAILED')`),

  insSession: db.prepare(`
    INSERT INTO x402_sessions (session_id, payer_address, resource, network, asset, asset_decimals,
      deposit_atomic, budget_atomic, spent_atomic, settle_tx_hash, payment_id, created_at, expires_at)
    VALUES (@sessionId, @payerAddress, @resource, @network, @asset, @assetDecimals,
      @depositAtomic, @budgetAtomic, '0', @settleTxHash, @paymentId, @now, @expiresAt)`),
  getSession: db.prepare('SELECT * FROM x402_sessions WHERE session_id = ?'),
  updSpent: db.prepare('UPDATE x402_sessions SET spent_atomic = ? WHERE session_id = ?'),
  insEvent: db.prepare(`
    INSERT INTO x402_session_events (session_id, kind, amount_atomic, tx_hash, request_path, bytes, nonce, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
  isNonceUsed: db.prepare('SELECT 1 FROM x402_session_events WHERE nonce = ?'),
  countSessionEvents: db.prepare("SELECT COUNT(*) AS n FROM x402_session_events WHERE session_id = ? AND kind = 'debit'"),
  sweepSessions: db.prepare('DELETE FROM x402_sessions WHERE expires_at < ?'),
  sweepSessionEvents: db.prepare('DELETE FROM x402_session_events WHERE session_id NOT IN (SELECT session_id FROM x402_sessions)')
};

/**
 * Lease of the right to settle — ONE synchronous transaction (BEGIN IMMEDIATE,
 * since it reads and writes; two processes over the same file thus cannot deadlock).
 * Returns { outcome, row }:
 *   OWNER | CACHED | CONFLICT_RESOURCE | CONFLICT_PAYLOAD | BUSY |
 *   TERMINAL | RECONCILE | INDETERMINATE
 */
const claimPayment = db.transaction((a) => {
  const now = Date.now();
  const ins = S.insPayment.run({
    paymentId: a.paymentId, resource: a.resource, fingerprint: a.fingerprint,
    leaseUntil: now + a.leaseMs, network: a.network, scheme: a.scheme, asset: a.asset,
    amountAtomic: a.amountAtomic, payer: a.payer || null, payTo: a.payTo,
    authNonce: a.authNonce || null, now, expiresAt: now + a.retentionMs
  });
  if (ins.changes === 1) return { outcome: 'OWNER', row: S.getPayment.get(a.paymentId) };

  const row = S.getPayment.get(a.paymentId);
  if (row.resource !== a.resource) return { outcome: 'CONFLICT_RESOURCE', row };
  if (row.fingerprint !== a.fingerprint) return { outcome: 'CONFLICT_PAYLOAD', row };

  switch (row.status) {
    case 'SETTLED':
    case 'SETTLED_UNVERIFIED':
      return { outcome: 'CACHED', row };
    case 'FAILED':
      if (row.error_retryable && row.lease_until < now) {
        S.reclaim.run(now + a.leaseMs, now, a.paymentId, 'FAILED');
        return { outcome: 'OWNER', row: S.getPayment.get(a.paymentId) };
      }
      return { outcome: 'TERMINAL', row };
    case 'SETTLING':
      if (row.lease_until >= now) return { outcome: 'BUSY', row };
      S.toIndeterminate.run(now, a.paymentId, now);
      return { outcome: 'INDETERMINATE', row: S.getPayment.get(a.paymentId) };
    case 'BROADCAST':
      return { outcome: 'RECONCILE', row };
    default:
      return { outcome: 'INDETERMINATE', row };
  }
});
// read-then-write → IMMEDIATE, so there is no deadlocking lock upgrade between the two processes
const claimPaymentImmediate = (a) => claimPayment.immediate(a);

/** Has this EIP-3009 authorization already been seen with a DIFFERENT payment_id? */
function checkAuthorization(authKey, paymentId) {
  S.insAuth.run(authKey, paymentId, Date.now());
  const row = S.getAuth.get(authKey);
  return { seenBefore: row.payment_id !== paymentId, firstPaymentId: row.payment_id };
}

function markBroadcast(paymentId, txHash) {
  return S.markBroadcast.run(txHash, Date.now(), paymentId).changes === 1;
}
function markSettled(paymentId, { txHash, blockNumber, gasUsed, effectiveGasPrice, paymentResponse }) {
  return S.markSettled.run(txHash || null, blockNumber ?? null, gasUsed ?? null,
    effectiveGasPrice ?? null, paymentResponse || null, Date.now(), paymentId).changes === 1;
}
function markSettledUnverified(paymentId, paymentResponse) {
  return S.markSettledUnverified.run(paymentResponse || null, Date.now(), paymentId).changes === 1;
}
function markFailed(paymentId, { code, message, retryable }) {
  return S.markFailed.run(code || 'settlement_failed', (message || '').slice(0, 500),
    retryable ? 1 : 0, Date.now(), paymentId).changes === 1;
}
// Authorization provably UNspent → the row becomes safely retryable:
// FAILED with error_retryable=1 and an expired lease, so the next claim
// takes it over as OWNER and settles again (this is NOT a blind re-submission —
// the on-chain state has been read).
const stmtToRetryable = db.prepare(`
  UPDATE x402_payments SET status='FAILED', error_code='reconciled_unused',
    error_message='authorization unspent on chain', error_retryable=1,
    lease_until=0, updated_at=?
  WHERE payment_id=? AND status IN ('BROADCAST','INDETERMINATE','SETTLING')`);
function reclaimAfterProvenUnused(paymentId) {
  return stmtToRetryable.run(Date.now(), paymentId).changes === 1;
}
function cacheResponse(paymentId, status, body) {
  const trimmed = typeof body === 'string' ? body.slice(0, 65536) : JSON.stringify(body).slice(0, 65536);
  return S.cacheResponse.run(status, trimmed, Date.now(), paymentId).changes === 1;
}
function getPayment(paymentId) { return S.getPayment.get(paymentId) || null; }

function x402Stats() {
  return { payments: S.countPayments.get().n, settled: S.countSettled.get().n };
}

function x402Sweep() {
  const now = Date.now();
  const l = S.sweepLeases.run(now, now);
  const d = S.sweepOld.run(now);
  const s = S.sweepSessions.run(now);
  const e = S.sweepSessionEvents.run();
  return { leases: l.changes, oldPayments: d.changes, sessions: s.changes, events: e.changes };
}

// ── credit sessions in atomic units (folder 03 and the websites) ─────────────
function openX402Session(args) {
  S.insSession.run({ ...args, now: Date.now() });
  S.insEvent.run(args.sessionId, 'topup', args.depositAtomic, args.settleTxHash, null, null, null, Date.now());
  return S.getSession.get(args.sessionId);
}
function getX402Session(sessionId) { return S.getSession.get(sessionId) || null; }
function countX402Debits(sessionId) { return S.countSessionEvents.get(sessionId).n; }

/**
 * Atomic debit of an x402-funded session. The SAME logical algorithm as
 * db.debit() in folder 03 (nonce → session → closed → expired → credit →
 * budget → atomic deduction), only in atomic units of the token. The rejection
 * reasons are the SAME strings as in the original, so the security tests carry over.
 */
const debitX402 = db.transaction(({ sessionId, amountAtomic, nonce, requestPath, bytes }) => {
  if (S.isNonceUsed.get(nonce)) return { ok: false, reason: 'nonce_reused' };
  const s = S.getSession.get(sessionId);
  if (!s) return { ok: false, reason: 'no_session' };
  if (s.closed_at) return { ok: false, reason: 'session_closed' };
  if (s.expires_at < Date.now()) return { ok: false, reason: 'session_expired' };
  const deposit = BigInt(s.deposit_atomic);
  const budget = BigInt(s.budget_atomic);
  const spent = BigInt(s.spent_atomic);
  const amount = BigInt(amountAtomic);
  if (spent + amount > deposit) {
    return { ok: false, reason: 'insufficient_balance', balanceAtomic: (deposit - spent).toString() };
  }
  if (spent + amount > budget) {
    return { ok: false, reason: 'budget_exceeded', budgetRemainingAtomic: (budget - spent).toString() };
  }
  const newSpent = spent + amount;
  S.updSpent.run(newSpent.toString(), sessionId);
  S.insEvent.run(sessionId, 'debit', amount.toString(), null, requestPath, bytes ?? null, nonce, Date.now());
  return {
    ok: true,
    balanceAtomic: (deposit - newSpent).toString(),
    budgetRemainingAtomic: (budget - newSpent).toString(),
    spentAtomic: newSpent.toString()
  };
});

function healthCheck() {
  try { db.prepare('SELECT 1').get(); return true; } catch { return false; }
}

module.exports = {
  db,
  claimPayment: claimPaymentImmediate,
  checkAuthorization,
  markBroadcast,
  markSettled,
  markSettledUnverified,
  markFailed,
  reclaimAfterProvenUnused,
  cacheResponse,
  getPayment,
  x402Stats,
  x402Sweep,
  openX402Session,
  getX402Session,
  countX402Debits,
  debitX402,
  healthCheck
};
