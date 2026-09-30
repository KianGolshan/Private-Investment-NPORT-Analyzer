// Phase 5b task 3: the fund page (Fund X-Ray on the warehouse) over real
// rows (test/fixtures/fund/: five whole funds exported from warehouse.db).
// The private book follows company status; totals come from filing_totals;
// amendments replace; exits show as "no longer reported"; no SEC call.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const request = require('supertest');
const nock = require('nock');

const { openFixtureWarehouse } = require('./helpers/warehouseFixture');
const { rebuildFundNames } = require('../lib/warehouse/fund-names');
const { exposureAsOf } = require('../lib/analytics/asof');
const { warehouseRouter } = require('../lib/api/warehouse');
const fund = require('../lib/services/fund');

const { db } = openFixtureWarehouse(path.join(__dirname, 'fixtures', 'fund', 'warehouse.json.gz'));
rebuildFundNames(db);
db.prepare(
  "INSERT INTO refresh_runs (started_at, finished_at, status) VALUES ('2026-09-30T00:00:00Z', '2026-09-30T00:01:00Z', 'ok')"
).run();
const app = express();
app.use(
  '/api',
  warehouseRouter(() => db)
);
const api = url => request(app).get(url);
const millions = v => Math.round(v / 1e5) / 10;

const GFA = 'S000009228';
const F2 = '0001193125-26-323081';

test.before(() => {
  nock.disableNetConnect();
  nock.enableNetConnect('127.0.0.1'); // supertest's own port; any SEC call fails
});
test.after(() => nock.enableNetConnect());

test('fund X-Ray: a fund private book equals exposureAsOf for each of its companies at that filing', () => {
  for (const accession of [F2, '0001193125-26-182055']) {
    const x = fund.xray(db, GFA, accession);
    const byCompany = new Map();
    for (const h of x.privateHoldings) {
      if (!h.company) continue;
      byCompany.set(h.company.id, (byCompany.get(h.company.id) || 0) + h.marketValue);
    }
    assert.ok(byCompany.size >= 5, `${accession}: ${byCompany.size} companies`);
    for (const [companyId, value] of byCompany) {
      const e = exposureAsOf(db, { companyId, date: x.markDate });
      const mine = e.holdings.find(h => h.fundKey === GFA);
      assert.ok(mine, `company ${companyId} held by the fund at ${x.markDate}`);
      assert.equal(mine.accession, accession);
      assert.ok(Math.abs(mine.value - value) < 0.01, `company ${companyId}: ${mine.value} vs ${value}`);
    }
  }
});

test('fund X-Ray: F2 Growth Fund of America Anthropic $4,979.7M with its mark date and accession', () => {
  const x = fund.xray(db, GFA, F2);
  assert.equal(x.markDate, '2026-05-31');
  assert.equal(x.accession, F2);
  const anthropic = x.privateHoldings.filter(h => h.company?.name === 'Anthropic');
  assert.equal(millions(anthropic.reduce((s, h) => s + h.marketValue, 0)), 4979.7);
  // Totals are the whole filing's (filing_totals), with v1's Level-3 figure beside ours.
  const t = db.prepare('SELECT * FROM filing_totals WHERE accession = ?').get(F2);
  assert.equal(x.totalHoldingsCount, t.rows);
  assert.equal(x.totalValueUSD, t.value_usd);
  assert.equal(x.publicHoldingsCount, t.rows - x.privateHoldingsCount);
  assert.deepEqual(x.v1Level3, { rows: t.rows_l3_equity, valueUSD: t.value_l3_equity });
  assert.ok(Math.abs(x.privatePctOfNetAssets - (x.privateValueUSD / x.fund.netAssets) * 100) < 1e-9);
  // Default: the newest canonical filing.
  assert.equal(fund.xray(db, GFA).markDate, fund.fundFilings(db, GFA)[0].reportDate);
});

test('fund X-Ray: amendments replace, never add (F16)', () => {
  const filings = fund.fundFilings(db, 'CIK2044519');
  const q1 = filings.filter(f => f.reportDate === '2026-03-31');
  assert.deepEqual(
    q1.map(f => [f.accession, f.form, f.versions]),
    [['0001410368-26-061868', 'NPORT-P/A', 2]]
  );
  assert.throws(
    () => fund.xray(db, 'CIK2044519', '0001410368-26-056381'),
    e => e.status === 409 && e.replacedBy === '0001410368-26-061868'
  );
  const x = fund.xray(db, 'CIK2044519', '0001410368-26-061868');
  const anthropic = x.privateHoldings.filter(h => h.company?.name === 'Anthropic').map(h => h.marketValue);
  assert.deepEqual(anthropic.sort(), [229783501.7, 249999768.8].sort());
});

test('fund compare: an exited position is "exited" (shown as no longer reported); Stripe leaves Fidelity OTC (F8/F9)', () => {
  const r = fund.compare(db, 'S000007191', '0000035402-26-002031', '0000035402-25-002966');
  assert.equal(r.prior.markDate, '2025-10-31');
  assert.equal(r.current.markDate, '2026-01-31');
  const stripe = r.comparison.positions.filter(p => /STRIPE/i.test(p.name));
  assert.ok(stripe.length >= 2);
  assert.ok(stripe.every(p => p.status === 'exited'));
  assert.ok(Math.abs(stripe.reduce((s, p) => s + p.marketValue.prior, 0) - (12.17e6 + 3.54e6)) < 0.02e6);
  // The prior defaults to the filing before the current one.
  assert.equal(fund.compare(db, 'S000007191', '0000035402-26-002031').prior.accession, '0000035402-25-002966');
  assert.throws(() => fund.compare(db, 'S000007191', '0000035402-25-002966', '0000035402-26-002031'), /earlier/);
});

