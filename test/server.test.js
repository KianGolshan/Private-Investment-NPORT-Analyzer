// Integration tests for the Express routes in server.js — request
// validation, the search/parse pipeline end-to-end (route -> cache ->
// SEC fetch -> parsers.js), cache-hit behavior, and 429-retry.
//
// Network calls to SEC are intercepted with nock (real fixtures from
// test/fixtures/, same ones parsers.test.js uses) rather than hitting the
// network — this suite is about the routing/caching/retry layer, which
// parsers.test.js deliberately doesn't cover since it tests the pure
// extraction functions in isolation.
//
// Node's test runner (`node --test`) runs each matched file in its own
// process, so it's safe to set env vars here before requiring server.js:
// this file's process gets its own isolated in-memory cache
// (CACHE_DB_PATH=':memory:') and a configured SEC_USER_AGENT, without
// touching the real cache.db or any other test file's env.
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

const FIXTURES = path.join(__dirname, 'fixtures');
const spacexXml = fs.readFileSync(path.join(FIXTURES, 'nport_spacex_primary_doc.xml'), 'utf8');
const westStarHtml = fs.readFileSync(path.join(FIXTURES, 'bdc_10q_west_star_aviation.html'), 'utf8');

const EFTS = 'https://efts.sec.gov';
const SEC = 'https://www.sec.gov';
const DATA_SEC = 'https://data.sec.gov';

test.beforeEach(() => {
  nock.cleanAll();
  // supertest boots the app on a real ephemeral localhost port and talks to
  // it over actual HTTP — only outbound calls to SEC's hosts should be
  // blocked/intercepted, not the test's own request to the app itself.
  nock.disableNetConnect();
  nock.enableNetConnect(/127\.0\.0\.1/);
});
test.after(() => {
  nock.enableNetConnect();
});

// ── /api/config ──────────────────────────────────────────────────────────

test('GET /api/config reflects whether SEC_USER_AGENT is configured', async () => {
  const res = await request(app).get('/api/config');
  assert.equal(res.status, 200);
  assert.equal(res.body.userAgentConfigured, true);
});

// ── /api/search-nport ────────────────────────────────────────────────────

test('GET /api/search-nport: 400 when security is missing', async () => {
  const res = await request(app).get('/api/search-nport');
  assert.equal(res.status, 400);
  assert.match(res.body.error, /security/);
});

test('GET /api/search-nport: fetches from SEC, then serves the second identical request from cache', async () => {
  const scope = nock(EFTS)
    .get('/LATEST/search-index')
    .query(q => q.q === 'SpaceX' && q.forms === 'NPORT-P')
    .reply(200, { hits: { hits: [{ _source: { adsh: '0000000000-00-000000' } }] } });

  const first = await request(app).get('/api/search-nport?security=SpaceX');
  assert.equal(first.status, 200);
  assert.equal(first.body.cached, false);
  assert.equal(first.body.hits.hits.length, 1);
  assert.ok(scope.isDone(), 'first request should have hit SEC');

  // No second nock interceptor is registered — if the route re-hit the
  // network instead of the cache, this would fail with "no match".
  const second = await request(app).get('/api/search-nport?security=SpaceX');
  assert.equal(second.status, 200);
  assert.equal(second.body.cached, true);
  assert.deepEqual(second.body.hits, first.body.hits);
});

test('GET /api/search-nport: retries a 429 with backoff and still succeeds', async () => {
  const scope = nock(EFTS)
    .get('/LATEST/search-index')
    .query(true)
    .reply(429)
    .get('/LATEST/search-index')
    .query(true)
    .reply(200, { hits: { hits: [] } });

  const res = await request(app).get('/api/search-nport?security=RetryTest');
  assert.equal(res.status, 200);
  assert.equal(res.body.cached, false);
  assert.ok(scope.isDone(), 'both the failing and the retried request should have been consumed');
});

test('GET /api/search-nport: upstream error surfaces as a 500 with a message', async () => {
  nock(EFTS).get('/LATEST/search-index').query(true).reply(500);

  const res = await request(app).get('/api/search-nport?security=ErrorTest');
  assert.equal(res.status, 500);
  assert.ok(res.body.error);
});

// ── /api/parse-nport ─────────────────────────────────────────────────────

test('GET /api/parse-nport: 400 when required params are missing', async () => {
  const res = await request(app).get('/api/parse-nport?cik=123');
  assert.equal(res.status, 400);
});

test('GET /api/parse-nport: fetches and parses a real filing end-to-end, then caches it', async () => {
  const scope = nock(SEC)
    .get('/Archives/edgar/data/2043954/000089418926024397/primary_doc.xml')
    .reply(200, spacexXml, { 'Content-Type': 'application/xml' });

  const first = await request(app).get('/api/parse-nport?cik=2043954&accession=0000894189-26-024397&security=SpaceX');
  assert.equal(first.status, 200);
  assert.equal(first.body.success, true);
  assert.equal(first.body.cached, false);
  const h = first.body.holdings.find(x => x.name === 'SPACEX');
  assert.ok(h, 'expected a SPACEX holding, same fixture parsers.test.js verifies against');
  assert.equal(h.ticker, 'SPCX');
  assert.notEqual(h.ticker, '[object Object]');
  assert.ok(scope.isDone());

  // Same (cik, accession, security) is one immutable filing — served from
  // cache without a second SEC fetch (no interceptor registered for it).
  const second = await request(app).get('/api/parse-nport?cik=2043954&accession=0000894189-26-024397&security=SpaceX');
  assert.equal(second.status, 200);
  assert.equal(second.body.cached, true);
  assert.deepEqual(second.body.holdings, first.body.holdings);
});

