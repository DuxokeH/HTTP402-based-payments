'use strict';

/**
 * Combined SQLite layer for the SHOWCASE site — FACILITATOR BRANCH
 * (folder 04_website_facilitator/server).
 *
 * The schema is DELIBERATELY unchanged from the direct branch (folder 05_website_direct),
 * so that the two implementations differ in nothing but topology. In this branch,
 * however, the payment tables (payment_requests, payment_proofs, redeemed_tx_hashes,
 * sessions, session_events) lie DORMANT: the payment ledger is kept by the facilitator
 * (../facilitator/db.js). The merchant actually uses only sessions_web /
 * sessions_web_links — the browser-session correlation, which is its own concern.
 * Holds all three payment modes in ONE database:
 *   - one-time + per-tx IoT: payment_requests, payment_proofs, redeemed_tx_hashes
 *   - metered session:       sessions, session_events
 *
 * Logic is copied from the already-reviewed folders 01 and 03 (no smart
 * contracts — the metered mode uses off-chain EIP-191 signed debits; smart
 * contracts remain future work).
 *
 * Plus (docs/IDENTITY.md §2, improvement B): sessions_web / sessions_web_links —
 * a browser-session correlation store keyed by the `sid` cookie. It exists ONLY
 * to tie the events of one visit together (402 → proof → access). It is NEVER
 * consulted for authorization, so a missing/changed `sid` — or a changed IP —
 * can never deny access.
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(process.env.DB_PATH || path.join(DATA_DIR, 'website_facilitator.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS payment_requests (
    request_id TEXT PRIMARY KEY, resource TEXT NOT NULL, recipient TEXT NOT NULL,
    amount_eth TEXT NOT NULL, currency TEXT NOT NULL, network TEXT NOT NULL,
    payer_address TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS payment_proofs (
    proof_token TEXT PRIMARY KEY, request_id TEXT NOT NULL, resource TEXT NOT NULL,
    tx_hash TEXT NOT NULL, block_number INTEGER NOT NULL, payer_address TEXT NOT NULL,
    recipient TEXT NOT NULL, amount_eth TEXT NOT NULL, verified_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL, consumed_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS redeemed_tx_hashes (
    tx_hash TEXT PRIMARY KEY, request_id TEXT NOT NULL, redeemed_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY, payer_address TEXT NOT NULL, resource TEXT NOT NULL,
    deposit_wei TEXT NOT NULL, budget_wei TEXT NOT NULL, spent_wei TEXT NOT NULL,
    topup_tx_hash TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, closed_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS session_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, kind TEXT NOT NULL,
    amount_wei TEXT NOT NULL, tx_hash TEXT, request_path TEXT, bytes INTEGER, nonce TEXT UNIQUE, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions_web (
    sid TEXT PRIMARY KEY, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL,
    expires_at INTEGER NOT NULL, requests INTEGER NOT NULL DEFAULT 0, payer_address TEXT,
    first_ip TEXT, last_ip TEXT, ip_changes INTEGER NOT NULL DEFAULT 0, user_agent TEXT
  );
  CREATE TABLE IF NOT EXISTS sessions_web_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT, sid TEXT NOT NULL, kind TEXT NOT NULL,
    ref TEXT NOT NULL, ip TEXT, created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pr_expires ON payment_requests(expires_at);
  CREATE INDEX IF NOT EXISTS idx_pp_expires ON payment_proofs(expires_at);
  CREATE INDEX IF NOT EXISTS idx_ev_session ON session_events(session_id);
  CREATE INDEX IF NOT EXISTS idx_sw_expires ON sessions_web(expires_at);
  CREATE INDEX IF NOT EXISTS idx_swl_sid ON sessions_web_links(sid, created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_swl_uniq ON sessions_web_links(sid, kind, ref);
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
  insSession: db.prepare(`INSERT INTO sessions (session_id,payer_address,resource,deposit_wei,budget_wei,spent_wei,topup_tx_hash,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)`),
  getSession: db.prepare('SELECT * FROM sessions WHERE session_id = ?'),
  updSpent: db.prepare('UPDATE sessions SET spent_wei = ? WHERE session_id = ?'),
  insEvent: db.prepare(`INSERT INTO session_events (session_id,kind,amount_wei,tx_hash,request_path,bytes,nonce,created_at) VALUES (?,?,?,?,?,?,?,?)`),
  isNonceUsed: db.prepare('SELECT 1 FROM session_events WHERE nonce = ?'),
  getWeb: db.prepare('SELECT * FROM sessions_web WHERE sid = ?'),
  delWeb: db.prepare('DELETE FROM sessions_web WHERE sid = ?'),
  insWeb: db.prepare(`INSERT INTO sessions_web (sid,created_at,last_seen,expires_at,requests,payer_address,first_ip,last_ip,ip_changes,user_agent) VALUES (?,?,?,?,1,NULL,?,?,0,?)`),
  updWeb: db.prepare(`UPDATE sessions_web SET last_seen = ?, expires_at = ?, requests = requests + 1, last_ip = ?, ip_changes = ip_changes + ?, user_agent = COALESCE(?, user_agent) WHERE sid = ?`),
  setWebPayer: db.prepare('UPDATE sessions_web SET payer_address = ? WHERE sid = ?'),
  insWebLink: db.prepare('INSERT OR IGNORE INTO sessions_web_links (sid,kind,ref,ip,created_at) VALUES (?,?,?,?,?)'),
  delWebLinks: db.prepare('DELETE FROM sessions_web_links WHERE sid = ?'),
  getWebLinks: db.prepare('SELECT kind, ref, created_at FROM sessions_web_links WHERE sid = ? ORDER BY created_at DESC LIMIT 50'),
  sweepWeb: db.prepare('DELETE FROM sessions_web WHERE expires_at < ?'),
  sweepWebLinks: db.prepare('DELETE FROM sessions_web_links WHERE sid NOT IN (SELECT sid FROM sessions_web)'),
  health: db.prepare('SELECT 1 AS ok')
};

// ── one-time / per-tx ────────────────────────────────────────────────────────
function createPaymentRequest(a) {
  const now = Date.now();
  S.insReq.run(a.requestId, a.resource, a.recipient, a.amountEth, a.currency, a.network, a.payerAddress || null, now, now + a.ttlSeconds * 1000);
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

// ── metered session ──────────────────────────────────────────────────────────
function getSession(id) { return S.getSession.get(id); }
const openSession = db.transaction(({ sessionId, payerAddress, resource, depositWei, budgetWei, txHash, ttlSeconds }) => {
  S.redeem.run(txHash, sessionId, Date.now());
  const now = Date.now();
  S.insSession.run(sessionId, payerAddress.toLowerCase(), resource, depositWei.toString(), budgetWei.toString(), '0', txHash, now, now + ttlSeconds * 1000);
  S.insEvent.run(sessionId, 'topup', depositWei.toString(), txHash, null, null, null, now);
  return getSession(sessionId);
});
const debit = db.transaction(({ sessionId, amountWei, nonce, requestPath, bytes }) => {
  if (S.isNonceUsed.get(nonce)) return { ok: false, reason: 'nonce_reused' };
  const s = getSession(sessionId);
  if (!s) return { ok: false, reason: 'no_session' };
  if (s.closed_at) return { ok: false, reason: 'session_closed' };
  if (s.expires_at < Date.now()) return { ok: false, reason: 'session_expired' };
  const amount = BigInt(amountWei), deposit = BigInt(s.deposit_wei), budget = BigInt(s.budget_wei), spent = BigInt(s.spent_wei);
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
  return { sessionId: s.session_id, payer: s.payer_address, resource: s.resource,
    depositWei: deposit.toString(), budgetWei: budget.toString(), spentWei: spent.toString(),
    balanceWei: (deposit - spent).toString(), budgetRemainingWei: (budget - spent).toString(),
    createdAt: new Date(s.created_at).toISOString(), expiresAt: new Date(s.expires_at).toISOString(),
    expired: s.expires_at < Date.now(), closed: !!s.closed_at };
}

// ── web session correlation (improvement B) ──────────────────────────────────
// CORRELATION, NOT AUTHORIZATION. None of these functions may ever decide about
// access; the IP is stored purely as soft telemetry (a change counter), so that it
// is possible to *show* that an IP change has no effect on the flow.
const touchWebSession = db.transaction(({ sid, ip, userAgent, ttlSeconds }) => {
  const now = Date.now(), expires = now + ttlSeconds * 1000;
  const ua = userAgent ? String(userAgent).slice(0, 120) : null;
  const cur = S.getWeb.get(sid);
  if (!cur || cur.expires_at < now) {
    // Expired session → start completely fresh. The links must be deleted too, otherwise
    // a new session under the same sid would inherit the previous visit's history.
    if (cur) { S.delWeb.run(sid); S.delWebLinks.run(sid); }
    S.insWeb.run(sid, now, now, expires, ip || null, ip || null, ua);
    return { created: true, ipChanged: false };
  }
  const ipChanged = !!ip && !!cur.last_ip && ip !== cur.last_ip;
  S.updWeb.run(now, expires, ip || cur.last_ip, ipChanged ? 1 : 0, ua, sid);
  return { created: false, ipChanged };
});
function linkWebSession({ sid, kind, ref, ip }) { S.insWebLink.run(sid, kind, ref, ip || null, Date.now()); }
function setWebSessionPayer(sid, payerAddress) { S.setWebPayer.run(payerAddress, sid); }
function getWebSession(sid) { const r = S.getWeb.get(sid); if (!r) return null; if (r.expires_at < Date.now()) return null; return r; }
function webSessionView(sid) {
  const r = getWebSession(sid);
  if (!r) return null;
  // sid is HttpOnly — the browser gets only an abbreviation; we return no IP addresses, only the change count.
  const shortRef = (kind, ref) => (kind === 'proof_token' ? `${ref.slice(0, 14)}…` : ref);
  return {
    sidShort: r.sid.slice(0, 8), createdAt: new Date(r.created_at).toISOString(),
    lastSeen: new Date(r.last_seen).toISOString(), expiresAt: new Date(r.expires_at).toISOString(),
    requests: r.requests, payer: r.payer_address, ipChanges: r.ip_changes, ipStable: r.ip_changes === 0,
    links: S.getWebLinks.all(r.sid).map(l => ({ kind: l.kind, ref: shortRef(l.kind, l.ref), at: new Date(l.created_at).toISOString() }))
  };
}

function sweep() {
  const now = Date.now();
  const out = { requests: S.sweepReq.run(now).changes, proofs: S.sweepProof.run(now).changes, webSessions: S.sweepWeb.run(now).changes };
  out.webLinks = S.sweepWebLinks.run().changes;
  return out;
}
function healthCheck() { try { return S.health.get().ok === 1; } catch { return false; } }

module.exports = { db, createPaymentRequest, getPaymentRequest, finalizeVerification, getProof, consumeProof, isTxRedeemed, getSession, openSession, debit, sessionView, touchWebSession, linkWebSession, setWebSessionPayer, getWebSession, webSessionView, sweep, healthCheck };
