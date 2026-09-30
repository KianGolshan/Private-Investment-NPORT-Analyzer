#!/usr/bin/env node
// Latency of the warehouse routes on the live warehouse (ROADMAP §5a task 7:
// measure before optimizing). Starts the real server in-process, replays a
// fixed set of real requests over HTTP, and prints p50 / p95 / max per route
// for two passes: the first in a fresh process (SQLite's cache is empty; the
// OS file cache may be warm: macOS cannot drop it without sudo), then again.
//
//   npm run bench                  # both passes
//   npm run bench -- --passes 1    # first pass only
//
// Requests: every tracked company (info, exposure at the newest date, history),
// the ROADMAP search cases plus each tracked company's name, and the 20 largest
// unreviewed names (info, exposure).
const { openWarehouseReadOnly } = require('../lib/warehouse/db');

const SEARCHES = ['Chobani', 'FHU', 'FHUS', 'fhu us holdings', 'Open AI', 'OpenAir', 'Databrick', 'Databriks'];
SEARCHES.push('Hub International', 'Vercel', 'Stripe', 'Pfizer', 'SpaceX', 'Anthropic');

function requests() {
  const db = openWarehouseReadOnly();
  const tracked = db
    .prepare('SELECT c.id, c.name FROM tracked_companies t JOIN companies c ON c.id = t.company_id ORDER BY c.id')
    .all();
  const unreviewed = db
    .prepare('SELECT key FROM unreviewed_entities WHERE active = 1 ORDER BY current_value_usd DESC LIMIT 20')
    .all();
  db.close();
  const enc = encodeURIComponent;
  return [
    ...[...SEARCHES, ...tracked.map(c => c.name)].map(q => ['search', `/api/search?q=${enc(q)}`]),
    ...tracked.map(c => ['company', `/api/companies/${c.id}`]),
    ...tracked.map(c => ['exposure', `/api/companies/${c.id}/exposure`]),
    ...tracked.map(c => ['history', `/api/companies/${c.id}/history`]),
    ...unreviewed.map(e => ['entity', `/api/entities/${enc(e.key)}`]),
    ...unreviewed.map(e => ['entity exposure', `/api/entities/${enc(e.key)}/exposure`]),
  ];
}

const pct = (xs, p) => xs[Math.min(xs.length - 1, Math.floor(xs.length * p))];

async function pass(base, list) {
  const byRoute = new Map();
  for (const [route, url] of list) {
    const t = process.hrtime.bigint();
    const res = await fetch(base + url);
    const body = await res.arrayBuffer();
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    if (res.status !== 200) throw new Error(`${url}: HTTP ${res.status}`);
    if (!byRoute.has(route)) byRoute.set(route, { ms: [], bytes: [] });
    byRoute.get(route).ms.push(ms);
    byRoute.get(route).bytes.push(body.byteLength);
  }
  const all = [];
  const rows = [...byRoute].map(([route, { ms, bytes }]) => {
    all.push(...ms);
    ms.sort((a, b) => a - b);
    bytes.sort((a, b) => a - b);
    return {
      route,
      n: ms.length,
      p50: +pct(ms, 0.5).toFixed(1),
      p95: +pct(ms, 0.95).toFixed(1),
      max: +ms[ms.length - 1].toFixed(1),
      'p95 KB': Math.round(pct(bytes, 0.95) / 1024),
    };
  });
  all.sort((a, b) => a - b);
  rows.push({ route: 'ALL', n: all.length, p50: +pct(all, 0.5).toFixed(1), p95: +pct(all, 0.95).toFixed(1) });
  return rows;
}

async function main() {
  const at = process.argv.indexOf('--passes');
  const passes = at > 0 ? Number(process.argv[at + 1]) : 2;
  const list = requests();
  // The per-visitor API limit (1,500/min) would stop a replay this fast.
  process.env.API_RATE_LIMIT_PER_MIN = '1000000';
  const app = require('../server');
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (let i = 1; i <= passes; i++) {
      const t = Date.now();
      const rows = await pass(base, list);
      console.log(`\npass ${i}${i === 1 ? ' (fresh process)' : ''}: ${list.length} requests in ${Date.now() - t} ms`);
      console.table(rows);
    }
  } finally {
    server.close();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
