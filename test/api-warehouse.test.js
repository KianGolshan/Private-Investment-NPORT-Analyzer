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

const { warehouseRouter } = require('../lib/api/warehouse');
const { openWarehouse } = require('../lib/warehouse/db');
const { goldenWarehouse } = require('./helpers/warehouseApp');

const { db, app, idOf } = goldenWarehouse();
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
  assert.equal(fundrise.filingDate, '2026-08-28');
  // F07 (staff review): the range obeys knownAsOf (filed 2026-08-28) and the as-of rule.
  const fr = body => body.disclosedExposure.filter(d => d.accession === '0001867090-26-000109').length;
  const at = async q => (await api(`/api/companies/${id}/exposure?${q}`).expect(200)).body;
  assert.equal(fr(a4), 0); // known 2026-06-30: not filed yet
  assert.equal(fr(await at('date=2026-06-30&knownAsOf=2019-01-01')), 0);
  assert.equal(fr(await at('date=2026-06-30&knownAsOf=2026-08-27')), 0);
  assert.equal(fr(await at('date=2026-06-30&knownAsOf=2026-08-28')), 1);
  assert.equal(fr(await at('date=2026-10-31')), 1); // 123 days after 06-30
  assert.equal(fr(await at('date=2026-11-01')), 0); // 124 days: the fund is inactive
});

test('R13: an impossible calendar date is a 400, not a silent roll-over to the next month', async () => {
  const id = idOf('Anthropic');
  for (const d of ['2026-02-31', '2025-02-29', '2026-04-31'])
    assert.match((await api(`/api/companies/${id}/exposure?date=${d}`).expect(400)).body.error, /ISO date/);
  await api(`/api/companies/${id}/exposure?date=2024-02-29`).expect(200);
  await api('/api/market/top?date=2026-02-31').expect(400);
});

test('R07: a same-date amendment supersedes a disclosed range until it is re-curated', () => {
  const Database = require('better-sqlite3');
  const { disclosedExposure } = require('../lib/services/company');
  const copy = new Database(db.serialize());
  const id = idOf('Anthropic');
  const ranges = (date, knownAsOf) => disclosedExposure(copy, id, date, { knownAsOf }).map(d => d.accession);
  assert.deepEqual(ranges('2026-06-30'), ['0001867090-26-000109']);
  // a synthetic NPORT-P/A for the same fund and report date, filed 2026-09-15
  const cols = copy
    .prepare('PRAGMA table_info(filings)')
    .all()
    .map(c => c.name);
  const set = { accession: "'0001867090-26-900001'", form: "'NPORT-P/A'", filing_date: "'2026-09-15'" };
  copy.exec(
    `INSERT INTO filings (${cols.join(', ')}) SELECT ${cols.map(c => set[c] ?? c).join(', ')}
     FROM filings WHERE accession = '0001867090-26-000109'`
  );
  assert.deepEqual(ranges('2026-06-30'), [], 'the original range no longer counts');
  assert.deepEqual(ranges('2026-06-30', '2026-09-14'), ['0001867090-26-000109'], 'known before the amendment');
  assert.deepEqual(ranges('2026-06-30', '2026-09-15'), []);
  copy.close();
});

