// Phase 4.5: evidence-based company identity (lib/entities/identity.js), the
// seed's use of it and the unresolved-value report. Offline, on real rows:
// test/fixtures/identity/ (FHU US Holdings / Chobani and Fidelity's per-fund
// LLCs, Project Debussy, Oura, Anduril, BlackRock's "Anthropics Technology" and
// "OpenAir.com" labels, Windstream / Uniti, Xiaoju Kuaizhi / Ant), rebuilt
// from warehouse.db by its build-fixture.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const identity = require('../lib/entities/identity');
const seed = require('../lib/entities/seed');
const { importAliases } = require('../lib/entities/review');
const { resolveCompanies } = require('../lib/entities/resolve');
const { toCsv, parseCsv } = require('../lib/entities/csv');
const { identityUpkeep, unresolvedReport } = require('../lib/entities/report');
const { exposureAsOf } = require('../lib/analytics/asof');
const { openFixtureWarehouse } = require('./helpers/warehouseFixture');

const FIXTURE = path.join(__dirname, 'fixtures', 'identity', 'warehouse.json.gz');
const ACCESSION = /^\d{10}-\d{2}-\d{6}$/;

const { db } = openFixtureWarehouse(FIXTURE);
const rows = identity.identityRows(db);
const graph = identity.buildIdentity(rows, { families: identity.fundFamilies(db) });
const asOf = db.prepare('SELECT MAX(report_date) d FROM canonical_filings').get().d;
const { clusters } = seed.buildClusters(rows, { asOf });
const listing = seed.latestListingEvidence(db);
const edge = (a, b, kind) =>
  graph.edges.find(e => ((e.a === a && e.b === b) || (e.a === b && e.b === a)) && (!kind || e.kind === kind));

// ---- Units ----

test('identity: LEI check digits (ISO 17442) and spelling variants', () => {
  assert.equal(identity.validLei('549300ISVDMZ91KNTR38'), '549300ISVDMZ91KNTR38'); // T. Rowe's FHU row
  assert.equal(identity.validLei('549300ISVDMZ91KNTR39'), '');
  assert.equal(identity.validLei('N/A'), '');
  // "FHUS" = "FHU US" (a letter doubled at the join written once) = "FHU US HLDGS"
  const fhu = new Set(identity.nameVariants('FHU US'));
  assert.ok(identity.nameVariants('FHUS').every(v => fhu.has(v)));
  assert.ok(identity.nameVariants('FHU US HLDGS').some(v => fhu.has(v)));
  assert.ok(identity.nameVariants('OPEN AI').some(v => identity.nameVariants('OPENAI').includes(v)));
  // Look-alikes never share a variant (trap 11).
  assert.ok(!identity.nameVariants('OPENAIR').some(v => identity.nameVariants('OPENAI').includes(v)));
  assert.ok(!identity.nameVariants('ANTHROPICS TECHNOLOGY').some(v => identity.nameVariants('ANTHROPIC').includes(v)));
});

// ---- Edges on real rows ----

test('identity: every edge carries its kind, confidence and (except name edges) a filing accession', () => {
  assert.ok(graph.edges.length > 0);
  for (const e of graph.edges) {
    assert.ok(identity.EDGE_ORDER.includes(e.kind), e.kind);
    assert.equal(e.confidence, identity.CONFIDENCE[e.kind]);
    if (e.kind !== 'name') assert.match(e.accession, ACCESSION, `${e.kind} ${e.a} ~ ${e.b}`);
  }
});

test('identity: LEI edges join Project Debussy to Databricks and BlackRock\'s "Anthropics Technology" to Anthropic', () => {
  assert.equal(edge('DATABRICKS', 'PROJECT DEBUSSY', 'lei').detail, '984500FEDAC7FBD96273');
  // One filer family's LEI on an unrelated name needs the same mark on the same date.
  assert.match(edge('ANTHROPIC', 'ANTHROPICS TECHNOLOGY', 'lei').detail, /^984500B6DEB8CEBC4Z70; same mark \$/);
});

test('identity: same-mark, instrument-id and share-count edges (Project Debussy, Oura, Anduril, BlackRock labels)', () => {
  assert.match(edge('DATABRICKS', 'PROJECT DEBUSSY', 'same_mark').detail, /same marks at [2-9] prices/);
  assert.equal(edge('OURA', 'OURA HEALTH OY', 'share_count').kind, 'share_count');
  assert.ok(edge('ANDURIL', 'ANDURIL ENGINEERING'));
  // BlackRock reports one instrument id under both names at the same mark (F31, F32).
  assert.match(edge('ANTHROPIC', 'ANTHROPICS TECHNOLOGY', 'instrument_id').detail, /^BYDXGRZL8: same mark \$/);
  assert.match(edge('OPENAI', 'OPENAIR', 'instrument_id').detail, /^BYJ0U3DG6: same mark \$687\.69/);
});

