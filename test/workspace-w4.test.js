// P6b W4 on the golden fixture (real rows): the Explore drill, Market movers
// and newly reported companies, the scoped feed, the watchlist and Compare.
// Each answer is held equal to the pivot, the bridge, exposureAsOf,
// companyActivity or a post-filter of the unfiltered answer (LESSONS 26).
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const nock = require('nock');
const { goldenWarehouse } = require('./helpers/warehouseApp');
const { exposureAsOf, companyRows } = require('../lib/analytics/asof');
const { companyActivity } = require('../lib/analytics/activity');
const analysis = require('../lib/services/analysis');
const firm = require('../lib/services/firm');

const { db, app, idOf, firmIdOf } = goldenWarehouse();
const api = url => request(app).get(url).set('Accept-Encoding', 'identity').expect(200);
const cents = v => Math.round(v * 100) / 100;
const scope = s => ({ firm: [], fund: [], class: [], kind: [], ...s });
const privateIds = db
  .prepare('SELECT DISTINCT p.company_id id FROM position_facts p JOIN companies c ON c.id = p.company_id')
  .all()
  .map(r => r.id);

test.before(() => {
  nock.disableNetConnect();
  nock.enableNetConnect('127.0.0.1');
});
test.after(() => nock.enableNetConnect());

test('explore exit check: pivot value cells equal exposureAsOf for every private company at every period end', () => {
  const p = analysis.pivot(db, {
    rows: 'company',
    period: 'quarter',
    from: '2024-12-31',
    to: '2026-06-30',
    limit: 1e6,
  });
  for (const id of privateIds) {
    const r = p.results.find(x => x.key === id);
    p.periods.forEach((per, i) => {
      const x = exposureAsOf(db, { companyId: id, date: per.to });
      assert.equal(cents(r?.value[i] || 0), cents(x.total), `company ${id} ${per.to}`);
      assert.equal(r?.holders[i] || 0, x.funds, `company ${id} ${per.to} holders`);
    });
  }
});

test('drill: every cell’s legs sum to the cell (firm, fund, company, class rows; every metric; the total row)', () => {
  const cg = firmIdOf('Capital Group (American Funds)');
  for (const [rows, opts] of [
    ['firm', {}],
    ['fund', { scope: scope({ firm: [cg] }) }],
    ['company', {}],
    ['class', { ref: { companyId: idOf('Anthropic') } }],
  ]) {
    const p = analysis.pivot(db, { rows, period: 'quarter', from: '2025-06-30', to: '2026-06-30', limit: 4, ...opts });
    for (const r of [...p.results, { key: null, ...p.total }])
      for (const metric of p.metrics)
        p.periods.forEach((per, i) => {
          const d = analysis.drill(db, { rows, key: r.key, metric, from: per.from, to: per.to, limit: 1e6, ...opts });
          assert.ok(Math.abs(d.total - r[metric][i]) < 0.005, `${rows} ${r.key} ${metric} ${per.label}`);
          if (metric !== 'holders') {
            const legSum = d.events.flatMap(e => e.legs).reduce((t, l) => t + l.amount, 0);
            assert.ok(Math.abs(legSum - r[metric][i]) < 0.005, `${rows} ${r.key} ${metric} ${per.label} legs`);
          }
        });
  }
});

test('drill lands on the right events: Growth Fund of America’s Stripe add (2026-05-31) and companyActivity', () => {
  const stripe = idOf('Stripe');
  const d = analysis.drill(db, {
    rows: 'company',
    key: stripe,
    metric: 'added',
    from: '2026-03-31',
    to: '2026-06-30',
    limit: 1e6,
  });
  const gfa = d.events.find(e => e.fundKey === 'S000009228' && e.accession === '0001193125-26-323081');
  assert.ok(gfa, 'the GFA filing is in the drill');
  assert.equal(gfa.label, 'added');
  assert.equal(gfa.markDate, '2026-05-31');
  const leg = gfa.legs.find(l => l.instrumentKey === 'ECS282034');
  assert.equal(cents(leg.amount), 149999976); // 2,380,952 sh × $63.00 (F43)
  // Every flow event in a company's drill is the companyActivity event of that fund's filing, same type.
  for (const metric of ['firstReported', 'added', 'reduced', 'exited', 'mark']) {
    const dd = analysis.drill(db, {
      rows: 'company',
      key: stripe,
      metric,
      from: '2024-12-31',
      to: '2026-06-30',
      limit: 1e6,
    });
    const acts = companyActivity(db, { companyId: stripe }, { since: '2025-01-01' });
    const byKey = new Map(acts.map(e => [`${e.fundKey}|${e.accession}`, e]));
    for (const e of dd.events) {
      const a = byKey.get(`${e.fundKey}|${e.accession}`);
      assert.ok(a, `${metric}: ${e.fundKey} ${e.accession} is a companyActivity event`);
      assert.equal(a.type, e.event, `${metric}: ${e.accession}`);
    }
  }
});

