#!/usr/bin/env node
// The live accuracy and safety check of a deployed Vantage (P9): run after
// every deploy (deploy/deploy.sh, which rolls back on a failure) and every
// night (scripts/nightly.js, VANTAGE_PUBLIC_URL). Plain HTTP against the URL, so
// it checks what visitors get, through the CDN and the proxy.
//
//   node scripts/smoke.js https://vantage.example.com
//   node scripts/smoke.js http://127.0.0.1:3002 --no-public   # a local server (live routes on)
//   node scripts/smoke.js http://127.0.0.1:3002 --no-goldens  # a test warehouse (the deploy drill)
//
// Goldens (docs/GOLDEN-NUMBERS.md, by company as the app reads them; the
// by-company totals of A1 and A2 are in GOLDEN-NUMBERS A1 and the P4.5 log in
// archive/STATUS-history.md). Historical dates only, so a new filing cannot
// move them; an amendment can, and then GOLDEN-NUMBERS is re-verified first.
// Exits 1 on any failed check.
const GOLDENS = [
  {
    name: 'A1 Anthropic 2026-03-31',
    path: '/api/companies/1/exposure?date=2026-03-31',
    funds: 72,
    billions: [5.945, 3],
  },
  {
    name: 'A2 Anthropic 2026-06-30',
    path: '/api/companies/1/exposure?date=2026-06-30',
    funds: 117,
    billions: [17.29, 2],
  },
  {
    name: 'A4 Anthropic known as of 2026-06-30',
    path: '/api/companies/1/exposure?date=2026-06-30&knownAsOf=2026-06-30',
    funds: 82,
  },
  { name: 'A5 Stripe 2025-06-30', path: '/api/companies/5/exposure?date=2025-06-30', funds: 49, billions: [1.02, 2] },
  { name: 'A5 Stripe 2025-12-31', path: '/api/companies/5/exposure?date=2025-12-31', funds: 35, billions: [1.31, 2] },
  { name: 'A5 Stripe 2026-03-31', path: '/api/companies/5/exposure?date=2026-03-31', funds: 34, billions: [1.91, 2] },
  { name: 'A5 Stripe 2026-06-30', path: '/api/companies/5/exposure?date=2026-06-30', funds: 37, billions: [2.44, 2] },
  { name: 'A6 Databricks 2026-06-30', path: '/api/companies/2/exposure?date=2026-06-30', funds: 120 },
];
const LIVE_ROUTES = ['/api/search-nport?q=Anthropic', '/api/parse-10q?cik=1&accession=000000000000000000'];
const TIMEOUT_MS = 30000;

const round = (v, places) => Math.round(v * 10 ** places) / 10 ** places;

// fetchImpl: injected by tests. publicSite: the URL is the public deployment
// (live routes and v1 off); false for a local or development server.
// goldens: false skips the golden numbers (a test warehouse, deploy/test/drill.sh).
async function runSmoke(base, { fetchImpl = fetch, publicSite = true, goldens = true } = {}) {
  const root = String(base).replace(/\/$/, '');
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
  const get = async (p, init = {}) => {
    const res = await fetchImpl(root + p, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: 'application/json', 'User-Agent': 'vantage-smoke', ...(init.headers || {}) },
      ...init,
    });
    let body = null;
    const type = res.headers.get('content-type') || '';
    try {
      body = type.includes('json') ? await res.json() : await res.text();
    } catch {
      // an empty or unreadable body: judged by status
    }
    return { status: res.status, headers: res.headers, body };
  };
  const step = async (name, fn) => {
    try {
      await fn();
    } catch (err) {
      check(name, false, err.message);
    }
  };

  await step('healthz', async () => {
    const r = await get('/healthz');
    check('healthz', r.status === 200 && r.body?.ok === true, `status ${r.status}`);
  });
  await step('readyz', async () => {
    const r = await get('/readyz');
    check(
      'readyz',
      r.status === 200 && r.body?.ready === true,
      r.status === 200
        ? `generation ${r.body?.generation}, filings through ${r.body?.newestFilingDate}`
        : `status ${r.status}: ${r.body?.reason ?? ''}`
    );
  });
  await step('home page', async () => {
    const r = await get('/', { headers: { Accept: 'text/html' } });
    const csp = r.headers.get('content-security-policy') || '';
    check('home page', r.status === 200 && /<div id="app"|<html/i.test(String(r.body)), `status ${r.status}`);
    check(
      'security headers',
      /default-src 'self'/.test(csp) &&
        r.headers.get('x-content-type-options') === 'nosniff' &&
        r.headers.get('x-frame-options') === 'DENY',
      csp ? 'CSP, nosniff and frame-deny present' : 'no Content-Security-Policy'
    );
  });
  for (const g of goldens ? GOLDENS : [])
    await step(g.name, async () => {
      const r = await get(g.path);
      if (r.status !== 200) return check(g.name, false, `status ${r.status}`);
      const got = { funds: r.body.funds, billions: g.billions ? round(r.body.total / 1e9, g.billions[1]) : undefined };
      const ok = got.funds === g.funds && (!g.billions || got.billions === g.billions[0]);
      return check(
        g.name,
        ok,
        `${got.funds} funds${g.billions ? ` / $${got.billions}B` : ''}` +
          (ok ? '' : ` (golden ${g.funds}${g.billions ? ` / $${g.billions[0]}B` : ''})`)
      );
    });
  await step('admin', async () => {
    const r = await get('/api/admin/companies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    check('admin refused', r.status === 403, `status ${r.status}`);
  });
  if (publicSite) {
    await step('public mode', async () => {
      const c = await get('/api/config');
      check('public mode', c.body?.public === true, `config public: ${c.body?.public}`);
      for (const p of LIVE_ROUTES) {
        const r = await get(p);
        check(`live route off ${p.split('?')[0]}`, r.status === 410, `status ${r.status}`);
      }
      const legacy = await get('/legacy', { headers: { Accept: 'text/html' } });
      check('v1 page off', legacy.status === 410, `status ${legacy.status}`);
    });
  }
  return { url: root, ok: checks.every(c => c.ok), checks };
}

async function main() {
  const args = process.argv.slice(2);
  const url = args.find(a => !a.startsWith('--')) || process.env.VANTAGE_PUBLIC_URL;
  if (!url) {
    console.error('usage: node scripts/smoke.js <url> [--no-public] [--no-goldens]');
    process.exitCode = 2;
    return;
  }
  const r = await runSmoke(url, { publicSite: !args.includes('--no-public'), goldens: !args.includes('--no-goldens') });
  for (const c of r.checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`);
  console.log(r.ok ? `smoke passed (${r.checks.length} checks)` : 'smoke FAILED');
  if (!r.ok) process.exitCode = 1;
}

if (require.main === module)
  main().catch(err => {
    console.error(`smoke failed: ${err.message}`);
    process.exitCode = 1;
  });

module.exports = { runSmoke, GOLDENS };