test("identity: one fund's mislabeled row does not carry another company's key (Xiaoju Kuaizhi is not Ant)", () => {
  // BlackRock's 2019-09-30 "Xiaoju Kuaizhi Inc., Series A-18" row is its Ant position (id BRTGP5LH5, same
  // 1,157,373 shares), but every other filer's XIAOJU KUAIZHI is DiDi: no key-level edge.
  const link = identity.linkComponents(graph);
  assert.notEqual(link.componentOf.get('XIAOJU KUAIZHI'), link.componentOf.get('ANT FINANCIAL'));
  assert.ok(
    !graph.edges.some(
      e => /XIAOJU/.test(e.a + e.b) && /^ANT\b/.test(`${e.a}|${e.b}`.split('|').find(k => !/XIAOJU/.test(k)))
    )
  );
});

// ---- Guardrails ----

test('guardrails: Windstream and Uniti stay separate (merger chain flagged); OpenAir never joins OpenAI by name', () => {
  // PIMCO and T. Rowe carry the same ids and share counts from "Windstream Parent" to "Uniti" after the
  // merger: real filer evidence of a conversion into a listed company, not one company. The seed's status
  // context (listing evidence; Level-3 share) makes it a flagged conflict.
  const { groups: plain, linked } = seed.suggestCompanies(clusters, { listing, identity: graph });
  const of = k => plain.find(g => g.aliases.some(a => a.cluster.key === k));
  assert.ok(of('UNITI') && of('WINDSTREAM PARENT'));
  assert.notEqual(of('UNITI'), of('WINDSTREAM PARENT'));
  assert.equal(of('UNITI').status, 'public');
  assert.equal(of('WINDSTREAM PARENT').status, 'private');
  assert.ok(
    linked.conflicts.some(
      e => [e.a, e.b].includes('UNITI') && /WINDSTREAM/.test(`${e.a} ${e.b}`) && /listed and a private/.test(e.conflict)
    )
  );
  assert.ok(!edge('OPENAI', 'OPENAIR', 'name'));
});

test('guardrails: a forced conflict is flagged, not merged (listed vs private, curated companies, separate pairs)', () => {
  const byStatus = identity.linkComponents(graph, {
    statusOf: k => (k === 'FHU US' ? 'private' : k === 'FHU US HLDGS' ? 'public' : ''),
  });
  assert.notEqual(byStatus.componentOf.get('FHU US'), byStatus.componentOf.get('FHU US HLDGS'));
  const c = byStatus.conflicts.find(e => [e.a, e.b].sort().join('|') === 'FHU US|FHU US HLDGS');
  assert.equal(c.conflict, 'a listed and a private company');
  assert.equal(c.applied, false);

  const byCompany = identity.linkComponents(graph, {
    companiesOf: k => (k === 'ANTHROPIC' ? [1] : k === 'ANTHROPICS TECHNOLOGY' ? [2] : []),
  });
  assert.notEqual(byCompany.componentOf.get('ANTHROPIC'), byCompany.componentOf.get('ANTHROPICS TECHNOLOGY'));
  assert.ok(byCompany.conflicts.some(e => e.b === 'ANTHROPICS TECHNOLOGY' && e.conflict === 'two curated companies'));

  const bySeparate = identity.linkComponents(graph, { separate: [{ a: 'FHU US', b: 'FHU US HLDGS' }] });
  assert.notEqual(bySeparate.componentOf.get('FHU US'), bySeparate.componentOf.get('FHU US HLDGS'));
  assert.ok(bySeparate.conflicts.some(e => e.conflict === 'kept separate by curation'));
});

test('guardrails: without curation the seed keeps BlackRock\'s "OpenAir.com" a separate company and flags the conflict', () => {
  const { groups, linked } = seed.suggestCompanies(clusters, { listing, identity: graph });
  const of = k => groups.find(g => g.aliases.some(a => a.cluster.key === k));
  assert.ok(of('OPENAI') && of('OPENAIR'));
  assert.notEqual(of('OPENAI'), of('OPENAIR'));
  assert.ok(linked.conflicts.some(e => [e.a, e.b].includes('OPENAIR') && e.conflict === 'two curated companies'));
});

