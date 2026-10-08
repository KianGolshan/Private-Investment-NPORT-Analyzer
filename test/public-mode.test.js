// P9 W1: the public site (VANTAGE_PUBLIC=1). Visitors never cause an SEC
// request: v1's live per-filing routes answer 410 without a fetch, and its page
// is off. Health routes, the config a tab compares builds with, and the smoke
// check against this server. Node runs each test file in its own process, so the
// environment is set before server.js loads. Public mode off is pinned in
// test/server.test.js (the live routes keep working there).
process.env.VANTAGE_PUBLIC = '1';
process.env.APP_BUILD = 'test-build-1';
process.env.CACHE_DB_PATH = ':memory:';
process.env.SEC_MIN_INTERVAL_MS = '0';
process.env.SEC_USER_AGENT = 'Test Suite test@example.com';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const nock = require('nock');
const request = require('supertest');
const { tmpDir } = require('./helpers/tmp');

// no warehouse at this path: /readyz must say so
process.env.WAREHOUSE_DB_PATH = path.join(tmpDir('ro'), 'missing.db');
// loaded from another working directory, as a service or the e2e server (web/) runs it
const CWD = process.cwd();
process.chdir(tmpDir('ro'));
const app = require('../server');
process.chdir(CWD);
const { runSmoke } = require('../scripts/smoke');

test.beforeEach(() => {
  nock.cleanAll();
  nock.disableNetConnect();
  nock.enableNetConnect(/127\.0\.0\.1/);
});
test.after(() => nock.enableNetConnect());

const LIVE = [
  '/api/search-nport?q=Anthropic',
  '/api/parse-nport?cik=44201&accession=0001193125-26-182055',
  '/api/search-10q?q=West%20Star',
  '/api/parse-10q?cik=1&accession=000000000000000000',
  '/api/search-fund?q=Growth%20Fund',
  '/api/fund-series?cik=44201',
  '/api/fund-series-filings?cik=44201&seriesId=S000009228',
  '/api/fund-xray?cik=44201&accession=0001193125-26-182055',
  '/api/fund-xray-compare?cik=44201&current=0001193125-26-182055&prior=0001193125-26-182055',
  '/api/fund-xray-returns?cik=44201&accessions=0001193125-26-182055',
  '/api/search-nport/', // a trailing slash is the same route
];

test('every live per-filing route answers 410 on the public site, without an SEC request', async () => {
  for (const url of LIVE) {
    const r = await request(app).get(url).expect(410);
    assert.match(r.body.error, /Live SEC lookups are off on the public site/, url);
    assert.equal(r.headers['cache-control'], 'no-store', url);
  }
  assert.ok(nock.isDone(), 'no outbound request was attempted');
  // ?refresh=1 cannot get around it
  await request(app).get('/api/search-nport?q=Anthropic&refresh=1').expect(410);
});

test("v1's page and its index are off; the workspace routes and warehouse API still answer", async () => {
  for (const url of ['/legacy', '/index.html']) {
    const r = await request(app).get(url).expect(410);
    assert.match(r.text, /not part of the public site/);
    assert.match(r.headers['content-security-policy'], /default-src 'self'/);
  }
  // no warehouse here: the warehouse routes say 503, never a live fallback
  await request(app).get('/api/search?q=anthropic').expect(503);
  // the workspace's HTML (built or not) is never v1's page in public mode
  const home = await request(app).get('/');
  assert.ok(home.status === 503 || (home.status === 200 && !/id="tab-/.test(home.text)), `home ${home.status}`);
  if (fs.existsSync(path.join(__dirname, '..', 'web', 'dist', 'index.html'))) assert.equal(home.status, 200);
});

test('config says public and the build; health and readiness are not rate-limited or cached', async () => {
  const c = await request(app).get('/api/config').expect(200);
  assert.deepEqual([c.body.public, c.body.build, c.body.admin], [true, 'test-build-1', false]);
  assert.equal(c.headers['cache-control'], 'no-store');
  const h = await request(app).get('/healthz').expect(200);
  assert.equal(h.body.ok, true);
  assert.equal(h.body.build, 'test-build-1');
  for (const k of ['uptimeS', 'rssMB', 'loopP99Ms', 'loopMaxMs']) assert.ok(Number.isFinite(h.body[k]), k);
  assert.equal(h.headers['cache-control'], 'no-store');
  assert.equal(h.headers['ratelimit-limit'], undefined, 'outside the API rate limit');
  const r = await request(app).get('/readyz').expect(503);
  assert.deepEqual([r.body.ready, r.body.fresh], [false, false]);
  assert.match(r.body.reason, /warehouse unavailable/);
  await request(app).get('/readyz?fresh=1').expect(503);
});

test('static files are served from the app folder whatever the working directory (og.png for link previews)', async () => {
  const og = await request(app).get('/og.png').expect(200);
  assert.equal(og.headers['content-type'], 'image/png');
  assert.equal(og.body.length, fs.statSync(path.join(__dirname, '..', 'public', 'og.png')).size);
  await request(app).get('/splits.js').expect(200);
});

test('admin is refused on the public site', async () => {
  await request(app).post('/api/admin/companies').send({}).expect(403);
});

// The smoke check against this server: the safety checks pass and the goldens
// fail (no warehouse), so the run fails. A fake fetch routes to the app.
function appFetch() {
  return async (url, init = {}) => {
    const u = new URL(url);
    let req = request(app)[(init.method || 'GET').toLowerCase()](u.pathname + u.search);
    for (const [k, v] of Object.entries(init.headers || {})) req = req.set(k, v);
    const r = await (init.body ? req.send(init.body) : req);
    return new Response(r.status === 304 || r.status === 204 ? null : (r.text ?? JSON.stringify(r.body)), {
      status: r.status,
      headers: r.headers,
    });
  };
}

test('smoke: the safety checks pass here; missing goldens and readiness fail the run', async () => {
  const s = await runSmoke('http://vantage.test', { fetchImpl: appFetch() });
  const by = Object.fromEntries(s.checks.map(c => [c.name, c]));
  assert.equal(s.ok, false);
  assert.equal(by.healthz.ok, true);
  assert.equal(by.readyz.ok, false);
  assert.equal(by['security headers'].ok, true);
  assert.equal(by['admin refused'].ok, true);
  assert.equal(by['public mode'].ok, true);
  assert.equal(by['v1 page off'].ok, true);
  assert.equal(by['live route off /api/search-nport'].ok, true);
  assert.equal(by['A1 Anthropic 2026-03-31'].ok, false);
  assert.match(by['A1 Anthropic 2026-03-31'].detail, /status 503/);
  // a site that is not public (--no-public) skips the public checks
  const local = await runSmoke('http://vantage.test', { fetchImpl: appFetch(), publicSite: false });
  assert.equal(
    local.checks.some(c => c.name === 'public mode'),
    false
  );
  // an unreachable site fails every check, never throws
  const down = await runSmoke('http://vantage.test', {
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  assert.equal(down.ok, false);
  assert.ok(down.checks.every(c => !c.ok && /ECONNREFUSED/.test(c.detail)));
});
