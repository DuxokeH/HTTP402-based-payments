'use strict';

/**
 * ============================================================================
 *  ADMIN LOGIN
 *  Shared module — the same code lives in folders 02, 03 and 04.
 * ============================================================================
 *
 *  Why: the server is publicly reachable, and in real mode routes such as
 *  /run/* spend a real wallet. Without a login anyone could trigger payments.
 *
 *  How the admin obtains the password: credentials are generated automatically
 *  on the FIRST start and written to `data/admin-credentials.txt` (mode 0600,
 *  owner only). The admin logs in to the server over SSH and reads them:
 *
 *      grep PASSWORD data/admin-credentials.txt
 *      grep TOKEN    data/admin-credentials.txt
 *
 *  Two authentication paths:
 *    • human   → login page /login, then the `admin_sid` cookie (HttpOnly),
 *    • machine → `Authorization: Bearer <TOKEN>` header (measurement agents).
 *
 *  The cookie is an "ambient" credential, so the browser also sends it when
 *  navigating from a foreign site (SameSite=Lax applies to GET navigations).
 *  Routes that change anything or spend money are therefore additionally
 *  guarded by `requireCsrf`.
 *
 *  The principle stays the same as in docs/IDENTITY.md: identity is NOT tied
 *  to an IP address. The login travels with the client (cookie/header), so
 *  switching networks (wifi ↔ mobile data, NAT) does not log the user out.
 * ============================================================================
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');

const SESSION_COOKIE = 'admin_sid';
const SESSION_TTL = parseInt(process.env.ADMIN_SESSION_TTL_SECONDS || '28800', 10);   // 8 h
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
const MAX_LOGINS_IN_FLIGHT = 4;          // limit concurrent expensive password checks
const FAIL_DELAY_MS = 250;               // constant delay on failure

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const rand = (bytes) => b64url(crypto.randomBytes(bytes));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Constant-time comparison — no information leak through timing.
function safeEqual(a, b) {
  const A = Buffer.from(String(a ?? ''), 'utf8');
  const B = Buffer.from(String(b ?? ''), 'utf8');
  if (A.length !== B.length) { crypto.timingSafeEqual(A, A); return false; }
  return crypto.timingSafeEqual(A, B);
}

// The password is stored only as an scrypt digest.
// The synchronous variant is used ONLY at startup; at runtime always the async one,
// so the expensive computation does not stall the event loop (and with it the measurement requests).
const hashSync = (password, salt) => b64url(crypto.scryptSync(String(password), String(salt), 32));
const hashAsync = (password, salt) => new Promise((resolve, reject) =>
  crypto.scrypt(String(password), String(salt), 32, (err, key) => err ? reject(err) : resolve(b64url(key))));

function readCookie(header, name) {
  if (!header) return null;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== name) continue;
    const raw = part.slice(i + 1).trim();
    // A malformed escape sequence (e.g. `%`) would otherwise throw a URIError and
    // turn the whole login decision into a 500 — return the raw value, which simply won't match.
    try { return decodeURIComponent(raw); } catch { return raw; }
  }
  return null;
}

/**
 * Load the credentials, or create them on first start.
 *
 * Rules (deliberately simple and predictable):
 *  - `ADMIN_PASSWORD` from the environment ALWAYS wins and is never written to disk.
 *  - `ADMIN_TOKEN` from the environment ALWAYS wins (independently of the password).
 *  - Anything not supplied via the environment is generated once and saved to `admin.json`.
 *  - `admin-credentials.txt` is refreshed on EVERY start and always contains a
 *    valid TOKEN, because the documentation looks it up everywhere with `grep`.
 *  - The plaintext password goes only into that file (0600) — never into the log.
 */
