// Edge-case and bug-hunt tests across the backend: analytics under hostile or
// degenerate input (empty/duplicate/out-of-order periods, zero shares, NaN),
// route parameter validation quirks, cache-key normalization, static serving,
// and response hygiene. These target the seams where earlier bugs were found.
//
// Run with: npm test

process.env.CACHE_DB_PATH = ':memory:';
process.env.SEC_MIN_INTERVAL_MS = '0';
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

test('the workspace (web/dist) serves at / and its routes when built; v1 stays at /legacy', async () => {
  const fs2 = require('fs');
  const built = fs2.existsSync(path.join(__dirname, '..', 'web', 'dist', 'index.html'));
  const legacy = await request(app).get('/legacy');
  assert.equal(legacy.status, 200);
  assert.match(legacy.text, /src="\/app.js"/, 'v1 page at /legacy');
  for (const p of ['/', '/company/5-stripe', '/firm/9', '/firms', '/activity', '/fund/S000009228']) {
    const res = await request(app).get(p);
    assert.equal(res.status, 200, p);
    assert.match(res.text, /<title>Vantage/i, p);
    if (built) assert.match(res.text, /type="module"/, `${p} is the workspace`);
  }
  assert.equal((await request(app).get('/assets/nope.js')).status, 404);
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

test('a transient upstream 500 (seen live from EFTS under load) is retried and the request succeeds; a persistent 500 still fails', async () => {
  nock(EFTS).get('/LATEST/search-index').query(true).once().reply(500, 'Internal Server Error');
  nock(EFTS)
    .get('/LATEST/search-index')
    .query(true)
    .once()
    .reply(200, { hits: { hits: [] } });
  const ok = await request(app).get('/api/search-nport?security=transient-500');
  assert.equal(ok.status, 200);

  nock(EFTS).get('/LATEST/search-index').query(true).times(3).reply(500, 'Internal Server Error');
  const bad = await request(app).get('/api/search-nport?security=persistent-500');
  assert.equal(bad.status, 500);
});

// ── Fixes from the full-project audit ─────────────────────────────────────

test('search-nport: pages through every EFTS hit, not just the first 100 (real: Anthropic had 837)', async () => {
  const page = (from, n) =>
    Array.from({ length: n }, (_, i) => ({ _id: `hit-${from + i}`, _source: { adsh: `adsh-${from + i}` } }));
  const seenFrom = [];
  nock(EFTS)
    .get('/LATEST/search-index')
    .query(q => {
      seenFrom.push(Number(q.from));
      return q.size === '100';
    })
    .times(3)
    .reply(uri => {
      const from = Number(new URL(uri, EFTS).searchParams.get('from'));
      const n = from < 200 ? 100 : 37;
      return [200, { hits: { total: { value: 237, relation: 'eq' }, hits: page(from, n) } }];
    });
  const res = await request(app).get('/api/search-nport?security=paged-name');
  assert.equal(res.status, 200);
  assert.deepEqual(seenFrom, [0, 100, 200]);
  assert.equal(res.body.hits.hits.length, 237);
  assert.equal(res.body.hits.total.value, 237);
});

test('search-nport: one hit per filing — EFTS document hits sharing an accession collapse, total reflects filings', async () => {
  // EFTS returns a hit per matching document; the same filing showed up
  // repeatedly in real results (412 of 2,000 top-100 slots across 20 names).
  nock(EFTS)
    .get('/LATEST/search-index')
    .query(true)
    .once()
    .reply(200, {
      hits: {
        total: { value: 4, relation: 'eq' },
        hits: [
          { _id: '0001193125-26-323081:primary_doc.xml', _source: { adsh: '0001193125-26-323081' } },
          { _id: '0001193125-26-323081:xslFormNPORT-P_X01/primary_doc.xml', _source: { adsh: '0001193125-26-323081' } },
          { _id: '0001193125-26-323082:primary_doc.xml', _source: { adsh: '0001193125-26-323082' } },
          { _id: '0001193125-26-323082:exhibit.htm', _source: { adsh: '0001193125-26-323082' } },
        ],
      },
    });
  const res = await request(app).get('/api/search-nport?security=dedupe-name');
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.body.hits.hits.map(h => h._source.adsh),
    ['0001193125-26-323081', '0001193125-26-323082']
  );
  assert.equal(res.body.hits.total.value, 2, 'every page was read, so the total is the unique filing count');
  assert.equal(res.body.hits.total.relation, 'eq');
});

test('search-nport: filings that match only in an attachment (not primary_doc.xml) are dropped', async () => {
  // Real pattern: a trust's shared schedule of investments (e.g. NYLIMFunds1031.htm,
  // FSS.htm) names sibling funds' holdings; the filing itself has no row.
  nock(EFTS)
    .get('/LATEST/search-index')
    .query(true)
    .once()
    .reply(200, {
      hits: {
        total: { value: 3, relation: 'eq' },
        hits: [
          { _id: '0000787441-26-000001:NYLIMFunds1031.htm', _source: { adsh: '0000787441-26-000001' } },
          { _id: '0000787441-26-000002:primary_doc.xml', _source: { adsh: '0000787441-26-000002' } },
          { _id: '0000787441-26-000002:NYLIMFunds1031.htm', _source: { adsh: '0000787441-26-000002' } },
        ],
      },
    });
  const res = await request(app).get('/api/search-nport?security=attachment-only');
  assert.deepEqual(
    res.body.hits.hits.map(h => h._source.adsh),
    ['0000787441-26-000002']
  );
  assert.equal(res.body.hits.total.value, 1);
});

test('search-nport: multi-word names are sent to EFTS as an exact phrase; single words and quoted input unchanged', async () => {
  const seenQ = [];
  nock(EFTS)
    .get('/LATEST/search-index')
    .query(q => {
      seenQ.push(q.q);
      return true;
    })
    .times(3)
    .reply(200, { hits: { hits: [] } });
  await request(app).get('/api/search-nport?security=' + encodeURIComponent('Redwood Materials'));
  await request(app).get('/api/search-nport?security=Anduril');
  await request(app).get('/api/search-nport?security=' + encodeURIComponent('"Vast Data"'));
  assert.deepEqual(seenQ, ['"Redwood Materials"', 'Anduril', '"Vast Data"']);
});

// EFTS ranks by relevance, so over the 1,000-hit cap the first 1,000 were an
// arbitrary slice of years (real: "Epic Games" skipped three 2026-05-26
// Fidelity filings while its "100 most recent" reached back to 2026-01-23).
test('search-nport: over the hit cap, reads newest-first date windows instead of a relevance slice', async () => {
  const windows = [];
  let n = 0;
  nock(EFTS)
    .get('/LATEST/search-index')
    .query(true)
    .times(20)
    .reply(uri => {
      const q = new URL(uri, EFTS).searchParams;
      if (!q.get('startdt')) {
        // Unwindowed probe: EDGAR reports far more than the cap.
        return [200, { hits: { total: { value: 10000, relation: 'gte' }, hits: [{ _id: 'relevance-only' }] } }];
      }
      windows.push([q.get('startdt'), q.get('enddt')]);
      const hits = Array.from({ length: 100 }, () => {
        n++;
        return { _id: `doc-${n}`, _source: { adsh: `adsh-${n}`, file_date: q.get('enddt') } };
      });
      return [200, { hits: { total: { value: 100, relation: 'eq' }, hits } }];
    });
  const res = await request(app).get('/api/search-nport?security=over-cap-name');
  assert.equal(res.status, 200);
  assert.equal(res.body.newestFirst, true);
  assert.equal(res.body.hits.hits.length, 1000, 'stops at the cap');
  assert.ok(!res.body.hits.hits.some(h => h._id === 'relevance-only'), 'the relevance-ranked probe is not kept');
  assert.equal(windows.length, 10);
  for (let i = 1; i < windows.length; i++) {
    assert.ok(windows[i][1] < windows[i - 1][0], 'each window ends before the previous (newer) one starts');
  }
  assert.equal(res.body.hits.total.value, 10000, "EDGAR's own total is kept when not every match was read");
});

test('search-nport: a date window that is itself over the cap is split before reading', async () => {
  const spans = [];
  nock(EFTS)
    .get('/LATEST/search-index')
    .query(true)
    .times(50) // probe + (over-cap window, halved window) per 50 docs until the 1,000 cap
    .reply(uri => {
      const q = new URL(uri, EFTS).searchParams;
      if (!q.get('startdt')) return [200, { hits: { total: { value: 1500, relation: 'eq' }, hits: [] } }];
      const days = (new Date(q.get('enddt')) - new Date(q.get('startdt'))) / 86400000 + 1;
      spans.push(days);
      if (days > 46) return [200, { hits: { total: { value: 1500, relation: 'eq' }, hits: [] } }];
      const hits = Array.from({ length: 50 }, (_, i) => ({
        _id: `${q.get('enddt')}-${i}`,
        _source: { adsh: `${q.get('enddt')}-${i}` },
      }));
      return [200, { hits: { total: { value: 50, relation: 'eq' }, hits } }];
    });
  const res = await request(app).get('/api/search-nport?security=split-window-name');
  assert.equal(res.status, 200);
  assert.equal(spans[0], 92, 'first window is a quarter');
  assert.equal(spans[1], 46, 'an over-cap window is halved and re-queried');
  assert.equal(spans[2], 92, 'the next window starts at a full quarter again');
  assert.equal(res.body.hits.hits.length, 1000, 'reads split windows until the cap');
});

test('search-nport: a result set that fits one page makes exactly one EFTS call', async () => {
  nock(EFTS)
    .get('/LATEST/search-index')
    .query(true)
    .once()
    .reply(200, { hits: { total: { value: 3 }, hits: [{ _id: 'a' }, { _id: 'b' }, { _id: 'c' }] } });
  const res = await request(app).get('/api/search-nport?security=one-page');
  assert.equal(res.body.hits.hits.length, 3);
  assert.ok(nock.isDone());
});

test('refresh: only refresh=1/true bypasses the cache — refresh=0 is served from cache', async () => {
  nock(EFTS)
    .get('/LATEST/search-index')
    .query(true)
    .once()
    .reply(200, { hits: { hits: [] } });
  await request(app).get('/api/search-nport?security=strict-refresh');
  const zero = await request(app).get('/api/search-nport?security=strict-refresh&refresh=0');
  assert.equal(zero.body.cached, true);
  const junk = await request(app).get('/api/search-nport?security=strict-refresh&refresh=please');
  assert.equal(junk.body.cached, true);
});

test('cik/accession are validated before they reach an SEC URL', async () => {
  const bad = [
    '/api/parse-nport?cik=..&accession=000000000000000009&security=x',
    '/api/parse-nport?cik=123abc&accession=000000000000000009&security=x',
    '/api/parse-nport?cik=900&accession=..%2F..%2Fetc&security=x',
    '/api/parse-10q?cik=900&accession=12345&issuer=x',
    '/api/fund-xray?cik=%2F..&accession=000000000000000009',
    '/api/fund-xray-compare?cik=900&currentAccession=abc&priorAccession=000000000000000009',
    '/api/fund-xray-returns?cik=900&accessions=000000000000000001,nope',
  ];
  for (const url of bad) {
    const res = await request(app).get(url);
    assert.equal(res.status, 400, url);
  }
});

test('upstream HTTP-client errors reach the client as a status summary, not internal detail', async () => {
  nock(SEC).get('/Archives/edgar/data/902/000000000000000004/primary_doc.xml').reply(404, 'nope');
  const res = await request(app).get('/api/fund-xray?cik=902&accession=000000000000000004');
  assert.equal(res.body.success, false);
  assert.equal(res.body.error, 'SEC request failed (HTTP 404)');
});

test('security headers: CSP pins script origins, framing and MIME sniffing are blocked', async () => {
  // v1's page alone allows inline handlers; everything else (the workspace, the API) allows scripts from self only (F01)
  const legacy = (await request(app).get('/legacy')).headers['content-security-policy'] || '';
  assert.match(legacy, /script-src 'self' 'unsafe-inline' https:\/\/cdn\.jsdelivr\.net https:\/\/cdn\.sheetjs\.com/);
  const api = (await request(app).get('/peer.js')).headers['content-security-policy'] || '';
  assert.match(api, /script-src 'self';/);
  const res = await request(app).get('/');
  const csp = res.headers['content-security-policy'] || '';
  const built = fs.existsSync(path.join(__dirname, '..', 'web', 'dist', 'index.html'));
  assert.match(csp, built ? /script-src 'self';/ : /script-src 'self' 'unsafe-inline'/);
  assert.match(csp, /connect-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['x-powered-by'], undefined);
});

test('every CDN script in index.html is SRI-pinned and allowed by the CSP', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const tags = html.match(/<script[^>]+src="https:[^"]+"[^>]*>/g) || [];
  assert.ok(tags.length >= 5);
  for (const tag of tags) {
    assert.match(tag, /integrity="sha384-[A-Za-z0-9+/=]+"/, tag);
    assert.match(tag, /crossorigin="anonymous"/, tag);
    assert.match(tag, /src="https:\/\/(cdn\.jsdelivr\.net|cdn\.sheetjs\.com)\//, tag);
  }
});
