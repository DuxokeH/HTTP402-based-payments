#!/usr/bin/env node
'use strict';

/**
 * ============================================================================
 *  ŠTEVNI POSREDOVALNIK (counting reverse proxy) — štetje sporočil
 *  (mapa 04_spletisce_posrednik/agent)
 * ============================================================================
 *
 *  Prepošilja :listen → :target in za vsako HTTP izmenjavo zapiše eno vrstico
 *  (metoda, pot, status, zlogi zahteve/odgovora). Namen je izmeriti ŠTEVILO
 *  sporočil na plačilni tok pri aplikacijski plasti — brez `tcpdump` in brez
 *  pravic root, torej ponovljivo tudi na strežniku brez posebnih dovoljenj.
 *
 *  Trditev, ki jo preverja:
 *      neposredna veja  (mapa 05)  →  3 izmenjave / 6 sporočil / 2 razmerji
 *      posredniška veja (mapa 04)  →  5 izmenjav / 10 sporočil / 3 razmerja
 *
 *  ZAGON — posredniška veja potrebuje DVA števca, ker so v njej TRI razmerja:
 *    node count-proxy.js --listen=3101 --target=http://127.0.0.1:8081 --tag=trgovec
 *    node count-proxy.js --listen=3102 --target=http://127.0.0.1:4000 --tag=posrednik
 *
 *  POZOR: skozi števec 3102 morata iti OBA, ki kličeta posrednika — plačnik IN
 *  trgovec. Trgovca je zato treba pognati s `POSREDNIK_URL=http://127.0.0.1:3102`,
 *  sicer se izmenjavi `payment-request` in `verify-proof` sploh ne preštejeta in
 *  namesto petih izmenjav jih naštejemo tri:
 *    cd ../streznik && POSREDNIK_URL=http://127.0.0.1:3102 npm run mock
 *    cd ../agent && node agent.js --mock --tx --queries 1 \
 *         --merchant-url http://127.0.0.1:3101 --posrednik-url http://127.0.0.1:3102
 *
 *  ZAGON — neposredna veja (mapa 05) potrebuje enega:
 *    node count-proxy.js --listen=3101 --target=http://127.0.0.1:8080 --tag=neposredno
 *
 *  Števec ustavi s Ctrl+C: takrat izpiše povzetek in zapiše CSV.
 *
 *  V plačilni tok se NE štejejo pripravljalne poti (`/config`, `/health`, `/prijava`,
 *  `/odjava`, `/seja`, `/run/*`): agent jih pokliče enkrat pred meritvijo, s samim
 *  plačilom pa nimajo nič. So pa v CSV zabeležene s stolpcem `placilna=0`, da je
 *  izbor viden in ne skrit.
 *
 *  Razlike proti stari izvedbi (`experiments/client/count-proxy.js`):
 *   - odgovor se PRETAKA in ne shranjuje v pomnilnik, zato deluje tudi s SSE
 *     (poti /run/tx in /run/merjeno bi sicer obvisele);
 *   - ob izhodu zapiše CSV in povzetek, da je štetje podatek in ne le izpis;
 *   - dolgo živeče pretoke (SSE) označi posebej, da ne kvarijo štetja izmenjav.
 * ============================================================================
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const args = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) args[m[1]] = m[2] === undefined ? 'true' : m[2];
}
const LISTEN = parseInt(args.listen || '3101', 10);
const TARGET = new URL(args.target || 'http://127.0.0.1:8081');
const TAG = args.tag || 'proxy';
const OUT = args.out || path.join(__dirname, '..', 'meritve', `e9_${TAG}.csv`);
const QUIET = args.quiet === 'true';

// Pripravljalne poti — zabeležimo jih, a v plačilni tok ne štejejo.
const NEPLACILNE = [/^\/config/, /^\/health/, /^\/prijava/, /^\/odjava/, /^\/seja/, /^\/run\//, /^\/favicon/];
const jePlacilna = (pot) => !NEPLACILNE.some((re) => re.test(pot));

let n = 0;
const rows = [];

const server = http.createServer((req, res) => {
  const t0 = process.hrtime.bigint();
  let reqBytes = 0, respBytes = 0;
  req.on('data', (c) => { reqBytes += c.length; });

  const up = http.request({
    hostname: TARGET.hostname,
    port: TARGET.port || 80,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: TARGET.host }
  }, (upRes) => {
    const sse = String(upRes.headers['content-type'] || '').startsWith('text/event-stream');
    res.writeHead(upRes.statusCode, upRes.headers);
    upRes.on('data', (c) => { respBytes += c.length; });
    // Pretakamo (ne medpomnimo): sicer bi se SSE zataknil in `/run/*` ne bi delal.
    upRes.pipe(res);
    upRes.on('end', () => {
      n += 1;
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      const pot = req.url.split('?')[0];
      const placilna = !sse && jePlacilna(pot);
      const row = { i: n, tag: TAG, metoda: req.method, pot, status: upRes.statusCode,
        zahteva_b: reqBytes, odgovor_b: respBytes, ms: +ms.toFixed(2), pretok: sse ? 1 : 0, placilna: placilna ? 1 : 0 };
      rows.push(row);
      if (!QUIET) console.log(`[${TAG}] #${n} ${req.method} ${pot} -> ${upRes.statusCode} reqB=${reqBytes} respB=${respBytes}${sse ? ' (SSE pretok)' : placilna ? '' : ' (pripravljalna — ne šteje)'}`);
    });
  });
  up.on('error', (e) => { if (!res.headersSent) res.writeHead(502); res.end(e.message); });
  req.pipe(up);
});

server.listen(LISTEN, '127.0.0.1', () =>
  console.log(`[${TAG}] števni posredovalnik :${LISTEN} → ${TARGET.href}\n         ustavi s Ctrl+C (takrat zapiše ${path.relative(process.cwd(), OUT)})`));

function zakljuci() {
  // SSE pretoki in pripravljalne poti niso plačilne izmenjave.
  const placilne = rows.filter(r => r.placilna);
  console.log(`\n[${TAG}] ── povzetek ────────────────────────────────────────`);
  console.log(`  izmenjav (zahteva+odgovor): ${placilne.length}`);
  console.log(`  sporočil (HTTP):            ${placilne.length * 2}`);
  const ostalo = rows.length - placilne.length;
  if (ostalo) console.log(`  (poleg tega ${ostalo} pripravljalnih zahtev / SSE pretokov — ne štejejo)`);
  for (const r of placilne) console.log(`    ${String(r.i).padStart(3)}. ${r.metoda.padEnd(5)} ${r.pot.padEnd(32)} ${r.status}`);
  try {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, 'i,tag,metoda,pot,status,zahteva_b,odgovor_b,ms,pretok,placilna\n' +
      rows.map(r => [r.i, r.tag, r.metoda, r.pot, r.status, r.zahteva_b, r.odgovor_b, r.ms, r.pretok, r.placilna].join(',')).join('\n') + '\n');
    console.log(`  CSV: ${path.relative(process.cwd(), OUT)}`);
  } catch (e) { console.error(`  CSV ni bil zapisan: ${e.message}`); }
  process.exit(0);
}
process.on('SIGINT', zakljuci);
process.on('SIGTERM', zakljuci);