test('fund X-Ray: labels ($0, unreviewed, not private) and the capital structure from stored debt rows', () => {
  // F34: Mesquite reported at $0 is still in the book, labeled.
  const hi = fund.xray(db, 'S000008787', '0001193125-26-371280');
  const mesquite = hi.privateHoldings.find(h => /MESQUITE/.test(h.name));
  assert.deepEqual([mesquite.marketValue, mesquite.labels], [0, ['reported at $0']]);
  // Northeast: Westmoreland Mining's 8% term loan (a stored capital-structure
  // row) ranks ahead of its common stock; Getlink is listed, shown apart.
  const ne = fund.xray(db, 'S000011440', '0001398344-26-009765');
  const w = ne.capitalStructure.find(c => /WESTMORELAND MINING/.test(c.issuer));
  assert.ok(w.multiTranche);
  assert.deepEqual(
    w.instruments.map(i => i.instrumentType),
    ['debt', 'equity']
  );
  assert.equal(w.instruments[0].couponPct, 8);
  assert.deepEqual(
    ne.notPrivate.map(h => [h.name, h.reason]),
    [['GETLINK SA', 'listed']]
  );
  for (const h of ne.privateHoldings) if (h.unreviewed) assert.match(h.labels[0], /^unreviewed/);
});

test('fund returns: v1 lot accounting over canonical filings', () => {
  const r = fund.returns(db, GFA, { accession: F2, n: 4 });
  assert.equal(r.filings.length, 4);
  assert.equal(r.filings[0].accession, F2);
  assert.ok(r.returns.summary.positionCount > 0);
  assert.throws(() => fund.returns(db, GFA, { accessions: [F2] }), /two filings/);
});

test('fund search: exact name first, ids, and prefixes', () => {
  assert.equal(fund.searchFunds(db, 'growth fund of america')[0].fundKey, GFA);
  assert.equal(fund.searchFunds(db, 'S000009228')[0].fundKey, GFA);
  assert.equal(fund.searchFunds(db, '44201')[0].fundKey, GFA);
  assert.equal(fund.searchFunds(db, 'fidel ot')[0].fundKey, 'S000007191');
  assert.deepEqual(fund.searchFunds(db, 'no such fund zzz'), []);
});

test('API: /api/funds routes answer from the warehouse, with 404, 409 and 400, and no SEC call', async () => {
  const s = (await api('/api/funds?q=coatue').expect(200)).body;
  assert.equal(s.source, 'warehouse');
  assert.equal(s.results[0].fundKey, 'CIK2044519');
  const f = (await api(`/api/funds/${GFA}`).expect(200)).body;
  assert.equal(f.fund.seriesName, 'Growth Fund of America');
  assert.ok(f.filings.length >= 27);
  const x = (await api(`/api/funds/${GFA}/xray?accession=${F2}`).expect(200)).body;
  assert.equal(x.xray.accession, F2);
  assert.ok(x.refreshId > 0);
  const c = (await api(`/api/funds/S000007191/compare?current=0000035402-26-002031`).expect(200)).body;
  assert.equal(c.prior.accession, '0000035402-25-002966');
  const r = (await api(`/api/funds/${GFA}/returns?accession=${F2}&n=3`).expect(200)).body;
  assert.equal(r.filings.length, 3);
  await api('/api/funds/S999999999').expect(404);
  const amended = (await api('/api/funds/CIK2044519/xray?accession=0001410368-26-056381').expect(409)).body;
  assert.equal(amended.replacedBy, '0001410368-26-061868');
  await api(`/api/funds/${GFA}/xray?accession=bad`).expect(400);
  await api('/api/funds').expect(400);
});

test('fund lists are cut to the largest rows for the wire; totals and math keep every row', () => {
  const x = fund.xray(db, GFA, F2);
  const small = fund.forDisplay(x, 5);
  assert.equal(small.privateHoldings.length, 5);
  assert.deepEqual(
    small.privateHoldings.map(h => h.rowKey),
    x.privateHoldings.slice(0, 5).map(h => h.rowKey)
  );
  assert.equal(small.privateValueUSD, x.privateValueUSD);
  assert.deepEqual(small.truncated, {
    shown: 5,
    privateHoldings: x.privateHoldings.length,
    notPrivate: x.notPrivate.length,
  });
  assert.equal(fund.forDisplay(x).truncated, null);
});

test('capital structure groups by company: T. Rowe files OpenAI as "OpenAI Group PCB" beside "OpenAI Group PBC" (F36)', () => {
  const { issuerKeyOf } = require('../parsers');
  const x = fund.xray(db, 'S000001497', '0001099263-26-010105');
  const openai = x.capitalStructure.filter(c => c.instruments.some(i => /OPENAI/i.test(i.title)));
  assert.equal(openai.length, 1, 'one OpenAI row');
  assert.equal(openai[0].issuer, 'OpenAI');
  assert.ok(
    openai[0].instruments.some(i => i.title === 'OPENAI LLV CVT INT Series A-3 CVT' && i.marketValue === 3867551.13)
  );
  // v1 grouped by the filed name, which the typo splits.
  assert.notEqual(
    issuerKeyOf({ name: 'OpenAI Group PCB PP Series A-3 CVT PP' }),
    issuerKeyOf({ name: 'OpenAI Group PBC SER C CVT PFD PP' })
  );
});
