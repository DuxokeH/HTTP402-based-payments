'use strict';

/**
 * ============================================================================
 *  SKRBNIŠKA PRIJAVA (admin login)
 *  Deljen modul — enaka koda je v mapah 02, 03 in 04.
 * ============================================================================
 *
 *  Zakaj: strežnik je javno dosegljiv, poti kot /run/* pa v pravem načinu
 *  porabljajo pravo denarnico. Brez prijave lahko kdorkoli sproži plačila.
 *
 *  Kako pride skrbnik do gesla: poverilnice se ob PRVEM zagonu same ustvarijo
 *  in zapišejo v `data/admin-credentials.txt` (pravice 0600, samo lastnik).
 *  Skrbnik se prijavi po SSH na strežnik in jih prebere:
 *
 *      grep GESLO   data/admin-credentials.txt
 *      grep ZETON   data/admin-credentials.txt
 *
 *  Dve poti avtentikacije:
 *    • človek  → prijavna stran /prijava, nato piškotek `admin_sid` (HttpOnly),
 *    • stroj   → glava `Authorization: Bearer <ZETON>` (merilni agenti).
 *
 *  Piškotek je „ambientalna" poverilnica, zato ga brskalnik pošlje tudi pri
 *  krmarjenju z tuje strani (SameSite=Lax velja za GET navigacije). Poti, ki
 *  kaj spremenijo ali porabijo denar, zato dodatno varuje `requireCsrf`.
 *
 *  Načelo ostaja isto kot v docs/IDENTITETA.md: identiteta se NE veže na IP.
 *  Prijava potuje z odjemalcem (piškotek/glava), zato menjava omrežja
 *  (wifi ↔ mobilni internet, NAT) prijavljenega uporabnika ne odjavi.
 * ============================================================================
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');

const SESSION_COOKIE = 'admin_sid';
const SESSION_TTL = parseInt(process.env.ADMIN_SESSION_TTL_SECONDS || '28800', 10);   // 8 h
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
const MAX_LOGINS_IN_FLIGHT = 4;          // omeji hkratna draga preverjanja gesla
const FAIL_DELAY_MS = 250;               // konstantna zakasnitev ob neuspehu

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const rand = (bytes) => b64url(crypto.randomBytes(bytes));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Časovno konstantna primerjava — brez uhajanja informacije prek trajanja.
function safeEqual(a, b) {
  const A = Buffer.from(String(a ?? ''), 'utf8');
  const B = Buffer.from(String(b ?? ''), 'utf8');
  if (A.length !== B.length) { crypto.timingSafeEqual(A, A); return false; }
  return crypto.timingSafeEqual(A, B);
}

// Geslo hranimo samo kot scrypt izvleček.
// Sinhrona različica se uporablja SAMO ob zagonu; med delovanjem vedno asinhrona,
// da drago računanje ne ustavi dogodkovne zanke (in s tem merilnih zahtev).
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
    // Pokvarjeno ubežno zaporedje (npr. `%`) sicer vrže URIError in bi celotno
    // odločitev o prijavi spremenilo v 500 — vrni surovo vrednost, ki se preprosto ne ujema.
    try { return decodeURIComponent(raw); } catch { return raw; }
  }
  return null;
}

/**
 * Naloži ali ob prvem zagonu ustvari poverilnice.
 *
 * Pravila (namenoma preprosta in predvidljiva):
 *  - `ADMIN_PASSWORD` iz okolja VEDNO prevlada in se nikoli ne zapiše na disk.
 *  - `ADMIN_TOKEN` iz okolja VEDNO prevlada (neodvisno od gesla).
 *  - Karkoli ni podano iz okolja, se enkrat ustvari in shrani v `admin.json`.
 *  - `admin-credentials.txt` se osveži ob VSAKEM zagonu in vedno vsebuje
 *    veljaven ZETON, ker ga dokumentacija povsod išče z `grep`.
 *  - Odprto geslo gre samo v to datoteko (0600) — nikoli v dnevnik.
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
      else logger.warn({ storePath }, 'admin.json je pomanjkljiv — ustvarjam nove poverilnice');
    } catch (e) { logger.warn({ err: e.message }, 'admin.json ni berljiv — ustvarjam nove poverilnice'); }
  }

  // Geslo
  let username, salt, hash, generatedPassword = null;
  if (envPass) {
    username = envUser || (stored && stored.username) || 'admin';
    salt = rand(16);
    hash = hashSync(envPass, salt);
  } else if (stored) {
    username = envUser || stored.username; salt = stored.salt; hash = stored.hash;
  } else {
    username = envUser || 'admin';
    generatedPassword = rand(15);            // 20 znakov, ~120 bitov entropije
    salt = rand(16);
    hash = hashSync(generatedPassword, salt);
  }

  // Žeton: okolje > shranjeno > novo
  const token = envToken || (stored && !envToken ? stored.token : null) || rand(24);

  // V admin.json shrani samo tisto, kar NE prihaja iz okolja.
  if (!envPass || !envToken) {
    const toStore = {
      username: envPass ? (stored ? stored.username : username) : username,
      salt: envPass && stored ? stored.salt : salt,
      hash: envPass && stored ? stored.hash : hash,
      token: envToken ? (stored ? stored.token : token) : token,
      createdAt: (stored && stored.createdAt) || new Date().toISOString()
    };
    // Če geslo prihaja iz okolja in shranjenega ni, nimamo česa smiselno shraniti razen žetona.
    if (envPass && !stored) { toStore.username = username; toStore.salt = salt; toStore.hash = ''; }
    try { fs.writeFileSync(storePath, JSON.stringify(toStore, null, 2), { mode: 0o600 }); fs.chmodSync(storePath, 0o600); }
    catch (e) { logger.warn({ err: e.message }, 'admin.json ni bilo mogoče zapisati'); }
  }

  // Berljiva datoteka za `grep` — osveži jo ob vsakem zagonu.
  const geslo = generatedPassword !== null ? generatedPassword
    : (envPass ? '(iz okoljske spremenljivke ADMIN_PASSWORD)' : '(nespremenjeno — glej prejšnji zapis ali izbriši admin.json za novo)');
  try {
    fs.writeFileSync(plainPath,
      `# ${appName} — skrbniške poverilnice\n` +
      `# Osveženo: ${new Date().toISOString()}\n` +
      `# Datoteka je berljiva samo lastniku (0600). Geslo shrani na varno.\n` +
      `# Novo geslo dobiš tako, da izbrišeš admin.json in znova zaženeš strežnik.\n` +
      `#\n` +
      `#   grep GESLO ${plainPath}\n` +
      `#   grep ZETON ${plainPath}\n` +
      `#\n` +
      `UPORABNIK=${username}\n` +
      `GESLO=${geslo}\n` +
      `# ZETON je za stroje (merilni agenti): Authorization: Bearer <ZETON>\n` +
      `ZETON=${token}\n`,
      { mode: 0o600 });
    fs.chmodSync(plainPath, 0o600);
  } catch (e) { logger.warn({ err: e.message }, 'admin-credentials.txt ni bilo mogoče zapisati'); }

  // V dnevnik gre SAMO pot do datoteke — nikoli geslo ali žeton.
  logger.info({ uporabnik: username, datoteka: plainPath },
    generatedPassword !== null
      ? `Ustvarjene nove skrbniške poverilnice. Geslo dobiš z:  grep GESLO ${plainPath}`
      : `Skrbniške poverilnice naložene. Geslo dobiš z:  grep GESLO ${plainPath}`);

  return { username, salt, hash, token };
}

function create({ dataDir, appName, logger, publicPaths = [], homePath = '/' }) {
  const creds = loadOrCreate({ dataDir, appName, logger });
  const sessions = new Map();                 // sid -> { expiresAt, csrf }
  const alwaysPublic = new Set(['/health', '/prijava', '/odjava', ...publicPaths]);

  // Draga preverjanja gesla so omejena po številu HKRATNIH zahtev in se ne
  // kopičijo v čakalni vrsti: presežek dobi takoj 429. Tako en sam napadalec
  // ne more zadržati prijave pravega skrbnika (kar bi neomejena vrsta omogočila),
  // hkrati pa ne more zasesti niti procesorja. Trajnega zaklepanja ni.
  // Ugibanje samo po sebi ni resna grožnja: geslo ima ~120 bitov entropije.
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

  /** Ali je zahteva overjena? Piškotek (človek) ali žeton (stroj). */
  function isAuthed(req) {
    if (sessionOf(req)) return 'seja';
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const header = req.headers['x-admin-token'];
    if (bearer && safeEqual(bearer, creds.token)) return 'zeton';
    if (header && safeEqual(header, creds.token)) return 'zeton';
    return null;
  }

  /** Middleware: vse zapre, razen javnih poti. */
  function requireAdmin(req, res, next) {
    if (alwaysPublic.has(req.path)) return next();
    const how = isAuthed(req);
    if (how) { req.admin = { via: how }; return next(); }
    // Brskalnik dobi prijavno stran, stroj pa strojno berljiv 401.
    if (req.method === 'GET' && String(req.headers.accept || '').includes('text/html')) {
      return res.redirect(302, '/prijava');
    }
    res.setHeader('WWW-Authenticate', 'Bearer realm="x402"');
    return res.status(401).json({
      error: 'Potrebna je prijava',
      message: 'Človek: odpri /prijava. Stroj: pošlji glavo Authorization: Bearer <ZETON>.',
      namig: 'Žeton dobiš na strežniku z:  grep ZETON data/admin-credentials.txt'
    });
  }

  /** Žeton CSRF za trenutno sejo (samo za prijavljen brskalnik). */
  function csrfFor(req) { const s = sessionOf(req); return s ? s.csrf : null; }

  /**
   * Dodatna zapora za poti, ki kaj sprožijo ali porabijo denar (/run/*).
   *
   * Sam piškotek ni dovolj: `SameSite=Lax` se pošlje tudi pri GET navigaciji s
   * tuje strani, zato bi lahko tuja stran prijavljenemu skrbniku sprožila
   * `/run/tx?queries=200` in porabila denarnico. Zahtevamo torej še žeton, ki ga
   * je mogoče prebrati samo z iste izvorne strani (`GET /run/zeton`), in zavrnemo
   * zahteve, ki so videti kot krmarjenje (`Sec-Fetch-Mode: navigate`).
   *
   * Strojni dostop z `Authorization: Bearer` je izvzet — tam ni ambientalne
   * poverilnice, torej ni CSRF.
   */
  function requireCsrf(req, res, next) {
    if (req.admin && req.admin.via === 'zeton') return next();
    const mode = String(req.headers['sec-fetch-mode'] || '');
    const site = String(req.headers['sec-fetch-site'] || '');
    if (mode === 'navigate' || (site && site !== 'same-origin')) {
      return res.status(403).json({ error: 'Zavrnjeno: zahteva ni z iste strani (zaščita pred CSRF)' });
    }
    const given = req.query.zeton || req.headers['x-csrf'];
    const want = csrfFor(req);
    if (!want || !given || !safeEqual(given, want)) {
      return res.status(403).json({
        error: 'Manjka ali napačen žeton CSRF',
        namig: 'Najprej pridobi žeton na GET /run/zeton in ga dodaj kot ?zeton=…'
      });
    }
    next();
  }

  /** Poti za prijavo/odjavo — namesti jih PRED requireAdmin. */
  function mount(app) {
    // Obrazec pošlje application/x-www-form-urlencoded, API pa JSON — podpremo oboje.
    const form = express.urlencoded({ extended: false, limit: '4kb' });

    app.get('/prijava', (req, res) => {
      if (isAuthed(req)) return res.redirect(302, homePath);
      res.type('html').status(200).send(loginPage(appName, null));
    });

    app.post('/prijava', form, async (req, res) => {
      const wantsHtml = !String(req.headers['content-type'] || '').includes('application/json');
      const fail = (code, msg) => wantsHtml
        ? res.type('html').status(code).send(loginPage(appName, msg))
        : res.status(code).json({ error: msg });
      try {
        const body = req.body || {};
        // Samo nizi: JSON lahko pripelje objekt, ki bi ob pretvorbi v niz vrgel napako.
        const uporabnik = typeof body.uporabnik === 'string' ? body.uporabnik : '';
        const geslo = typeof body.geslo === 'string' ? body.geslo : '';
        if (!uporabnik || !geslo) return fail(401, 'Napačno uporabniško ime ali geslo.');

        if (inFlight >= MAX_LOGINS_IN_FLIGHT) {
          res.setHeader('Retry-After', '2');
          return fail(429, 'Preveč hkratnih poskusov prijave. Poskusi znova čez nekaj sekund.');
        }
        inFlight++;
        let okPass;
        try { okPass = safeEqual(await hashAsync(geslo, creds.salt), creds.hash); }
        finally { inFlight--; }                       // zakasnitev NE sme držati mesta
        const okUser = safeEqual(uporabnik, creds.username);

        if (!okUser || !okPass || !creds.hash) {
          await sleep(FAIL_DELAY_MS);
          return fail(401, 'Napačno uporabniško ime ali geslo.');
        }
        const sid = rand(32);
        sessions.set(sid, { expiresAt: Date.now() + SESSION_TTL * 1000, csrf: rand(24) });
        res.append('Set-Cookie', cookie(sid, req, SESSION_TTL));
        if (wantsHtml) return res.redirect(302, homePath);
        return res.json({ success: true, uporabnik: creds.username, veljaSekund: SESSION_TTL });
      } catch (err) {
        // Brez tega bi zavrnjena obljuba v Express 4 ostala neobravnavana in ubila proces.
        logger.error({ err: err.message }, 'napaka pri prijavi');
        if (!res.headersSent) return fail(400, 'Neveljavna zahteva za prijavo.');
      }
    });

    app.post('/odjava', form, (req, res) => {
      const sid = readCookie(req.headers.cookie, SESSION_COOKIE);
      if (sid) sessions.delete(sid);
      res.append('Set-Cookie', cookie('', req, 0));
      if (String(req.headers['content-type'] || '').includes('application/json')) return res.json({ success: true });
      res.redirect(302, '/prijava');
    });
  }

  return { requireAdmin, requireCsrf, csrfFor, mount, isAuthed, token: () => creds.token, username: () => creds.username };
}

/**
 * Samostojna prijavna stran. Navaden HTML obrazec brez JavaScripta — tako deluje
 * tudi pod privzetim `helmet()` CSP v mapah 02/03, kjer `script-src` ne dovoljuje
 * vgrajenih skript. Brez zunanjih virov (pisave, CDN).
 */
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function loginPage(appName, error) {
  return `<!doctype html>
<html lang="sl"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Prijava · ${escapeHtml(appName)}</title>
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
  <form class="card" method="post" action="/prijava" autocomplete="off">
    <h1>Skrbniška prijava</h1>
    <p class="muted">${escapeHtml(appName)}</p>
    <label for="u">Uporabniško ime</label>
    <input id="u" name="uporabnik" autocomplete="username" autofocus required />
    <label for="p">Geslo</label>
    <input id="p" name="geslo" type="password" autocomplete="current-password" required />
    <button type="submit">Prijava</button>
    ${error ? `<div class="err">${escapeHtml(error)}</div>` : ''}
    <div class="hint">Poverilnice so na strežniku. Prijavi se po SSH in poženi:<br />
      <code>grep GESLO data/admin-credentials.txt</code></div>
  </form>
</body></html>`;
}

module.exports = { create, SESSION_COOKIE };
