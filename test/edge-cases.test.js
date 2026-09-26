// Edge-case and bug-hunt tests across the backend: analytics under hostile or
// degenerate input (empty/duplicate/out-of-order periods, zero shares, NaN),
// route parameter validation quirks, cache-key normalization, static serving,
// and response hygiene. These target the seams where earlier bugs were found.
//
// Run with: npm test

process.env.CACHE_DB_PATH = ':memory:';
process.env.SEC_USER_AGENT = 'Test Suite test@example.com';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const nock = require('nock');
const request = require('supertest');

const app = require('../server');
const {
  buildPositionReturns,
  buildIssuerCapitalStructure,
  xirr,
  parseFinancialNumber,
  extractHoldings,
  extractAllHoldings,
  buildFundXRay,
} = require('../parsers');

const FIXTURES = path.join(__dirname, 'fixtures');
const spacexXml = fs.readFileSync(path.join(FIXTURES, 'nport_spacex_primary_doc.xml'), 'utf8');
const SEC = 'https://www.sec.gov';
const EFTS = 'https://efts.sec.gov';

test.beforeEach(() => {
  nock.cleanAll();
  nock.disableNetConnect();
  nock.enableNetConnect(/127\.0\.0\.1/);
});
test.after(() => nock.enableNetConnect());

const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const h = (over = {}) => {
  const shares = over.shares ?? 100;
  const pps = over.pps === undefined ? 10 : over.pps;
  return {
    name: over.issuer || 'ACME INC',
    issuer: over.issuer || 'ACME INC',
    title: over.title || 'ACME INC PFD A',
    cusip: over.cusip || '',
    instrumentLabel: 'Preferred A',
    instrumentType: 'equity',
    shares,
    pricePerShare: pps,
    marketValue: over.marketValue ?? (pps == null ? 0 : shares * pps),
    isPrivate: true,
  };
};
const per = (reportDate, hs) => ({ reportDate, xray: { privateHoldings: hs } });

// ── mark-implied returns: degenerate inputs ─────────────────────────────────

test('returns: no periods, one period, and null entries never throw', () => {
  assert.equal(buildPositionReturns([]).positions.length, 0);
  assert.equal(buildPositionReturns([null, undefined, {}]).positions.length, 0);
  const one = buildPositionReturns([per('2024-03-31', [h()])]);
  assert.equal(one.positions.length, 1);
  assert.ok(close(one.positions[0].moic, 1), 'a single filing can only ever show 1.0x');
  assert.equal(one.positions[0].irr, null, 'no time elapsed → no IRR');
});

test('returns: periods supplied out of order are processed chronologically', () => {
  const ordered = buildPositionReturns([per('2024-03-31', [h({ pps: 10 })]), per('2024-06-30', [h({ pps: 15 })])]);
  const shuffled = buildPositionReturns([per('2024-06-30', [h({ pps: 15 })]), per('2024-03-31', [h({ pps: 10 })])]);
  assert.equal(shuffled.positions[0].moic, ordered.positions[0].moic);
  assert.ok(close(shuffled.positions[0].moic, 1.5));
});

test('returns: a repeated position in the same filing pair does not double count', () => {
  const { summary } = buildPositionReturns([
    per('2024-03-31', [h({ title: 'A' }), h({ title: 'B', issuer: 'OTHER CO' })]),
    per('2024-06-30', [h({ title: 'A' }), h({ title: 'B', issuer: 'OTHER CO' })]),
  ]);
  assert.equal(summary.positionCount, 2);
  assert.ok(close(summary.invested, 2000));
});

test('returns: add-on then full exit reconciles cash flows (invested = costs of both lots, realized = last mark value)', () => {
  const { positions } = buildPositionReturns([
    per('2024-03-31', [h({ shares: 100, pps: 10 })]),
    per('2024-06-30', [h({ shares: 200, pps: 12 })]), // +100 @12 = 1200
    per('2024-09-30', []),
  ]);
  const p = positions[0];
  assert.ok(close(p.invested, 1000 + 1200));
  assert.ok(close(p.realized, 200 * 12), 'exit realized at the last mark (200 sh × $12)');
  assert.ok(close(p.moic, (200 * 12) / 2200));
});

