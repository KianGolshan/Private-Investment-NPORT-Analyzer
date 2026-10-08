#!/usr/bin/env node
// Many visitors at once (P9, review R17): N virtual users browse a deployed
// Vantage for a while, each opening pages the way the workspace does (a page's
// API calls in parallel, then a pause), and the run reports latency
// percentiles, errors and status codes per page, plus the server's own memory
// and event-loop delay from /healthz. scripts/bench.js measures each route on
// this machine; this measures the whole site under concurrent use, over HTTP.
//
//   node scripts/loadtest.js https://vantage.example.com --users 50 --seconds 300
//   node scripts/loadtest.js http://127.0.0.1:3002 --users 10 --seconds 20   # a quick local check
//
// Run it from another machine than the server when you can (it is the client).
// Pages (weights): Market 25, company 35, firm 15, fund 10, search 10, Explore 5.
// The ids come from the site itself (market top, firms, Anthropic's holders).
// Budget (STATUS Measurements): 0 errors (429 counted apart), p95 < 200 ms.
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};

const pick = list => list[Math.floor(Math.random() * list.length)];
const sleep = ms => new Promise(r => setTimeout(r, ms));
function pct(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

async function discover(base, get) {
  const fresh = await get('/api/freshness');
  const newest = fresh.newestReportDate;
  const top = (await get('/api/market/top?limit=300')).results.map(r => r.companyId);
  const firms = (await get('/api/firms')).results.map(r => r.id);
  const holders = (await get('/api/companies/1/exposure')).holdings || [];
  const funds = [...new Set(holders.map(h => h.fundKey))].slice(0, 100);
  const names = ['anth', 'stripe', 'databr', 'canva', 'fidelity', 'blackrock', 'growth fund', 'openai', 'xai', 'shein'];
  if (!top.length || !firms.length || !funds.length) throw new Error(`nothing to browse on ${base}`);
  return { newest, top, firms, funds, names };
}

// One page view: the API calls the workspace makes for it, in parallel.
function pageOf(ids) {
  const r = Math.random() * 100;
  const enc = encodeURIComponent;
  if (r < 25) return ['market', ['/api/freshness', '/api/market/top?limit=300', '/api/market/tracked']];
  if (r < 60) {
    const id = pick(ids.top);
    return ['company', [`/api/companies/${id}`, `/api/companies/${id}/exposure`, `/api/companies/${id}/history`]];
  }
  if (r < 75) {
    const id = pick(ids.firms);
    return ['firm', [`/api/firms/${id}`, `/api/firms/${id}/changes`]];
  }
  if (r < 85) {
    const key = enc(pick(ids.funds));
    return ['fund', [`/api/funds/${key}`, `/api/funds/${key}/changes`]];
  }
  if (r < 95) return ['search', [`/api/search?q=${enc(pick(ids.names))}&kinds=company,firm,fund&limit=8`]];
  return [
    'explore',
    [`/api/analysis/pivot?rows=company&period=quarter&from=2025-01-01&to=${ids.newest}&limit=200`, '/api/freshness'],
  ];
}

async function run(base, { users, seconds, thinkMs }) {
  const root = base.replace(/\/$/, '');
  const getJson = async p => {
    const res = await fetch(root + p, { headers: { Accept: 'application/json', 'Accept-Encoding': 'gzip' } });
    if (!res.ok) throw new Error(`${p}: ${res.status}`);
    return res.json();
  };
  const ids = await discover(root, getJson);
  const stats = new Map(); // page -> { ms: [], status: {} }
  const record = (page, ms, status) => {
    const s = stats.get(page) ?? stats.set(page, { ms: [], status: {} }).get(page);
    s.ms.push(ms);
    s.status[status] = (s.status[status] || 0) + 1;
  };
  const health = [];
  const end = Date.now() + seconds * 1000;
  const poll = (async () => {
    while (Date.now() < end) {
      try {
        health.push(await getJson('/healthz'));
      } catch {
        // counted by the visitors' errors
      }
      await sleep(5000);
    }
  })();
  const visitor = async () => {
    while (Date.now() < end) {
      const [page, urls] = pageOf(ids);
      await Promise.all(
        urls.map(async u => {
          const t = performance.now();
          let status = 'error';
          try {
            const res = await fetch(root + u, { headers: { Accept: 'application/json', 'Accept-Encoding': 'gzip' } });
            await res.arrayBuffer();
            status = res.status;
          } catch {
            // a network error or reset
          }
          record(page, performance.now() - t, status);
        })
      );
      await sleep(thinkMs * (0.5 + Math.random()));
    }
  };
  await Promise.all(Array.from({ length: users }, (_, i) => sleep(i * 50).then(visitor)));
  await poll;
  return { ids, stats, health };
}

function report({ stats, health }, { users, seconds }) {
  const rows = [];
  const all = [];
  let errors = 0;
  let limited = 0;
  for (const [page, s] of [...stats].sort()) {
    const sorted = s.ms.sort((a, b) => a - b);
    all.push(...sorted);
    const bad = Object.entries(s.status)
      .filter(([k]) => k !== '200' && k !== '304' && k !== '429')
      .reduce((n, [, v]) => n + v, 0);
    errors += bad;
    limited += s.status[429] || 0;
    rows.push({
      page,
      requests: sorted.length,
      p50: Math.round(pct(sorted, 50)),
      p95: Math.round(pct(sorted, 95)),
      p99: Math.round(pct(sorted, 99)),
      max: Math.round(sorted.at(-1)),
      errors: bad,
      status: JSON.stringify(s.status),
    });
  }
  all.sort((a, b) => a - b);
  console.table(rows);
  const rss = health.map(h => h.rssMB).filter(Number.isFinite);
  const loop = health.map(h => h.loopMaxMs).filter(Number.isFinite);
  const p95 = Math.round(pct(all, 95));
  console.log(
    `${users} users for ${seconds} s: ${all.length} requests (${Math.round(all.length / seconds)}/s), ` +
      `p50 ${Math.round(pct(all, 50))} ms, p95 ${p95} ms, p99 ${Math.round(pct(all, 99))} ms; ` +
      `errors ${errors}, rate-limited ${limited}` +
      (rss.length
        ? `; server (one instance per poll) RSS max ${Math.max(...rss)} MB, event-loop max ${Math.max(...loop)} ms`
        : '')
  );
  return { errors, p95 };
}

async function main() {
  const url = args.find(a => /^https?:\/\//.test(a));
  if (!url) {
    console.error('usage: node scripts/loadtest.js <url> [--users 50] [--seconds 300] [--think-ms 2000]');
    process.exitCode = 2;
    return;
  }
  const o = {
    users: Number(opt('users', 50)),
    seconds: Number(opt('seconds', 300)),
    thinkMs: Number(opt('think-ms', 2000)),
  };
  const r = report(await run(url, o), o);
  if (r.errors || r.p95 >= 200) process.exitCode = 1;
}

if (require.main === module)
  main().catch(err => {
    console.error(`loadtest failed: ${err.message}`);
    process.exitCode = 1;
  });

module.exports = { run, report, pct };
