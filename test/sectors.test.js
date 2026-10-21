// P14 (ADR 0010): sector, industry and theme views on the golden fixture (real
// rows) with the committed review files. Sectors and industries add up to
// Market's operating-company total; Explore's sector rows add up to the total
// row and drill to their cell; the mark index follows each fund's own security
// (F62: Fidelity Hastings Street Trust's Anthropic Series F, $140.96 on
// 2025-12-31 to $589.01 on 2026-06-30, raw EDGAR), counts a company only from
// a mark in force at the start, and gives no value below its minimum sample.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const nock = require('nock');

const { goldenWarehouse } = require('./helpers/warehouseApp');
const market = require('../lib/services/market');
const analysis = require('../lib/services/analysis');
const sectors = require('../lib/services/sectors');

const { db, app, idOf } = goldenWarehouse();
const api = url => request(app).get(url);
const near = (a, b, eps = 0.01) => Math.abs(a - b) < eps;
const DATES = ['2025-06-30', '2025-12-31', '2026-06-30'];

test.before(() => {
  nock.disableNetConnect();
  nock.enableNetConnect('127.0.0.1');
});
test.after(() => nock.enableNetConnect());

test('totals: sectors and industries add up to Market; themes are marked as overlapping', () => {
  for (const date of DATES) {
    const top = market.topCompanies(db, { date, limit: 1e9, categories: ['company'] });
    for (const level of ['sector', 'industry']) {
      const t = sectors.totals(db, { date, level });
      assert.equal(t.additive, true);
      assert.ok(near(t.totalValue, top.totalValue), `${level} ${date}`);
      assert.ok(
        near(
          t.groups.reduce((s, g) => s + g.value, 0),
          top.totalValue
        ),
        `${level} ${date} sum`
      );
      assert.equal(
        t.groups.reduce((s, g) => s + g.companies, 0),
        top.companies,
        `${level} ${date}: each company once`
      );
    }
    const th = sectors.totals(db, { date, level: 'theme' });
    assert.equal(th.additive, false);
  }
  const t = sectors.totals(db, { date: '2026-06-30', level: 'industry' });
  const ai = t.groups.find(g => g.key === 'tech.ai_models');
  assert.equal(ai.sector, 'tech');
  assert.ok(ai.top.some(c => c.name === 'Anthropic'));
});

test('group companies: one industry lists its companies and adds up to its total; unknown codes are 404', () => {
  const t = sectors.totals(db, { date: '2026-06-30', level: 'sector' });
  for (const g of t.groups) {
    const c = sectors.groupCompanies(db, { level: 'sector', key: g.key, date: '2026-06-30' });
    assert.equal(c.companies, g.companies);
    assert.ok(near(c.totalValue, g.value));
  }
  const fin = sectors.groupCompanies(db, { level: 'industry', key: 'fin.payments', date: '2026-06-30' });
  assert.ok(fin.results.some(r => r.name === 'Stripe'));
  assert.throws(() => sectors.groupCompanies(db, { level: 'industry', key: 'tech.nope' }), /no industry/);
  assert.throws(() => sectors.totals(db, { level: 'galaxy' }), /level must be/);
});

test('Explore: sector rows add up to the total row in every period, and a cell drills to its legs', () => {
  const p = analysis.pivot(db, {
    rows: 'sector',
    period: 'quarter',
    from: '2025-06-30',
    to: '2026-06-30',
    categories: ['company'],
    limit: 1000,
  });
  assert.equal(p.additive, true);
  for (const m of ['value', 'positionEffect', 'markEffect'])
    p.total[m].forEach((v, i) =>
      assert.ok(
        near(
          p.results.reduce((s, r) => s + r[m][i], 0),
          v
        ),
        `${m} period ${i}`
      )
    );
  const tech = p.results.find(r => r.key === 'tech');
  const d = analysis.drill(db, {
    rows: 'sector',
    key: 'tech',
    metric: 'markEffect',
    from: p.periods[1].from,
    to: p.periods[1].to,
    categories: ['company'],
    limit: 100000,
  });
  const legs = d.events.flatMap(e => e.legs);
  assert.ok(legs.length > 0);
  assert.ok(
    near(
      legs.reduce((s, l) => s + l.amount, 0),
      tech.markEffect[1],
      1
    )
  );
  const th = analysis.pivot(db, { rows: 'theme', from: '2025-06-30', to: '2026-06-30', categories: ['company'] });
  assert.equal(th.additive, false);
  assert.throws(() => analysis.pivot(db, { rows: 'sector', keys: ['Tech!'] }), /must be a code/);
});

