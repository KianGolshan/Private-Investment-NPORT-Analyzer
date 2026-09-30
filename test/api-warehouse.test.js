// Phase 5a: the warehouse routes (lib/api/warehouse.js) over the golden
// fixture (test/fixtures/warehouse/, real rows) with the committed
// data/review/ files. Golden numbers through the API, the display labels,
// history starts, routing, stable ids, ETags, and no SEC call.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const request = require('supertest');
const nock = require('nock');

const { importAliases, importDisclosedExposure } = require('../lib/entities/review');
const { resolveCompanies } = require('../lib/entities/resolve');
const { parseCsv } = require('../lib/entities/csv');
const { identityUpkeep } = require('../lib/entities/report');
const { rebuildEntities } = require('../lib/entities/entities');
const { warehouseRouter } = require('../lib/api/warehouse');
const { openWarehouse } = require('../lib/warehouse/db');
const { openFixtureWarehouse } = require('./helpers/warehouseFixture');

const REVIEW = path.join(__dirname, '..', 'data', 'review');
const read = f => parseCsv(fs.readFileSync(path.join(REVIEW, f), 'utf8'));

const { db } = openFixtureWarehouse();
importAliases(db, read('aliases.csv'), { ids: read('company_ids.csv'), now: '2026-09-30T00:00:00Z' });
importDisclosedExposure(db, read('disclosed_exposure.csv'));
resolveCompanies(db);
rebuildEntities(db, identityUpkeep(db));
db.prepare(
  "INSERT INTO refresh_runs (started_at, finished_at, status) VALUES ('2026-09-30T00:00:00Z', '2026-09-30T00:01:00Z', 'ok')"
).run();

const app = express();
app.use(
  '/api',
  warehouseRouter(() => db)
);
const idOf = name => db.prepare('SELECT id FROM companies WHERE name = ?').get(name).id;
const api = url => request(app).get(url);
const billions = v => Math.round(v / 1e7) / 100;

test.before(() => {
  nock.disableNetConnect();
  nock.enableNetConnect('127.0.0.1'); // supertest's own port; any SEC call fails
});
test.after(() => nock.enableNetConnect());

test('API goldens: Anthropic A1 72 / $5.93B, A2 117 / $17.26B, A4 knownAsOf 82 / $6.23B (fixture rows)', async () => {
  const id = idOf('Anthropic');
  const a1 = (await api(`/api/companies/${id}/exposure?date=2026-03-31`).expect(200)).body;
  const a2 = (await api(`/api/companies/${id}/exposure?date=2026-06-30`).expect(200)).body;
  const a4 = (await api(`/api/companies/${id}/exposure?date=2026-06-30&knownAsOf=2026-06-30`).expect(200)).body;
  assert.deepEqual([a1.funds, billions(a1.total)], [72, 5.93]);
  assert.deepEqual([a2.funds, billions(a2.total)], [117, 17.26]);
  assert.deepEqual([a4.funds, billions(a4.total)], [82, 6.23]);
  assert.equal(a2.source, 'warehouse');
  assert.ok(a2.refreshId > 0);
  // F2: Growth Fund of America's 5/31 marks, with the mark date and accession on the row.
  const gfa = a2.holdings.find(h => h.accession === '0001193125-26-323081');
  assert.equal(gfa.markDate, '2026-05-31');
  assert.equal(Math.round(gfa.value / 1e5) / 10, 4979.7);
  // F11: Magnitude's SPV is indirect. F22: Fundrise's range, in the filing's words.
  const magnitude = a2.holdings.find(h => h.accession === '0000894189-26-024246');
  assert.deepEqual([magnitude.indirect, magnitude.label], [true, 'indirect']);
  assert.equal(Math.round(magnitude.value / 1e5) / 10, 235.7);
  const fundrise = a2.disclosedExposure.find(d => d.accession === '0001867090-26-000109');
  assert.match(fundrise.basis, /Greater than 20%/);
});

test('API goldens: Stripe A5 49 / 35 / 34 / 37 and Databricks A6 120 / $6.22B', async () => {
  const stripe = idOf('Stripe');
  const counts = [];
  for (const d of ['2025-06-30', '2025-12-31', '2026-03-31', '2026-06-30'])
    counts.push((await api(`/api/companies/${stripe}/exposure?date=${d}`).expect(200)).body.funds);
  assert.deepEqual(counts, [49, 35, 34, 37]);
  const dbx = (await api(`/api/companies/${idOf('Databricks')}/exposure?date=2026-06-30`).expect(200)).body;
  assert.deepEqual([dbx.funds, billions(dbx.total)], [120, 6.22]);
});

test('API labels: Fidelity OTC Portfolio is "no longer reported" at 2026-01-31 (F8/F9)', async () => {
  const r = (await api(`/api/companies/${idOf('Stripe')}/exposure?date=2026-01-31`).expect(200)).body;
  const otc = r.exited.find(h => h.lastHeldAccession === '0000035402-25-002966');
  assert.ok(otc, 'Fidelity OTC held Stripe at 2025-10-31 and not at 2026-01-31');
  assert.equal(otc.label, 'no longer reported');
  assert.equal(otc.accession, '0000035402-26-002031');
});

