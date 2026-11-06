// P15 W3 (ADR 0011): the cost basis in the answers (lib/services/cost.js through
// lib/api/warehouse.js), on the golden warehouse with REAL N-CSR filings read
// (test/fixtures/ncsr: Fidelity Mt. Vernon Street Trust N-CSRS 2026-05-31, Growth Fund
// of America N-CSRS 2026-02-28). Two rules are pinned here:
//   - a position shows a cost only at its cost's own filing, or carried forward through
//     legs with the same shares and no split; totals only when every position has one;
//   - every answer that existed before P15 is unchanged except for the added fields
//     (cost, costCoverage, roundPrices), for Anthropic, Databricks and Anduril and every
//     fund and firm that held them.
//
// Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');

const { goldenWarehouse } = require('./helpers/warehouseApp');
const { readFiling, store } = require('../lib/warehouse/ncsr');
const { buildCostFacts } = require('../lib/warehouse/cost-facts');
const { buildPositionFacts } = require('../lib/warehouse/position-facts');
const { costOfPosition, costOfAll } = require('../lib/services/cost');
const { compare, stable } = require('../scripts/snapshot-api');

const DIR = path.join(__dirname, 'fixtures', 'ncsr');
const read = f => fs.readFileSync(path.join(DIR, f), 'utf8');
const FID = '0000707823-26-000042';
const GFA = '0001193125-26-195253';

function readBoth(db) {
  for (const [acc, cik, family, period] of [
    [FID, '707823', 'fidelity', '2026-05-31'],
    [GFA, '44201', 'capital', '2026-02-28'],
  ]) {
    const rep = { accession: acc, cik, form: 'N-CSRS', filingDate: '2026-07-01', periodEnd: period };
    const r = readFiling(db, rep, family, {
      html: read(`${acc}.html`),
      header: read(`headers/${acc}.html`),
      document: 'x',
    });
    store(db, rep, family, r, { status: 'ok', now: '2026-11-05T00:00:00Z' });
  }
  buildCostFacts(db);
}

// Every answer the snapshot harness covers, in process, for the companies in the fixture.
async function answers(app, db) {
  const ids = db
    .prepare("SELECT id FROM companies WHERE name IN ('Anthropic', 'Databricks', 'Anduril Industries') ORDER BY id")
    .all()
    .map(r => r.id);
  const funds = db
    .prepare(`SELECT DISTINCT fund_key FROM position_facts WHERE company_id IN (${ids.join(',')}) ORDER BY 1`)
    .all()
    .map(r => r.fund_key);
  const firms = db
    .prepare(
      `SELECT DISTINCT ma.manager_id id FROM fund_advisers fa JOIN manager_advisers ma ON ma.file_num = fa.file_num
       WHERE fa.fund_key IN (${funds.map(f => `'${f}'`).join(',')}) ORDER BY 1`
    )
    .all()
    .map(r => r.id);
  const urls = [];
  for (const id of ids) {
    const c = `/api/companies/${id}`;
    urls.push(c, `${c}/exposure`, `${c}/exposure?date=2026-03-31`, `${c}/history`, `${c}/marks`, `${c}/classes`);
    urls.push(`${c}/rows`, `${c}/bridge`, `${c}/legs`, `${c}/leadership`, `${c}/activity`, `${c}/trend`);
    for (const fk of funds) urls.push(`${c}/positions/${encodeURIComponent(fk)}`);
  }
  for (const fk of funds) {
    const f = `/api/funds/${encodeURIComponent(fk)}`;
    urls.push(f, `${f}/changes`, `${f}/returns`, `${f}/compare`);
    for (const a of db.prepare('SELECT accession FROM canonical_filings WHERE fund_key = ?').all(fk))
      urls.push(`${f}/xray?accession=${a.accession}`);
  }
  for (const id of firms) urls.push(`/api/firms/${id}`, `/api/firms/${id}?date=2026-03-31`, `/api/firms/${id}/changes`);
  urls.push('/api/market/top', '/api/market/top?date=2026-03-31', '/api/sectors', '/api/firms', '/api/stats');
  const out = new Map();
  for (const u of urls) {
    const res = await request(app).get(u);
    out.set(u, { status: res.status, body: stable(res.body) });
  }
  return out;
}

