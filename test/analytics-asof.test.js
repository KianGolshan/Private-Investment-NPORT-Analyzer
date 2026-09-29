// Phase 3: canonical views and the as-of engine.
// Golden tests run offline against test/fixtures/warehouse/, real rows
// exported from warehouse.db (every filing of every fund that ever held
// Anthropic, Databricks or Stripe). Numbers and accessions: GOLDEN-NUMBERS.md.
const test = require('node:test');
const assert = require('node:assert/strict');

const { openWarehouse } = require('../lib/warehouse/db');
const { exposureAsOf, instrumentHistory } = require('../lib/analytics/asof');
const { openFixtureWarehouse } = require('./helpers/warehouseFixture');

const { db, manifest } = openFixtureWarehouse();
const PATTERN = manifest.companies;
const bn = x => Math.round(x / 1e7) / 100; // $B to 2 decimals
const mm = x => Math.round(x / 1e5) / 10; // $M to 1 decimal
const byFund = r => new Map(r.holdings.map(h => [h.fundKey, h]));

// Capital Group funds holding Anthropic at 2026-06-30 (A3), verified on EDGAR.
const CAPITAL_GROUP = {
  S000009228: { name: 'Growth Fund of America', accession: '0001193125-26-323081', mark: '2026-05-31', mm: 4979.7 },
  S000009227: { name: 'Fundamental Investors', accession: '0001193125-26-371278', mark: '2026-06-30', mm: 1016.7 },
  S000008791: { name: 'AFIS Growth Fund', accession: '0001193125-26-371320', mark: '2026-06-30', mm: 873.6 },
  S000008801: { name: 'American Balanced', accession: '0001193125-26-371283', mark: '2026-06-30', mm: 520.7 },
  S000009598: { name: 'New Economy', accession: '0001193125-26-323082', mark: '2026-05-31', mm: 486.1 },
  S000008817: { name: 'AMCAP', accession: '0001193125-26-323076', mark: '2026-05-31', mm: 469.9 },
  S000008796: { name: 'AFIS Asset Allocation', accession: '0001193125-26-371277', mark: '2026-06-30', mm: 64.0 },
  S000009001: { name: 'Capital World G&I', accession: '0001193125-26-323078', mark: '2026-05-31', mm: 46.8 },
  S000013710: { name: 'AFIS Capital World G&I', accession: '0001193125-26-371285', mark: '2026-06-30', mm: 0.7 },
};

