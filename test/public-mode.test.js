// P9 W1: the public site (VANTAGE_PUBLIC=1). Visitors never cause an SEC
// request: every route answers from the warehouse (v1's live per-filing routes
// were removed; git tag v1-archive). Health routes, the config a tab compares
// builds with, and the smoke check against this server. Node runs each test file
// in its own process, so the environment is set before server.js loads. Public
// mode off is pinned in test/server.test.js.
process.env.VANTAGE_PUBLIC = '1';
process.env.APP_BUILD = 'test-build-1';
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

test('no route calls the SEC: the former live routes are gone, and nothing reaches the network', async () => {
  for (const url of ['/api/search-nport?q=Anthropic', '/api/parse-10q?cik=1&accession=0', '/api/fund-xray?cik=1']) {
    await request(app).get(url).expect(404);
  }
  assert.ok(nock.isDone(), 'no outbound request was attempted');
});

test("v1's page is gone; the workspace routes and warehouse API still answer", async () => {
  for (const url of ['/legacy', '/index.html', '/app.js']) await request(app).get(url).expect(404);
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
  const report = await request(app).get('/readyz?report=1').expect(200);
  assert.deepEqual([report.body.ready, report.body.fresh], [false, false], 'same body, always 200');
});

test('paths are case-sensitive (review H2): /API/... is a 404, never the API under a spelling the limits miss', async () => {
  await request(app).get('/api/search?q=anthropic').expect(503); // the real route (no warehouse here)
  for (const url of ['/API/search?q=anthropic', '/Api/Analysis/Pivot', '/api/Analysis/pivot', '/API/admin/companies'])
    await request(app).get(url).set('Accept', 'application/json').expect(404);
  await request(app).post('/API/admin/companies').send({}).expect(404);
});

test('health details only from this machine (review L10); ok and the build for anyone', async () => {
  const local = await request(app).get('/healthz').expect(200);
  assert.ok(Number.isFinite(local.body.rssMB), 'loopback sees the details');
  app.set('trust proxy', 1); // as on the server behind Caddy
  try {
    const remote = await request(app).get('/healthz').set('X-Forwarded-For', '203.0.113.9').expect(200);
    assert.deepEqual(remote.body, { ok: true, build: 'test-build-1' });
    // the loopback listener's smoke and load checks come through Caddy as 127.0.0.1
    const smoke = await request(app).get('/healthz').set('X-Forwarded-For', '127.0.0.1').expect(200);
    assert.ok(Number.isFinite(smoke.body.loopMaxMs));
  } finally {
    app.set('trust proxy', false);
  }
});

test('static files are served from the app folder whatever the working directory (og.png for link previews)', async () => {
  const og = await request(app).get('/og.png').expect(200);
  assert.equal(og.headers['content-type'], 'image/png');
  assert.equal(og.body.length, fs.statSync(path.join(__dirname, '..', 'public', 'og.png')).size);
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
  assert.equal(by['v1 page gone'].ok, true);
  assert.equal(by['no live SEC route /api/search-nport'].ok, true);
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
