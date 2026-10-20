// Review 2026-10-18 (P13) W3 and W4.
// W3: "known by" on Market top, Firms and the firm book: only filings made on
// or before a day count, amendments included, by the same rule as
// exposureAsOf's knownAsOf (asof.js KNOWN_CANONICAL), held equal here.
// W4: Firms, the firm book and changes, the timeline and Explore (pivot and
// drill) take the same company categories as Market, and give the same
// totals for the same date and category.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { goldenWarehouse } = require('./helpers/warehouseApp');
const { exposureAsOf } = require('../lib/analytics/asof');
const market = require('../lib/services/market');
const firm = require('../lib/services/firm');
const analysis = require('../lib/services/analysis');

const { db, app, idOf } = goldenWarehouse();
const api = url => request(app).get(url).set('Accept-Encoding', 'identity');
const cents = v => Math.round(v * 100);

test('known by: Market top per company equals exposureAsOf({ knownAsOf }) at three dates (A4: Anthropic 82 / $6.23B)', () => {
  for (const [date, known] of [
    ['2026-06-30', true],
    ['2026-03-31', '2026-06-01'],
    ['2025-12-31', true],
  ]) {
    const top = market.topCompanies(db, { date, knownAsOf: known, limit: 1000 });
    assert.equal(top.knownAsOf, known === true ? date : known);
    for (const r of top.results) {
      const e = exposureAsOf(db, { companyId: r.companyId, date, knownAsOf: known });
      assert.equal(cents(r.value), cents(e.total), `${r.name} ${date}`);
      assert.equal(r.funds, e.funds, `${r.name} ${date}`);
    }
    // and no company exposureAsOf finds is missing from the list
    const listed = new Set(top.results.map(r => r.companyId));
    for (const { id } of db.prepare("SELECT id FROM companies WHERE status = 'private'").all())
      if (!listed.has(id)) assert.equal(exposureAsOf(db, { companyId: id, date, knownAsOf: known }).total, 0, `${id}`);
  }
  const a = market.topCompanies(db, { date: '2026-06-30', knownAsOf: true, limit: 1000 }).results;
  const anthropic = a.find(r => r.companyId === idOf('Anthropic'));
  assert.equal(
    anthropic.funds,
    exposureAsOf(db, { companyId: idOf('Anthropic'), date: '2026-06-30', knownAsOf: true }).funds
  );
});

test('known by: an amendment filed after the day leaves the original in force (Coatue, F16)', () => {
  const coatue = 'CIK2044519';
  const book = known => {
    const id = [...firm.fundFirms(db).byFund.get(coatue)].find(f => f.role !== 'subadviser').managerId;
    return firm.firmBook(db, id, { date: '2026-03-31', knownAsOf: known }).byFund.find(f => f.fundKey === coatue);
  };
  assert.equal(book('2026-06-01').accession, '0001410368-26-056381');
  assert.equal(book('2026-06-30').accession, '0001410368-26-061868');
  // before either was filed, nothing from that report date: the fund shows its earlier filing or nothing
  const before = book('2026-05-01');
  assert.ok(!before || before.markDate < '2026-03-31');
});

test('known by: without it every answer is byte-identical to today; with a far-future day too', () => {
  for (const date of ['2025-12-31', '2026-06-30']) {
    const plain = market.topCompanies(db, { date, limit: 1000 });
    const far = market.topCompanies(db, { date, limit: 1000, knownAsOf: '9999-12-31' });
    assert.deepEqual({ ...far, knownAsOf: undefined }, { ...plain, knownAsOf: undefined });
    const f0 = firm.firms(db, { date, limit: 1000 });
    const f1 = firm.firms(db, { date, limit: 1000, knownAsOf: '9999-12-31' });
    assert.deepEqual(f1.results, f0.results);
    assert.equal(cents(f1.uniqueValue), cents(f0.uniqueValue));
    assert.equal(f0.knownAsOf, undefined);
  }
});

test('known by: Firms and each firm book read the same filings; the 123-day edge holds in both modes', () => {
  const date = '2026-06-30';
  const list = firm.firms(db, { date, knownAsOf: true, limit: 1000 });
  for (const f of list.results.filter(x => x.value > 0).slice(0, 8)) {
    const b = firm.firmBook(db, f.id, { date, knownAsOf: true });
    assert.equal(cents(b.value), cents(f.value), f.name);
    assert.ok(b.byFund.every(x => x.markDate <= date));
    // every position's filing was made by the day
    for (const c of b.byCompany)
      for (const p of c.positions)
        assert.ok(
          db.prepare('SELECT filing_date FROM filings WHERE accession = ?').get(p.accession).filing_date <= date
        );
  }
  // known by the day before a fund's only fresh filing: that fund falls back or drops out, never a later filing
  const k = market.topCompanies(db, { date, knownAsOf: '2026-01-01', limit: 1000 });
  assert.ok(k.totalValue <= market.topCompanies(db, { date, limit: 1000 }).totalValue);
  // an empty answer, not an error, before any filing
  const none = market.topCompanies(db, { date: '2019-01-31', knownAsOf: true, limit: 10 });
  assert.deepEqual([none.companies, none.totalValue], [0, 0]);
  assert.throws(() => market.topCompanies(db, { date, knownAsOf: 'yesterday' }), /knownAsOf must be an ISO date/);
});