test('every pre-existing answer is unchanged; only cost fields are added', async () => {
  const { db, app } = goldenWarehouse();
  const before = await answers(app, db);
  readBoth(db);
  const after = await answers(app, db);
  let added = 0;
  for (const [u, a] of before) {
    const b = after.get(u);
    assert.equal(b.status, a.status, u);
    assert.deepEqual(compare(a.body, b.body), [], u);
    if (JSON.stringify(b.body).includes('"cost":')) added++;
  }
  assert.ok(before.size > 300, `${before.size} answers compared`);
  assert.ok(added > 10, `${added} answers carry a cost`);
});

test('a position: its own filing, carried through unchanged legs, never across a change', () => {
  const { db } = goldenWarehouse();
  readBoth(db);
  // Fidelity Growth Company, Anthropic Series D, at the N-CSR's own filing
  const d = costOfPosition(db, {
    fundKey: 'S000007119',
    accession: '0000035402-26-004656',
    reportDate: '2026-05-31',
    instrumentKey: 'KJX974000',
    balance: 235150,
    valueUsd: 146484341,
  });
  assert.deepEqual(
    [d.usd, d.perShare, d.asOf, d.carried, d.acquiredFirst, d.ncsrAccession],
    [7055558, 7055558 / 235150, '2026-05-31', false, '2024-05-31', FID]
  );
  assert.equal(d.valueToCost, 146484341 / 7055558);
  // Growth Fund of America, Anthropic F-1: cost at 2026-02-28, the same 2,859,590 shares at 2026-05-31
  const f1 = {
    fundKey: 'S000009228',
    accession: '0001193125-26-323081',
    reportDate: '2026-05-31',
    instrumentKey: 'ECA408707',
    balance: 2859590,
    valueUsd: 1684325676.11,
  };
  const carried = costOfPosition(db, f1);
  assert.deepEqual([carried.usd, carried.asOf, carried.carried], [403109000, '2026-02-28', true]);
  assert.equal(carried.valueToCost, 1684325676.11 / 403109000);
  // not with other shares, not before the cost's filing, not without a key
  assert.equal(costOfPosition(db, { ...f1, balance: 2859591 }), null);
  assert.equal(costOfPosition(db, { ...f1, accession: '0001193125-25-251567', reportDate: '2025-08-31' }), null);
  assert.equal(costOfPosition(db, { ...f1, instrumentKey: null }), null);
  // a leg in between with other shares, or a split, stops the carry
  const changed = goldenWarehouse();
  readBoth(changed.db);
  changed.db
    .prepare(
      "UPDATE holdings SET balance = 2859000 WHERE accession = '0001193125-26-323081' AND title LIKE 'ANTHROPIC PBC CL F-1%'"
    )
    .run();
  buildPositionFacts(changed.db);
  buildCostFacts(changed.db);
  assert.equal(costOfPosition(changed.db, { ...f1, balance: 2859000 }), null);
  const split = goldenWarehouse();
  readBoth(split.db);
  split.db
    .prepare(
      "UPDATE position_facts SET split = 2 WHERE fund_key = 'S000009228' AND instrument_key = 'ECA408707' AND report_date = '2026-05-31'"
    )
    .run();
  buildCostFacts(split.db); // a new index for the new generation of facts
  assert.equal(costOfPosition(split.db, f1), null);
  // totals: all or nothing
  assert.equal(costOfAll([{ usd: 1 }, null], 10), null);
  assert.deepEqual(costOfAll([{ usd: 2 }, { usd: 3 }], 10), { usd: 5, valueToCost: 2, positions: 2 });
});