test('mark index: a company is the median of its own chains (F62: Anthropic +317.86%)', () => {
  const c = sectors.companyMarkChanges(db, { level: 'theme', key: 'ai', from: '2025-12-31', to: '2026-06-30' });
  const anthropic = c.companies.find(r => r.companyId === idOf('Anthropic'));
  // Fidelity Hastings Street Trust, Anthropic Series F (LKV546000): 25,300 sh at $3,566,288 on 2025-12-31
  // (0000035402-26-001217) and $14,901,953 on 2026-06-30 (0000035402-26-005467): the median chain
  assert.ok(Math.abs(anthropic.change - (589.01 / 140.96 - 1)) < 1e-9, String(anthropic.change));
  assert.equal(anthropic.path[0].level, 1);
  // every company in the cohort has a mark in force at the start
  for (const r of c.companies) assert.equal(r.path[0].level, 1, r.name);
});

test('mark index: no value below the minimum sample; a fixed cohort; partial periods flagged', () => {
  // the fixture holds two AI companies: below the 5-company minimum, so no index value
  const ai = sectors.markIndex(db, { level: 'theme', keys: ['ai'], from: '2025-12-31', to: '2026-06-30' });
  assert.equal(ai.groups[0].cohort, 2);
  for (const p of ai.groups[0].points) assert.deepEqual([p.sufficient, p.index], [false, null]);
  const all = sectors.markIndex(db, { level: 'sector', from: '2025-06-30', to: '2026-06-30' });
  for (const g of all.groups) {
    assert.ok(
      g.points.every(p => p.companies <= g.cohort),
      g.key
    );
    const first = g.points[0];
    if (first.sufficient) assert.equal(first.index, 100);
  }
  const partial = sectors.markIndex(db, { level: 'sector', from: '2025-06-30', to: '2026-05-15' });
  assert.equal(partial.groups[0].points.at(-1).partial, true);
  assert.throws(() => sectors.markIndex(db, { from: '2026-06-30', to: '2025-06-30' }), /from must be before to/);
  assert.throws(() => sectors.markIndex(db, { period: 'week' }), /period must be/);
});

test('API: sectors, companies, index, marks, Explore rows and the company classification', async () => {
  const r = await api('/api/sectors?date=2026-06-30');
  assert.equal(r.status, 200);
  assert.equal(r.body.level, 'sector');
  assert.ok(r.body.taxonomy.sectors.length >= 9);
  const top = await api('/api/market/top?date=2026-06-30&category=company&limit=1');
  assert.ok(near(r.body.totalValue, top.body.totalValue));
  assert.equal((await api('/api/sectors?level=galaxy')).status, 400);
  assert.equal((await api('/api/sectors/companies?level=industry&key=tech.nope')).status, 404);
  const co = await api('/api/sectors/companies?level=industry&key=tech.ai_models&date=2026-06-30');
  assert.equal(co.status, 200);
  assert.ok(co.body.results.some(x => x.name === 'Anthropic'));
  const ix = await api('/api/sectors/index?level=sector&from=2025-06-30&to=2026-06-30');
  assert.equal(ix.status, 200);
  assert.ok(ix.body.method.chains);
  const mk = await api('/api/sectors/marks?level=theme&key=ai&from=2025-12-31&to=2026-06-30');
  assert.equal(mk.status, 200);
  const pv = await api(
    '/api/analysis/pivot?rows=industry&period=quarter&from=2025-06-30&to=2026-06-30&category=company'
  );
  assert.equal(pv.status, 200);
  assert.equal(pv.body.rows, 'industry');
  const c = await api(`/api/companies/${idOf('Anthropic')}`);
  assert.deepEqual(
    [c.body.company.classification.sector.code, c.body.company.classification.industry.code],
    ['tech', 'tech.ai_models']
  );
  assert.deepEqual(
    c.body.company.classification.themes.map(t => t.code),
    ['ai']
  );
});

test('page titles: a sector page names its group; an unknown code or level is not found', () => {
  const { pageMetaOf } = require('../lib/api/warehouse');
  assert.match(pageMetaOf(db, '/sectors/theme/ai').title, /^AI: private companies/);
  assert.match(pageMetaOf(db, '/sectors/industry/hc.biotech').title, /^Biotech & pharmaceuticals:/);
  assert.deepEqual(pageMetaOf(db, '/sectors/industry/tech.nope'), { notFound: true });
  assert.deepEqual(pageMetaOf(db, '/sectors/galaxy/ai'), { notFound: true });
  assert.deepEqual(pageMetaOf(db, '/sectors/theme/%E0%A4%A'), { notFound: true });
});
