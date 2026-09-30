// Phase 5b task 8: "make this a company", admin only. On real rows (the fund
// fixture after the committed review import) and a temporary copy of
// data/review/: the job writes the decision, imports it under the refresh
// lock, and the name becomes a company with a new stable id; it refuses while
// a refresh runs and restores the review files on failure. The route refuses
// without the flag, from a non-local address, and without its header.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const request = require('supertest');

const { openFixtureWarehouse } = require('./helpers/warehouseFixture');
const { readReview } = require('./helpers/warehouseApp');
const { openWarehouse } = require('../lib/warehouse/db');
const { importAliases } = require('../lib/entities/review');
const { resolveCompanies } = require('../lib/entities/resolve');
const { rebuildEntities } = require('../lib/entities/entities');
const { identityUpkeep } = require('../lib/entities/report');
const { claimRun } = require('../lib/warehouse/refresh');
const { makeCompany } = require('../lib/entities/make-company');
const { adminRouter, isLocalRequest, runMakeCompanyJob } = require('../lib/api/admin');
const company = require('../lib/services/company');
const { search } = require('../lib/services/search');

const REVIEW = path.join(__dirname, '..', 'data', 'review');

function reviewedWarehouse(file = ':memory:') {
  const { db: fixture } = openFixtureWarehouse(path.join(__dirname, 'fixtures', 'fund', 'warehouse.json.gz'));
  const db = file === ':memory:' ? fixture : fixtureToFile(fixture, file);
  importAliases(db, readReview('aliases.csv'), { ids: readReview('company_ids.csv'), now: '2026-09-30T00:00:00Z' });
  resolveCompanies(db);
  rebuildEntities(db, identityUpkeep(db));
  return db;
}
function fixtureToFile(db, file) {
  fs.writeFileSync(file, db.serialize());
  db.close();
  return openWarehouse(file);
}
function reviewCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vantage-review-'));
  for (const f of fs.readdirSync(REVIEW)) fs.copyFileSync(path.join(REVIEW, f), path.join(dir, f));
  return dir;
}
const ledgerMax = dir =>
  Math.max(
    ...fs
      .readFileSync(path.join(dir, 'company_ids.csv'), 'utf8')
      .trim()
      .split('\n')
      .slice(1)
      .map(l => Number(l.split(',')[0]))
  );

test('make this a company: Verily Life Sciences becomes a company with the next free id, its rows resolved', () => {
  const db = reviewedWarehouse();
  const dir = reviewCopy();
  const before = fs.readFileSync(path.join(dir, 'aliases.csv'), 'utf8');
  const next = ledgerMax(dir) + 1;
  const entity = company.findUnreviewed(db, 'VERILY LIFE SCIENCES');
  const rows = db.prepare('SELECT COUNT(*) n FROM holdings WHERE entity_id = ?').get(entity.id).n;

  const r = makeCompany(db, { dir, key: 'VERILY LIFE SCIENCES', name: 'Verily Life Sciences' });
  assert.equal(r.company.id, next);
  assert.equal(r.company.name, 'Verily Life Sciences');
  assert.equal(r.company.status, 'private');
  assert.equal(r.company.rows, rows);
  assert.match(r.evidence, /^\d{10}-\d{2}-\d{6}$/);
  // The decision is in the reviewed files: existing rows untouched, the new row appended, the id in the ledger.
  const after = fs.readFileSync(path.join(dir, 'aliases.csv'), 'utf8');
  assert.ok(after.startsWith(before));
  assert.match(after.slice(before.length), /^Verily Life Sciences,private,N,issuer_key,VERILY LIFE SCIENCES,0,/);
  assert.match(
    fs.readFileSync(path.join(dir, 'company_ids.csv'), 'utf8'),
    new RegExp(`\\n${next},Verily Life Sciences,,`)
  );
  // The name is a company now: search finds it as one, and it is no longer unreviewed.
  assert.equal(search(db, 'Verily Life Sciences')[0].type, 'company');
  assert.equal(company.findUnreviewed(db, 'VERILY LIFE SCIENCES').active, false);
  // The run is recorded under the lock as a curation, finished ok.
  assert.deepEqual(db.prepare('SELECT kind, status FROM refresh_runs WHERE id = ?').get(r.runId), {
    kind: 'curation',
    status: 'ok',
  });
  // A rebuild from the files reproduces the id (ADR 0008).
  const again = reviewedWarehouse();
  importAliases(again, readReviewFrom(dir, 'aliases.csv'), { ids: readReviewFrom(dir, 'company_ids.csv') });
  assert.equal(again.prepare('SELECT id FROM companies WHERE name = ?').get('Verily Life Sciences').id, next);
});