test('answers: holders, the drawer, the X-Ray, a firm book and round prices', async () => {
  const { db, app, idOf } = goldenWarehouse();
  readBoth(db);
  const anthropic = idOf('Anthropic');
  const databricks = idOf('Databricks');
  // Holders at 2026-05-31: Fidelity Growth Company (every Anthropic class has a cost) and
  // Growth Fund of America (F-1 and G-1 carried; its new Common has none, so no holder total)
  const e = (await request(app).get(`/api/companies/${anthropic}/exposure?date=2026-05-31`)).body;
  const gco = e.holdings.find(h => h.fundKey === 'S000007119');
  assert.ok(
    gco.positions.every(p => p.cost),
    'each Growth Company class has its cost'
  );
  assert.equal(
    gco.cost.usd,
    gco.positions.reduce((s, p) => s + p.cost.usd, 0)
  );
  assert.equal(gco.cost.valueToCost, gco.value / gco.cost.usd);
  const gfa = e.holdings.find(h => h.fundKey === 'S000009228');
  const byClass = Object.fromEntries(gfa.positions.map(p => [p.classLabel, p.cost || null]));
  assert.equal(byClass['Series F-1'].usd, 403109000);
  assert.equal(byClass.Common, null);
  assert.equal(gfa.cost, undefined, 'one class without a cost: no total');
  // the drawer: the leg at the N-CSR's filing has the cost; the leg before it has none
  const legs = (await request(app).get(`/api/companies/${anthropic}/positions/S000009228`)).body.legs;
  const at = (date, cls) => legs.find(l => l.markDate === date && l.classLabel === cls);
  assert.equal(at('2026-02-28', 'Series F-1').cost.usd, 403109000);
  assert.equal(at('2026-05-31', 'Series F-1').cost.carried, true);
  assert.equal((legs.find(l => l.markDate < '2026-02-28') || {}).cost, undefined);
  // the X-Ray of the N-CSR's filing: costs and the coverage of private value
  const x = (await request(app).get('/api/funds/S000007119/xray?accession=0000035402-26-004656')).body.xray;
  const withCost = x.privateHoldings.filter(h => h.cost);
  assert.ok(withCost.length >= 10);
  assert.equal(x.costCoverage.positions, withCost.length);
  assert.equal(
    x.costCoverage.valueUsd,
    withCost.reduce((s, h) => s + h.marketValue, 0)
  );
  assert.equal(x.costCoverage.share, x.costCoverage.valueUsd / x.privateValueUSD);
  // the X-Ray of a filing before any N-CSR read: exactly as before
  const old = (await request(app).get('/api/funds/S000007119/xray?accession=0000035402-26-000436')).body.xray;
  assert.equal(old.costCoverage, undefined);
  assert.ok(old.privateHoldings.every(h => !h.cost));
  // round prices: Databricks has two (J and K: Fidelity and Capital Group, same date, same price)
  const db1 = (await request(app).get(`/api/companies/${databricks}`)).body;
  assert.deepEqual(
    db1.roundPrices.map(r => [r.classLabel, r.acquiredOn, Math.round(r.price * 100) / 100, r.firms]),
    [
      ['Series K', '2025-09-08', 150, 2],
      ['Series J', '2024-12-17', 92.5, 2],
    ]
  );
  assert.equal((await request(app).get(`/api/companies/${anthropic}`)).body.roundPrices, undefined);
  assert.ok((await request(app).get(`/api/companies/${databricks}/marks`)).body.roundPrices.length === 2);
  // a firm's book: Fidelity's Anthropic positions with costs
  const book = (await request(app).get('/api/firms/3?date=2026-05-31')).body;
  const a = book.byCompany.find(c => c.companyId === anthropic);
  assert.ok(a.positions.some(p => p.cost && p.fundKey === 'S000007119'));
  for (const p of a.positions.filter(q => q.cost)) assert.equal(p.cost.valueToCost, p.value / p.cost.usd);
});
