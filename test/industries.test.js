// P14 (ADR 0010): sector, industry and theme decisions. The import refuses
// anything it cannot place (unknown codes, a name that does not match its id, a
// label on a fund interest, a blank industry that is not "unclear"); the job
// refuses a private operating company with no decision; on the committed review
// files every private operating company has one, and sector totals add up to
// Market's operating-company total to the cent.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { importTaxonomy, importIndustries } = require('../lib/entities/review');
const { unlabeledCompanies } = require('../lib/warehouse/job');
const { goldenWarehouse, readReview } = require('./helpers/warehouseApp');
const market = require('../lib/services/market');

const TAXONOMY = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'review', 'taxonomy.json'), 'utf8'));
const { db, idOf } = goldenWarehouse();
const row = (over = {}) => ({
  company_id: String(idOf('Anthropic')),
  company: 'Anthropic',
  industry: 'tech.ai_models',
  themes: 'ai',
  confidence: 'high',
  source: 'test',
  note: '',
  ...over,
});
const committed = readReview('industries.csv');
const others = committed.filter(r => r.company !== 'Anthropic');
const reimport = () => importIndustries(db, committed);

test('taxonomy: the committed file imports; bad codes, misplaced industries and repeats are refused', () => {
  assert.equal(importTaxonomy(db, TAXONOMY).version, TAXONOMY.version);
  assert.equal(db.prepare('SELECT version FROM taxonomy_meta').get().version, TAXONOMY.version);
  const copy = () => JSON.parse(JSON.stringify(TAXONOMY));
  const t1 = copy();
  t1.sectors[0].industries[0].code = 'hc.wrong';
  assert.throws(() => importTaxonomy(db, t1), /not under sector/);
  const t2 = copy();
  t2.themes.push({ ...t2.themes[0] });
  assert.throws(() => importTaxonomy(db, t2), /appears twice/);
  const t3 = copy();
  delete t3.version;
  assert.throws(() => importTaxonomy(db, t3), /version/);
  assert.throws(() => importTaxonomy(db, { ...copy(), sectors: [] }), /sectors/);
  // a refused import changes nothing: the committed taxonomy and labels are still there
  importTaxonomy(db, TAXONOMY);
  reimport();
});

test('industries: each refusal names the file and line, and nothing half-imports', () => {
  const before = db.prepare('SELECT COUNT(*) n FROM company_industry').get().n;
  const cases = [
    [row({ industry: 'tech.nope' }), /unknown industry/],
    [row({ themes: 'ai|robots' }), /unknown theme/],
    [row({ themes: 'ai|ai' }), /appears twice/],
    [row({ company: 'Anthropic PBC' }), /is "Anthropic", the file says/],
    [row({ company_id: '999999' }), /not in the reviewed list/],
    [row({ industry: '', confidence: 'high' }), /blank industry/],
    [row({ industry: 'tech.ai_models', confidence: 'unclear' }), /blank industry/],
    [row({ confidence: 'sure' }), /confidence must be/],
    [row({ source: '' }), /empty source/],
  ];
  for (const [bad, re] of cases) {
    assert.throws(() => importIndustries(db, [...others, bad]), re);
    assert.throws(() => importIndustries(db, [...others, bad]), /industries\.csv line \d+/);
  }
  assert.throws(() => importIndustries(db, [row(), row()]), /appears twice/);
  const fund = db.prepare("SELECT id, name FROM companies WHERE category = 'fund' LIMIT 1").get();
  assert.throws(
    () => importIndustries(db, [row({ company_id: String(fund.id), company: fund.name })]),
    /industries are for operating companies/
  );
  assert.equal(db.prepare('SELECT COUNT(*) n FROM company_industry').get().n, before);
});

test('industries: "not yet classified" is a decision; the file is the input used', () => {
  importIndustries(db, [...others, row({ industry: '', themes: '', confidence: 'unclear', note: 'test' })]);
  assert.deepEqual(
    db.prepare('SELECT industry, confidence FROM company_industry WHERE company_id = ?').get(idOf('Anthropic')),
    { industry: null, confidence: 'unclear' }
  );
  assert.equal(db.prepare('SELECT COUNT(*) n FROM company_themes WHERE company_id = ?').get(idOf('Anthropic')).n, 0);
  importIndustries(db, [...others, row({ industry: 'tech.software', themes: 'ai|fintech' })]);
  assert.equal(
    db.prepare('SELECT industry FROM company_industry WHERE company_id = ?').get(idOf('Anthropic')).industry,
    'tech.software'
  );
  assert.deepEqual(
    db
      .prepare('SELECT theme FROM company_themes WHERE company_id = ? ORDER BY theme')
      .all(idOf('Anthropic'))
      .map(r => r.theme),
    ['ai', 'fintech']
  );
  reimport();
  const a = db.prepare('SELECT industry, confidence FROM company_industry WHERE company_id = ?').get(idOf('Anthropic'));
  assert.deepEqual(a, { industry: 'tech.ai_models', confidence: 'high' });
});

test('job guard: a private operating company with no decision is a problem; with the committed file there is none', () => {
  assert.deepEqual(unlabeledCompanies(db), []);
  importIndustries(db, others);
  assert.deepEqual(
    unlabeledCompanies(db).map(c => c.name),
    ['Anthropic']
  );
  reimport();
  assert.deepEqual(unlabeledCompanies(db), []);
});

test('committed labels: every private operating company has one decision; sectors add up to Market', () => {
  const companies = db
    .prepare("SELECT id FROM companies WHERE status = 'private' AND category = 'company'")
    .all()
    .map(r => r.id);
  const labeled = new Set(
    db
      .prepare('SELECT company_id FROM company_industry')
      .all()
      .map(r => r.company_id)
  );
  assert.equal(companies.filter(id => !labeled.has(id)).length, 0);
  const sectorOf = new Map(
    db
      .prepare(
        'SELECT ci.company_id id, i.sector FROM company_industry ci LEFT JOIN taxonomy_industries i ON i.code = ci.industry'
      )
      .all()
      .map(r => [r.id, r.sector])
  );
  for (const date of ['2025-12-31', '2026-03-31', '2026-06-30']) {
    const top = market.topCompanies(db, { date, limit: 100000, categories: ['company'] });
    const bySector = new Map();
    for (const c of top.results) {
      const s = sectorOf.get(c.companyId) ?? 'unclassified';
      bySector.set(s, (bySector.get(s) || 0) + c.value);
    }
    const sum = [...bySector.values()].reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - top.totalValue) < 0.01, `${date}: ${sum} vs ${top.totalValue}`);
  }
  // the fixture's real companies carry the reviewed labels
  const label = name =>
    db.prepare('SELECT industry FROM company_industry WHERE company_id = ?').get(idOf(name)).industry;
  assert.equal(label('Anthropic'), 'tech.ai_models');
  assert.equal(label('Stripe'), 'fin.payments');
  assert.equal(label('Databricks'), 'tech.software');
});

test('industries: a blank id (a company new in this import) resolves by exact name; an unknown name fails', () => {
  const r = importIndustries(db, [...others, row({ company_id: '' })]);
  assert.equal(r.resolved, 1);
  assert.equal(r.rows.find(x => x.company === 'Anthropic').company_id, idOf('Anthropic'));
  assert.ok(
    r.rows.every((x, i, a) => i === 0 || a[i - 1].company_id < x.company_id),
    'written back in id order'
  );
  assert.throws(
    () => importIndustries(db, [...others, row({ company_id: '', company: 'Anthropic Inc.' })]),
    /no company named "Anthropic Inc\."/
  );
  reimport();
});