test('V06: an exit caused by a filing with no holdings says so; an ordinary exit does not', () => {
  const Database = require('better-sqlite3');
  const company = require('../lib/services/company');
  const copy = new Database(db.serialize());
  const id = idOf('Anthropic');
  // Growth Fund of America held Anthropic at 2026-05-31 (F2); its next filing lists nothing
  const gfa = '0001193125-26-323081';
  const cols = copy
    .prepare('PRAGMA table_info(filings)')
    .all()
    .map(c => c.name);
  const set = { accession: "'0009999999-26-000002'", report_date: "'2026-06-30'", filing_date: "'2026-08-20'" };
  copy.exec(
    `INSERT INTO filings (${cols.join(', ')}) SELECT ${cols.map(c => set[c] ?? c).join(', ')} FROM filings WHERE accession = '${gfa}'`
  );
  copy.exec(`INSERT INTO filing_totals (accession, rows, value_usd, rows_listed, value_listed, rows_debt, value_debt,
             rows_l3_equity, value_l3_equity) VALUES ('0009999999-26-000002', 0, 0, 0, 0, 0, 0, 0, 0)`);
  const r = company.exposure(copy, { companyId: id }, '2026-07-15');
  const e = r.exited.find(x => x.accession === '0009999999-26-000002');
  assert.ok(e, 'the fund reads as exited');
  assert.equal(e.label, 'no longer reported (the filing lists no holdings)');
  assert.equal(e.filingListsNoHoldings, true);
  // an ordinary exit (Fidelity OTC, F8/F9) keeps the plain label
  const stripe = company.exposure(copy, { companyId: idOf('Stripe') }, '2026-01-31');
  const otc = stripe.exited.find(h => h.lastHeldAccession === '0000035402-25-002966');
  assert.equal(otc.label, 'no longer reported');
  assert.equal(otc.filingListsNoHoldings, undefined);
  // the same words wherever the exit appears: the activity list and the fund's legs (one definition)
  const { companyActivity } = require('../lib/analytics/activity');
  const { buildPositionFacts } = require('../lib/warehouse/position-facts');
  const analysis = require('../lib/services/analysis');
  const ev = companyActivity(copy, { companyId: id }).find(x => x.accession === '0009999999-26-000002');
  assert.deepEqual(
    [ev.type, ev.label, ev.filingListsNoHoldings],
    ['exited', 'no longer reported (the filing lists no holdings)', true]
  );
  buildPositionFacts(copy);
  const legs = analysis
    .positionHistory(copy, { companyId: id }, 'S000009228')
    .legs.filter(l => l.accession === '0009999999-26-000002');
  assert.ok(legs.length && legs.every(l => l.label === 'no longer reported (the filing lists no holdings)'));
  copy.close();
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

test('API caching: the ETag is the refresh id plus the build; a matching If-None-Match gets 304', async () => {
  const r = await api('/api/search?q=anthropic').expect(200);
  assert.ok(r.headers.etag.startsWith('W/"r' + r.body.refreshId + '-'), r.headers.etag);
  await api('/api/search?q=anthropic').set('If-None-Match', r.headers.etag).expect(304);
  // A new build (a deploy, or a restart after a code change) never matches the old ETag.
  const next = express().use(
    '/api',
    warehouseRouter(() => db, { build: 'next' })
  );
  await request(next).get('/api/search?q=anthropic').set('If-None-Match', r.headers.etag).expect(200);
  // /freshness carries the last job's state, which moves without a new generation
  // (review R08): the generation ETag never answers it with a 304
  const f = await api('/api/freshness').set('If-None-Match', r.headers.etag).expect(200);
  assert.equal(f.headers['cache-control'], 'no-store');
  assert.ok(!String(f.headers.etag || '').startsWith('W/"r'), 'no generation ETag on /freshness');
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

// ── Post-P5 review fixes ────────────────────────────────────────────────────

test('history labels: two funds with one name stay two funds (Capital World Growth & Income, F17)', async () => {
  const h = (await api(`/api/companies/${idOf('Anthropic')}/history`).expect(200)).body;
  const labels = h.funds.map(f => f.label);
  assert.equal(new Set(labels).size, labels.length, 'every fund label is unique');
  const cwgi = h.funds.filter(f => f.seriesName === 'Capital World Growth & Income Fund');
  assert.deepEqual(cwgi.map(f => f.fundKey).sort(), ['S000009001', 'S000013710']);
  assert.ok(cwgi.some(f => f.label === 'Capital World Growth & Income Fund (AMERICAN FUNDS INSURANCE SERIES)'));
  const x = (await api(`/api/companies/${idOf('Anthropic')}/exposure?date=2026-06-30`).expect(200)).body;
  const named = [...x.holdings, ...x.exited].map(f => f.fundLabel);
  assert.equal(new Set(named).size, named.length);
});

test('listed companies: stored rows answer only on request, labeled, with exits as "not in stored rows" (SpaceX)', async () => {
  const id = idOf('Space Exploration Technologies');
  const head = (await api(`/api/companies/${id}`).expect(200)).body;
  assert.equal(head.answeredBy.source, 'live');
  assert.match(head.stored.note, /private-era marks/);
  const h = (await api(`/api/companies/${id}/history?stored=1`).expect(200)).body;
  assert.equal(h.source, 'warehouse');
  assert.ok(h.funds.length > 0, 'SpaceX has stored rows');
  assert.equal(h.stored.label, 'stored rows of a listed company');
  const x = (await api(`/api/companies/${id}/exposure?date=2026-06-30&stored=1`).expect(200)).body;
  for (const e of x.exited) assert.equal(e.label, 'not in stored rows (may be listed stock now)');
});

test('search: only a strong match opens by itself', async () => {
  const top = async q => (await api(`/api/search?q=${encodeURIComponent(q)}`).expect(200)).body.results[0];
  assert.equal((await top('Anthropic')).strong, true); // exact
  assert.equal((await top('Open AI')).strong, true); // normalized
  const similar = await top('Databriks');
  assert.deepEqual([similar.name, similar.match.how, similar.strong], ['Databricks', 'similar', false]);
});

test('unreviewed names: a key a review gave to a company answers 301 to the company', async () => {
  const { db: d, app: a } = goldenWarehouse();
  const e = d
    .prepare("SELECT key, keys FROM unreviewed_entities WHERE active = 1 AND category = 'company' ORDER BY key LIMIT 1")
    .get();
  // What a review import leaves behind: the entity inactive, its key an alias of a company.
  d.prepare('UPDATE unreviewed_entities SET active = 0 WHERE key = ?').run(e.key);
  d.prepare("INSERT INTO companies (id, name, status) VALUES (9001, 'Reviewed Since', 'private')").run();
  d.prepare(
    "INSERT INTO company_aliases (company_id, kind, pattern, via_spv, source) VALUES (9001, 'issuer_key', ?, 0, 't')"
  ).run(JSON.parse(e.keys)[0]);
  const r = await request(a)
    .get(`/api/entities/${encodeURIComponent(e.key)}/history`)
    .expect(301);
  assert.equal(r.headers.location, '/api/companies/9001/history');
});

test('API answers are gzipped for clients that accept it', async () => {
  const r = await api(`/api/companies/${idOf('Anthropic')}/history`)
    .set('Accept-Encoding', 'gzip')
    .expect(200);
  assert.equal(r.headers['content-encoding'], 'gzip');
  assert.ok(r.body.funds.length > 0);
});