test('API history: Anthropic from 2023-04-28, Stripe from 2019-12-31, Databricks from 2019-10-31', async () => {
  for (const [name, first] of [
    ['Anthropic', '2023-04-28'],
    ['Stripe', '2019-12-31'],
    ['Databricks', '2019-10-31'],
  ]) {
    const h = (await api(`/api/companies/${idOf(name)}/history`).expect(200)).body;
    assert.equal(h.firstMarkDate, first, name);
    const p = h.funds[0].series[0].points[0];
    for (const k of ['markDate', 'accession', 'valueUsd', 'pricePerShare', 'pricePerUnit']) assert.ok(k in p, k);
  }
  // F13: T. Rowe's Databricks Series H 3:1 split is flagged on its 2022-08-31 point.
  const h = (await api(`/api/companies/${idOf('Databricks')}/history`).expect(200)).body;
  const split = h.funds.flatMap(f => f.series.flatMap(s => s.points)).find(p => p.accession === '0001752724-22-239970');
  assert.equal(split.split, 3);
});

test('API routing: a listed company answers from the live path, never from its stored rows (SpaceX is public)', async () => {
  const id = idOf('Space Exploration Technologies');
  const info = (await api(`/api/companies/${id}`).expect(200)).body;
  assert.equal(info.company.status, 'public');
  assert.equal(info.answeredBy.source, 'live');
  const r = (await api(`/api/companies/${id}/exposure?date=2026-06-30`).expect(200)).body;
  assert.equal(r.source, 'live');
  assert.equal(r.liveQuery, 'Space Exploration Technologies');
  assert.ok(!('holdings' in r) && !('total' in r));
});

test('API search and unreviewed names', async () => {
  const s = (await api('/api/search?q=Open%20AI').expect(200)).body;
  assert.equal(s.results[0].name, 'OpenAI');
  const anyUnreviewed = db
    .prepare("SELECT key FROM unreviewed_entities WHERE active = 1 AND category = 'company'")
    .get();
  const e = (await api(`/api/entities/${encodeURIComponent(anyUnreviewed.key)}`).expect(200)).body;
  assert.equal(e.label, 'unreviewed');
  await api('/api/search').expect(400);
  await api('/api/entities/NO%20SUCH%20NAME').expect(404);
});

test('API ids: a merged id redirects to its successor, a dropped id is gone, bad ids fail', async () => {
  const anthropic = idOf('Anthropic');
  db.prepare(
    "INSERT INTO company_redirects (old_id, old_name, new_id, reason, retired_at) VALUES (99001, 'Anthropic PBC (old)', ?, 'merged', 'x')"
  ).run(anthropic);
  db.prepare(
    "INSERT INTO company_redirects (old_id, old_name, new_id, reason, retired_at) VALUES (99002, 'Gone Co', NULL, 'dropped', 'x')"
  ).run();
  const r = await api('/api/companies/99001/exposure?date=2026-06-30').expect(301);
  assert.equal(r.headers.location, `/api/companies/${anthropic}/exposure?date=2026-06-30`);
  await api('/api/companies/99002').expect(410);
  await api('/api/companies/424242').expect(404);
  await api('/api/companies/abc').expect(400);
  await api(`/api/companies/${anthropic}/exposure?date=06-30-2026`).expect(400);
});

test('API caching: the ETag is the refresh id; a matching If-None-Match gets 304', async () => {
  const r = await api('/api/freshness').expect(200);
  assert.equal(r.headers.etag, `W/"r${r.body.refreshId}"`);
  await api('/api/freshness').set('If-None-Match', r.headers.etag).expect(304);
});

test('API read-only: a missing or behind warehouse gives 503, never a new file; the server opens it read-only', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vantage-ro-'));
  const missing = path.join(dir, 'none.db');
  const { openWarehouseReadOnly } = require('../lib/warehouse/db');
  const a = express().use(
    '/api',
    warehouseRouter(() => openWarehouseReadOnly(missing))
  );
  await request(a).get('/api/freshness').expect(503);
  assert.ok(!fs.existsSync(missing), 'no file created');
  const behind = path.join(dir, 'behind.db');
  const w = new (require('better-sqlite3'))(behind);
  w.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY)');
  w.close();
  const b = express().use(
    '/api',
    warehouseRouter(() => openWarehouseReadOnly(behind))
  );
  const res = await request(b).get('/api/freshness').expect(503);
  assert.match(res.body.error, /missing migration/);
  // A current warehouse opens read-only.
  const ok = path.join(dir, 'ok.db');
  openWarehouse(ok).close();
  const ro = openWarehouseReadOnly(ok);
  assert.equal(ro.readonly, true);
  assert.throws(() => ro.prepare('DELETE FROM filings').run(), /readonly/);
  ro.close();
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /warehouseRouter\(\(\) => openWarehouseReadOnly\(\)\)/);
  assert.doesNotMatch(server, /openWarehouse\(/);
  fs.rmSync(dir, { recursive: true, force: true });
});
