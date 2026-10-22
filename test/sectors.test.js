// P14 (ADR 0010): sector, industry and theme views on the golden fixture (real
// rows) with the committed review files. Sectors and industries add up to
// Market's operating-company total; Explore's sector rows add up to the total
// row and drill to their cell; the mark index follows each fund's own security
// (F62: Fidelity Hastings Street Trust's Anthropic Series F, $140.96 on
// 2025-12-31 to $589.01 on 2026-06-30, raw EDGAR), links period returns of the
// companies marked at both ends, and gives no value below its minimum sample.
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

test("mark index: a company's linked period returns multiply to its change over the window (F62 once, not twice)", () => {
  const id = idOf('Anthropic');
  const { dates } = sectors.windowOf(db, { from: '2025-12-31', to: '2026-06-30', period: 'quarter' });
  const periods = sectors.companyReturns(db, { dates, keep: c => c === id }).get(id);
  assert.equal(periods[0], null);
  const linked = periods.slice(1).reduce((t, p) => t * (1 + p.ret), 1);
  assert.ok(Math.abs(linked - 589.01 / 140.96) < 1e-9, String(linked));
  for (const p of periods.slice(1)) assert.ok(p.chains >= 1 && p.weight > 0);
});

test('mark index: a mark up from a placeholder or a unit restatement ends a chain; write-downs and real step-ups do not (trap 68)', () => {
  const leg = o => ({
    change: 'unchanged',
    per_share: 1,
    split: null,
    prev_report_date: o.prev,
    report_date: o.date,
    ...o,
  });
  // Arctic Canadian Diamond, 0001752724-23-092546: 1,633 sh carried at $0.000006, then $354.32
  const arctic = leg({
    prev: '2022-11-30',
    date: '2023-02-28',
    balance: 1633,
    prev_balance: 1633,
    prev_price: 0.00000612369871402327,
    price: 354.32249846907536,
  });
  assert.equal(sectors.continues(arctic, '2022-11-30'), false);
  // Climeworks, 0001752724-24-126215: 58,205,144.23 units at $1.49 to 7,823,400 at $11.09, both $86.7M
  const climeworks = leg({
    prev: '2023-12-31',
    date: '2024-03-31',
    change: 'reduced',
    balance: 7823400,
    prev_balance: 58205144.23,
    prev_price: 1.4888394997797259,
    price: 11.09046453587954,
  });
  assert.equal(sectors.continues(climeworks, '2023-12-31'), false);
  // Intarcia, 0001752724-20-240890: $4.89 to $0.00001, a real write-down
  const intarcia = leg({
    prev: '2020-06-30',
    date: '2020-09-30',
    balance: 2100446,
    prev_balance: 2100446,
    prev_price: 4.89,
    price: 0.000009997876641437104,
  });
  assert.equal(sectors.continues(intarcia, '2020-06-30'), true);
  // Figure AI, 0000940400-25-014993: $14.57 to $120.91 (x8.3), a real step-up
  const figure = leg({
    prev: '2025-07-31',
    date: '2025-10-31',
    balance: 189096,
    prev_balance: 189096,
    prev_price: 14.57,
    price: 120.91,
  });
  assert.equal(sectors.continues(figure, '2025-07-31'), true);
  // the same step-up with more shares bought is still a mark move
  assert.equal(sectors.continues({ ...figure, balance: 189096 * 3, change: 'added' }, '2025-07-31'), true);
});

test('mark index: the average company caps the extreme 5% at each end; the default window starts at a period end', () => {
  const returns = [...Array(19).fill(0), 100]; // 19 unchanged marks and one +10,000%
  const avg = sectors.averageReturn(returns);
  // the 95th percentile of 20 values is 0.05 of the way from 0 to 100: capped at 5
  assert.ok(Math.abs(avg - 5 / 20) < 1e-12, String(avg));
  assert.equal(sectors.averageReturn([0.1, 0.1, 0.1, 0.1, 0.1]), 0.1);
  for (const period of ['month', 'quarter', 'year']) {
    const w = sectors.windowOf(db, { period });
    assert.ok(w.dates[1] > w.start);
    const m = Number(w.start.slice(5, 7));
    assert.ok(period === 'month' || (period === 'quarter' ? m % 3 === 0 : m === 12), `${period} ${w.start}`);
  }
});

