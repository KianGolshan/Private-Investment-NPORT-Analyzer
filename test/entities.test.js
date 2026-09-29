// Phase 4: N-CEN advisers, managers, company seeding, alias import and
// resolution. Offline, on real data: test/fixtures/ncen/ (trimmed SEC N-CEN
// data set + the same filings' primary_doc.xml) and test/fixtures/warehouse/
// (every filing of the funds that held Anthropic, Databricks, Stripe,
// ByteDance or SpaceX, their rows, and their registrants' N-CEN rows).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { openWarehouse } = require('../lib/warehouse/db');
const { ingestNcenDataset, ncenRowsFromXml, adviserKey } = require('../lib/warehouse/ncen');
const { refreshFundAdvisers } = require('../lib/entities/managers');
const seed = require('../lib/entities/seed');
const { importAliases, importManagers, importDisclosedExposure } = require('../lib/entities/review');
const { resolveCompanies } = require('../lib/entities/resolve');
const { toCsv, parseCsv } = require('../lib/entities/csv');
const { exposureAsOf } = require('../lib/analytics/asof');
const { openFixtureWarehouse } = require('./helpers/warehouseFixture');

const NCEN = path.join(__dirname, 'fixtures', 'ncen');
const xml = accession => fs.readFileSync(path.join(NCEN, 'xml', `${accession}.xml`), 'utf8');
const CAPITAL_GROUP_CIKS = ['44201', '719608', '4405', '39473', '4568', '894005', '729528'];
const rowSet = rows => rows.map(r => `${r.series_id}|${r.series_lei}|${r.file_num}|${r.role}`).sort();

// ---- N-CEN ----

test('N-CEN: the EDGAR XML path yields exactly the data set rows (4 real filings)', async () => {
  const db = openWarehouse(':memory:');
  const r = await ingestNcenDataset(db, path.join(NCEN, 'mini_ncen.zip'), { quarter: '2026q1' });
  assert.deepEqual(r, { quarter: '2026q1', filings: 4, rows: 62 });
  const manifest = JSON.parse(fs.readFileSync(path.join(NCEN, 'manifest.json'), 'utf8'));
  for (const accession of Object.keys(manifest.dataset)) {
    const stored = db.prepare('SELECT * FROM ncen_advisers WHERE accession = ?').all(accession);
    assert.ok(stored.length, accession);
    assert.deepEqual(rowSet(await ncenRowsFromXml(xml(accession))), rowSet(stored), accession);
  }
  const log = db.prepare("SELECT status, filings, rows_kept FROM ingest_log WHERE kind = 'ncen'").get();
  assert.deepEqual(log, { status: 'ok', filings: 4, rows_kept: 62 });
});

test('N-CEN: American Funds Insurance Series names Capital Research (801-8055) for all 42 series', async () => {
  const rows = await ncenRowsFromXml(xml('0001193125-26-108005'));
  const advisers = rows.filter(r => r.role === 'adviser');
  assert.equal(new Set(advisers.map(r => r.series_id)).size, 42);
  assert.deepEqual(
    [...new Set(advisers.map(r => `${r.file_num} ${r.name}`))],
    ['801-8055 Capital Research and Management Company']
  );
});

test('N-CEN: sub-advisers are kept per series (Touchstone -> Fort Washington)', async () => {
  const rows = await ncenRowsFromXml(xml('0001193125-26-105983'));
  const s = rows.filter(r => r.series_id === 'S000076657');
  assert.deepEqual(s.map(r => [r.role, r.file_num, r.name]).sort(), [
    ['adviser', '801-45963', 'Touchstone Advisors, Inc.'],
    ['subadviser', '801-37235', 'Fort Washington Investment Advisors, Inc.'],
  ]);
});

test('N-CEN: a filing missing from the SEC data sets is read from EDGAR (Growth Fund of America 2025-11-14)', async () => {
  const rows = await ncenRowsFromXml(xml('0001193125-25-282335'));
  assert.deepEqual(rows, [
    {
      series_id: 'S000009228',
      series_lei: 'VOJHP0RJPD2FRCAXQJ44',
      role: 'adviser',
      name: 'Capital Research and Management Company',
      file_num: '801-8055',
      crd: '000110885',
      lei: 'M02M7XSKLMK96MWKNF95',
    },
  ]);
});

