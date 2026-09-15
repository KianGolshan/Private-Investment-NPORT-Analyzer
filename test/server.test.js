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

// ── /api/search-fund ─────────────────────────────────────────────────────
// Resolves a fund by its EDGAR company-name lookup (browse-edgar), not
// full-text search — full-text search matches filing *content*, so a fund
// name mostly surfaces unrelated funds-of-funds that merely mention it as
// one of their own holdings, burying the actual fund (a real bug found live
// against "SMALLCAP World Fund": 10,000+ full-text hits, 97% irrelevant).

test('GET /api/search-fund: 400 when fund is missing', async () => {
  const res = await request(app).get('/api/search-fund');
  assert.equal(res.status, 400);
  assert.match(res.body.error, /fund/);
});

test('GET /api/search-fund: unambiguous name — resolves via company-info in the atom feed itself, then serves the second identical request from cache', async () => {
  const atomFeed = `<?xml version="1.0" encoding="ISO-8859-1" ?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <company-info>
        <cik>0002043954</cik>
        <conformed-name>REX ETF Trust</conformed-name>
      </company-info>
      <entry><content type="text/xml">
        <accession-number>0000894189-26-024397</accession-number>
        <filing-date>2026-07-15</filing-date>
        <filing-type>NPORT-P</filing-type>
      </content></entry>
    </feed>`;
  const browseScope = nock(SEC)
    .get('/cgi-bin/browse-edgar')
    .query(q => q.company === 'REX ETF Trust' && q.type === 'NPORT-P')
    .reply(200, atomFeed, { 'Content-Type': 'application/atom+xml' });

  const subScope = nock(DATA_SEC)
    .get('/submissions/CIK0002043954.json')
    .reply(200, {
      name: 'REX ETF Trust',
      filings: {
        recent: {
          form: ['NPORT-P', '485BPOS'],
          accessionNumber: ['0000894189-26-024397', '0000894189-26-000001'],
          filingDate: ['2026-07-15', '2026-01-01'],
          reportDate: ['2026-06-30', ''],
        },
        files: [],
      },
    });

  const first = await request(app).get('/api/search-fund?fund=REX ETF Trust');
  assert.equal(first.status, 200);
  assert.equal(first.body.cached, false);
  assert.equal(first.body.matches.length, 1);
  assert.equal(first.body.matches[0].cik, '2043954');
  assert.equal(first.body.matches[0].name, 'REX ETF Trust');
  // The 485BPOS in the same submissions history must be excluded (NPORT-P only).
  assert.equal(first.body.matches[0].filings.length, 1);
  assert.equal(first.body.matches[0].filings[0].accession, '0000894189-26-024397');
  assert.ok(browseScope.isDone());
  assert.ok(subScope.isDone());

  // No second interceptor registered for either upstream call — a cache hit
  // proves neither was re-fetched.
  const second = await request(app).get('/api/search-fund?fund=REX ETF Trust');
  assert.equal(second.status, 200);
  assert.equal(second.body.cached, true);
  assert.deepEqual(second.body.matches, first.body.matches);
});

test('GET /api/search-fund: a filing-heavy registrant\'s older NPORT-P filings (pushed out of "recent" by other form types) are recovered via files pagination', async () => {
  // Regression test for a real bug found live: the submissions API's
  // "recent" block is capped across a filer's TOTAL submission volume
  // (every form type combined), not just NPORT-P — so a filing-heavy
  // multi-series trust can have its own older NPORT-P filings pushed out of
  // "recent" entirely. Confirmed against the real American Funds Insurance
  // Series (CIK 729528): a "recent"-only read returned NPORT-P history
  // truncated to 2022+, silently missing 2019-2021 — fetchFundNportHistory
  // must paginate into "files" (via fetchSubmissionsAllPages, the same
  // helper the Private Credit flow already relies on) to recover them.
  const atomFeed = `<?xml version="1.0" encoding="ISO-8859-1" ?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <company-info>
        <cik>0000729528</cik>
        <conformed-name>AMERICAN FUNDS INSURANCE SERIES</conformed-name>
      </company-info>
      <entry><content type="text/xml">
        <accession-number>0001193125-26-100000</accession-number>
        <filing-date>2026-05-28</filing-date>
        <filing-type>NPORT-P</filing-type>
      </content></entry>
    </feed>`;
  nock(SEC)
    .get('/cgi-bin/browse-edgar')
    .query(q => q.company === 'American Funds Insurance Series')
    .reply(200, atomFeed, { 'Content-Type': 'application/atom+xml' });

  // "recent" only reaches back to 2022 — thousands of other-form-type
  // filings for this trust have pushed 2019-2021 NPORT-P filings onto an
  // older page.
  nock(DATA_SEC)
    .get('/submissions/CIK0000729528.json')
    .reply(200, {
      name: 'AMERICAN FUNDS INSURANCE SERIES',
      filings: {
        recent: {
          form: ['NPORT-P'],
          accessionNumber: ['0001193125-26-100000'],
          filingDate: ['2026-05-28'],
          reportDate: ['2026-03-31'],
        },
        files: [{ name: 'CIK0000729528-submissions-001.json' }],
      },
    });
  nock(DATA_SEC)
    .get('/submissions/CIK0000729528-submissions-001.json')
    .reply(200, {
      form: ['NPORT-P', '485BPOS'],
      accessionNumber: ['0001145549-19-047688', '0001145549-19-000001'],
      filingDate: ['2019-11-27', '2019-01-01'],
      reportDate: ['2019-09-30', ''],
    });

  const res = await request(app).get('/api/search-fund?fund=American Funds Insurance Series');
  assert.equal(res.status, 200);
  assert.equal(res.body.matches.length, 1);
  const filings = res.body.matches[0].filings;
  assert.equal(filings.length, 2, 'both the recent 2026 filing and the paginated 2019 filing must be present');
  assert.ok(
    filings.some(f => f.accession === '0001145549-19-047688' && f.reportDate === '2019-09-30'),
    'the older, paginated-in filing must not be dropped'
  );
});