test('mark index: no value below the minimum sample; chain-linked; partial periods flagged', () => {
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
    // 100 the date before the first period with a value; each value is the last one times (1 + change)
    const first = g.points.findIndex(p => p.index != null);
    if (first < 0) continue;
    assert.equal(g.points[first].index, 100, g.key);
    for (let i = first + 1; i < g.points.length && g.points[i].index != null; i++) {
      const p = g.points[i];
      assert.ok(p.sufficient, g.key);
      assert.ok(Math.abs(p.index - g.points[i - 1].index * (1 + p.change)) < 1e-9, g.key);
      assert.ok(p.p25 <= p.change && p.change <= p.p75, g.key);
    }
  }
  const partial = sectors.markIndex(db, { level: 'sector', from: '2025-06-30', to: '2026-05-15' });
  assert.equal(partial.groups[0].points.at(-1).partial, true);
  assert.throws(() => sectors.markIndex(db, { from: '2026-06-30', to: '2025-06-30' }), /from must be before to/);
  assert.throws(() => sectors.markIndex(db, { period: 'week' }), /period must be/);
  assert.throws(() => sectors.markIndex(db, { level: 'theme', keys: ['ai', 'tech.nope'] }), /no theme "tech.nope"/);
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

test('filters: Market, movers and newly reported by sector equal the sector totals; rows carry labels', async () => {
  const date = '2026-06-30';
  const t = sectors.totals(db, { date, level: 'industry' });
  for (const g of t.groups.filter(x => x.key !== 'unclassified').slice(0, 4)) {
    const top = market.topCompanies(db, {
      date,
      limit: 1e9,
      categories: ['company'],
      group: { level: 'industry', key: g.key },
    });
    assert.ok(near(top.totalValue, g.value), g.key);
    assert.equal(top.companies, g.companies);
    assert.ok(top.results.every(r => r.industry === g.key));
    assert.deepEqual(top.results.map(r => r.rank).slice(0, 3), [1, 2, 3].slice(0, Math.min(3, top.results.length)));
  }
  assert.throws(() => market.topCompanies(db, { group: { level: 'industry', key: 'tech.nope' } }), /no industry/);
  const mv = analysis.movers(db, { categories: ['company'], group: { level: 'theme', key: 'ai' }, limit: 100 });
  const ai = new Set(sectors.groupCompanies(db, { level: 'theme', key: 'ai', date }).results.map(r => r.companyId));
  for (const r of [...mv.markUp, ...mv.markDown, ...mv.flowIn, ...mv.flowOut])
    assert.ok(r.themes.includes('ai'), r.name);
  assert.ok(mv.markUp.some(r => ai.has(r.companyId)));
  const nr = analysis.newlyReported(db, { categories: ['company'], group: { level: 'sector', key: 'tech' } });
  assert.ok(nr.results.every(r => r.sector === 'tech'));
  const api1 = await api('/api/market/top?date=2026-06-30&category=company&industry=tech.ai_models&limit=5');
  assert.equal(api1.status, 200);
  assert.equal(api1.body.results[0].name, 'Anthropic');
  assert.equal((await api('/api/market/top?sector=tech&theme=ai')).status, 400);
  const tax = await api('/api/sectors/taxonomy');
  assert.ok(tax.body.sectors.length >= 9 && tax.body.themes.some(x => x.code === 'ai'));
});

test('search: sector, industry and theme names; "AI" is a strong match for the theme', () => {
  const { unifiedSearch } = require('../lib/services/search');
  const hits = unifiedSearch(db, 'AI', { limit: 10 });
  assert.deepEqual([hits[0].type, hits[0].code, hits[0].strong], ['sector', 'ai', true]);
  assert.ok(unifiedSearch(db, 'biotech').some(h => h.type === 'sector' && h.code === 'hc.biotech'));
  assert.equal(unifiedSearch(db, 'Anthropic')[0].type, 'company');
});