test('fixture: built from the real warehouse, with its source recorded', () => {
  assert.equal(manifest.source, 'warehouse.db');
  assert.match(manifest.sourceNewestFilingDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(manifest.funds > 150 && manifest.filings > 4000 && manifest.holdings > 6000);
});

test('canonical_filings: one row per fund and report date; the amendment wins (trap 1)', () => {
  const dupes = db
    .prepare(
      'SELECT COUNT(*) n FROM (SELECT 1 FROM canonical_filings GROUP BY fund_key, report_date HAVING COUNT(*) > 1)'
    )
    .get().n;
  assert.equal(dupes, 0);
  const pairs = db.prepare('SELECT COUNT(*) n FROM (SELECT DISTINCT fund_key, report_date FROM filings)').get().n;
  assert.equal(db.prepare('SELECT COUNT(*) n FROM canonical_filings').get().n, pairs);
  // Coatue Innovative Strategies 2026-03-31: NPORT-P filed 5/29, NPORT-P/A 6/16.
  const coatue = db
    .prepare(
      "SELECT accession, form FROM canonical_filings WHERE fund_key = 'CIK2044519' AND report_date = '2026-03-31'"
    )
    .all();
  assert.deepEqual(coatue, [{ accession: '0001410368-26-061868', form: 'NPORT-P/A' }]);
});

test('fund_filing_timeline: every canonical filing in order; F14 KP Large Cap ends 2020-09-30', () => {
  const kp = db.prepare("SELECT * FROM fund_filing_timeline WHERE fund_key = 'S000041501' ORDER BY seq").all();
  const last = kp[kp.length - 1];
  assert.equal(last.report_date, '2020-09-30');
  assert.equal(last.accession, '0001752724-20-246785');
  assert.equal(last.next_report_date, null);
  assert.equal(last.seq, kp.length);
  assert.equal(kp[1].prev_report_date, kp[0].report_date);
  const coatue = db
    .prepare("SELECT versions FROM fund_filing_timeline WHERE fund_key = 'CIK2044519' AND report_date = '2026-03-31'")
    .get();
  assert.equal(coatue.versions, 2);
});

test('A1: Anthropic equity as of 2026-03-31 = 72 funds / $5.93B (Capital Group $2.63B)', () => {
  const r = exposureAsOf(db, { pattern: PATTERN.anthropic, date: '2026-03-31' });
  assert.equal(r.funds, 72);
  assert.equal(bn(r.total), 5.93);
  const cg = r.holdings.filter(h => CAPITAL_GROUP[h.fundKey]);
  assert.equal(bn(cg.reduce((s, h) => s + h.value, 0)), 2.63);
  // The amendment's marks count, not the superseded original's.
  assert.equal(byFund(r).get('CIK2044519').accession, '0001410368-26-061868');
});

test('A2/A3: Anthropic as of 2026-06-30 = 117 funds / $17.26B; Capital Group 9 funds / $8.46B', () => {
  const r = exposureAsOf(db, { pattern: PATTERN.anthropic, date: '2026-06-30' });
  assert.equal(r.funds, 117);
  assert.equal(bn(r.total), 17.26);
  const funds = byFund(r);
  for (const [key, want] of Object.entries(CAPITAL_GROUP)) {
    const got = funds.get(key);
    assert.ok(got, `${want.name} missing`);
    assert.equal(got.accession, want.accession, want.name);
    assert.equal(got.markDate, want.mark, want.name);
    assert.equal(mm(got.value), want.mm, want.name);
  }
  const cg = r.holdings.filter(h => CAPITAL_GROUP[h.fundKey]);
  assert.equal(bn(cg.reduce((s, h) => s + h.value, 0)), 8.46);
  // Staggered calendars: one "as of" answer mixes mark dates.
  assert.deepEqual([...new Set(cg.map(h => h.markDate))].sort(), ['2026-05-31', '2026-06-30']);
  // F2 row detail: G-1 + F-1 + common, each traceable to its row.
  const gfa = funds.get('S000009228');
  assert.equal(gfa.positions.length, 3);
  assert.ok(gfa.positions.every(p => p.rowKey && p.pricePerShare > 0));
});

test('knownAsOf: Anthropic known on 2026-06-30 excludes F2-F7 (filed July/August) = 82 funds / $6.23B (A4)', () => {
  const r = exposureAsOf(db, { pattern: PATTERN.anthropic, date: '2026-06-30', knownAsOf: true });
  assert.equal(r.knownAsOf, '2026-06-30');
  assert.equal(r.funds, 82);
  assert.equal(bn(r.total), 6.23);
  const accessions = new Set(r.holdings.map(h => h.accession));
  for (const { accession } of Object.values(CAPITAL_GROUP)) assert.ok(!accessions.has(accession), accession);
  assert.ok(r.holdings.every(h => h.filingDate <= '2026-06-30'));
  // What was public then: Growth Fund of America's February marks (F1).
  const gfa = byFund(r).get('S000009228');
  assert.equal(gfa.markDate, '2026-02-28');
  assert.equal(gfa.accession, '0001193125-26-182055');
  // Before Coatue's amendment was filed (6/16) its original filing counts.
  const early = exposureAsOf(db, { pattern: PATTERN.anthropic, date: '2026-03-31', knownAsOf: '2026-06-01' });
  assert.equal(byFund(early).get('CIK2044519').accession, '0001410368-26-056381');
});

test('knownAsOf far in the future equals the canonical_filings view', () => {
  for (const [company, date] of [
    ['anthropic', '2026-06-30'],
    ['stripe', '2025-12-31'],
    ['databricks', '2022-09-30'],
  ]) {
    const a = exposureAsOf(db, { pattern: PATTERN[company], date });
    const b = exposureAsOf(db, { pattern: PATTERN[company], date, knownAsOf: '9999-12-31' });
    assert.deepEqual({ ...b, knownAsOf: null }, a, `${company} ${date}`);
  }
});

test('A5: Stripe equity holders 49 / 35 / 34 / 37, with exits (trap 3)', () => {
  const want = {
    '2025-06-30': [49, 1.02],
    '2025-12-31': [35, 1.31],
    '2026-03-31': [34, 1.91],
    '2026-06-30': [37, 2.44],
  };
  for (const [date, [funds, total]] of Object.entries(want)) {
    const r = exposureAsOf(db, { pattern: PATTERN.stripe, date });
    assert.equal(r.funds, funds, date);
    assert.equal(bn(r.total), total, date);
  }
});

test('F8/F9: Fidelity OTC Portfolio holds Stripe at 2025-10-31 and has exited by 2026-01-31', () => {
  const before = exposureAsOf(db, { pattern: PATTERN.stripe, date: '2025-10-31' });
  const held = byFund(before).get('S000007191');
  assert.equal(held.accession, '0000035402-25-002966');
  assert.equal(mm(held.value), 15.7); // Ser H $12.17M + Class B $3.54M
  const after = exposureAsOf(db, { pattern: PATTERN.stripe, date: '2026-01-31' });
  assert.ok(!byFund(after).has('S000007191'));
  const exit = after.exited.find(e => e.fundKey === 'S000007191');
  assert.equal(exit.accession, '0000035402-26-002031');
  assert.equal(exit.markDate, '2026-01-31');
  assert.equal(exit.lastHeldDate, '2025-10-31');
});

test('A6: Databricks equity as of 2026-06-30 = 120 funds / $6.22B', () => {
  const r = exposureAsOf(db, { pattern: PATTERN.databricks, date: '2026-06-30' });
  assert.equal(r.funds, 120);
  assert.equal(bn(r.total), 6.22);
});

test('F14: KP Large Cap (last report 2020-09-30) is active through day 123, inactive on day 124 (trap 4)', () => {
  const kp = r => r.holdings.find(h => h.fundKey === 'S000041501');
  const day123 = exposureAsOf(db, { pattern: PATTERN.stripe, date: '2021-01-31' });
  assert.equal(kp(day123).accession, '0001752724-20-246785');
  assert.equal(kp(day123).value, 237483.84);
  const day124 = exposureAsOf(db, { pattern: PATTERN.stripe, date: '2021-02-01' });
  assert.equal(kp(day124), undefined);
  const gone = day124.inactive.find(f => f.fundKey === 'S000041501');
  assert.equal(gone.markDate, '2020-09-30');
  assert.equal(gone.accession, '0001752724-20-246785');
  const later = exposureAsOf(db, { pattern: PATTERN.stripe, date: '2026-06-30' });
  assert.ok(later.inactive.some(f => f.fundKey === 'S000041501'));
});

test('F13: Databricks 2022-08-31 at T. Rowe Tax-Efficient is a 3:1 split, not a crash (trap 9)', () => {
  const series = instrumentHistory(db, { pattern: PATTERN.databricks, fundKey: 'S000002160', date: '2022-12-31' });
  const serH = series.find(s => s.instrumentKey === 'TC2K5K6F9');
  const may = serH.points.find(p => p.markDate === '2022-05-31');
  const aug = serH.points.find(p => p.markDate === '2022-08-31');
  assert.equal(may.accession, '0001752724-22-166570');
  assert.equal(aug.accession, '0001752724-22-239970');
  assert.deepEqual([may.balance, may.pricePerShare.toFixed(2)], [3712, '165.88']);
  assert.deepEqual([aug.balance, aug.pricePerShare.toFixed(2)], [11136, '55.29']);
  assert.equal(aug.split, 3);
  assert.equal(may.split, null);
  assert.equal(may.balance * may.splitFactor, aug.balance * aug.splitFactor);
  // Every Databricks class this fund held split on the same date.
  const splitDates = series.flatMap(s => s.points.filter(p => p.split).map(p => `${p.markDate}:${p.split}`));
  assert.deepEqual([...new Set(splitDates)], ['2022-08-31:3']);
  assert.equal(splitDates.length, 4);
});

test('options: NULL-balance rows and the instrument_type basis do not move the golden numbers', () => {
  for (const opts of [{ nullBalance: true }, { classifyBy: 'instrument_type' }]) {
    const r = exposureAsOf(db, { pattern: PATTERN.anthropic, date: '2026-06-30', ...opts });
    assert.equal(r.funds, 117, JSON.stringify(opts));
    assert.equal(bn(r.total), 17.26, JSON.stringify(opts));
  }
  const all = exposureAsOf(db, { pattern: PATTERN.anthropic, date: '2026-06-30', instrument: 'all' });
  assert.ok(all.total >= 17.26e9);
});

// ---- Shape-level semantics on a hand-built warehouse (rules, not numbers) ----

function miniWarehouse() {
  const w = openWarehouse(':memory:');
  const filing = w.prepare(
    `INSERT INTO filings (accession, fund_key, cik, series_id, report_date, filing_date, form, source)
     VALUES (?, ?, '1', ?, ?, ?, ?, 'edgar')`
  );
  const row = w.prepare(
    `INSERT INTO holdings (accession, row_key, issuer_name, title, balance, value_usd, asset_cat, instrument_type, company_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  return { w, filing, row };
}

test('same-day tie: an NPORT-P/A beats an NPORT-P, then the later accession wins', () => {
  const { w, filing, row } = miniWarehouse();
  filing.run('A-3', 'S1', 'S1', '2026-03-31', '2026-05-29', 'NPORT-P/A');
  filing.run('A-9', 'S1', 'S1', '2026-03-31', '2026-05-29', 'NPORT-P');
  filing.run('B-1', 'S2', 'S2', '2026-03-31', '2026-05-29', 'NPORT-P');
  filing.run('B-2', 'S2', 'S2', '2026-03-31', '2026-05-29', 'NPORT-P');
  for (const a of ['A-3', 'A-9', 'B-1', 'B-2']) row.run(a, 'r', 'ACME INC', 'ACME', 10, 100, 'EC', 'equity', 7);
  const got = w.prepare('SELECT fund_key, accession FROM canonical_filings ORDER BY fund_key').all();
  assert.deepEqual(got, [
    { fund_key: 'S1', accession: 'A-3' },
    { fund_key: 'S2', accession: 'B-2' },
  ]);
  const r = exposureAsOf(w, { companyId: 7, date: '2026-06-30', knownAsOf: '2026-06-30' });
  assert.deepEqual(r.holdings.map(h => h.accession).sort(), ['A-3', 'B-2']);
});

test('an amendment that drops the row turns the fund into an exit; later buyers are not listed', () => {
  const { w, filing, row } = miniWarehouse();
  filing.run('F1', 'S1', 'S1', '2025-12-31', '2026-02-20', 'NPORT-P');
  filing.run('F2', 'S1', 'S1', '2026-03-31', '2026-05-20', 'NPORT-P');
  filing.run('F2A', 'S1', 'S1', '2026-03-31', '2026-06-10', 'NPORT-P/A');
  filing.run('G1', 'S2', 'S2', '2026-06-30', '2026-08-20', 'NPORT-P');
  row.run('F1', 'r', 'ACME INC', 'ACME', 10, 100, 'EC', 'equity', null);
  row.run('F2', 'r', 'ACME INC', 'ACME', 10, 120, 'EC', 'equity', null);
  row.run('G1', 'r', 'ACME INC', 'ACME', 10, 130, 'EC', 'equity', null);
  const r = exposureAsOf(w, { pattern: '\\bacme\\b', date: '2026-03-31' });
  assert.equal(r.funds, 0);
  assert.deepEqual(
    r.exited.map(e => [e.fundKey, e.accession, e.lastHeldDate]),
    [['S1', 'F2A', '2025-12-31']]
  );
  const before = exposureAsOf(w, { pattern: '\\bacme\\b', date: '2026-03-31', knownAsOf: '2026-06-01' });
  assert.deepEqual([before.funds, before.total, before.holdings[0].accession], [1, 120, 'F2']);
});

test('row rules: NULL-balance SPV rows and instrument_type are opt-in; value must be positive', () => {
  const { w, filing, row } = miniWarehouse();
  filing.run('F1', 'S1', 'S1', '2026-06-30', '2026-08-20', 'NPORT-P');
  row.run('F1', 'spv', 'ACME SPV LLC (invested in Acme)', null, null, 50, 'OTHER', 'indirect', null);
  row.run('F1', 'loan', 'ACME TL 1L', null, 1000, 900, 'EP', 'debt', null);
  row.run('F1', 'zero', 'ACME COMMON', null, 5, 0, 'EC', 'equity', null);
  const at = opts => exposureAsOf(w, { pattern: 'acme', date: '2026-06-30', ...opts }).total;
  assert.equal(at({}), 900);
  assert.equal(at({ nullBalance: true }), 950);
  assert.equal(at({ classifyBy: 'instrument_type' }), 0);
  assert.equal(at({ classifyBy: 'instrument_type', nullBalance: true }), 50);
});

test('failure paths: bad input fails loudly', () => {
  const bad = [
    [{ date: '2026-06-30' }, /exactly one of pattern or companyId/],
    [{ pattern: 'x', companyId: 1, date: '2026-06-30' }, /exactly one of pattern or companyId/],
    [{ pattern: 'x' }, /date must be an ISO date/],
    [{ pattern: 'x', date: '06/30/2026' }, /date must be an ISO date/],
    [{ pattern: 'x', date: '2026-13-45' }, /date must be an ISO date/],
    [{ pattern: '', date: '2026-06-30' }, /non-empty/],
    [{ pattern: '(', date: '2026-06-30' }, /Invalid regular expression/],
    [{ companyId: '7', date: '2026-06-30' }, /companyId must be an integer/],
    [{ pattern: 'x', date: '2026-06-30', knownAsOf: 'yesterday' }, /knownAsOf must be an ISO date/],
    [{ pattern: 'x', date: '2026-06-30', instrument: 'debt' }, /debt is not in the warehouse/],
    [{ pattern: 'x', date: '2026-06-30', instrument: 'bonds' }, /unknown instrument/],
    [{ pattern: 'x', date: '2026-06-30', classifyBy: 'level' }, /unknown classifyBy/],
  ];
  for (const [opts, err] of bad) assert.throws(() => exposureAsOf(db, opts), err, JSON.stringify(opts));
  assert.throws(() => instrumentHistory(db, { pattern: 'x' }), /fundKey is required/);
  const { w } = miniWarehouse();
  w.exec('DROP VIEW fund_filing_timeline; DROP VIEW canonical_filings');
  w.prepare(
    "INSERT INTO filings (accession, fund_key, report_date, filing_date, form, source) VALUES ('F','S','2026-06-30','2026-08-01','NPORT-P','edgar')"
  ).run();
  w.prepare(
    "INSERT INTO holdings (accession, row_key, issuer_name, balance, value_usd, asset_cat, instrument_type) VALUES ('F','r','ACME',1,1,'EC','equity')"
  ).run();
  assert.throws(() => exposureAsOf(w, { pattern: 'acme', date: '2026-06-30' }), /no such table: canonical_filings/);
});

test('an empty answer is an answer, not an error', () => {
  const r = exposureAsOf(db, { pattern: 'no such company zzz', date: '2026-06-30' });
  assert.deepEqual([r.funds, r.total, r.holdings, r.exited, r.inactive], [0, 0, [], [], []]);
});
