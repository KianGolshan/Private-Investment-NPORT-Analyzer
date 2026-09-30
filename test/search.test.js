// Phase 5a: search over every issuer (lib/services/search.js), unreviewed
// entities and their row tags (lib/entities/entities.js), and company_stats.
// Offline, on real rows: test/fixtures/search/ (Hockey Parent / HUB INTL,
// OpenAI with OPEN AI GLOBAL and BlackRock's OpenAir.com label, FHU US Holdings
// / Chobani, Pfizer, Vercel, the Stripes PE funds), rebuilt from warehouse.db
// by its build-fixture.js, with the committed data/review/ files.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { importAliases } = require('../lib/entities/review');
const { resolveCompanies } = require('../lib/entities/resolve');
const { parseCsv } = require('../lib/entities/csv');
const { identityUpkeep, unresolvedReport } = require('../lib/entities/report');
const { rebuildEntities, searchVariants } = require('../lib/entities/entities');
const { search, editDistance } = require('../lib/services/search');
const { exposureAsOf } = require('../lib/analytics/asof');
const { openFixtureWarehouse } = require('./helpers/warehouseFixture');

const FIXTURE = path.join(__dirname, 'fixtures', 'search', 'warehouse.json.gz');
const REVIEW = path.join(__dirname, '..', 'data', 'review');
const read = f => parseCsv(fs.readFileSync(path.join(REVIEW, f), 'utf8'));

function build({ dropAlias } = {}) {
  const { db } = openFixtureWarehouse(FIXTURE);
  const aliases = read('aliases.csv').filter(r => !(dropAlias && r.alias === dropAlias));
  importAliases(db, aliases, { ids: read('company_ids.csv'), now: '2026-09-30T00:00:00Z' });
  resolveCompanies(db);
  const up = identityUpkeep(db);
  const stats = rebuildEntities(db, up);
  return { db, up, stats };
}

const { db, up, stats } = build();
const idOf = name => db.prepare('SELECT id FROM companies WHERE name = ?').get(name).id;
const top = (q, d = db) => search(d, q)[0];

// ---- Units ----

test('search: spelling variants and edit distance', () => {
  assert.ok(searchVariants('FHUS').some(v => searchVariants('FHU US').includes(v)));
  assert.ok(searchVariants('Hub International').some(v => searchVariants('HUB INTL').includes(v)));
  assert.ok(searchVariants('Open AI').some(v => searchVariants('OPENAI').includes(v)));
  assert.ok(!searchVariants('OpenAir').some(v => searchVariants('OPENAI').includes(v)));
  assert.equal(editDistance('DATABRIKS', 'DATABRICKS', 1), 1);
  assert.equal(editDistance('DATABRICSK', 'DATABRICKS', 1), 1); // transposition
  assert.equal(editDistance('ANTHROPIC', 'OPENAI', 2), 3); // stops above the bound
});

// ---- The ROADMAP §5a search cases, each with its match reason ----

test('search: Chobani, FHU, FHUS and "fhu us holdings" all find FHU US Holdings (F29)', () => {
  const fhu = idOf('FHU US Holdings');
  const cases = {
    Chobani: { how: 'exact', via: 'brand' },
    FHU: { how: 'prefix' },
    FHUS: { how: 'normalized' },
    'fhu us holdings': { how: 'exact', via: 'name' },
  };
  for (const [q, want] of Object.entries(cases)) {
    const r = top(q);
    assert.equal(r.type, 'company', q);
    assert.equal(r.id, fhu, q);
    for (const [k, v] of Object.entries(want)) assert.equal(r.match[k], v, `${q}: ${k}`);
  }
  assert.equal(top('Chobani').match.detail, '0001099263-26-006603', 'the brand cites its filing');
});

test('search: "Open AI" finds OpenAI; "Databrick" and "Databriks" find Databricks', () => {
  const openai = top('Open AI');
  assert.equal(openai.id, idOf('OpenAI'));
  assert.ok(['exact', 'normalized'].includes(openai.match.how));
  assert.deepEqual(
    { id: top('Databrick').id, how: top('Databrick').match.how },
    { id: idOf('Databricks'), how: 'prefix' }
  );
  assert.deepEqual(
    { id: top('Databriks').id, how: top('Databriks').match.how },
    { id: idOf('Databricks'), how: 'similar' }
  );
});

test('search: "Hub International" finds Hockey Parent Holdings by its brand HUB INTL, ahead of an unreviewed name', () => {
  const [first, ...rest] = search(db, 'Hub International');
  assert.equal(first.id, idOf('Hockey Parent Holdings'));
  assert.deepEqual([first.match.how, first.match.via, first.match.text], ['normalized', 'brand', 'HUB INTL']);
  // AMG Pantheon's "Hub International" co-investment line is not Hockey Parent's security: unreviewed, apart.
  assert.ok(rest.every(r => r.type !== 'company' || r.id !== first.id));
});

test('search: "OpenAir" matches OpenAI only through the curated alias (F32), never by spelling', () => {
  const r = top('OpenAir');
  assert.equal(r.id, idOf('OpenAI'));
  assert.deepEqual([r.match.how, r.match.via, r.match.text], ['exact', 'alias', 'OPENAIR']);
  const without = build({ dropAlias: 'OPENAIR' }).db;
  const results = search(without, 'OpenAir');
  assert.ok(results.length > 0, 'the OpenAir.com rows are still findable');
  assert.ok(!results.some(x => x.type === 'company' && x.name === 'OpenAI'), JSON.stringify(results));
  assert.ok(results.every(x => x.match.how !== 'similar'));
  assert.equal(results[0].type, 'unreviewed');
  without.close();
});

