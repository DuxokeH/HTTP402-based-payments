'use strict';

/**
 * ============================================================================
 *  SQLite knjiga POSREDNIKA (mapa 04_spletisce_posrednik/posrednik)
 * ============================================================================
 *
 *  V topologiji (b) plačilno stanje NE živi pri trgovcu, ampak pri posredniku.
 *  Ta modul je zato knjiga posrednika:
 *
 *    payment_requests   plačilne zahteve, ki jih odpre trgovec (POST /payment-request)
 *    payment_proofs     dokazni žetoni, ki jih posrednik izda plačniku (POST /submit-payment)
 *    redeemed_tx_hashes že unovčene transakcije (ena transakcija = eno dokazilo)
 *    sessions           predplačniške merjene seje (dobroimetje, proračun, veljavnost)
 *    session_events     polnitve in bremenitve; `nonce` je UNIQUE → zaščita pred ponovitvijo
 *
 *  Shema je namenoma ENAKA kot v neposredni izvedbi (mapa 05_spletisce), da
 *  se arhitekturi razlikujeta SAMO v topologiji in ne tudi v načinu hrambe —
 *  prav to je omejitev zgodnejše primerjave (dve različni kodni bazi), ki jo
 *  ta mapa odpravlja.
 *
 *  Razlike proti mapi 05:
 *   - ni tabel `sessions_web` / `sessions_web_links`: korelacija seje brskalnika
 *     je skrb trgovca (piškotek `sid`), ne posrednika. Posrednik brskalnika
 *     sploh ne vidi.
 *   - `amount_wei` namesto `amount_eth`: zneski se primerjajo izključno kot
 *     celoštevilski wei (BigInt). Stara izvedba posrednika
 *     (`experiments/legacy/.../facilitator.js`) je primerjala `parseFloat` —
 *     to je napaka št. 3 od petih, popravljenih v tej mapi.
 *   - `merchant` v plačilni zahtevi: posrednik je storitev za VEČ trgovcev,
 *     zato prejemnika preverja proti `payment_requests.recipient` in ne proti
 *     eni sami globalni denarnici.
 * ============================================================================
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(process.env.DB_PATH || path.join(DATA_DIR, 'posrednik.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS payment_requests (
    request_id TEXT PRIMARY KEY, merchant TEXT NOT NULL, resource TEXT NOT NULL,
    recipient TEXT NOT NULL, amount_wei TEXT NOT NULL, currency TEXT NOT NULL,
    network TEXT NOT NULL, payer_address TEXT,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS payment_proofs (
    proof_token TEXT PRIMARY KEY, request_id TEXT NOT NULL, resource TEXT NOT NULL,
    tx_hash TEXT NOT NULL, block_number INTEGER NOT NULL, payer_address TEXT NOT NULL,
    recipient TEXT NOT NULL, amount_wei TEXT NOT NULL, verified_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL, consumed_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS redeemed_tx_hashes (
    tx_hash TEXT PRIMARY KEY, request_id TEXT NOT NULL, redeemed_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY, merchant TEXT NOT NULL, payer_address TEXT NOT NULL,
    resource TEXT NOT NULL, recipient TEXT NOT NULL,
    deposit_wei TEXT NOT NULL, budget_wei TEXT NOT NULL, spent_wei TEXT NOT NULL,
    topup_tx_hash TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, closed_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS session_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, kind TEXT NOT NULL,
    amount_wei TEXT NOT NULL, tx_hash TEXT, request_path TEXT, bytes INTEGER,
    nonce TEXT UNIQUE, created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pr_expires ON payment_requests(expires_at);
  CREATE INDEX IF NOT EXISTS idx_pp_expires ON payment_proofs(expires_at);
  CREATE INDEX IF NOT EXISTS idx_ev_session ON session_events(session_id);
`);

const S = {
  insReq: db.prepare(`INSERT INTO payment_requests (request_id,merchant,resource,recipient,amount_wei,currency,network,payer_address,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)`),
  getReq: db.prepare('SELECT * FROM payment_requests WHERE request_id = ?'),
  insProof: db.prepare(`INSERT INTO payment_proofs (proof_token,request_id,resource,tx_hash,block_number,payer_address,recipient,amount_wei,verified_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)`),
  getProof: db.prepare('SELECT * FROM payment_proofs WHERE proof_token = ?'),
  consumeProof: db.prepare('UPDATE payment_proofs SET consumed_at = ? WHERE proof_token = ? AND consumed_at IS NULL'),
  isRedeemed: db.prepare('SELECT 1 FROM redeemed_tx_hashes WHERE tx_hash = ?'),
  redeem: db.prepare('INSERT INTO redeemed_tx_hashes (tx_hash,request_id,redeemed_at) VALUES (?,?,?)'),
  sweepReq: db.prepare('DELETE FROM payment_requests WHERE expires_at < ?'),
  sweepProof: db.prepare('DELETE FROM payment_proofs WHERE expires_at < ?'),
  insSession: db.prepare(`INSERT INTO sessions (session_id,merchant,payer_address,resource,recipient,deposit_wei,budget_wei,spent_wei,topup_tx_hash,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`),
  getSession: db.prepare('SELECT * FROM sessions WHERE session_id = ?'),
  updSpent: db.prepare('UPDATE sessions SET spent_wei = ? WHERE session_id = ?'),
  insEvent: db.prepare(`INSERT INTO session_events (session_id,kind,amount_wei,tx_hash,request_path,bytes,nonce,created_at) VALUES (?,?,?,?,?,?,?,?)`),
  isNonceUsed: db.prepare('SELECT 1 FROM session_events WHERE nonce = ?'),
  countDebits: db.prepare(`SELECT COUNT(*) AS n FROM session_events WHERE session_id = ? AND kind = 'debit'`),
  health: db.prepare('SELECT 1 AS ok')
};

// ── plačilne zahteve in dokazila (enkratno + po transakciji) ─────────────────
function createPaymentRequest(a) {
  const now = Date.now();
  S.insReq.run(a.requestId, a.merchant, a.resource, a.recipient, BigInt(a.amountWei).toString(),
    a.currency, a.network, a.payerAddress || null, now, now + a.ttlSeconds * 1000);
}
function getPaymentRequest(id) {
  const r = S.getReq.get(id);
  if (!r) return null;
  if (r.expires_at < Date.now()) return null;
  return r;
}

// Unovčenje transakcije in izdaja dokazila sta ENA transakcija baze: `redeemed_tx_hashes`
// ima PRIMARY KEY na `tx_hash`, zato druga hkratna prijava iste transakcije pade na
// omejitvi in dokazilo se ne izda. To je popravek napake št. 2 stare izvedbe
// (ena transakcija je tam lahko zadostila poljubno mnogo različnim `requestId`).
const issueProof = db.transaction((a) => {
  S.redeem.run(a.txHash, a.requestId, Date.now());
  const now = Date.now();
  S.insProof.run(a.proofToken, a.requestId, a.resource, a.txHash, a.blockNumber,
    a.payerAddress, a.recipient, BigInt(a.amountWei).toString(), now, now + a.ttlSeconds * 1000);
});

function getProof(t) {
  const r = S.getProof.get(t);
  if (!r) return null;
  if (r.expires_at < Date.now()) return null;
  return r;
}
// Enkratna poraba: pogoj `consumed_at IS NULL` je v SQL, zato dve hkratni zahtevi
// z istim žetonom ne moreta obe uspeti. Popravek napake št. 1 stare izvedbe, kjer
// je bil `/verify-proof` zgolj branje in je en žeton veljal neomejeno.
function consumeProof(t) { return S.consumeProof.run(Date.now(), t).changes === 1; }
function isTxRedeemed(t) { return !!S.isRedeemed.get(t); }

// ── merjene seje ─────────────────────────────────────────────────────────────
function getSession(id) { return S.getSession.get(id); }
const openSession = db.transaction(({ sessionId, merchant, payerAddress, resource, recipient, depositWei, budgetWei, txHash, ttlSeconds }) => {
  S.redeem.run(txHash, sessionId, Date.now());
  const now = Date.now();
  S.insSession.run(sessionId, merchant, payerAddress.toLowerCase(), resource, recipient,
    depositWei.toString(), budgetWei.toString(), '0', txHash, now, now + ttlSeconds * 1000);
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
  return { sessionId: s.session_id, payer: s.payer_address, resource: s.resource, recipient: s.recipient,
    depositWei: deposit.toString(), budgetWei: budget.toString(), spentWei: spent.toString(),
    balanceWei: (deposit - spent).toString(), budgetRemainingWei: (budget - spent).toString(),
    debits: S.countDebits.get(s.session_id).n,
    createdAt: new Date(s.created_at).toISOString(), expiresAt: new Date(s.expires_at).toISOString(),
    expired: s.expires_at < Date.now(), closed: !!s.closed_at };
}

function sweep() {
  const now = Date.now();
  return { requests: S.sweepReq.run(now).changes, proofs: S.sweepProof.run(now).changes };
}
function healthCheck() { try { return S.health.get().ok === 1; } catch { return false; } }

module.exports = {
  db, createPaymentRequest, getPaymentRequest, issueProof, getProof, consumeProof, isTxRedeemed,
  getSession, openSession, debit, sessionView, sweep, healthCheck
};