function loadOrCreate({ dataDir, appName, logger }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const storePath = path.join(dataDir, 'admin.json');
  const plainPath = path.join(dataDir, 'admin-credentials.txt');

  const envUser = process.env.ADMIN_USER;
  const envPass = process.env.ADMIN_PASSWORD;
  const envToken = process.env.ADMIN_TOKEN;

  let stored = null;
  if (fs.existsSync(storePath)) {
    try {
      const s = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      if (s && s.username && s.salt && s.hash && s.token) stored = s;
      else logger.warn({ storePath }, 'admin.json is incomplete — creating new credentials');
    } catch (e) { logger.warn({ err: e.message }, 'admin.json is unreadable — creating new credentials'); }
  }

  // Password
  let username, salt, hash, generatedPassword = null;
  if (envPass) {
    username = envUser || (stored && stored.username) || 'admin';
    salt = rand(16);
    hash = hashSync(envPass, salt);
  } else if (stored) {
    username = envUser || stored.username; salt = stored.salt; hash = stored.hash;
  } else {
    username = envUser || 'admin';
    generatedPassword = rand(15);            // 20 characters, ~120 bits of entropy
    salt = rand(16);
    hash = hashSync(generatedPassword, salt);
  }

  // Token: environment > stored > new
  const token = envToken || (stored && !envToken ? stored.token : null) || rand(24);

  // Save to admin.json only what does NOT come from the environment.
  if (!envPass || !envToken) {
    const toStore = {
      username: envPass ? (stored ? stored.username : username) : username,
      salt: envPass && stored ? stored.salt : salt,
      hash: envPass && stored ? stored.hash : hash,
      token: envToken ? (stored ? stored.token : token) : token,
      createdAt: (stored && stored.createdAt) || new Date().toISOString()
    };
    // If the password comes from the environment and nothing is stored, there is nothing meaningful to save except the token.
    if (envPass && !stored) { toStore.username = username; toStore.salt = salt; toStore.hash = ''; }
    try { fs.writeFileSync(storePath, JSON.stringify(toStore, null, 2), { mode: 0o600 }); fs.chmodSync(storePath, 0o600); }
    catch (e) { logger.warn({ err: e.message }, 'could not write admin.json'); }
  }

  // Human-readable file for `grep` — refresh it on every start.
  const password = generatedPassword !== null ? generatedPassword
    : (envPass ? '(from the ADMIN_PASSWORD environment variable)' : '(unchanged — see the previous entry, or delete admin.json for a new one)');
  try {
    fs.writeFileSync(plainPath,
      `# ${appName} — admin credentials\n` +
      `# Refreshed: ${new Date().toISOString()}\n` +
      `# This file is readable by the owner only (0600). Store the password somewhere safe.\n` +
      `# To get a new password, delete admin.json and restart the server.\n` +
      `#\n` +
      `#   grep PASSWORD ${plainPath}\n` +
      `#   grep TOKEN ${plainPath}\n` +
      `#\n` +
      `USERNAME=${username}\n` +
      `PASSWORD=${password}\n` +
      `# The TOKEN is for machines (measurement agents): Authorization: Bearer <TOKEN>\n` +
      `TOKEN=${token}\n`,
      { mode: 0o600 });
    fs.chmodSync(plainPath, 0o600);
  } catch (e) { logger.warn({ err: e.message }, 'could not write admin-credentials.txt'); }

  // Only the file path goes into the log — never the password or the token.
  logger.info({ username: username, datoteka: plainPath },
    generatedPassword !== null
      ? `New admin credentials created. Get the password with:  grep PASSWORD ${plainPath}`
      : `Admin credentials loaded. Get the password with:  grep PASSWORD ${plainPath}`);

  return { username, salt, hash, token };
}