test('search: look-alikes stay apart and labeled (Stripe vs the Stripes PE funds)', () => {
  const [first, ...rest] = search(db, 'Stripe');
  assert.equal(first.id, idOf('Stripe'));
  const stripes = rest.filter(r => /^STRIPES/i.test(r.name));
  assert.ok(stripes.length > 0);
  assert.ok(stripes.every(r => r.type === 'unreviewed' && r.match.how !== 'exact'));
});

test('search: a listed company comes back with its status (Pfizer, F24), and short queries return nothing', () => {
  const r = top('Pfizer');
  assert.deepEqual([r.type, r.status, r.reviewed], ['company', 'public', true]);
  assert.deepEqual(search(db, 'ab'), []);
  assert.deepEqual(search(db, '  '), []);
});

// ---- Unreviewed entities ----

test('unreviewed: "Vercel" is an unreviewed company, and its answer equals the pattern answer on the same rows', () => {
  const r = top('Vercel');
  assert.equal(r.type, 'unreviewed');
  assert.equal(r.category, 'company');
  const date = r.evidence.lastMarkDate;
  const byEntity = exposureAsOf(db, { entityId: r.id, date });
  const byPattern = exposureAsOf(db, { pattern: '\\bvercel\\b', date });
  assert.ok(byEntity.funds > 0);
  assert.deepEqual(
    byEntity.holdings.map(h => [h.fundKey, h.accession, h.value]),
    byPattern.holdings.map(h => [h.fundKey, h.accession, h.value])
  );
});

test('unreviewed: every review-queue component is an entity with the same category, funds and value', () => {
  const report = unresolvedReport(up, { threshold: 50e6 });
  assert.ok(report.components.length > 0);
  const get = db.prepare('SELECT category, current_funds, current_value_usd FROM unreviewed_entities WHERE key = ?');
  for (const c of report.components) {
    const e = get.get(c.component);
    assert.ok(e, c.component);
    assert.equal(e.category, c.category, c.component);
    assert.equal(e.current_funds, c.funds, c.component);
    assert.equal(+(e.current_value_usd / 1e6).toFixed(1), c.value_musd, c.component);
  }
});

test('unreviewed: only rows no company claims carry an entity, in every filing', () => {
  assert.equal(
    db.prepare('SELECT COUNT(*) n FROM holdings WHERE company_id IS NOT NULL AND entity_id IS NOT NULL').get().n,
    0
  );
  const untagged = db
    .prepare('SELECT issuer_name, title FROM holdings WHERE company_id IS NULL AND entity_id IS NULL')
    .all();
  assert.ok(untagged.length < stats.rows * 0.01, 'rows without an issuer key only');
});

test('as-of: a position with no shares (balance 0) counts, without a per-share price (trap 43, GOLDEN F35)', () => {
  const r = exposureAsOf(db, { companyId: idOf('Hockey Parent Holdings'), date: '2026-06-30' });
  const pantheon = r.holdings.find(h => h.accession === '0001193125-26-376088');
  assert.ok(pantheon, 'AMG Pantheon Master Fund holds Hockey Parent Holdings, L.P.');
  assert.equal(pantheon.value, 45443907.6);
  assert.deepEqual(
    pantheon.positions.map(p => [p.balance, p.unit, p.pricePerShare, p.pricePerUnit]),
    [[0, 'OU', null, null]]
  );
  const research = exposureAsOf(db, {
    companyId: idOf('Hockey Parent Holdings'),
    date: '2026-06-30',
    nullBalance: false,
  });
  assert.ok(!research.holdings.some(h => h.accession === '0001193125-26-376088'), 'the research rule still drops it');
});

test('company_stats: current funds and value equal exposureAsOf at the newest report date', () => {
  for (const name of ['FHU US Holdings', 'OpenAI', 'Hockey Parent Holdings']) {
    const s = db.prepare('SELECT * FROM company_stats WHERE company_id = ?').get(idOf(name));
    const r = exposureAsOf(db, { companyId: idOf(name), date: s.as_of });
    assert.equal(s.current_funds, r.funds, name);
    assert.ok(Math.abs(s.current_value_usd - r.total) < 0.01, name);
  }
});

test('rebuild: idempotent, keeps entity ids, and follows curation (a reviewed name leaves the unreviewed list)', () => {
  const { db: d } = build();
  const ids = () => d.prepare('SELECT key, id FROM unreviewed_entities ORDER BY key').all();
  const before = ids();
  assert.equal(rebuildEntities(d, identityUpkeep(d)).tagged, 0);
  assert.deepEqual(ids(), before);
  const vercel = search(d, 'Vercel')[0];
  const key = d.prepare('SELECT key FROM unreviewed_entities WHERE id = ?').get(vercel.id).key;
  importAliases(
    d,
    [
      ...read('aliases.csv'),
      { company: 'Vercel', status: 'private', track: 'N', kind: 'issuer_key', alias: key, via_spv: '0' },
    ],
    { ids: read('company_ids.csv') }
  );
  resolveCompanies(d);
  const s = rebuildEntities(d, identityUpkeep(d));
  assert.ok(s.cleared > 0);
  assert.equal(d.prepare('SELECT active FROM unreviewed_entities WHERE id = ?').get(vercel.id).active, 0);
  const now = search(d, 'Vercel')[0];
  assert.deepEqual([now.type, now.name, now.reviewed], ['company', 'Vercel', true]);
  d.close();
});