// ---- The seed with the graph, the committed curation, import and as-of ----

const curation = seed.loadCuration();
const { groups } = seed.suggestCompanies(clusters, { listing, identity: graph, curation });
const groupOf = key => groups.find(g => g.aliases.some(a => a.cluster.key === key));

test('seed: FHU US Holdings is one company, brand Chobani; Fidelity per-fund LLCs are indirect', () => {
  const g = groupOf('FHU US');
  assert.equal(g.name, 'FHU US Holdings');
  assert.equal(g.status, 'private');
  assert.ok(g.aliases.some(a => a.cluster.key === 'FHU US HLDGS')); // T. Rowe, LEI 549300ISVDMZ91KNTR38
  const chobani = g.brands.find(b => b.brand === 'Chobani');
  assert.match(chobani.accession, ACCESSION);
  const vehicles = g.spvs.map(s => s.raw);
  for (const code of ['CONTSA', 'BCGF', 'OTC', 'VIPCONTA', 'FANIFA', 'CONTK6A', 'FSOIFDA'])
    assert.ok(vehicles.includes(`${code} FHUS HOLDINGS LLC`), code);
  // The component carries T. Rowe's issuer LEI.
  assert.ok(rows.some(r => r.key === 'FHU US HLDGS' && r.lei === '549300ISVDMZ91KNTR38'));
});

test("seed: curated evidence merges BlackRock's labels into Anthropic and OpenAI; opaque Fidelity vehicles stay out", () => {
  assert.equal(groupOf('ANTHROPICS TECHNOLOGY'), groupOf('ANTHROPIC'));
  assert.equal(groupOf('OPENAIR COM') || groupOf('OPENAIR'), groupOf('OPENAI'));
  assert.equal(groupOf('BCGF VETERINARY'), undefined);
  assert.ok(graph.vehicles.get('BCGF VETERINARY'), 'a per-fund vehicle with an opaque target');
});

const imported = importAliases(db, parseCsv(toCsv(seed.ALIAS_COLUMNS, seed.aliasRows(groups))), {
  now: '2026-09-30T00:00:00Z',
});
resolveCompanies(db);
const companyId = name => db.prepare('SELECT id FROM companies WHERE name = ?').get(name).id;

test('import + as-of: FHU US Holdings is 13 funds / $359.0M at 2026-06-30 (GOLDEN F29), vehicles indirect', () => {
  assert.ok(imported.brands >= 1);
  const r = exposureAsOf(db, { companyId: companyId('FHU US Holdings'), date: '2026-06-30' });
  assert.equal(r.funds, 13);
  assert.equal(Math.round(r.total / 1e5) / 10, 359.0);
  const pattern = exposureAsOf(db, { pattern: '\\bFHU ?U?S (HOLDINGS|HLDGS)\\b|\\bCHOBANI\\b', date: '2026-06-30' });
  assert.deepEqual(
    r.holdings.map(h => [h.fundKey, h.accession, h.value]),
    pattern.holdings.map(h => [h.fundKey, h.accession, h.value])
  );
  const via = db
    .prepare(
      "SELECT DISTINCT via_spv FROM holdings WHERE issuer_name LIKE '%FHUS HOLDINGS LLC' AND company_id IS NOT NULL"
    )
    .all();
  assert.deepEqual(via, [{ via_spv: 1 }]);
  assert.deepEqual(db.prepare("SELECT brand FROM company_brands WHERE brand = 'Chobani'").all(), [
    { brand: 'Chobani' },
  ]);
});

test('report: the graph is stored; opaque per-fund vehicles are ranked as vehicles, never guessed', () => {
  const up = identityUpkeep(db, { curation, rows: identity.identityRows(db) });
  assert.ok(db.prepare('SELECT COUNT(*) n FROM identity_edges').get().n > 0);
  assert.equal(
    db.prepare("SELECT component FROM identity_nodes WHERE key = 'CONTSA FHUS'").get().component,
    db.prepare("SELECT component FROM identity_nodes WHERE key = 'FHU US'").get().component
  );
  const report = unresolvedReport(up, { threshold: 50e6 });
  const vet = report.components.find(c => /VETERINARY/.test(c.names));
  assert.equal(vet.category, 'vehicle');
  assert.equal(vet.vehicle_target, 'VETERINARY HOLDINGS LLC');
  assert.ok(!report.components.some(c => /FHUS|FHU US/.test(c.names)), 'FHU fully resolved');
});
