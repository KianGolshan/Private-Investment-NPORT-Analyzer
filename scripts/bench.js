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
// unreviewed names (info, exposure); P5b: v1's Top Funds names through the fund
// search, and the 60 funds with the largest stored book in their newest filing
// (info, X-Ray, compare with the prior filing, returns over 8 filings). P6 and
// P6b W1: each tracked company's analysis views, scope filters, bridge and one
// position history; the 12 firms with the most holding funds (Fidelity first)
// for book, changes, bridge, timeline and pivot; market-wide pivots; unified search.
const { openWarehouseReadOnly } = require('../lib/warehouse/db');
const { TOP_FUND_GROUPS } = require('../public/fund-groups');

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
  const funds = db
    .prepare(
      `SELECT n.fund_key, (SELECT COUNT(*) FROM holdings h WHERE h.accession = n.last_accession) rows
       FROM fund_names n WHERE n.filings >= 2 ORDER BY rows DESC, n.fund_key LIMIT 60`
    )
    .all();
  // P6 and P6b W1: the 12 largest firms (Fidelity, BlackRock, Capital Group, …) and one fund per tracked company.
  const newest = db.prepare('SELECT MAX(as_of) d FROM company_stats').get().d;
  const firmsTop = db
    .prepare(
      `SELECT ma.manager_id id, COUNT(DISTINCT p.fund_key) n FROM position_facts p
       JOIN fund_advisers fa ON fa.fund_key = p.fund_key AND fa.role = 'adviser'
       JOIN manager_advisers ma ON ma.file_num = fa.file_num GROUP BY 1 ORDER BY n DESC LIMIT 12`
    )
    .all()
    .map(r => r.id);
  const positions = db
    .prepare(
      `SELECT company_id, fund_key FROM position_facts WHERE company_id IN (SELECT company_id FROM tracked_companies)
       GROUP BY company_id HAVING fund_key = MAX(fund_key) ORDER BY company_id`
    )
    .all();
  db.close();
  const enc = encodeURIComponent;
  const yearAgo = new Date(Date.parse(newest) - 365 * 86400000).toISOString().slice(0, 10);
  return [
    ...[...SEARCHES, ...tracked.map(c => c.name)].map(q => ['search', `/api/search?q=${enc(q)}`]),
    ...tracked.map(c => ['company', `/api/companies/${c.id}`]),
    ...tracked.map(c => ['exposure', `/api/companies/${c.id}/exposure`]),
    ...tracked.map(c => ['history', `/api/companies/${c.id}/history`]),
    ...unreviewed.map(e => ['entity', `/api/entities/${enc(e.key)}`]),
    ...unreviewed.map(e => ['entity exposure', `/api/entities/${enc(e.key)}/exposure`]),
    ...Object.values(TOP_FUND_GROUPS)
      .flat()
      .map(q => ['fund search', `/api/funds?q=${enc(q)}&limit=25`]),
    ...funds.map(f => ['fund', `/api/funds/${enc(f.fund_key)}`]),
    ...funds.map(f => ['fund xray', `/api/funds/${enc(f.fund_key)}/xray`]),
    ...funds.map(f => ['fund compare', `/api/funds/${enc(f.fund_key)}/compare`]),
    ...funds.map(f => ['fund returns', `/api/funds/${enc(f.fund_key)}/returns`]),
    // P6 analysis views
    ...tracked.map(c => ['activity', `/api/companies/${c.id}/activity`]),
    ...tracked.map(c => ['trend', `/api/companies/${c.id}/trend`]),
    ...tracked.map(c => ['classes', `/api/companies/${c.id}/classes`]),
    ...tracked.map(c => ['marks', `/api/companies/${c.id}/marks`]),
    ['firms', '/api/firms'],
    ...firmsTop.map(id => ['firm book', `/api/firms/${id}`]),
    ...firmsTop.map(id => ['firm changes', `/api/firms/${id}/changes`]),
    ['market top', '/api/market/top'],
    // P6b W1: scope filters, bridge, positions, pivot, timeline, unified search
    ...tracked.map(c => ['exposure ?firm', `/api/companies/${c.id}/exposure?firm=${firmsTop[0]}`]),
    ...tracked.map(c => ['activity ?firm', `/api/companies/${c.id}/activity?firm=${firmsTop[0]}`]),
    ...tracked.map(c => ['bridge', `/api/companies/${c.id}/bridge`]),
    ...tracked.map(c => ['bridge ?kind', `/api/companies/${c.id}/bridge?kind=direct&from=${yearAgo}`]),
    ...positions.map(p => ['positions', `/api/companies/${p.company_id}/positions/${enc(p.fund_key)}`]),
    ...firmsTop.map(id => ['firm bridge', `/api/analysis/bridge?firm=${id}`]),
    ...firmsTop.map(id => ['firm timeline', `/api/analysis/timeline?firm=${id}`]),
    ...firmsTop.map(id => ['firm pivot', `/api/analysis/pivot?rows=company&period=quarter&firm=${id}`]),
    ['pivot', '/api/analysis/pivot?rows=firm&period=quarter'],
    ['pivot', '/api/analysis/pivot?rows=company&period=month'],
    ['pivot', '/api/analysis/pivot?rows=fund&period=year&from=2019-12-31'],
    ['bridge all', '/api/analysis/bridge'],
    // P6b W3: firm and fund pages
    ...firmsTop.map(id => ['firm marks', `/api/analysis/marks?firm=${id}`]),
    ...firmsTop.map(id => ['firm changes page', `/api/firms/${id}/changes?limit=500`]),
    ...funds.slice(0, 20).map(f => ['fund timeline', `/api/analysis/timeline?fund=${enc(f.fund_key)}`]),
    ...funds.slice(0, 20).map(f => ['fund marks', `/api/analysis/marks?fund=${enc(f.fund_key)}`]),
    // P6b W2: the company workbench
    ...tracked.map(c => ['legs', `/api/companies/${c.id}/legs`]),
    ...tracked.map(c => ['rows', `/api/companies/${c.id}/rows`]),
    ...tracked.map(c => ['leadership', `/api/companies/${c.id}/leadership`]),
    ...tracked.map(c => [
      'company pivot',
      `/api/analysis/pivot?company=${c.id}&rows=firm&period=quarter&from=2019-09-30`,
    ]),
    // P6b W4: Explore drill, Market movers and newly reported, scoped feed, watchlist, Compare
    ...['value', 'positionEffect', 'mark', 'holders'].map(m => [
      'drill total',
      `/api/analysis/drill?rows=firm&metric=${m}&from=${yearAgo}&to=${newest}`,
    ]),
    ...firmsTop.map(id => [
      'drill firm',
      `/api/analysis/drill?rows=firm&key=${id}&metric=positionEffect&from=${yearAgo}&to=${newest}`,
    ]),
    ...tracked.map(c => [
      'drill company',
      `/api/analysis/drill?rows=company&key=${c.id}&metric=value&from=${yearAgo}&to=${newest}`,
    ]),
    ['pivot tracked', '/api/analysis/pivot?rows=company&period=quarter&tracked=1'],
    ['pivot class', '/api/analysis/pivot?rows=class&period=quarter'],
    ['movers', '/api/market/movers'],
    ['movers', `/api/market/movers?from=2019-12-31&to=${newest}`],
    ['movers tracked', '/api/market/movers?tracked=1'],
    ['newly reported', '/api/market/new'],
    ['newly reported', `/api/market/new?from=2019-12-31&to=${newest}`],
    ...firmsTop.map(id => ['feed ?firm', `/api/feed?all=1&firm=${id}`]),
    [
      'watchlist',
      `/api/watchlist?company=${tracked
        .slice(0, 100)
        .map(c => c.id)
        .join(',')}&firm=${firmsTop.join(',')}`,
    ],
    [
      'compare companies',
      `/api/analysis/compare?rows=company&${tracked
        .slice(0, 5)
        .map(c => `key=${c.id}`)
        .join('&')}`,
    ],
    [
      'compare firms',
      `/api/analysis/compare?rows=firm&${firmsTop
        .slice(0, 5)
        .map(id => `key=${id}`)
        .join('&')}`,
    ],
    ...[...SEARCHES, 'Fidelity', 'Capital Group', 'Growth Fund of America', 'Anthropic Series G'].map(q => [
      'search all',
      `/api/search?q=${enc(q)}&kinds=company,entity,firm,fund,class`,
    ]),
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
    // 422: returns refused for a filing over the position limit (lib/services/fund.js).
    const expected = res.status === 200 || (route === 'fund returns' && res.status === 422);
    if (!expected) throw new Error(`${url}: HTTP ${res.status}`);
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