function create({ dataDir, appName, logger, publicPaths = [], homePath = '/' }) {
  const creds = loadOrCreate({ dataDir, appName, logger });
  const sessions = new Map();                 // sid -> { expiresAt, csrf }
  const alwaysPublic = new Set(['/health', '/login', '/logout', ...publicPaths]);

  // Expensive password checks are limited by the number of CONCURRENT requests
  // and do not pile up in a queue: the excess gets an immediate 429. That way a
  // single attacker can neither hold up the real admin's login (which an unbounded
  // queue would allow) nor monopolise the CPU. There is no permanent lockout.
  // Guessing by itself is not a serious threat: the password has ~120 bits of entropy.
  let inFlight = 0;

  function sweep() {
    const now = Date.now();
    for (const [sid, s] of sessions) if (s.expiresAt < now) sessions.delete(sid);
  }
  setInterval(sweep, 300_000).unref();

  const cookie = (sid, req, maxAge) =>
    `${SESSION_COOKIE}=${sid}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax` +
    ((COOKIE_SECURE || req.secure) ? '; Secure' : '');

  function sessionOf(req) {
    const sid = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (!sid) return null;
    const s = sessions.get(sid);
    if (!s || s.expiresAt <= Date.now()) return null;
    return s;
  }

  /** Is the request authenticated? Cookie (human) or token (machine). */
  function isAuthed(req) {
    if (sessionOf(req)) return 'session';
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const header = req.headers['x-admin-token'];
    if (bearer && safeEqual(bearer, creds.token)) return 'token';
    if (header && safeEqual(header, creds.token)) return 'token';
    return null;
  }

  /** Middleware: locks everything down except the public routes. */
  function requireAdmin(req, res, next) {
    if (alwaysPublic.has(req.path)) return next();
    const how = isAuthed(req);
    if (how) { req.admin = { via: how }; return next(); }
    // A browser gets the login page; a machine gets a machine-readable 401.
    if (req.method === 'GET' && String(req.headers.accept || '').includes('text/html')) {
      return res.redirect(302, '/login');
    }
    res.setHeader('WWW-Authenticate', 'Bearer realm="x402"');
    return res.status(401).json({
      error: 'Login required',
      message: 'Human: open /login. Machine: send the Authorization: Bearer <TOKEN> header.',
      hint: 'Get the token on the server with:  grep TOKEN data/admin-credentials.txt'
    });
  }

  /** CSRF token for the current session (logged-in browser only). */
  function csrfFor(req) { const s = sessionOf(req); return s ? s.csrf : null; }

  /**
   * An extra barrier for routes that trigger something or spend money (/run/*).
   *
   * The cookie alone is not enough: `SameSite=Lax` is also sent on GET
   * navigation from a foreign site, so a foreign page could make a logged-in
   * admin trigger `/run/tx?queries=200` and drain the wallet. We therefore also
   * require a token that can only be read from the same origin
   * (`GET /run/token`), and reject requests that look like navigation
   * (`Sec-Fetch-Mode: navigate`).
   *
   * Machine access with `Authorization: Bearer` is exempt — there is no
   * ambient credential there, hence no CSRF.
   */
  function requireCsrf(req, res, next) {
    if (req.admin && req.admin.via === 'token') return next();
    const mode = String(req.headers['sec-fetch-mode'] || '');
    const site = String(req.headers['sec-fetch-site'] || '');
    if (mode === 'navigate' || (site && site !== 'same-origin')) {
      return res.status(403).json({ error: 'Rejected: request is not same-origin (CSRF protection)' });
    }
    const given = req.query.token || req.headers['x-csrf'];
    const want = csrfFor(req);
    if (!want || !given || !safeEqual(given, want)) {
      return res.status(403).json({
        error: 'Missing or invalid CSRF token',
        hint: 'First obtain a token from GET /run/token and append it as ?token=…'
      });
    }
    next();
  }

  /** Login/logout routes — mount them BEFORE requireAdmin. */
  function mount(app) {
    // The form sends application/x-www-form-urlencoded, the API sends JSON — support both.
    const form = express.urlencoded({ extended: false, limit: '4kb' });

    app.get('/login', (req, res) => {
      if (isAuthed(req)) return res.redirect(302, homePath);
      res.type('html').status(200).send(loginPage(appName, null));
    });

    app.post('/login', form, async (req, res) => {
      const wantsHtml = !String(req.headers['content-type'] || '').includes('application/json');
      const fail = (code, msg) => wantsHtml
        ? res.type('html').status(code).send(loginPage(appName, msg))
        : res.status(code).json({ error: msg });
      try {
        const body = req.body || {};
        // Strings only: JSON may carry an object that would throw when coerced to a string.
        const username = typeof body.username === 'string' ? body.username : '';
        const password = typeof body.password === 'string' ? body.password : '';
        if (!username || !password) return fail(401, 'Incorrect username or password.');

        if (inFlight >= MAX_LOGINS_IN_FLIGHT) {
          res.setHeader('Retry-After', '2');
          return fail(429, 'Too many concurrent login attempts. Try again in a few seconds.');
        }
        inFlight++;
        let okPass;
        try { okPass = safeEqual(await hashAsync(password, creds.salt), creds.hash); }
        finally { inFlight--; }                       // the delay must NOT hold a slot
        const okUser = safeEqual(username, creds.username);

        if (!okUser || !okPass || !creds.hash) {
          await sleep(FAIL_DELAY_MS);
          return fail(401, 'Incorrect username or password.');
        }
        const sid = rand(32);
        sessions.set(sid, { expiresAt: Date.now() + SESSION_TTL * 1000, csrf: rand(24) });
        res.append('Set-Cookie', cookie(sid, req, SESSION_TTL));
        if (wantsHtml) return res.redirect(302, homePath);
        return res.json({ success: true, username: creds.username, veljaSekund: SESSION_TTL });
      } catch (err) {
        // Without this, a rejected promise in Express 4 would go unhandled and kill the process.
        logger.error({ err: err.message }, 'login error');
        if (!res.headersSent) return fail(400, 'Invalid login request.');
      }
    });

    app.post('/logout', form, (req, res) => {
      const sid = readCookie(req.headers.cookie, SESSION_COOKIE);
      if (sid) sessions.delete(sid);
      res.append('Set-Cookie', cookie('', req, 0));
      if (String(req.headers['content-type'] || '').includes('application/json')) return res.json({ success: true });
      res.redirect(302, '/login');
    });
  }

  return { requireAdmin, requireCsrf, csrfFor, mount, isAuthed, token: () => creds.token, username: () => creds.username };
}

