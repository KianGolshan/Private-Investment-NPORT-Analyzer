// Edge-case and bug-hunt tests across the backend: analytics under hostile or
// degenerate input (empty/duplicate/out-of-order periods, zero shares, NaN),
// static serving and response hygiene. These target the seams where earlier
// bugs were found.
//
// Run with: npm test

process.env.SEC_USER_AGENT = 'Test Suite test@example.com';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');

const app = require('../server');
const {
  buildPositionReturns,
  buildIssuerCapitalStructure,
  xirr,
  extractAllHoldings,
  buildFundXRay,
} = require('../parsers');

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
  const unnamed = { ...h(), issuer: '', name: '', title: '' };
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

test('extractAllHoldings: empty and malformed documents return [] instead of throwing', () => {
  for (const doc of [{}, { edgarSubmission: {} }, { edgarSubmission: { formData: {} } }, null]) {
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

// ── serving and response hygiene ─────────────────────────────────────────────

const built = fs.existsSync(path.join(__dirname, '..', 'web', 'dist', 'index.html'));

test('the workspace serves at / and its routes when built (else a plain 503 that says how to build it)', async () => {
  for (const p of ['/', '/company/5-stripe', '/firm/9', '/firms', '/activity', '/fund/S000009228']) {
    const res = await request(app).get(p);
    if (built) {
      assert.equal(res.status, 200, p);
      assert.match(res.text, /<title>[^<]*Vantage[^<]*<\/title>/i, p);
      assert.match(res.text, /type="module"/, `${p} is the workspace`);
    } else {
      assert.equal(res.status, 503, p);
      assert.match(res.text, /npm run build:web/, p);
    }
  }
  assert.equal((await request(app).get('/assets/nope.js')).status, 404);
});

test('v1 is gone from the live project: its page, scripts and per-filing routes are not served', async () => {
  // kept, runnable, at the git tag v1-archive (2026-10-13 review)
  for (const p of ['/app.js', '/views.js', '/peer.js', '/splits.js', '/index.html', '/nope.js']) {
    assert.equal((await request(app).get(p)).status, 404, p);
  }
  for (const p of ['/api/search-nport?security=x', '/api/parse-10q', '/api/fund-xray', '/api/search-fund?fund=x']) {
    assert.equal((await request(app).get(p)).status, 404, p);
  }
  assert.equal((await request(app).get('/legacy').set('Accept', 'text/html')).status, 404, '/legacy');
});

test('static frontend: no source maps, env files, or server code are exposed under /', async () => {
  for (const p of ['/.env', '/server.js', '/parsers.js', '/warehouse.db', '/package.json', '/lib/api/heavy.js']) {
    assert.equal((await request(app).get(p)).status, 404, p);
  }
  assert.equal((await request(app).get('/og.png')).status, 200, 'the link-preview image is still served');
});

test('API responses carry RateLimit headers (limiter is mounted on /api)', async () => {
  const res = await request(app).get('/api/config');
  assert.ok(res.headers['ratelimit'] || res.headers['ratelimit-limit'], 'standard rate limit headers present');
});

test('security headers: scripts from self only, no framing or sniffing, no device APIs, own browsing group', async () => {
  for (const p of ['/', '/api/config', '/og.png']) {
    const res = await request(app).get(p);
    const csp = res.headers['content-security-policy'] || '';
    assert.match(csp, /script-src 'self';/, p);
    assert.doesNotMatch(csp, /unsafe-inline'[^;]*;?\s*$|script-src[^;]*unsafe-inline/, p);
    assert.match(csp, /connect-src 'self'/, p);
    assert.match(csp, /frame-ancestors 'none'/, p);
    assert.equal(res.headers['x-content-type-options'], 'nosniff', p);
    assert.equal(res.headers['x-frame-options'], 'DENY', p);
    assert.match(res.headers['permissions-policy'] || '', /camera=\(\).*geolocation=\(\)/, p);
    assert.equal(res.headers['cross-origin-opener-policy'], 'same-origin', p);
    assert.equal(res.headers['x-powered-by'], undefined, p);
  }
});
