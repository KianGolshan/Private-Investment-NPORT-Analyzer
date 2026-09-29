// Phase 4: fund identity (DATA-QUALITY trap 20) and the LEI backfill.
// Identifiers below are the real ones from EDGAR (GOLDEN-NUMBERS F19, F21).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { openWarehouse } = require('../lib/warehouse/db');
const { ingestBulkZip } = require('../lib/warehouse/bulk-ingest');
const { rekeyFunds } = require('../lib/warehouse/fund-keys');
const { backfillLeisFromZip } = require('../lib/warehouse/lei-backfill');

const ZIP = path.join(__dirname, 'fixtures', 'bulk', 'mini_nport.zip');

function warehouse(rows) {
  const db = openWarehouse(':memory:');
  const ins = db.prepare(
    `INSERT INTO filings (accession, fund_key, cik, series_id, series_name, series_lei, report_date, filing_date, form, source)
     VALUES (@accession, @fund_key, @cik, @series_id, @series_name, @series_lei, @report_date, '2026-01-01', 'NPORT-P', 'test')`
  );
  for (const r of rows) ins.run({ series_id: null, series_name: null, ...r, fund_key: r.series_id || `CIK${r.cik}` });
  return db;
}
const keys = db =>
  Object.fromEntries(
    db
      .prepare('SELECT accession, fund_key FROM filings ORDER BY accession')
      .all()
      .map(r => [r.accession, r.fund_key])
  );

test('several series LEIs on one report date with no series IDs: one fund per LEI (Invesco BLDRS)', () => {
  const db = warehouse([
    { accession: 'a1', cik: '1169717', series_lei: '549300LVU6KD2HUIMD47', report_date: '2019-09-30' },
    { accession: 'a2', cik: '1169717', series_lei: '549300POSO253J7MH338', report_date: '2019-09-30' },
    { accession: 'a3', cik: '1169717', series_lei: '549300POSO253J7MH338', report_date: '2019-12-31' },
  ]);
  assert.deepEqual(rekeyFunds(db), { overridden: 0, joined: 0, multi: 3 });
  assert.deepEqual(keys(db), {
    a1: 'CIK1169717:549300LVU6KD2HUIMD47',
    a2: 'CIK1169717:549300POSO253J7MH338',
    a3: 'CIK1169717:549300POSO253J7MH338',
  });
  assert.deepEqual(rekeyFunds(db), { overridden: 0, joined: 0, multi: 0 }, 'idempotent');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM canonical_filings').get().n, 3);
});

test('a single fund whose LEI changes keeps one CIK key (history stays whole)', () => {
  const db = warehouse([
    { accession: 'p1', cik: '1166258', series_lei: 'LEI0000000000000OLD1', report_date: '2025-09-30' },
    { accession: 'p2', cik: '1166258', series_lei: 'LEI0000000000000NEW2', report_date: '2025-12-31' },
  ]);
  rekeyFunds(db);
  assert.deepEqual(keys(db), { p1: 'CIK1166258', p2: 'CIK1166258' });
});

test('a filing that left off its series ID joins the series with the same LEI (Tidal Trust IV)', () => {
  const db = warehouse([
    {
      accession: 't1',
      cik: '2043390',
      series_id: 'S000096306',
      series_lei: '254900ZSRBKPHNL9ZZ37',
      report_date: '2026-01-31',
    },
    { accession: 't2', cik: '2043390', series_lei: '254900ZSRBKPHNL9ZZ37', report_date: '2026-04-30' },
    { accession: 't3', cik: '2043390', series_lei: '254900RX8NWPLNMG9Q58', report_date: '2026-04-30' },
    {
      accession: 't4',
      cik: '2043390',
      series_id: 'S000096308',
      series_lei: '254900RX8NWPLNMG9Q58',
      report_date: '2026-07-31',
    },
  ]);
  assert.deepEqual(rekeyFunds(db), { overridden: 0, joined: 2, multi: 0 });
  assert.deepEqual(keys(db), { t1: 'S000096306', t2: 'S000096306', t3: 'S000096308', t4: 'S000096308' });
});

test('fund_key_overrides: Sardis misreported Ultimus ETF series S000097937 (migration 0006)', () => {
  const db = warehouse([
    {
      accession: 'u1',
      cik: '1545440',
      series_id: 'S000097937',
      series_lei: '2549007LT04F99R6CR27',
      report_date: '2026-02-28',
    },
    { accession: 's1', cik: '2021225', series_lei: '529900CMQ0OEESBVQ461', report_date: '2025-12-31' },
    {
      accession: 's2',
      cik: '2021225',
      series_id: 'S000097937',
      series_lei: '529900CMQ0OEESBVQ461',
      report_date: '2026-03-31',
    },
  ]);
  const r = rekeyFunds(db);
  assert.equal(r.overridden, 1);
  assert.deepEqual(keys(db), { s1: 'CIK2021225', s2: 'CIK2021225', u1: 'S000097937' });
  const reason = db.prepare("SELECT reason FROM fund_key_overrides WHERE series_id = 'S000097937'").get().reason;
  assert.match(reason, /Ultimus Managers Trust \(CIK 1545440/);
});

test('bulk ingest stores series and registrant LEIs and applies the fund-key rules', async () => {
  const db = openWarehouse(':memory:');
  await ingestBulkZip(db, ZIP, { quarter: '2026q2' });
  const f = db.prepare("SELECT series_lei, registrant_lei FROM filings WHERE accession = '0002048251-26-004683'").get();
  assert.equal(f.series_lei, '254900J0TWMFUBE50084'); // KraneShares AI & Technology ETF
  assert.match(f.registrant_lei, /^[0-9A-Z]{20}$/);
});

test('LEI backfill fills filings loaded before migration 0005, logs the quarter, and fails loudly on a mismatch', async () => {
  const db = openWarehouse(':memory:');
  await ingestBulkZip(db, ZIP, { quarter: '2026q2' });
  const before = db.prepare('SELECT accession, series_lei, registrant_lei FROM filings ORDER BY accession').all();
  db.exec('UPDATE filings SET series_lei = NULL, registrant_lei = NULL');
  const r = await backfillLeisFromZip(db, ZIP, { quarter: '2026q2' });
  assert.equal(r.updated, before.length);
  assert.deepEqual(
    db.prepare('SELECT accession, series_lei, registrant_lei FROM filings ORDER BY accession').all(),
    before
  );
  const log = db.prepare("SELECT status, filings FROM ingest_log WHERE kind = 'lei-backfill'").get();
  assert.deepEqual(log, { status: 'ok', filings: before.length });

  // A stored filing that is not in the zip means the wrong zip: fail, log it.
  db.prepare(
    "INSERT INTO filings (accession, fund_key, report_date, filing_date, form, source) VALUES ('0000000000-26-000001','S1','2026-03-31','2026-05-01','NPORT-P','bulk:2026q2')"
  ).run();
  await assert.rejects(backfillLeisFromZip(db, ZIP, { quarter: '2026q2' }), /updated \d+ of \d+ stored filings/);
  const failed = db.prepare("SELECT status FROM ingest_log WHERE kind = 'lei-backfill' ORDER BY id DESC").get();
  assert.equal(failed.status, 'failed');
  db.exec('UPDATE filings SET series_lei = NULL');
  await assert.rejects(backfillLeisFromZip(db, ZIP, { quarter: '2026q2' }));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM filings WHERE series_lei IS NOT NULL').get().n, 0, 'rolled back');
  await assert.rejects(backfillLeisFromZip(db, ZIP, { quarter: 'q2' }), /bad quarter/);
});
