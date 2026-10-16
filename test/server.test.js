// Integration tests for server.js itself (config, unknown routes, public-mode
// flag) and for the paced SEC client the nightly job uses (lib/edgar.js through
// lib/warehouse/delta.js secGet): throttling is retried, a persistent upstream
// error still fails. v1's per-filing routes and their tests were removed from
// the live project (kept at the git tag v1-archive).
//
// Node's test runner runs each file in its own process, so the env set here
// applies to this file only.
//
// Run with: npm test

process.env.SEC_MIN_INTERVAL_MS = '0';
process.env.SEC_USER_AGENT = 'Test Suite test@example.com';

const test = require('node:test');
const assert = require('node:assert/strict');
const nock = require('nock');
const request = require('supertest');

const app = require('../server');
const { secGet } = require('../lib/warehouse/delta');

const SEC = 'https://www.sec.gov';

test.beforeEach(() => {
  nock.cleanAll();
  nock.disableNetConnect();
  nock.enableNetConnect(/127\.0\.0\.1/);
});
test.after(() => nock.enableNetConnect());

test('GET /api/config reflects whether SEC_USER_AGENT is configured, and public mode is off by default', async () => {
  const res = await request(app).get('/api/config').expect(200);
  assert.equal(res.body.userAgentConfigured, true);
  assert.equal(res.body.public, false);
  assert.equal(typeof res.body.build, 'string');
});

test('GET /api/does-not-exist: 404', async () => {
  assert.equal((await request(app).get('/api/does-not-exist')).status, 404);
});

test('/tracked moved to /watchlist (review 2026-10-15 W2): a permanent redirect that keeps the query', async () => {
  const plain = await request(app).get('/tracked').expect(301);
  assert.equal(plain.headers.location, '/watchlist');
  const q = await request(app).get('/tracked?view=tracked&date=2026-06-30').expect(301);
  assert.equal(q.headers.location, '/watchlist?view=tracked&date=2026-06-30');
  // the redirect stays on this site whatever the query holds
  const odd = await request(app).get('/tracked?//evil.example').expect(301);
  assert.ok(odd.headers.location.startsWith('/watchlist?'));
  assert.equal((await request(app).get('/tracked/x')).status, 404);
});

test('SEC client: a 429 is retried with backoff and the request succeeds', async () => {
  const scope = nock(SEC)
    .get('/Archives/edgar/full-index/2026/QTR3/form.idx')
    .reply(429)
    .get('/Archives/edgar/full-index/2026/QTR3/form.idx')
    .reply(200, 'Form Type   Company Name');
  const body = await secGet(`${SEC}/Archives/edgar/full-index/2026/QTR3/form.idx`);
  assert.match(String(body), /Form Type/);
  assert.ok(scope.isDone(), 'both the throttled and the retried request were made');
});

test('SEC client: a persistent upstream 404 fails instead of returning nothing', async () => {
  nock(SEC).get('/Archives/edgar/data/1/0/primary_doc.xml').reply(404);
  await assert.rejects(secGet(`${SEC}/Archives/edgar/data/1/0/primary_doc.xml`), err => err.response?.status === 404);
});