const { parseCsv } = require('../lib/entities/csv');
const readReviewFrom = (dir, f) => parseCsv(fs.readFileSync(path.join(dir, f), 'utf8'));

test('make this a company: refused while a refresh runs; refused for a name already a company or not unreviewed', () => {
  const db = reviewedWarehouse();
  const dir = reviewCopy();
  const running = claimRun(db);
  assert.throws(
    () => makeCompany(db, { dir, key: 'VERILY LIFE SCIENCES', name: 'Verily Life Sciences' }),
    e => e.status === 409 && /already running/.test(e.message)
  );
  db.prepare("UPDATE refresh_runs SET status = 'ok', finished_at = 'x' WHERE id = ?").run(running);
  assert.throws(
    () => makeCompany(db, { dir, key: 'VERILY LIFE SCIENCES', name: 'Anthropic' }),
    e => e.status === 409
  );
  assert.throws(
    () => makeCompany(db, { dir, key: 'NO SUCH NAME', name: 'X' }),
    e => e.status === 404
  );
  assert.throws(
    () => makeCompany(db, { dir, key: 'VERILY LIFE SCIENCES', name: '  ' }),
    e => e.status === 400
  );
});

test('make this a company: a failing import restores the review files and fails the run', () => {
  const db = reviewedWarehouse();
  const dir = reviewCopy();
  const files = ['aliases.csv', 'company_ids.csv'].map(f => fs.readFileSync(path.join(dir, f), 'utf8'));
  fs.writeFileSync(path.join(dir, 'managers.csv'), 'manager,kind,key\nX,nonsense,1\n'); // invalid: aborts the import
  assert.throws(() => makeCompany(db, { dir, key: 'VERILY LIFE SCIENCES', name: 'Verily Life Sciences' }));
  assert.deepEqual(
    ['aliases.csv', 'company_ids.csv'].map(f => fs.readFileSync(path.join(dir, f), 'utf8')),
    files
  );
  const run = db.prepare("SELECT status FROM refresh_runs WHERE kind = 'curation' ORDER BY id DESC").get();
  assert.equal(run.status, 'failed');
  assert.doesNotThrow(() => claimRun(db), 'the lock is released');
});

test('admin route: refused without the flag, from a non-local or proxied address, and without its header', async () => {
  let ran = 0;
  const runJob = async () => (ran++, { company: { id: 900, name: 'X', rows: 1 } });
  const mount = enabled => {
    const app = express();
    app.use('/api/admin', adminRouter({ enabled: () => enabled, runJob }));
    return app;
  };
  const body = { key: 'VERILY LIFE SCIENCES', name: 'Verily Life Sciences' };
  await request(mount(false)).post('/api/admin/companies').set('X-Vantage-Admin', '1').send(body).expect(403);
  await request(mount(true)).post('/api/admin/companies').send(body).expect(403);
  await request(mount(true))
    .post('/api/admin/companies')
    .set('X-Vantage-Admin', '1')
    .set('X-Forwarded-For', '203.0.113.9')
    .send(body)
    .expect(403);
  assert.equal(ran, 0);
  assert.equal(isLocalRequest({ headers: {}, socket: { remoteAddress: '10.0.0.5' } }), false);
  assert.equal(isLocalRequest({ headers: {}, socket: { remoteAddress: '::1' } }), true);
  const ok = await request(mount(true)).post('/api/admin/companies').set('X-Vantage-Admin', '1').send(body).expect(201);
  assert.equal(ok.body.company.id, 900);
  assert.equal(ran, 1);
  await request(mount(true)).post('/api/admin/companies').set('X-Vantage-Admin', '1').send({}).expect(400);
});