test('N-CEN: adviser key is the SEC file number, else CRD, else the name; bad input fails loudly', async () => {
  assert.equal(adviserKey({ fileNum: '801-8055', crd: '000110885', name: 'x' }), '801-8055');
  assert.equal(adviserKey({ fileNum: 'N/A', crd: '000123', name: 'x' }), 'CRD:123');
  assert.equal(adviserKey({ fileNum: '', crd: '', name: ' Foo  Capital Ltd ' }), 'NAME:FOO CAPITAL LTD');
  await assert.rejects(ncenRowsFromXml('<edgarSubmission/>'), /not an N-CEN document/);
  const db = openWarehouse(':memory:');
  await assert.rejects(ingestNcenDataset(db, path.join(NCEN, 'mini_ncen.zip'), { quarter: 'q1' }), /bad quarter/);
  await assert.rejects(ingestNcenDataset(db, path.join(NCEN, 'missing.zip'), { quarter: '2026q1' }));
  assert.equal(db.prepare("SELECT status FROM ingest_log WHERE kind = 'ncen'").get().status, 'failed');
});

test('fund advisers: series match, registrant without series (Coatue), and the latest N-CEN wins', async () => {
  const db = openWarehouse(':memory:');
  await ingestNcenDataset(db, path.join(NCEN, 'mini_ncen.zip'), { quarter: '2026q1' });
  const filing = db.prepare(
    "INSERT INTO filings (accession, fund_key, cik, series_id, report_date, filing_date, form, source) VALUES (?, ?, ?, ?, '2026-03-31', '2026-05-29', 'NPORT-P', 'test')"
  );
  filing.run('a1', 'S000008791', '729528', 'S000008791');
  filing.run('a2', 'CIK2044519', '2044519', null);
  filing.run('a3', 'S000076657', '1919700', 'S000076657');
  filing.run('a4', 'S999999999', '1', 'S999999999');
  assert.deepEqual(refreshFundAdvisers(db), { funds: 4, mapped: 3 });
  const got = db.prepare('SELECT fund_key, file_num, role FROM fund_advisers ORDER BY fund_key, role').all();
  assert.deepEqual(got, [
    { fund_key: 'CIK2044519', file_num: '801-73669', role: 'adviser' },
    { fund_key: 'S000008791', file_num: '801-8055', role: 'adviser' },
    { fund_key: 'S000076657', file_num: '801-45963', role: 'adviser' },
    { fund_key: 'S000076657', file_num: '801-37235', role: 'subadviser' },
  ]);
});

// ---- Companies, aliases and managers on the fixture warehouse ----

const { db: fx } = openFixtureWarehouse();
const asOf = fx.prepare('SELECT MAX(report_date) d FROM canonical_filings').get().d;
const { clusters } = seed.buildClusters(seed.companyRows(fx), { asOf });
const { groups } = seed.suggestCompanies(clusters);
const groupOf = key => groups.find(g => g.aliases.some(a => a.cluster.key === key));
const aliasKeys = g => g.aliases.map(a => a.cluster.key);
const spvNames = g => g.spvs.map(s => s.raw);