test('drill: value legs in force are exposureAsOf’s holdings, fund for fund', () => {
  const id = idOf('Anthropic');
  const d = analysis.drill(db, { rows: 'company', key: id, metric: 'value', from: '2026-03-31', to: '2026-06-30' });
  const x = exposureAsOf(db, { companyId: id, date: '2026-06-30' });
  assert.equal(cents(d.total), cents(x.total));
  const held = new Set(x.holdings.map(h => h.fundKey));
  for (const e of d.events.filter(e => e.amount > 0)) assert.ok(held.has(e.fundKey), e.fundKey);
  assert.equal(d.rowLabel, 'Anthropic');
  assert.ok(d.events.every(e => e.cik && e.fundLabel && e.company === 'Anthropic'));
});

test('movers: each company’s mark and position effects equal its bridge over the window', () => {
  const m = analysis.movers(db, { from: '2025-06-30', to: '2026-06-30', limit: 1000 });
  const all = [...m.markUp, ...m.markDown, ...m.flowIn, ...m.flowOut];
  assert.ok(all.length > 0);
  for (const r of all) {
    const b = analysis.bridge(db, { ref: { companyId: r.companyId }, from: m.from, to: m.to });
    assert.equal(cents(r.markEffect), cents(b.markEffect), r.name);
    assert.equal(cents(r.positionEffect), cents(b.positionEffect), r.name);
    assert.equal(cents(r.startValue), cents(b.start.value), r.name);
    assert.equal(cents(r.endValue), cents(b.end.value), r.name);
  }
  assert.ok(m.markUp.every((r, i, a) => r.markEffect > 0 && (!i || a[i - 1].markEffect >= r.markEffect)));
  assert.ok(m.flowOut.every(r => r.positionEffect < 0));
});

test('newly reported: the company’s first stored holding falls in the window; value equals exposureAsOf', () => {
  const n = analysis.newlyReported(db, { from: '2019-12-31', to: '2026-06-30' });
  assert.ok(n.count > 0);
  for (const r of n.results) {
    const rows = companyRows(db, { companyId: r.companyId }, '9999-12-31').filter(x => x.value_usd > 0);
    const first = rows.reduce((m, x) => (x.report_date < m ? x.report_date : m), '9999');
    assert.equal(r.firstMarkDate, first, r.name);
    assert.ok(r.firstMarkDate > n.from && r.firstMarkDate <= n.to);
    const x = exposureAsOf(db, { companyId: r.companyId, date: n.to });
    assert.equal(cents(r.value), cents(x.total), r.name);
    assert.ok(r.firstAccession && r.cik && r.how.length);
  }
  // A company held from the first stored quarter is never "new".
  assert.ok(analysis.newlyReported(db, { from: '2019-01-01', to: '2019-12-31' }).count === 0);
});

test('feed: firm and fund filters equal a post-filter of the unfiltered feed', async () => {
  const cg = firmIdOf('Capital Group (American Funds)');
  const all = (await api('/api/feed?since=2026-07-01&until=2026-09-30&all=1')).body;
  const scoped = (await api(`/api/feed?since=2026-07-01&until=2026-09-30&all=1&firm=${cg}`)).body;
  const funds = new Set(firm.fundFirms(db).byFirm.get(cg).managed);
  assert.deepEqual(
    scoped.events.map(e => `${e.fundKey}|${e.accession}|${e.companyId}`),
    all.events.filter(e => funds.has(e.fundKey)).map(e => `${e.fundKey}|${e.accession}|${e.companyId}`)
  );
  assert.deepEqual(scoped.filters, { firm: [cg] });
  assert.equal(scoped.scope, 'all reviewed private companies'); // v1 reads this
  const one = (await api('/api/feed?since=2026-07-01&until=2026-09-30&all=1&fund=S000009228')).body;
  assert.ok(one.events.length > 0 && one.events.every(e => e.fundKey === 'S000009228'));
  await request(app).get('/api/feed?class=Series%20G').expect(400);
});