test('admin job: the child process runs to its end on a warehouse file and reports the new company', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vantage-admin-'));
  const file = path.join(tmp, 'warehouse.db');
  reviewedWarehouse(file).close();
  const dir = reviewCopy();
  const saved = process.env.WAREHOUSE_DB_PATH;
  process.env.WAREHOUSE_DB_PATH = file;
  try {
    const r = await runMakeCompanyJob({
      key: 'VERILY LIFE SCIENCES',
      name: 'Verily Life Sciences',
      status: 'private',
      track: 'N',
      dir,
    });
    assert.equal(r.company.name, 'Verily Life Sciences');
    assert.equal(r.company.id, ledgerMax(REVIEW) + 1);
    const again = await runMakeCompanyJob({
      key: 'VERILY LIFE SCIENCES',
      name: 'Verily',
      status: 'private',
      track: 'N',
      dir,
    });
    assert.equal(again.status, 409); // no longer unreviewed
  } finally {
    if (saved === undefined) delete process.env.WAREHOUSE_DB_PATH;
    else process.env.WAREHOUSE_DB_PATH = saved;
  }
});

test('the page: a local admin sees "Make this a company" on an unreviewed name, and lands on the new company', async () => {
  const { loadApp } = require('./helpers/loadApp');
  const { jsonResponse } = require('./helpers/fakes');
  const { warehouseRouter } = require('../lib/api/warehouse');
  const db = reviewedWarehouse();
  db.prepare("INSERT INTO refresh_runs (started_at, finished_at, status) VALUES ('a', 'b', 'ok')").run();
  const dir = reviewCopy();
  const app = express();
  app.use(
    '/api',
    warehouseRouter(() => db)
  );
  app.use('/api/admin', adminRouter({ enabled: () => true, runJob: async args => makeCompany(db, { ...args, dir }) }));
  const posts = [];
  const fetchImpl = async (url, init = {}) => {
    if (url === '/api/config') return jsonResponse({ userAgentConfigured: true, admin: true });
    const req =
      init.method === 'POST'
        ? request(app).post(url).set(init.headers).send(JSON.parse(init.body))
        : request(app).get(url);
    if (init.method === 'POST') posts.push(JSON.parse(init.body));
    const r = await req;
    return jsonResponse(r.body, { ok: r.status < 400, status: r.status });
  };
  const { window, document } = await loadApp({ fetchImpl, url: 'http://localhost/name/VERILY%20LIFE%20SCIENCES' });
  await new Promise(r => window.setTimeout(r, 150));
  assert.ok(document.getElementById('makeCompanyBtn'), 'the admin form is on the page');
  assert.equal(document.getElementById('makeCompanyName').value, 'VERILY LIFE SCIENCES LLC');
  document.getElementById('makeCompanyName').value = 'Verily Life Sciences';
  await window.makeThisACompany();
  await new Promise(r => window.setTimeout(r, 150));
  assert.deepEqual(posts, [
    { key: 'VERILY LIFE SCIENCES', name: 'Verily Life Sciences', status: 'private', track: 'N' },
  ]);
  assert.match(window.location.pathname, /^\/company\/\d+-verily-life-sciences$/);
  assert.match(document.getElementById('companyContainer').textContent, /Verily Life Sciences\s*Private/);

  // Not an admin: no form.
  const plain = await loadApp({
    fetchImpl: async url => (url === '/api/config' ? jsonResponse({ admin: false }) : fetchImpl(url)),
    url: 'http://localhost/name/APPNEXUS',
  });
  await new Promise(r => plain.window.setTimeout(r, 150));
  assert.equal(plain.document.getElementById('makeCompanyBtn'), null);
});