test('seed: Databricks name variants merge; its named SPVs are suggested with via_spv', () => {
  const g = groupOf('DATABRICKS');
  assert.equal(g.anchor.key, 'DATABRICKS');
  assert.ok(aliasKeys(g).includes('DATABRICKS INC SERES'));
  assert.ok(aliasKeys(g).includes('DATABRICKS INC PRIVATE PLACEMENT'));
  assert.ok(spvNames(g).some(n => /^TIGER GLOBAL PIP 12-1, LLC \(INVESTED IN DATABRICKS/.test(n)));
  assert.equal(g.status, 'private');
});

test('seed: whole-word matching keeps look-alikes apart (STRIPES, ANTHROPICS TECHNOLOGY)', () => {
  const stripe = groupOf('STRIPE');
  assert.ok(!aliasKeys(stripe).some(k => /^STRIPES\b/.test(k)));
  assert.ok(!spvNames(stripe).some(n => /\bSTRIPES\b/.test(n)));
  const anthropic = groupOf('ANTHROPIC');
  assert.ok(!aliasKeys(anthropic).includes('ANTHROPICS TECHNOLOGY'));
  assert.ok(spvNames(anthropic).some(n => n.startsWith('MAGNITUDE ANC III, LLC (ECONOMIC EXPOSURE TO ANTHROPIC')));
});

test('seed: DOUYIN merges into ByteDance because its rows are titled "BYTEDANCE LTD …", with the evidence accession', () => {
  const g = groupOf('BYTEDANCE');
  const douyin = g.aliases.find(a => a.cluster.key === 'DOUYIN');
  assert.equal(douyin.reason, 'titles read "BYTEDANCE"');
  assert.match(douyin.evidence, /^\d{10}-\d{2}-\d{6}$/);
});

test('seed: SpaceX is public, with its SEC evidence', () => {
  const g = groupOf('SPACE EXPLORATION TECHNOLOGIES');
  assert.equal(g.status, 'public');
  assert.match(g.note, /0001867090-26-000109/);
  assert.equal(g.track, false);
});

// Import the unedited seed into the fixture, then resolve every row.
const aliasCsv = toCsv(seed.ALIAS_COLUMNS, seed.aliasRows(groups));
const imported = importAliases(fx, parseCsv(aliasCsv), { now: '2026-09-28T00:00:00Z' });
const resolved = resolveCompanies(fx);
const companyId = name => fx.prepare('SELECT id FROM companies WHERE name = ?').get(name)?.id;

test('import + resolve: Databricks raw issuer strings all resolve to one company (59 in the real data)', () => {
  assert.ok(imported.companies > 0 && resolved.resolved > 0);
  const rows = fx
    .prepare(
      `SELECT DISTINCT UPPER(COALESCE(NULLIF(issuer_name, 'N/A'), title)) raw, company_id FROM holdings
       WHERE (issuer_name LIKE '%databricks%' OR title LIKE '%databricks%') AND value_usd > 0 AND instrument_type <> 'debt'`
    )
    .all();
  assert.equal(new Set(rows.map(r => r.raw)).size, 59);
  assert.deepEqual([...new Set(rows.map(r => r.company_id))], [companyId('Databricks')]);
});

test('import + resolve: STRIPE INC and STRIPE LLC are one company; Douyin is ByteDance; Magnitude is Anthropic via SPV', () => {
  const idOf = name => fx.prepare('SELECT DISTINCT company_id, via_spv FROM holdings WHERE issuer_name = ?').all(name);
  assert.deepEqual(idOf('STRIPE INC'), [{ company_id: companyId('Stripe'), via_spv: 0 }]);
  assert.deepEqual(idOf('STRIPE LLC'), [{ company_id: companyId('Stripe'), via_spv: 0 }]);
  assert.deepEqual(idOf('DOUYIN CO LTD'), [{ company_id: companyId('Bytedance'), via_spv: 0 }]);
  const magnitude = fx
    .prepare("SELECT DISTINCT company_id, via_spv FROM holdings WHERE issuer_name LIKE 'Magnitude ANC III%'")
    .all();
  assert.deepEqual(magnitude, [{ company_id: companyId('Anthropic'), via_spv: 1 }]);
  const spacex = fx.prepare("SELECT status FROM companies WHERE name = 'Space Exploration Technologies'").get();
  assert.equal(spacex.status, 'public');
});

test('companyId reproduces the pattern golden numbers (A2, A5, A6)', () => {
  for (const [name, pattern, date] of [
    ['Anthropic', '\\banthropic\\b', '2026-06-30'],
    ['Stripe', '\\bstripe,? (inc|llc)\\b|^stripe\\b', '2025-12-31'],
    ['Databricks', '\\bdatabricks\\b', '2026-06-30'],
  ]) {
    const a = exposureAsOf(fx, { pattern, date });
    const b = exposureAsOf(fx, { companyId: companyId(name), date });
    assert.deepEqual(
      b.holdings.map(h => [h.fundKey, h.accession, h.value]),
      a.holdings.map(h => [h.fundKey, h.accession, h.value]),
      `${name} ${date}`
    );
  }
});

test('managers: the Capital Group manager includes CIKs 44201, 719608, 4405, 39473, 4568, 894005 and 729528', () => {
  refreshFundAdvisers(fx);
  const rows = seed.suggestManagers(fx);
  const crmc = rows.find(r => r.key === '801-8055');
  assert.equal(crmc.manager, 'Capital Group (American Funds)'); // v1's curated group name
  importManagers(fx, rows);
  const ciks = fx
    .prepare(
      `SELECT DISTINCT f.cik FROM managers m JOIN manager_advisers ma ON ma.manager_id = m.id
       JOIN fund_advisers fa ON fa.file_num = ma.file_num AND fa.role = 'adviser'
       JOIN filings f ON f.fund_key = fa.fund_key WHERE m.name = 'Capital Group (American Funds)'`
    )
    .all()
    .map(r => r.cik);
  for (const cik of CAPITAL_GROUP_CIKS) assert.ok(ciks.includes(cik), cik);
});

test('disclosed exposure: Fundrise reports Anthropic as a range with its source accession', () => {
  const file = parseCsv(
    fs.readFileSync(path.join(__dirname, '..', 'data', 'review', 'disclosed_exposure.csv'), 'utf8')
  );
  const anthropic = file.filter(r => r.company === 'Anthropic');
  assert.deepEqual(importDisclosedExposure(fx, anthropic), { rows: 1 });
  const row = fx.prepare('SELECT * FROM disclosed_exposure').get();
  assert.equal(row.fund_key, 'CIK1867090');
  assert.equal(row.source_accession, '0001867090-26-000109');
  assert.match(row.basis, /^Greater than 20% of net assets/);
  assert.throws(
    () => importDisclosedExposure(fx, [{ ...anthropic[0], company: 'No Such Co' }]),
    /unknown company "No Such Co"/
  );
});

// ---- Review import rules ----

test('review import fails loudly on bad rows and leaves the previous import intact', () => {
  const db = openWarehouse(':memory:');
  const good = [
    { company: 'Acme', status: 'private', track: 'Y', kind: 'issuer_key', alias: 'ACME', via_spv: '0' },
    { company: 'Acme', status: 'private', track: 'Y', kind: 'exact', alias: 'ACME SPV LLC', via_spv: '1' },
    { company: '', status: 'private', track: 'N', kind: 'issuer_key', alias: 'DROPPED', via_spv: '0' },
  ];
  assert.deepEqual(importAliases(db, good), { companies: 1, aliases: 2, tracked: 1 });
  const bad = [
    [{ ...good[0], status: 'maybe' }, /status must be private or public/],
    [{ ...good[0], track: 'yes' }, /track must be Y or N/],
    [{ ...good[0], kind: 'fuzzy' }, /unknown kind/],
    [{ ...good[0], kind: 'regex', alias: '(' }, /bad regex/],
    [{ ...good[0], via_spv: '2' }, /via_spv must be 0 or 1/],
    [{ ...good[0], alias: ' ' }, /empty alias/],
  ];
  for (const [row, err] of bad) assert.throws(() => importAliases(db, [good[0], row]), err);
  assert.throws(() => importAliases(db, [good[0], { ...good[1], status: 'public' }]), /conflicting status\/track/);
  assert.throws(() => importAliases(db, [good[0], { ...good[0], company: 'Other' }]), /claimed by "Acme" too/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM company_aliases').get().n, 2, 'previous import intact');
  assert.throws(() => importManagers(db, [{ manager: 'X', kind: 'fund', key: '1' }]), /adviser or registrant/);
  assert.throws(() => importManagers(db, [{ manager: 'X', kind: 'registrant', key: 'abc' }]), /must be a CIK/);
});

test('CSV round trip keeps commas, quotes and newlines; a ragged row fails', () => {
  const rows = [{ a: 'x, y', b: 'say "hi"', c: 'line1\nline2' }];
  assert.deepEqual(parseCsv(toCsv(['a', 'b', 'c'], rows)), rows);
  assert.throws(() => parseCsv('a,b\n1,2,3\n'), /3 fields, header has 2/);
  assert.throws(() => parseCsv('a\n"open\n'), /unterminated/);
});