test('GET /api/search-fund: ambiguous name — recovers CIKs from the buggy multi-match atom feed, then a clean name per CIK', async () => {
  // Real SEC behavior for an ambiguous company-name prefix: no top-level
  // company-info, and each candidate's own company-info has an
  // unserializable name ("ARRAY(0x...)") — only its <cik> can be trusted.
  const atomFeed = `<?xml version="1.0" encoding="ISO-8859-1" ?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <entry title="ARRAY(0xdeadbeef)"><content type="text/xml">
        <company-info name="ARRAY(0xdeadbeef)"><cik>0000111111</cik></company-info>
      </content></entry>
    </feed>`;
  nock(SEC)
    .get('/cgi-bin/browse-edgar')
    .query(q => q.company === 'Ambiguous Fund')
    .reply(200, atomFeed, { 'Content-Type': 'application/atom+xml' });

  nock(DATA_SEC)
    .get('/submissions/CIK0000111111.json')
    .reply(200, {
      name: 'Ambiguous Fund Series A',
      filings: {
        recent: {
          form: ['NPORT-P'],
          accessionNumber: ['0001111111-26-000001'],
          filingDate: ['2026-05-01'],
          reportDate: ['2026-03-31'],
        },
        files: [],
      },
    });

  const res = await request(app).get('/api/search-fund?fund=Ambiguous Fund');
  assert.equal(res.status, 200);
  assert.equal(res.body.matches.length, 1);
  assert.equal(res.body.matches[0].cik, '111111');
  assert.equal(res.body.matches[0].name, 'Ambiguous Fund Series A');
});

test('GET /api/search-fund: no company match — returns an empty match list, not an error', async () => {
  nock(SEC)
    .get('/cgi-bin/browse-edgar')
    .query(q => q.company === 'TotallyFakeFundXYZ')
    .reply(
      200,
      `<?xml version="1.0" encoding="ISO-8859-1" ?><feed xmlns="http://www.w3.org/2005/Atom"></feed>`,
      { 'Content-Type': 'application/atom+xml' }
    );

  const res = await request(app).get('/api/search-fund?fund=TotallyFakeFundXYZ');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.matches, []);
});

// ── /api/fund-xray ───────────────────────────────────────────────────────

test('GET /api/fund-xray: 400 when required params are missing', async () => {
  const res = await request(app).get('/api/fund-xray?cik=123');
  assert.equal(res.status, 400);
});

test('GET /api/fund-xray: fetches and parses a real filing end-to-end, then caches it', async () => {
  const scope = nock(SEC)
    .get('/Archives/edgar/data/2043954/000089418926024397/primary_doc.xml')
    .reply(200, spacexXml, { 'Content-Type': 'application/xml' });

  const first = await request(app).get('/api/fund-xray?cik=2043954&accession=0000894189-26-024397');
  assert.equal(first.status, 200);
  assert.equal(first.body.success, true);
  assert.equal(first.body.cached, false);
  // Same fixture parsers.test.js verifies as a fully public book (every
  // holding fairValLevel 1) — zero private exposure, not a thrown error.
  assert.equal(first.body.xray.privateHoldingsCount, 0);
  assert.ok(first.body.xray.totalHoldingsCount > 20);
  assert.equal(first.body.xray.fund.registrantName, 'REX ETF Trust');
  assert.ok(scope.isDone());

  // Same (cik, accession) is one immutable filing — served from cache
  // without a second SEC fetch (no interceptor registered for it).
  const second = await request(app).get('/api/fund-xray?cik=2043954&accession=0000894189-26-024397');
  assert.equal(second.status, 200);
  assert.equal(second.body.cached, true);
  assert.deepEqual(second.body.xray, first.body.xray);
});

test('GET /api/fund-xray: a fetch failure is reported as success:false, not a thrown error', async () => {
  nock(SEC).get('/Archives/edgar/data/999/000000000000000002/primary_doc.xml').reply(404);

  const res = await request(app).get('/api/fund-xray?cik=999&accession=0000000000-00-000002');
  assert.equal(res.status, 200);
  assert.equal(res.body.success, false);
  assert.ok(res.body.error);
});

// ── Unknown routes ──────────────────────────────────────────────────────

test('GET /api/does-not-exist: 404', async () => {
  const res = await request(app).get('/api/does-not-exist');
  assert.equal(res.status, 404);
});