test('category: Firms, the firm book and Explore give Market’s total for the same date and category', () => {
  for (const date of ['2025-12-31', '2026-06-30']) {
    for (const categories of [['company'], ['fund'], undefined]) {
      const top = market.topCompanies(db, { date, categories, limit: 1000 });
      const list = firm.firms(db, { date, categories, limit: 1000 });
      // every fund holding private companies has a firm in the golden data, so the unique total is Market's
      assert.equal(cents(list.uniqueValue), cents(top.totalValue), `${date} ${categories}`);
      for (const f of list.results.filter(x => x.value > 0).slice(0, 5)) {
        const b = firm.firmBook(db, f.id, { date, categories });
        assert.equal(cents(b.value), cents(f.value), `${f.name} ${date} ${categories}`);
        const ids = market.categoryIds(db, categories);
        if (ids) for (const c of b.byCompany) assert.ok(ids.has(c.companyId));
      }
      const p = analysis.pivot(db, {
        rows: 'firm',
        period: 'quarter',
        from: '2025-06-30',
        to: date,
        categories,
        limit: 1000,
      });
      const last = p.total.value[p.total.value.length - 1];
      assert.equal(cents(last), cents(top.totalValue), `pivot total ${date} ${categories}`);
      // the drill behind the total value cell sums to it
      const dr = analysis.drill(db, {
        rows: 'firm',
        metric: 'value',
        from: p.periods.at(-1).from,
        to: date,
        categories,
        limit: 2000,
      });
      assert.equal(cents(dr.total), cents(last));
    }
  }
  // the category is said on the answer only when asked
  assert.deepEqual(firm.firms(db, { categories: ['company'] }).categories, ['company']);
  assert.equal(firm.firms(db, {}).categories, undefined);
});

test('category: a firm holding only fund interests reads $0 for operating companies; changes and timeline narrow too', () => {
  const date = '2026-06-30';
  const all = firm.firms(db, { date, limit: 1000 }).results;
  const ops = new Map(firm.firms(db, { date, categories: ['company'], limit: 1000 }).results.map(f => [f.id, f]));
  const fundOnly = all.find(f => f.value > 0 && (ops.get(f.id)?.value || 0) === 0);
  if (fundOnly) {
    const b = firm.firmBook(db, fundOnly.id, { date, categories: ['company'] });
    assert.deepEqual([b.value, b.companies], [0, 0]);
  }
  const big = all.find(f => f.value > 0);
  const ids = market.categoryIds(db, ['company']);
  const ch = firm.firmChanges(db, big.id, { categories: ['company'] });
  assert.ok(ch.events.every(e => ids.has(e.companyId)));
  assert.ok(ch.count <= firm.firmChanges(db, big.id, {}).count);
  const t = analysis.timeline(db, { firm: big.id, categories: ['company'] });
  assert.ok(t.companies.every(c => ids.has(c.companyId)));
  assert.throws(() => firm.firms(db, { categories: ['stocks'] }), /category must be one of/);
});

test('routes: ?known=1 and ?category= reach Market, Firms, a firm, Explore and the timeline', async () => {
  const date = '2026-06-30';
  const top = (await api(`/api/market/top?date=${date}&known=1`).expect(200)).body;
  assert.equal(top.knownAsOf, date);
  const fl = (await api(`/api/firms?date=${date}&known=1&category=company`).expect(200)).body;
  assert.deepEqual([fl.knownAsOf, fl.categories], [date, ['company']]);
  const id = fl.results[0].id;
  const b = (await api(`/api/firms/${id}?date=${date}&known=1&category=company`).expect(200)).body;
  assert.equal(cents(b.value), cents(fl.results[0].value));
  const p = (await api(`/api/analysis/pivot?rows=firm&from=2025-12-31&to=${date}&category=company`).expect(200)).body;
  assert.deepEqual(p.categories, ['company']);
  const t = (await api(`/api/analysis/timeline?firm=${id}&category=company`).expect(200)).body;
  assert.deepEqual(t.categories, ['company']);
  await api(`/api/market/top?knownAsOf=soon`).expect(400);
});

test('category: the bridge in a firm scope reconciles and equals the pivot for the same category', () => {
  const date = '2026-06-30';
  const id = firm.firms(db, { date, categories: ['company'] }).results[0].id;
  const scope = { firm: [id], fund: [], class: [], kind: [] };
  const b = analysis.bridge(db, { scope, from: '2025-12-31', to: date, categories: ['company'] });
  assert.ok(b.reconciled);
  assert.deepEqual(b.categories, ['company']);
  const p = analysis.pivot(db, {
    scope,
    rows: 'company',
    period: 'quarter',
    from: '2025-12-31',
    to: date,
    categories: ['company'],
    limit: 1000,
  });
  assert.equal(cents(b.end.value), cents(p.total.value.at(-1)));
  assert.equal(cents(b.end.value), cents(firm.firmBook(db, id, { date, categories: ['company'] }).value));
});
