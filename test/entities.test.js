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
const { identityRows } = require('../lib/entities/identity');
const {
  importAliases,
  importManagers,
  importDisclosedExposure,
  companyIdRows,
  COMPANY_ID_COLUMNS,
} = require('../lib/entities/review');
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
const { clusters } = seed.buildClusters(identityRows(fx), { asOf });
// The committed curated status decisions (curation.json "status": SpaceX is public).
const { groups } = seed.suggestCompanies(clusters, { curation: { status: seed.loadCuration().status } });
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

test('seed: listing evidence makes a Level-3-only cluster public, with the filing count as evidence', () => {
  const lone = new Map([...clusters].filter(([k]) => k === 'DATABRICKS'));
  const listing = new Map([
    ['DATABRICKS', { filings: 5, quarter: '2026q2', sample_accession: '0000000000-26-000001', sample_cusip: null }],
  ]);
  const [g] = seed.suggestCompanies(lone, { listing }).groups;
  assert.equal(g.status, 'public');
  assert.match(g.note, /^Listed: 5 filings price it at Level 1/);
  assert.equal(g.track, false);
  assert.equal(seed.suggestCompanies(lone).groups[0].status, 'private');
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

// ---- Seed rules added in the Phase 4 review (real names from the warehouse) ----

test("display names use the filers' own spelling, cut at security words and legal suffixes", () => {
  for (const [filed, name] of [
    ['OpenAI Group PBC', 'OpenAI'],
    ['Anthropic, PBC', 'Anthropic'],
    ['Space Exploration Technologies Corp.', 'Space Exploration Technologies'],
    ['X.AI Holdings Corp SER C CVT', 'X.AI'],
    ['ByteDance Ltd.', 'ByteDance'],
    ['Stripe, Inc. - Class B', 'Stripe'],
  ])
    assert.equal(seed.cleanName(filed), name, filed);
});

test("named SPVs: vehicle rows only, never look-alike companies, a company's own fund, or a note", () => {
  const words = k => ` ${k} `;
  const yes = [
    ['TIGER GLOBAL PIP 12-1, LLC (INVESTED IN DATABRICKS, INC., PREFERRED SERIES G)', 'DATABRICKS'],
    ['CARLYLE SYNIVERSE CO INVEST LP', 'SYNIVERSE'],
    ['HEDOSOPHIA VINTED INVESTMENTS VI /', 'VINTED'],
    ['KALSHI SPV EXPOSURE', 'KALSHI'],
  ];
  const no = [
    ['FORUM ENERGY TECHNOLOGIES INC', 'ENERGY TECHNOLOGIES'],
    ['ICAPITAL MILLENNIUM FUND LP', 'ICAPITAL'],
    ['WELLPATH RECOVERY SOLUTIONS LLC', 'RECOVERY SOLUTIONS'],
    [
      'PRIVE TENS, LLC (INVESTED IN TENSTORRENT HOLDINGS INC., SUBORDINATED CONVERTIBLE PROMISSORY NOTE 15.00%)',
      'TENSTORRENT',
    ],
    ['STRIPES VI RAINIER CO INVEST', 'STRIPE'],
  ];
  for (const [raw, key] of yes) assert.equal(seed.isVehicleFor(raw, words(key)), true, raw);
  for (const [raw, key] of no) assert.equal(seed.isVehicleFor(raw, words(key)), false, raw);
});

test('manager firm names come from adviser names: brand kept, entity words dropped, initials kept', () => {
  for (const [adviser, firm] of [
    ['BlackRock Fund Advisors', 'BlackRock'],
    ['BlackRock Advisors, LLC', 'BlackRock'],
    ['J.P. Morgan Investment Management Inc.', 'J.P. Morgan'],
    ['Pantheon Infra Advisors, LLC', 'Pantheon'],
    ['Hamilton Lane Advisors, L.L.C.', 'Hamilton Lane'],
    ['Hamilton Capital, LLC', 'Hamilton'],
    ['PGIM INVESTMENTS LLC', 'PGIM'],
    ['NEUBERGER BERMAN INVESTMENT ADVISERS LLC', 'Neuberger Berman'],
    ['First Trust Capital Management L.P', 'First Trust'],
    ['F. L. Putnam Investment Management Company', 'F. L. Putnam'],
  ])
    assert.equal(seed.managerStem(adviser), firm, adviser);
});

function clusterFrom(rows, asOf = '2026-06-30') {
  const base = { accession: '0000000000-26-000001', value_usd: 10e6, fv_level: '3', instrument_type: 'equity' };
  return seed.buildClusters(
    rows.map((r, i) => ({ ...base, fund_key: `S${i % 4}`, report_date: asOf, ...r })),
    { asOf }
  ).clusters;
}

test('status: recent post-IPO lock-up or PIPE shares mean listed; "lockup upon IPO" does not', () => {
  const status = rows => seed.suggestCompanies(clusterFrom(rows)).groups[0];
  const four = (issuer, title) => Array.from({ length: 4 }, () => ({ issuer_name: issuer, title }));
  const ipo = status(four('KARDIGAN INC', 'KARDIGAN, INC. LOCKUP SHARES PP'));
  assert.equal(ipo.status, 'public');
  assert.match(ipo.note, /post-IPO lock-up shares from 2026-06-30/);
  assert.equal(status(four('KEURIG DR PEPPER', 'KEURIG DR PEPPER SER A CVT PIPE COMMIT PP')).status, 'public');
  assert.equal(status(four('CELONIS SE', 'CELONIS SE ORD USD 1 180 DAYS LOCKUP UPON IPO')).status, 'private');
  assert.equal(status(four('ACME ROBOTICS INC', 'ACME ROBOTICS SER B PFD')).status, 'private');
});

test('curation: evidence-backed merges, drops, renames and untracks apply; unknown keys are errors', () => {
  const rows = [
    ...Array.from({ length: 4 }, () => ({ issuer_name: 'OURA HEALTH OY', title: 'OURA HEALTH OY SER E PC PP' })),
    { issuer_name: 'OURA INC', title: 'OURA INC SER E PC PP' },
    ...Array.from({ length: 4 }, () => ({ issuer_name: 'GUSTO INC', title: 'GUSTO INC SER E' })),
    { issuer_name: 'GUSTO DISTRIBUTING CO.', title: 'GUSTO DISTRIBUTING CO.' },
  ];
  const curation = {
    merge: [{ into: 'OURA HEALTH OY', keys: ['OURA'], reason: 'same shares', evidence: '0000035402-26-005386' }],
    drop: [{ key: 'GUSTO DISTRIBUTING', reason: 'different company' }],
    rename: { 'OURA HEALTH OY': 'Oura' },
    untrack: { GUSTO: 'test' },
  };
  const { groups, issues } = seed.suggestCompanies(clusterFrom(rows), { curation });
  assert.deepEqual(issues, []);
  const oura = groups.find(g => g.name === 'Oura');
  assert.deepEqual(oura.aliases.map(a => a.cluster.key).sort(), ['OURA', 'OURA HEALTH OY']);
  assert.equal(oura.aliases.find(a => a.cluster.key === 'OURA').evidence, '0000035402-26-005386');
  const gusto = groups.find(g => g.anchor.key === 'GUSTO');
  assert.ok(!gusto.aliases.some(a => a.cluster.key === 'GUSTO DISTRIBUTING'));
  assert.equal(gusto.track, false);
  const bad = seed.suggestCompanies(clusterFrom(rows), {
    curation: { merge: [{ into: 'NOPE', keys: ['OURA'] }], rename: { NOPE: 'x' } },
  }).issues;
  assert.equal(bad.length, 2);
});

test('the committed curation file: every merge gives a reason and cites an accession when it has one', () => {
  const file = seed.loadCuration();
  assert.ok(file.merge.every(m => m.reason && typeof m.evidence === 'string'));
  assert.ok(file.merge.filter(m => m.evidence).every(m => /^\d{10}-\d{2}-\d{6}$/.test(m.evidence)));
});

// ---- Review import rules ----

test('review import fails loudly on bad rows and leaves the previous import intact', () => {
  const db = openWarehouse(':memory:');
  const good = [
    { company: 'Acme', status: 'private', track: 'Y', kind: 'issuer_key', alias: 'ACME', via_spv: '0' },
    { company: 'Acme', status: 'private', track: 'Y', kind: 'exact', alias: 'ACME SPV LLC', via_spv: '1' },
    { company: '', status: 'private', track: 'N', kind: 'issuer_key', alias: 'DROPPED', via_spv: '0' },
  ];
  assert.deepEqual(importAliases(db, good), { companies: 1, aliases: 2, brands: 0, tracked: 1 });
  const bad = [
    [{ ...good[0], status: 'maybe' }, /status must be private or public/],
    [{ ...good[0], track: 'yes' }, /track must be Y or N/],
    [{ ...good[0], kind: 'fuzzy' }, /unknown kind/],
    [{ ...good[0], kind: 'regex', alias: '(' }, /bad regex/],
    [{ ...good[0], via_spv: '2' }, /via_spv must be 0 or 1/],
    [{ ...good[0], alias: ' ' }, /empty alias/],
    [{ ...good[0], kind: 'brand', alias: 'Acme Brand' }, /needs an evidence accession/],
  ];
  for (const [row, err] of bad) assert.throws(() => importAliases(db, [good[0], row]), err);
  assert.throws(() => importAliases(db, [good[0], { ...good[1], status: 'public' }]), /conflicting status\/track/);
  assert.throws(() => importAliases(db, [good[0], { ...good[0], company: 'Other' }]), /claimed by "Acme" too/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM company_aliases').get().n, 2, 'previous import intact');
  const before = db
    .prepare('SELECT c.id, t.added_at FROM companies c JOIN tracked_companies t ON t.company_id = c.id')
    .get();
  // Renaming a company keeps its id and tracked date; the old name does not linger.
  importAliases(
    db,
    good.map(r => ({ ...r, company: r.company && 'Acme Corp' })),
    { now: '2030-01-01T00:00:00Z' }
  );
  assert.deepEqual(
    db
      .prepare('SELECT c.id, c.name, t.added_at FROM companies c JOIN tracked_companies t ON t.company_id = c.id')
      .all(),
    [{ id: before.id, name: 'Acme Corp', added_at: before.added_at }]
  );
  // A split: the first new name reached through the old aliases keeps the id, the other is new.
  importAliases(db, [
    { ...good[0], company: 'Acme East' },
    { ...good[1], company: 'Acme West', track: 'N' },
  ]);
  const rows = db.prepare('SELECT id, name FROM companies ORDER BY name').all();
  assert.deepEqual(
    rows.map(r => r.name),
    ['Acme East', 'Acme West']
  );
  assert.equal(rows.find(r => r.name === 'Acme East').id, before.id, 'one side keeps the id');
  // Untracking removes the row; tracking again records the new date.
  importAliases(db, [{ ...good[0], company: 'Acme East', track: 'N' }]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tracked_companies').get().n, 0);
  assert.throws(() => importManagers(db, [{ manager: 'X', kind: 'fund', key: '1' }]), /adviser or registrant/);
  assert.throws(() => importManagers(db, [{ manager: 'X', kind: 'registrant', key: 'abc' }]), /must be a CIK/);
});

test('company ids are stable: a rebuild from the ledger reproduces them, merged and dropped ids redirect, none is reused', () => {
  const row = (company, alias, extra = {}) => ({
    company,
    status: 'private',
    track: 'N',
    kind: 'issuer_key',
    alias,
    via_spv: '0',
    ...extra,
  });
  const db = openWarehouse(':memory:');
  importAliases(db, [row('Acme', 'ACME'), row('Beta', 'BETA'), row('Gamma', 'GAMMA'), row('Delta', 'DELTA')]);
  const id = name => db.prepare('SELECT id FROM companies WHERE name = ?').get(name)?.id;
  const [acme, beta, gamma, delta] = ['Acme', 'Beta', 'Gamma', 'Delta'].map(id);
  // Beta's alias moves to Acme (a merge), Gamma leaves the file (a drop).
  importAliases(db, [row('Acme', 'ACME'), row('Acme', 'BETA'), row('Delta', 'DELTA')], { now: '2026-10-01' });
  // Delta merges into Acme too, then a new company arrives: its id is above every id ever used.
  importAliases(db, [
    row('Acme', 'ACME'),
    row('Acme', 'BETA'),
    row('Acme', 'DELTA'),
    row('Epsilon', 'EPSILON'),
    row('Zeta', 'ZETA'),
  ]);
  assert.ok(id('Epsilon') > Math.max(acme, beta, gamma, delta), 'retired ids are never reused');
  const redirects = db.prepare('SELECT old_id, new_id, reason FROM company_redirects ORDER BY old_id').all();
  assert.deepEqual(redirects, [
    { old_id: beta, new_id: acme, reason: 'merged' },
    { old_id: gamma, new_id: null, reason: 'dropped' },
    { old_id: delta, new_id: acme, reason: 'merged' },
  ]);
  // A fresh warehouse built from the files reproduces every id and redirect.
  const ledger = parseCsv(toCsv(COMPANY_ID_COLUMNS, companyIdRows(db)));
  const fresh = openWarehouse(':memory:');
  const aliases = [
    row('Zeta', 'ZETA'),
    row('Epsilon', 'EPSILON'),
    row('Acme', 'ACME'),
    row('Acme', 'BETA'),
    row('Acme', 'DELTA'),
  ];
  importAliases(fresh, aliases, { ids: ledger });
  const all = d => d.prepare('SELECT id, name FROM companies ORDER BY id').all();
  assert.deepEqual(all(fresh), all(db));
  assert.deepEqual(
    fresh.prepare('SELECT old_id, new_id, reason FROM company_redirects ORDER BY old_id').all(),
    redirects
  );
  assert.deepEqual(companyIdRows(fresh), companyIdRows(db));
  // A chain collapses: Acme merges into Zeta, so Beta and Delta now point at Zeta.
  const zeta = id('Zeta');
  importAliases(
    fresh,
    aliases.map(r => ({ ...r, company: r.company === 'Acme' ? 'Zeta' : r.company })),
    { ids: companyIdRows(fresh) }
  );
  assert.deepEqual(
    fresh
      .prepare('SELECT new_id FROM company_redirects WHERE old_id IN (?, ?, ?) ORDER BY old_id')
      .all(acme, beta, delta)
      .map(r => r.new_id),
    [zeta, zeta, zeta]
  );
  // A ledger that disagrees with the warehouse, or reuses a retired id, fails loudly.
  assert.throws(
    () => importAliases(db, aliases, { ids: [{ id: String(acme + 100), company: 'Acme' }] }),
    /gives "Acme" id \d+, but the warehouse has/
  );
  assert.throws(
    () =>
      importAliases(openWarehouse(':memory:'), [row('Omega', 'OMEGA')], {
        ids: [...ledger, { id: String(gamma), company: 'Omega' }],
      }),
    /appears twice/
  );
  assert.throws(() => importAliases(db, aliases, { ids: [{ id: 'x', company: 'Acme' }] }), /positive integer/);
  assert.throws(
    () => importAliases(db, aliases, { ids: [{ id: '9', company: 'A', reason: 'merged' }] }),
    /needs a successor/
  );
});

test('CSV round trip keeps commas, quotes and newlines; a ragged row fails', () => {
  const rows = [{ a: 'x, y', b: 'say "hi"', c: 'line1\nline2' }];
  assert.deepEqual(parseCsv(toCsv(['a', 'b', 'c'], rows)), rows);
  assert.throws(() => parseCsv('a,b\n1,2,3\n'), /3 fields, header has 2/);
  assert.throws(() => parseCsv('a\n"open\n'), /unterminated/);
});

// ---- The committed review files (data/review/) ----

test('the committed review files import cleanly, and every issuer_key alias is a key issuerKeyOf produces', () => {
  const { issuerKeyOf } = require('../parsers');
  const dir = path.join(__dirname, '..', 'data', 'review');
  const read = f => parseCsv(fs.readFileSync(path.join(dir, f), 'utf8'));
  const db = openWarehouse(':memory:');
  const aliases = read('aliases.csv');
  const a = importAliases(db, aliases, { ids: read('company_ids.csv') });
  assert.ok(a.companies > 700 && a.tracked > 100, JSON.stringify(a));
  // Stable ids (ADR 0008): a warehouse built from the committed files has exactly the ledger's ids.
  const ledger = read('company_ids.csv');
  assert.deepEqual(
    companyIdRows(db),
    ledger.map(r => ({ ...r, id: Number(r.id), successor: r.successor && Number(r.successor) }))
  );
  assert.ok(importManagers(db, read('managers.csv')).managers > 100);
  assert.ok(importDisclosedExposure(db, read('disclosed_exposure.csv')).rows > 0);
  // Holdings resolve by issuerKeyOf(row) === alias; a change to the name
  // normalization that moves a reviewed key would silently unresolve rows.
  const moved = aliases
    .filter(r => r.company && r.kind === 'issuer_key')
    .filter(r => issuerKeyOf({ issuer: r.alias }) !== r.alias);
  assert.deepEqual(
    moved.map(r => r.alias),
    []
  );
  // SpaceX is public (CLAUDE.md); curated statuses cite SEC evidence.
  const spacex = db
    .prepare("SELECT status FROM companies WHERE name LIKE 'SpaceX%' OR name LIKE 'Space Exploration%'")
    .all();
  assert.ok(spacex.length && spacex.every(c => c.status === 'public'));
  for (const [key, s] of Object.entries(seed.loadCuration().status || {})) {
    assert.ok(['public', 'private'].includes(s.status), key);
    assert.match(s.note, /\d{10}-\d{2}-\d{6}/, key);
  }
  db.close();
});
