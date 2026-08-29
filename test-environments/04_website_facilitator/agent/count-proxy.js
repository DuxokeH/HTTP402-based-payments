#!/usr/bin/env node
'use strict';

/**
 * ============================================================================
 *  COUNTING REVERSE PROXY — message counting
 *  (folder 04_website_facilitator/agent)
 * ============================================================================
 *
 *  Forwards :listen → :target and writes one row per HTTP exchange
 *  (method, path, status, request/response bytes). The point is to measure the NUMBER
 *  of messages per payment flow at the application layer — without `tcpdump` and without
 *  root privileges, so it is reproducible on a server without special permissions too.
 *
 *  The claim it checks:
 *      direct branch      (folder 05)  →  3 exchanges / 6 messages / 2 relationships
 *      facilitator branch (folder 04)  →  5 exchanges / 10 messages / 3 relationships
 *
 *  RUNNING — the facilitator branch needs TWO counters, because it has THREE relationships:
 *    node count-proxy.js --listen=3101 --target=http://127.0.0.1:8081 --tag=merchant
 *    node count-proxy.js --listen=3102 --target=http://127.0.0.1:4000 --tag=facilitator
 *
 *  NOTE: BOTH callers of the facilitator must go through counter 3102 — the payer AND
 *  the merchant. The merchant must therefore be started with `FACILITATOR_URL=http://127.0.0.1:3102`,
 *  otherwise the `payment-request` and `verify-proof` exchanges are not counted at all and
 *  instead of five exchanges we count three:
 *    cd ../server && FACILITATOR_URL=http://127.0.0.1:3102 npm run mock
 *    cd ../agent && node agent.js --mock --tx --queries 1 \
 *         --merchant-url http://127.0.0.1:3101 --facilitator-url http://127.0.0.1:3102
 *
 *  RUNNING — the direct branch (folder 05) needs a single one:
 *    node count-proxy.js --listen=3101 --target=http://127.0.0.1:8080 --tag=direct
 *    (the tag must stay `direct` — the analysis script recognises the direct branch by it)
 *
 *  Stop the counter with Ctrl+C: it then prints a summary and writes the CSV.
 *
 *  Preparatory routes (`/config`, `/health`, `/login`, `/logout`, `/session`, `/run/*`) do
 *  NOT count towards the payment flow: the agent calls them once before the measurement and
 *  they have nothing to do with the payment itself. They ARE recorded in the CSV with a
 *  `payment=0` column, so the selection is visible and not hidden.
 *
 *  Differences from the old implementation (`experiments/client/count-proxy.js`):
 *   - the response is STREAMED and not buffered in memory, so it works with SSE as well
 *     (the /run/tx and /run/metered routes would otherwise hang);
 *   - on exit it writes a CSV and a summary, so the counting is data and not just output;
 *   - long-lived streams (SSE) are marked separately so they do not spoil the exchange count.
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
const OUT = args.out || path.join(__dirname, '..', 'measurements', `e9_${TAG}.csv`);
const QUIET = args.quiet === 'true';

// Preparatory routes — we record them, but they do not count towards the payment flow.
const NON_PAYMENT = [/^\/config/, /^\/health/, /^\/login/, /^\/logout/, /^\/session/, /^\/run\//, /^\/favicon/];
const isPayment = (path) => !NON_PAYMENT.some((re) => re.test(path));

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
    // We stream (we do not buffer): otherwise SSE would stall and `/run/*` would not work.
    upRes.pipe(res);
    upRes.on('end', () => {
      n += 1;
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      const path = req.url.split('?')[0];
      const payment = !sse && isPayment(path);
      const row = { i: n, tag: TAG, method: req.method, path, status: upRes.statusCode,
        request_b: reqBytes, response_b: respBytes, ms: +ms.toFixed(2), flow: sse ? 1 : 0, payment: payment ? 1 : 0 };
      rows.push(row);
      if (!QUIET) console.log(`[${TAG}] #${n} ${req.method} ${path} -> ${upRes.statusCode} reqB=${reqBytes} respB=${respBytes}${sse ? ' (SSE flow)' : payment ? '' : ' (preparatory — not counted)'}`);
    });
  });
  up.on('error', (e) => { if (!res.headersSent) res.writeHead(502); res.end(e.message); });
  req.pipe(up);
});

server.listen(LISTEN, '127.0.0.1', () =>
  console.log(`[${TAG}] counting proxy :${LISTEN} → ${TARGET.href}\n         stop with Ctrl+C (it then writes ${path.relative(process.cwd(), OUT)})`));

function finish() {
  // SSE streams and preparatory routes are not payment exchanges.
  const paymentRows = rows.filter(r => r.payment);
  console.log(`\n[${TAG}] ── summary ─────────────────────────────────────────`);
  console.log(`  exchanges (request+response): ${paymentRows.length}`);
  console.log(`  messages (HTTP):              ${paymentRows.length * 2}`);
  const other = rows.length - paymentRows.length;
  if (other) console.log(`  (plus ${other} preparatory requests / SSE streams — not counted)`);
  for (const r of paymentRows) console.log(`    ${String(r.i).padStart(3)}. ${r.method.padEnd(5)} ${r.path.padEnd(32)} ${r.status}`);
  try {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, 'i,tag,method,path,status,request_b,response_b,ms,flow,payment\n' +
      rows.map(r => [r.i, r.tag, r.method, r.path, r.status, r.request_b, r.response_b, r.ms, r.flow, r.payment].join(',')).join('\n') + '\n');
    console.log(`  CSV: ${path.relative(process.cwd(), OUT)}`);
  } catch (e) { console.error(`  CSV was not written: ${e.message}`); }
  process.exit(0);
}
process.on('SIGINT', finish);
process.on('SIGTERM', finish);
