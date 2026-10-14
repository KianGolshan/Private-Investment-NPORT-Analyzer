// What kind of thing a reviewed company is (migration 0022, review F-03): the
// import validates and stores the category, Market's three views filter by it,
// the API rejects an unknown one, and the CLO families renamed in the same
// review kept their ids. Golden fixture (real rows) plus the committed
// data/review files.
//
// Run with: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { goldenWarehouse, readReview } = require('./helpers/warehouseApp');
const { openFixtureWarehouse } = require('./helpers/warehouseFixture');
const { importAliases } = require('../lib/entities/review');
const market = require('../lib/services/market');
const analysis = require('../lib/services/analysis');

const { db, app } = goldenWarehouse();
const categoryOf = id => db.prepare('SELECT category FROM companies WHERE id = ?').get(id).category;

test('the committed review: every private company has a category; the four kinds are all used', () => {
  const rows = db.prepare("SELECT category, COUNT(*) n FROM companies WHERE status = 'private' GROUP BY 1").all();
  assert.deepEqual(rows.map(r => r.category).sort(), ['clo', 'company', 'fund', 'insurance']);
  assert.equal(categoryOf(1), 'company', 'Anthropic');
  assert.equal(categoryOf(5), 'company', 'Stripe');
  const named = name => db.prepare('SELECT id, category FROM companies WHERE name = ?').get(name);
  assert.equal(named('Blackstone Private Credit Fund').category, 'fund');
  assert.equal(named('Rondout').category, 'insurance');
  assert.equal(named('Hockey Parent Holdings').category, 'company', 'the holding company of Hub International');
});

test('the CLO families keep their ids under honest names (an "Octagon 57" that held six CLOs)', () => {
  for (const [id, name] of [
    [771, 'Octagon CLOs (55, 57, 58, 60, 75)'],
    [780, 'OCP CLOs'],
    [769, 'Ares CLOs'],
  ]) {
    const c = db.prepare('SELECT name, category FROM companies WHERE id = ?').get(id);
    assert.deepEqual(c, { name, category: 'clo' }, String(id));
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM company_redirects WHERE old_id IN (771, 780, 769)').get().n, 0);
});

test('Market top: the categories partition the list, and the operating companies are a strict subset', () => {
  const all = market.topCompanies(db, { limit: 1000 });
  const parts = market.CATEGORIES.map(c => market.topCompanies(db, { limit: 1000, categories: [c] }));
  assert.equal(
    parts.reduce((t, p) => t + p.companies, 0),
    all.companies
  );
  assert.ok(Math.abs(parts.reduce((t, p) => t + p.totalValue, 0) - all.totalValue) < 0.01);
  const companies = parts[0];
  assert.ok(companies.companies > 0 && companies.companies < all.companies);
  assert.ok(companies.results.every(r => r.category === 'company'));
  assert.deepEqual(companies.categories, ['company']);
  assert.equal(all.categories, undefined, 'no filter: every category, as before');
  // rows keep the same values as the unfiltered list (only filtered, never recomputed)
  const byId = new Map(all.results.map(r => [r.companyId, r]));
  for (const r of companies.results) assert.equal(r.value, byId.get(r.companyId).value);
  // two categories at once
  const two = market.topCompanies(db, { limit: 1000, categories: ['fund', 'clo'] });
  assert.equal(two.companies, parts[1].companies + parts[2].companies);
});

test('Movers and Newly reported filter the same way', () => {
  const all = analysis.movers(db, { limit: 100 });
  const ops = analysis.movers(db, { limit: 100, categories: ['company'] });
  assert.ok(ops.companies <= all.companies);
  for (const side of ['markUp', 'markDown', 'flowIn', 'flowOut'])
    assert.ok(
      ops[side].every(r => r.category === 'company'),
      side
    );
  const allNew = analysis.newlyReported(db, {});
  const opsNew = analysis.newlyReported(db, { categories: ['company'] });
  assert.ok(opsNew.results.every(r => r.category === 'company'));
  assert.equal(opsNew.results.length, allNew.results.filter(r => r.category === 'company').length);
});

test('the API takes ?category= on the three Market routes and rejects an unknown one', async () => {
  const top = await request(app).get('/api/market/top?category=company&limit=1000').expect(200);
  assert.ok(top.body.results.every(r => r.category === 'company'));
  await request(app).get('/api/market/movers?category=company,fund').expect(200);
  await request(app).get('/api/market/new?category=insurance').expect(200);
  for (const url of [
    '/api/market/top?category=spv',
    '/api/market/movers?category=Company',
    '/api/market/new?category=,x',
  ])
    assert.match((await request(app).get(url).expect(400)).body.error, /category must be one of/, url);
  const c = await request(app).get('/api/companies/1').expect(200);
  assert.equal(c.body.company.category, 'company');
});

test('import: blank is a company, a bad value or two values for one company fail the whole file', () => {
  const base = readReview('aliases.csv');
  const ids = readReview('company_ids.csv');
  const fresh = () => openFixtureWarehouse().db;
  const stripe = r => r.company === 'Stripe';
  // a bad value
  assert.throws(
    () =>
      importAliases(
        fresh(),
        base.map(r => (stripe(r) ? { ...r, category: 'startup' } : r)),
        { ids }
      ),
    /category must be one of company, fund, clo, insurance/
  );
  // two values for one company (its first row says fund, the rest blank)
  let first = true;
  assert.throws(
    () =>
      importAliases(
        fresh(),
        base.map(r => {
          if (!stripe(r) || !first) return r;
          first = false;
          return { ...r, category: 'fund' };
        }),
        { ids }
      ),
    /conflicting status\/track\/category/
  );
  // a change on re-import is applied in place (same id)
  const d = fresh();
  importAliases(d, base, { ids });
  importAliases(
    d,
    base.map(r => (stripe(r) ? { ...r, category: 'fund' } : r)),
    { ids }
  );
  assert.equal(d.prepare('SELECT category FROM companies WHERE id = 5').get().category, 'fund');
  importAliases(d, base, { ids });
  assert.equal(d.prepare('SELECT category FROM companies WHERE id = 5').get().category, 'company');
});