test('returns: NaN / undefined marks never produce NaN in the summary', () => {
  const bad = h({ pps: undefined });
  bad.pricePerShare = undefined;
  bad.marketValue = undefined;
  const { summary, positions } = buildPositionReturns([per('2024-03-31', [bad, h()]), per('2024-06-30', [bad, h()])]);
  for (const k of ['invested', 'realized', 'currentValue']) assert.ok(Number.isFinite(summary[k]), `${k} finite`);
  assert.ok(positions.every(p => p.moic === null || Number.isFinite(p.moic)));
});

test('returns: two same-issuer positions where only one converts are not both merged', () => {
  const { positions } = buildPositionReturns([
    per('2024-03-31', [
      h({ title: 'ACME PFD A', shares: 100, pps: 10 }),
      h({ title: 'ACME PFD B', shares: 50, pps: 20 }),
    ]),
    per('2024-06-30', [h({ title: 'ACME PFD B', shares: 50, pps: 20 }), h({ title: 'ACME COM', shares: 200, pps: 6 })]),
  ]);
  const titles = positions.map(p => p.title).sort();
  assert.deepEqual(titles, ['ACME COM', 'ACME PFD B']);
  const com = positions.find(p => p.title === 'ACME COM');
  assert.equal(com.chainedFrom, 'ACME PFD A');
  assert.ok(close(com.invested, 1000), 'only the converted lot carries over');
});

test('xirr: extreme and pathological flows return a number or null, never NaN/Infinity/hang', () => {
  const t0 = Date.parse('2020-01-01');
  const yr = 365 * 86400000;
  const cases = [
    [
      { t: t0, amount: -1 },
      { t: t0 + yr, amount: 1e12 },
    ],
    [
      { t: t0, amount: -1e12 },
      { t: t0 + yr, amount: 1 },
    ],
    [
      { t: t0, amount: -100 },
      { t: t0, amount: 100 },
    ],
    [
      { t: NaN, amount: -100 },
      { t: t0 + yr, amount: 110 },
    ],
    [],
  ];
  for (const flows of cases) {
    const r = xirr(flows);
    assert.ok(r === null || Number.isFinite(r), JSON.stringify(flows));
  }
});

// ── capital structure ───────────────────────────────────────────────────────

test('capital structure: no private holdings → empty; unnamed issuers skipped; no NAV → null pct', () => {
  assert.deepEqual(buildIssuerCapitalStructure([{ ...h(), isPrivate: false }], 1e6), []);
  const unnamed = { ...h(), issuer: '', name: '' };
  assert.deepEqual(buildIssuerCapitalStructure([unnamed], 1e6), []);
  const [row] = buildIssuerCapitalStructure([h()], 0);
  assert.equal(row.pctOfNetAssets, null);
  assert.equal(row.multiTranche, false);
});

test('capital structure: issuer name casing/spacing differences still group into one issuer', () => {
  const rows = buildIssuerCapitalStructure(
    [
      h({ issuer: 'Acme  Inc', title: 'PFD' }),
      { ...h({ issuer: 'ACME INC', title: 'TL' }), instrumentType: 'debt', isPrivate: false },
    ],
    0
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].instruments.length, 2);
});

// ── parsers: hostile numerics ───────────────────────────────────────────────

test('parseFinancialNumber: garbage never yields NaN', () => {
  for (const v of [undefined, null, '', '   ', '—', 'N/A', '$', '(', '()', '1,2,3', '1e999', '--5']) {
    const r = parseFinancialNumber(v);
    assert.ok(r === null || Number.isFinite(r) || r === Infinity, `${v} → ${r}`);
  }
  assert.equal(parseFinancialNumber('(1,234.5)'), -1234.5);
});

test('extractHoldings / extractAllHoldings: empty and malformed documents return [] instead of throwing', () => {
  for (const doc of [{}, { edgarSubmission: {} }, { edgarSubmission: { formData: {} } }, null]) {
    assert.deepEqual(extractHoldings(doc || {}, 'x'), []);
    assert.deepEqual(extractAllHoldings(doc || {}), []);
  }
});

test('buildFundXRay: holdings with NaN values do not poison totals', () => {
  const xr = buildFundXRay(
    [
      { marketValue: NaN, isPrivate: true, instrumentType: 'equity', country: 'US' },
      { marketValue: 100, isPrivate: true, instrumentType: 'equity', country: 'US' },
    ],
    { netAssets: 1000 }
  );
  assert.ok(Number.isFinite(xr.privateValueUSD));
  assert.ok(Number.isFinite(xr.totalValueUSD));
});

// ── routes: validation, caching, hygiene ────────────────────────────────────