test('watchlist: companies equal exposureAsOf, firms the firm list, funds their pivot row', async () => {
  const cg = firmIdOf('Capital Group (American Funds)');
  const w = (await api(`/api/watchlist?company=${idOf('Anthropic')},${idOf('Stripe')}&firm=${cg}&fund=s000009228`))
    .body;
  const date = w.date;
  for (const it of w.items.filter(i => i.kind === 'company')) {
    const x = exposureAsOf(db, { companyId: it.key, date });
    assert.equal(cents(it.value), cents(x.total));
    assert.equal(it.funds, x.funds);
    const y = exposureAsOf(db, { companyId: it.key, date: w.yearAgo });
    assert.equal(cents(it.valueYearAgo), cents(y.total));
  }
  const f = w.items.find(i => i.kind === 'firm');
  const listed = firm.firms(db, { date, limit: 1000 }).results.find(x => x.id === cg);
  assert.equal(cents(f.value), cents(listed.value));
  assert.equal(f.label, 'Capital Group (American Funds)');
  const fund = w.items.find(i => i.kind === 'fund');
  assert.equal(fund.key, 'S000009228');
  const p = analysis.pivot(db, { rows: 'fund', period: 'year', from: w.yearAgo, to: date, keys: ['S000009228'] });
  assert.equal(cents(fund.value), cents(p.results[0].value.at(-1)));
  await request(app).get('/api/watchlist?company=abc').expect(400);
});

test('compare: rows equal the pivot’s; class marks are same-date medians of the funds that filed them', async () => {
  const ids = [idOf('Anthropic'), idOf('Stripe')];
  const c = (await api(`/api/analysis/compare?rows=company&key=${ids[0]}&key=${ids[1]}&from=2025-06-30&to=2026-06-30`))
    .body;
  const p = analysis.pivot(db, {
    rows: 'company',
    period: 'quarter',
    from: '2025-06-30',
    to: '2026-06-30',
    limit: 1e6,
  });
  assert.deepEqual(
    c.results.map(r => r.key),
    ids
  );
  for (const r of c.results) {
    const q = p.results.find(x => x.key === r.key);
    assert.deepEqual(r.value.map(cents), q.value.map(cents));
    assert.deepEqual(r.markEffect.map(cents), q.markEffect.map(cents));
    assert.ok(r.markClass && r.marks.length > 0);
  }
  const cls = (
    await api(
      `/api/analysis/compare?rows=class&key=${ids[0]}:Series%20G&key=${ids[1]}:Common%20B&from=2025-06-30&to=2026-06-30`
    )
  ).body;
  const byDate = analysis.marksByDate(db);
  for (const r of cls.results)
    for (const m of r.marks) {
      const list = byDate.get(`${r.key.replace(':', '\u0000')}\u0000${m.markDate}`);
      const s = list.map(x => x.price).sort((a, b) => a - b);
      const h = s.length >> 1;
      assert.equal(m.median, s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2);
    }
  await request(app).get(`/api/analysis/compare?rows=company&key=${ids[0]}`).expect(400);
  await request(app).get('/api/analysis/compare?rows=class&key=1&key=2').expect(400);
});

test('routes: drill, movers and newly reported answer through the API; bad input is 400', async () => {
  const d = (await api('/api/analysis/drill?rows=firm&metric=value&from=2026-03-31&to=2026-06-30')).body;
  assert.equal(d.rowLabel, 'Total');
  assert.ok(d.events.length > 0 && d.events.length <= 200);
  const m = (await api('/api/market/movers?from=2025-06-30&to=2026-06-30')).body;
  assert.ok(m.markUp.length > 0 && m.label.startsWith('changes in filings'));
  const n = (await api('/api/market/new?from=2025-06-30&to=2026-06-30')).body;
  assert.ok(Array.isArray(n.results));
  const t = (await api('/api/analysis/pivot?rows=company&period=year&tracked=1&from=2025-06-30&to=2026-06-30')).body;
  const tracked = new Set(
    db
      .prepare('SELECT company_id FROM tracked_companies')
      .all()
      .map(r => r.company_id)
  );
  assert.ok(t.tracked && t.results.every(r => tracked.has(r.key)));
  await request(app).get('/api/analysis/drill?metric=sales').expect(400);
  await request(app).get('/api/analysis/drill?rows=class&key=Series%20G').expect(400);
  await request(app).get('/api/market/movers?from=2026-06-30&to=2025-06-30').expect(400);
});