/**
 * Self-contained login page. A plain HTML form without JavaScript — that way it
 * also works under the default `helmet()` CSP in folders 02/03, where
 * `script-src` does not allow inline scripts. No external resources (fonts, CDN).
 */
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function loginPage(appName, error) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Login · ${escapeHtml(appName)}</title>
<style>
  :root{--blue:#2a78d6;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;--surface:#fff;--plane:#f4f5f7;--grid:#e1e0d9;--bad:#d03b3b}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--plane);color:var(--ink);
       font-family:system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.5;padding:1rem}
  .card{background:var(--surface);border:1px solid var(--grid);border-radius:14px;padding:1.5rem;
        max-width:26rem;width:100%;box-shadow:0 1px 2px rgba(0,0,0,.04)}
  h1{margin:0 0 .2rem;font-size:1.25rem}
  p.muted{color:var(--muted);font-size:.9rem;margin:.2rem 0 1rem}
  label{display:block;font-size:.85rem;color:var(--ink2);margin:.7rem 0 .2rem}
  input{width:100%;padding:.55rem .7rem;border:1px solid var(--grid);border-radius:9px;font-size:1rem;font-family:inherit}
  button{width:100%;margin-top:1.1rem;background:var(--blue);color:#fff;border:none;border-radius:10px;
         padding:.6rem 1rem;font-size:1rem;cursor:pointer}
  .err{color:var(--bad);font-size:.9rem;margin-top:.7rem}
  code{background:var(--plane);border:1px solid var(--grid);border-radius:6px;padding:.05rem .3rem;font-size:.82rem}
  .hint{margin-top:1.2rem;padding-top:.9rem;border-top:1px solid var(--grid);color:var(--muted);font-size:.82rem}
</style></head>
<body>
  <form class="card" method="post" action="/login" autocomplete="off">
    <h1>Admin login</h1>
    <p class="muted">${escapeHtml(appName)}</p>
    <label for="u">Username</label>
    <input id="u" name="username" autocomplete="username" autofocus required />
    <label for="p">Password</label>
    <input id="p" name="password" type="password" autocomplete="current-password" required />
    <button type="submit">Log in</button>
    ${error ? `<div class="err">${escapeHtml(error)}</div>` : ''}
    <div class="hint">The credentials are on the server. Log in over SSH and run:<br />
      <code>grep PASSWORD data/admin-credentials.txt</code></div>
  </form>
</body></html>`;
}

module.exports = { create, SESSION_COOKIE };