test('search-10q: maxPerFund validation — negative and non-numeric rejected, zero and blank accepted', async () => {
  assert.equal((await request(app).get('/api/search-10q?issuer=x&maxPerFund=-1')).status, 400);
  assert.equal((await request(app).get('/api/search-10q?issuer=x&maxPerFund=abc')).status, 400);
  nock(EFTS)
    .get('/LATEST/search-index')
    .query(true)
    .times(2)
    .reply(200, { hits: { hits: [] } });
  assert.equal((await request(app).get('/api/search-10q?issuer=zero&maxPerFund=0')).status, 200);
  assert.equal((await request(app).get('/api/search-10q?issuer=blank&maxPerFund=')).status, 200);
});

test('search-nport: ?refresh=1 bypasses the search cache; a normal repeat does not hit SEC', async () => {
  nock(EFTS)
    .get('/LATEST/search-index')
    .query(true)
    .times(2)
    .reply(200, { hits: { hits: [] } });
  await request(app).get('/api/search-nport?security=refreshme');
  const cached = await request(app).get('/api/search-nport?security=refreshme');
  assert.equal(cached.body.cached, true);
  const fresh = await request(app).get('/api/search-nport?security=refreshme&refresh=1');
  assert.equal(fresh.body.cached, false);
});

test('search cache keys are case/whitespace-insensitive (one SEC call for "Acme", " acme ")', async () => {
  nock(EFTS)
    .get('/LATEST/search-index')
    .query(true)
    .once()
    .reply(200, { hits: { hits: [] } });
  await request(app).get('/api/search-nport?security=Acme');
  const res = await request(app).get('/api/search-nport?security=%20acme%20');
  assert.equal(res.body.cached, true);
});

test('parse-nport: the same accession with and without dashes shares one cache entry (one SEC fetch)', async () => {
  nock(SEC)
    .get('/Archives/edgar/data/900/000000000000000009/primary_doc.xml')
    .once()
    .reply(200, spacexXml, { 'Content-Type': 'application/xml' });
  const a = await request(app).get('/api/parse-nport?cik=900&accession=0000000000-00-000009&security=spacex');
  const b = await request(app).get('/api/parse-nport?cik=900&accession=000000000000000009&security=SpaceX');
  assert.equal(a.body.success, true);
  assert.equal(b.body.cached, true);
});

test('fund-xray-returns: duplicate accessions are de-duplicated and the response is JSON, never HTML', async () => {
  nock(SEC)
    .get(/\/Archives\/edgar\/data\/901\/00000000000000000[12]\/primary_doc\.xml/)
    .times(2)
    .reply(200, spacexXml, { 'Content-Type': 'application/xml' });
  const res = await request(app).get(
    '/api/fund-xray-returns?cik=901&accessions=0000000000-00-000001,0000000000-00-000001,0000000000-00-000002'
  );
  assert.match(res.headers['content-type'], /json/);
  assert.equal(res.body.success, true);
  assert.equal(res.body.returns.summary.periodCount, 2);
});

test('reflected input never comes back as HTML: hostile params in error paths are JSON only', async () => {
  const payload = encodeURIComponent('<script>alert(1)</script>');
  for (const url of [
    `/api/search-nport?security=${payload}&x=1`,
    `/api/parse-nport?cik=${payload}`,
    `/api/search-fund?fund=`,
    `/api/fund-xray-returns?cik=${payload}&accessions=${payload}`,
  ]) {
    const res = await request(app).get(url);
    assert.doesNotMatch(res.headers['content-type'] || '', /html/, url);
  }
});

test('static frontend: index.html and app.js are served; unknown static paths 404', async () => {
  const idx = await request(app).get('/');
  assert.equal(idx.status, 200);
  assert.match(idx.text, /<title>Vantage/i);
  const js = await request(app).get('/app.js');
  assert.equal(js.status, 200);
  assert.equal((await request(app).get('/nope.js')).status, 404);
});

test('static frontend: no source maps, env files, or server code are exposed under /', async () => {
  for (const p of ['/.env', '/server.js', '/parsers.js', '/cache.db', '/package.json']) {
    assert.equal((await request(app).get(p)).status, 404, p);
  }
});

test('API responses carry RateLimit headers (limiter is mounted on /api)', async () => {
  const res = await request(app).get('/api/config');
  assert.ok(res.headers['ratelimit'] || res.headers['ratelimit-limit'], 'standard rate limit headers present');
});
