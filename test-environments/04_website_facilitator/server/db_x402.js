'use strict';

/**
 * SQLite shramba za NOVE x402 v2 načine (idempotenca + stanje poravnav + seje).
 *
 * NAMENOMA ločena datoteka in ločena baza (`data/x402_placila.db`):
 *  - obstoječe tabele in baze merjenih poskusov ostanejo bajt-za-bajtom nespremenjene,
 *  - ta modul je bajt-identičen v vseh mapah (kot auth.js) — en md5 za vse kopije,
 *  - brez migracij: CREATE TABLE IF NOT EXISTS na svoji datoteki.
 *
 * ŽELEZNO PRAVILO: nobena funkcija, podana v db.transaction, ni async in ne
 * vsebuje await. better-sqlite3 je sinhron; transakcija, ki bi objela await,
 * bi se tiho zaprla pred razrešitvijo obljube. Vsi await-i živijo IZVEN
 * transakcij (glej x402.js).
 *
 * Statusni stroj poravnave (x402_payments.status):
 *   SETTLING       — lastnik zahteve poravnava (zakup `lease_until`)
 *   BROADCAST      — poslano na verigo, potrdilo še ni znano (tx_hash zabeležen PRED čakanjem)
 *   SETTLED        — uspešno poravnano
 *   SETTLED_UNVERIFIED — pooblastilo dokazano porabljeno na verigi, hash izgubljen
 *   FAILED         — dokončno neuspešno (error_retryable=0) ali varno ponovljivo (=1)
 *   INDETERMINATE  — izid neznan; razreši ga uskladitev, nikoli slepa ponovna oddaja
 *
 * Zneski: `amount_atomic` so ATOMSKE ENOTE sredstva (testni ETH: 18 decimalk,
 * torej wei; USDC bi imel 6) kot celoštevilski niz in nikoli float.
 *
 * Kriptografsko avtoritativna zaščita pred ponovno uporabo (replay) JE
 * EIP-3009 nonce v pogodbi žetona na verigi. Tabela x402_authorizations je
 * samo lokalni hitri filter + revizijska sled; x402_payments je aplikacijska
 * idempotenca, vezava na vir in obnova po izgubljenem odgovoru.
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.X402_DB_PATH || path.join(DATA_DIR, 'x402_placila.db');
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

  -- Seje z dobroimetjem v atomskih enotah sredstva (mapi 03 in 05/04 — drugod tabeli mirujeta).
  -- Zavestno LOČENI od obstoječih tabel sessions/session_events: tam so zneski
  -- v wei (ETH), tu v atomskih enotah žetona. Mešanje enot v istih stolpcih je
  -- točno tista napaka, ki se ji ta projekt izogiba.
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
 * Zakup pravice do poravnave — ENA sinhrona transakcija (BEGIN IMMEDIATE, ker
 * bere in piše; dva procesa nad isto datoteko se tako ne moreta zakleniti).
 * Vrne { outcome, row }:
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
// beri-nato-piši → IMMEDIATE, da med procesoma ni nadgradnje zaklepa v slepi ulici
const claimPaymentImmediate = (a) => claimPayment.immediate(a);

/** Ali je bilo to EIP-3009 pooblastilo že videno z DRUGIM payment_id? */
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
// Pooblastilo dokazano NEporabljeno → vrstica postane varno ponovljiva:
// FAILED z error_retryable=1 in poteklim zakupom, da jo naslednji claim
// prevzame kot OWNER in poravna znova (to NI slepa ponovna oddaja — stanje
// na verigi je bilo prebrano).
const stmtToRetryable = db.prepare(`
  UPDATE x402_payments SET status='FAILED', error_code='reconciled_unused',
    error_message='pooblastilo na verigi neporabljeno', error_retryable=1,
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
  return { placil: S.countPayments.get().n, poravnanih: S.countSettled.get().n };
}

function x402Sweep() {
  const now = Date.now();
  const l = S.sweepLeases.run(now, now);
  const d = S.sweepOld.run(now);
  const s = S.sweepSessions.run(now);
  const e = S.sweepSessionEvents.run();
  return { zakupi: l.changes, stara_placila: d.changes, seje: s.changes, dogodki: e.changes };
}

// ── seje z dobroimetjem v atomskih enotah (mapa 03 in spletišči) ─────────────
function openX402Session(args) {
  S.insSession.run({ ...args, now: Date.now() });
  S.insEvent.run(args.sessionId, 'topup', args.depositAtomic, args.settleTxHash, null, null, null, Date.now());
  return S.getSession.get(args.sessionId);
}
function getX402Session(sessionId) { return S.getSession.get(sessionId) || null; }
function countX402Debits(sessionId) { return S.countSessionEvents.get(sessionId).n; }

/**
 * Atomska bremenitev x402-financirane seje. ISTI logični algoritem kot
 * db.debit() v mapi 03 (nonce → seja → zaprta → potekla → dobroimetje →
 * proračun → atomski odpis), le v atomskih enotah žetona. Razlogi za
 * zavrnitev so ISTI nizi kot v izvirniku, da se varnostni testi prenesejo.
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