test('GET /api/parse-nport: a fetch failure is reported as success:false, not a thrown error', async () => {
  nock(SEC).get('/Archives/edgar/data/999/000000000000000001/primary_doc.xml').reply(404);

  const res = await request(app).get('/api/parse-nport?cik=999&accession=0000000000-00-000001&security=Nothing');
  assert.equal(res.status, 200);
  assert.equal(res.body.success, false);
  assert.ok(res.body.error);
});

// ── /api/search-10q ───────────────────────────────────────────────────────

test('GET /api/search-10q: 400 when issuer is missing', async () => {
  const res = await request(app).get('/api/search-10q');
  assert.equal(res.status, 400);
});

test('GET /api/search-10q: identifies BDC funds via 814- file numbers and pulls their filing history', async () => {
  nock(EFTS)
    .get('/LATEST/search-index')
    .query(q => q.forms === '10-Q')
    .reply(200, {
      hits: {
        hits: [
          {
            _source: {
              file_num: ['814-01234'],
              ciks: ['0001974793'],
              display_names: ['Oaktree Gardens OLP, LLC (OGO)'],
              adsh: '0001974793-26-000004',
              period_ending: '2025-12-31',
              file_date: '2026-02-15',
            },
          },
        ],
      },
    });

  nock(DATA_SEC)
    .get('/submissions/CIK0001974793.json')
    .reply(200, {
      filings: {
        recent: {
          form: ['10-Q', '8-K'],
          accessionNumber: ['0001974793-26-000004', '0001974793-26-000003'],
          filingDate: ['2026-02-15', '2026-01-01'],
          reportDate: ['2025-12-31', ''],
          primaryDocument: ['olp-20251231.htm', 'other.htm'],
        },
        files: [],
      },
    });

  const res = await request(app).get('/api/search-10q?issuer=West Star Aviation');
  assert.equal(res.status, 200);
  assert.equal(res.body.cached, false);
  assert.equal(res.body.confirmed, 1);
  assert.deepEqual(res.body.bdcFunds, ['Oaktree Gardens OLP, LLC']);
  // The confirmed EFTS hit and the matching submissions-history entry share
  // the same accession — must be deduplicated, not listed twice.
  assert.equal(res.body.filings.filter(f => f.accession === '0001974793-26-000004').length, 1);
  // The 8-K in the same submissions history must be excluded (10-Q only).
  assert.ok(!res.body.filings.some(f => f.accession === '0001974793-26-000003'));
});

// ── /api/parse-10q ────────────────────────────────────────────────────────

test('GET /api/parse-10q: 400 when required params are missing', async () => {
  const res = await request(app).get('/api/parse-10q?cik=123');
  assert.equal(res.status, 400);
});

test('GET /api/parse-10q: locates the primary doc via submissions API, fetches and parses it, then caches it', async () => {
  const cik = '1974793';
  const accession = '0001974793-26-000004';

  const submissionsScope = nock(DATA_SEC)
    .get('/submissions/CIK0001974793.json')
    .reply(200, {
      filings: {
        recent: {
          form: ['10-Q'],
          accessionNumber: [accession],
          filingDate: ['2026-02-15'],
          reportDate: ['2025-12-31'],
          primaryDocument: ['olp-20251231.htm'],
        },
        files: [],
      },
    });

  const docScope = nock(SEC)
    .get('/Archives/edgar/data/1974793/000197479326000004/olp-20251231.htm')
    .reply(200, westStarHtml, { 'Content-Type': 'text/html' });

  const first = await request(app).get(
    `/api/parse-10q?cik=${cik}&accession=${accession}&issuer=West Star Aviation&reportDate=2025-12-31`
  );
  assert.equal(first.status, 200);
  assert.equal(first.body.success, true);
  assert.equal(first.body.cached, false);
  assert.equal(first.body.holdings.length, 5, 'same fixture parsers.test.js verifies has 5 tranches');
  assert.ok(submissionsScope.isDone());
  assert.ok(docScope.isDone());

  // Immutable filing — second identical request must be served from cache
  // (no second interceptor registered for either upstream call).
  const second = await request(app).get(
    `/api/parse-10q?cik=${cik}&accession=${accession}&issuer=West Star Aviation&reportDate=2025-12-31`
  );
  assert.equal(second.status, 200);
  assert.equal(second.body.cached, true);
  assert.deepEqual(second.body.holdings, first.body.holdings);
});

test('GET /api/parse-10q: reports success:false when the primary doc cannot be located', async () => {
  nock(DATA_SEC)
    .get('/submissions/CIK0000000002.json')
    .reply(200, { filings: { recent: {}, files: [] } });

  const res = await request(app).get('/api/parse-10q?cik=2&accession=0000000000-00-000002&issuer=Nothing');
  assert.equal(res.status, 200);
  assert.equal(res.body.success, false);
  assert.match(res.body.error, /Could not locate/);
});

// ── Unknown routes ──────────────────────────────────────────────────────

test('GET /api/does-not-exist: 404', async () => {
  const res = await request(app).get('/api/does-not-exist');
  assert.equal(res.status, 404);
});
