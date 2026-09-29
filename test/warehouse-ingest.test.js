// Phase 1: bulk ingest into the warehouse, checked against REAL filings.
// test/fixtures/bulk/ is built by build-fixture.js from the SEC's 2026q2
// N-PORT dataset plus each filing's primary_doc.xml (trimmed to the same
// holdings). The warehouse must store exactly what extractAllHoldings()
// reads from the XML, for exactly the private-candidate rows.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const xml2js = require('xml2js');

const { openWarehouse, migrate } = require('../lib/warehouse/db');
const { ingestBulkZip, bulkDateToIso, isPrivateCandidate } = require('../lib/warehouse/bulk-ingest');
const { isValidCusip, isValidIsin, fundKeyOf } = require('../lib/warehouse/identifiers');
const { extractAllHoldings } = require('../parsers');

const FIXTURE = path.join(__dirname, 'fixtures', 'bulk');
const ZIP = path.join(FIXTURE, 'mini_nport.zip');
const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'manifest.json'), 'utf8'));

async function parseXml(accession) {
  const xml = fs.readFileSync(path.join(FIXTURE, 'xml', `${accession}.xml`), 'utf8');
  return new xml2js.Parser({
    explicitArray: false,
    mergeAttrs: true,
    normalizeTags: true,
    tagNameProcessors: [xml2js.processors.stripPrefix],
  }).parseStringPromise(xml);
}

async function freshWarehouse() {
  const db = openWarehouse(':memory:');
  const stats = await ingestBulkZip(db, ZIP, { quarter: '2026q2', sourceUrl: 'fixture' });
  return { db, stats };
}

const missing = v => v === null || v === undefined || v === '' || Number.isNaN(v);
const sameNumber = (a, b) =>
  missing(a) || missing(b) ? missing(a) && missing(b) : Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a));
const levelOf = v => (missing(v) || /^N\/?A$/i.test(String(v)) ? null : String(v));

// ── identifiers ─────────────────────────────────────────────────────────────

test('identifiers: real check digits pass; placeholders and dummies fail', () => {
  assert.ok(isValidCusip('037833100'), 'Apple CUSIP');
  assert.ok(isValidIsin('US0378331005'), 'Apple ISIN');
  assert.ok(isValidIsin('GB0002634946'), 'BAE Systems ISIN');
  for (const junk of ['N/A', '', null, '000000000', '999999999', '037833101']) assert.equal(isValidCusip(junk), false);
  for (const junk of ['N/A', '', null, 'US0378331006', '1892140D']) assert.equal(isValidIsin(junk), false);
});

test('fundKeyOf: series ID, else CIK; the S000000000 placeholder counts as blank (trap 20)', () => {
  assert.equal(fundKeyOf('S000009228', '44201'), 'S000009228');
  assert.equal(fundKeyOf('', '2044519'), 'CIK2044519');
  assert.equal(fundKeyOf(null, '2044519'), 'CIK2044519');
  // Real: Delaware Investments Dividend & Income Fund, 0001752724-21-085587 (F20).
  assert.equal(fundKeyOf('S000000000', '896923'), 'CIK896923');
});

test('migration 0004 re-keys stored placeholder-series filings by CIK and keeps series_id as reported', () => {
  const db = openWarehouse(':memory:');
  const ins = db.prepare(
    "INSERT INTO filings (accession, fund_key, cik, series_id, report_date, filing_date, form, source) VALUES (?, ?, ?, ?, '2021-02-26', '2021-04-27', 'NPORT-P', 'bulk:2021q2')"
  );
  ins.run('0001752724-21-085587', 'S000000000', '896923', 'S000000000');
  ins.run('0001752724-21-085169', 'S000000000', '1396167', 'S000000000');
  ins.run('0001193125-26-182055', 'S000009228', '44201', 'S000009228');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '0004_placeholder_series.sql'), 'utf8'));
  const rows = db.prepare('SELECT fund_key, series_id FROM filings ORDER BY accession').all();
  assert.deepEqual(rows, [
    { fund_key: 'S000009228', series_id: 'S000009228' },
    { fund_key: 'CIK1396167', series_id: 'S000000000' },
    { fund_key: 'CIK896923', series_id: 'S000000000' },
  ]);
  // Two funds that shared one key are now two canonical filings.
  assert.equal(db.prepare('SELECT COUNT(*) n FROM canonical_filings').get().n, 3);
});

test('bulkDateToIso: DERA DD-MON-YYYY becomes ISO; junk becomes null', () => {
  assert.equal(bulkDateToIso('28-FEB-2026'), '2026-02-28');
  assert.equal(bulkDateToIso('1-Jul-2025'), '2025-07-01');
  assert.equal(bulkDateToIso(''), null);
  assert.equal(bulkDateToIso('2026-02-28'), null);
});

test('isPrivateCandidate: Level 3 / restricted / no valid id keep; public, non-equity and empty rows drop', () => {
  const row = over => ({
    ASSET_CAT: 'EC',
    DERIVATIVE_CAT: '',
    FAIR_VALUE_LEVEL: '1',
    IS_RESTRICTED_SECURITY: 'N',
    ISSUER_CUSIP: '037833100',
    BALANCE: '10',
    CURRENCY_VALUE: '100',
    ...over,
  });
  assert.equal(isPrivateCandidate(row(), false), false, 'public: Level 1 with a valid CUSIP');
  assert.equal(isPrivateCandidate(row({ ISSUER_CUSIP: 'N/A' }), true), false, 'public: valid ISIN');
  assert.equal(isPrivateCandidate(row({ ISSUER_CUSIP: 'N/A' }), false), true, 'no valid id at all');
  assert.equal(isPrivateCandidate(row({ FAIR_VALUE_LEVEL: '3' }), true), true, 'Level 3');
  assert.equal(isPrivateCandidate(row({ IS_RESTRICTED_SECURITY: 'Y' }), true), true, 'restricted');
  assert.equal(isPrivateCandidate(row({ ASSET_CAT: 'LON', FAIR_VALUE_LEVEL: '3' }), false), false, 'loans are out');
  assert.equal(isPrivateCandidate(row({ ASSET_CAT: 'DE', DERIVATIVE_CAT: 'FUT', ISSUER_CUSIP: '' }), false), false);
  assert.equal(isPrivateCandidate(row({ ASSET_CAT: 'DE', DERIVATIVE_CAT: 'WAR', FAIR_VALUE_LEVEL: '3' }), false), true);
  assert.equal(isPrivateCandidate(row({ FAIR_VALUE_LEVEL: '3', BALANCE: '', CURRENCY_VALUE: '0' }), false), false);
});

// ── migrations ──────────────────────────────────────────────────────────────

test('migrations apply once and are recorded', () => {
  const db = openWarehouse(':memory:');
  const versions = db
    .prepare('SELECT version FROM schema_migrations')
    .all()
    .map(r => r.version);
  const files = fs
    .readdirSync(path.join(__dirname, '..', 'db', 'migrations'))
    .filter(f => /^\d{4}_[\w-]+\.sql$/.test(f))
    .map(f => Number(f.slice(0, 4)))
    .sort((a, b) => a - b);
  assert.deepEqual(versions, files, 'every migration file applied, in order');
  assert.deepEqual(files.slice(0, 2), [1, 2]);
  assert.deepEqual(migrate(db), [], 'nothing left to apply');
  db.close();
});

// ── ingest vs. the real XML ─────────────────────────────────────────────────

test('ingest: every filing stored with ISO dates and a fund key; kept/dropped rows exactly as the manifest', async () => {
  const { db, stats } = await freshWarehouse();
  const accessions = Object.keys(manifest.filings);
  assert.equal(stats.filings, accessions.length);
  for (const accession of accessions) {
    const f = db.prepare('SELECT * FROM filings WHERE accession = ?').get(accession);
    assert.ok(f, accession);
    assert.match(f.report_date, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(f.filing_date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(f.fund_key, f.series_id || `CIK${f.cik}`);
    assert.equal(f.source, 'bulk:2026q2');
    const keys = db
      .prepare('SELECT row_key FROM holdings WHERE accession = ?')
      .all(accession)
      .map(r => r.row_key)
      .sort();
    assert.deepEqual(keys, [...manifest.filings[accession].keptHoldingIds].sort(), `${accession} kept rows`);
    for (const dropped of manifest.filings[accession].droppedHoldingIds) assert.ok(!keys.includes(dropped));
  }
  db.close();
});

test('ingest: warehouse rows equal extractAllHoldings() on the same filing XML, field by field', async () => {
  const { db } = await freshWarehouse();
  let compared = 0;
  for (const accession of Object.keys(manifest.filings)) {
    const parsed = extractAllHoldings(await parseXml(accession));
    const rows = db.prepare('SELECT * FROM holdings WHERE accession = ?').all(accession);
    const used = new Set();
    for (const row of rows) {
      const i = parsed.findIndex(
        (h, idx) => !used.has(idx) && h.title === row.title && sameNumber(h.marketValue, row.value_usd)
      );
      assert.ok(i >= 0, `${accession} ${row.row_key} "${row.title}" has no XML counterpart`);
      used.add(i);
      const h = parsed[i];
      const where = `${accession} "${row.title}"`;
      assert.ok(sameNumber(h.shares, row.balance), `${where} balance`);
      assert.equal(row.instrument_type, h.instrumentType, `${where} instrument type`);
      assert.equal(levelOf(row.fv_level), levelOf(h.fairValLevel), `${where} fair-value level`);
      assert.equal(row.other_id || '', h.filerId || '', `${where} filer instrument id`);
      assert.equal(row.country || '', h.country || '', `${where} country`);
      compared++;
    }
  }
  assert.ok(compared >= 100, `compared ${compared} rows`);
  db.close();
});

test('ingest: GOLDEN F1 — Growth Fund of America Anthropic G-1 and F-1 values (2026-02-28)', async () => {
  const { db } = await freshWarehouse();
  const rows = db
    .prepare(
      "SELECT title, balance, value_usd, fv_level FROM holdings WHERE accession = '0001193125-26-182055' AND title LIKE 'ANTHROPIC PBC CL %'"
    )
    .all();
  const g1 = rows.find(r => r.title.startsWith('ANTHROPIC PBC CL G-1'));
  const f1 = rows.find(r => r.title.startsWith('ANTHROPIC PBC CL F-1'));
  assert.equal(g1.value_usd, 1315268824.79);
  assert.equal(g1.balance, 5075585);
  assert.equal(f1.value_usd, 741023858.08);
  assert.equal(f1.balance, 2859590);
  assert.equal(g1.fv_level, '3');
  db.close();
});

test('ingest: private rows filed at Level 1/2 with junk identifiers are kept (KraneShares, Innovation Access Fund)', async () => {
  const { db } = await freshWarehouse();
  const krane = db
    .prepare("SELECT * FROM holdings WHERE accession = '0002048251-26-004683' AND title LIKE '%ANTHROPIC%'")
    .get();
  assert.equal(krane.fv_level, '1');
  assert.equal(krane.ticker, '1892140D', 'kept even though a (non-exchange) ticker is present');
  const iaf = db
    .prepare("SELECT * FROM holdings WHERE accession = '0001193125-26-239358' AND issuer_name LIKE '%ANTHROPIC%'")
    .get();
  assert.equal(iaf.fv_level, '2');
  assert.equal(iaf.isin, null, 'ISIN "N/A" is stored as missing');
  db.close();
});

test('ingest: SPVs are indirect and warrants are derivatives, as the live parser classifies them', async () => {
  const { db } = await freshWarehouse();
  const destiny = db
    .prepare(
      "SELECT instrument_type, other_asset, COUNT(*) n FROM holdings WHERE accession = '0000894189-26-016628' GROUP BY 1, 2"
    )
    .all();
  assert.ok(destiny.some(r => r.instrument_type === 'indirect' && r.other_asset === 'Special Purpose Vehicle'));
  const warrants = db
    .prepare("SELECT instrument_type FROM holdings WHERE accession = '0000225318-26-000007' AND deriv_cat = 'WAR'")
    .all();
  assert.ok(warrants.length > 0);
  assert.ok(warrants.every(r => r.instrument_type === 'derivative'));
  db.close();
});

test('ingest: CURRENCY_VALUE is the USD value for non-USD holdings (equals XML valUSD)', async () => {
  const { db } = await freshWarehouse();
  const row = db.prepare("SELECT * FROM holdings WHERE accession = '0002048251-26-002806' AND currency = 'CAD'").get();
  assert.ok(row, 'CAD-denominated private holding present');
  const xmlRow = extractAllHoldings(await parseXml('0002048251-26-002806')).find(h => h.title === row.title);
  assert.equal(row.value_usd, xmlRow.marketValue);
  db.close();
});

test('ingest: re-running a quarter replaces it exactly and is logged', async () => {
  const { db, stats } = await freshWarehouse();
  const before = db.prepare('SELECT COUNT(*) n FROM holdings').get().n;
  const again = await ingestBulkZip(db, ZIP, { quarter: '2026q2', sourceUrl: 'fixture' });
  assert.deepEqual(again, stats);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM holdings').get().n, before);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM filings').get().n, stats.filings);
  const log = db.prepare("SELECT status, rows_kept, rows_read FROM ingest_log WHERE kind = 'bulk'").all();
  assert.deepEqual(
    log.map(r => r.status),
    ['ok', 'ok']
  );
  assert.equal(log[1].rows_kept, stats.rowsKept);
  db.close();
});

test('ingest: a bad quarter label or unreadable zip fails loudly and is logged as failed', async () => {
  const db = openWarehouse(':memory:');
  await assert.rejects(() => ingestBulkZip(db, ZIP, { quarter: '2026-Q2' }), /quarter must look like/);
  await assert.rejects(() => ingestBulkZip(db, path.join(FIXTURE, 'manifest.json'), { quarter: '2026q2' }));
  const failed = db.prepare("SELECT status, error FROM ingest_log WHERE status = 'failed'").all();
  assert.equal(failed.length, 1);
  assert.ok(failed[0].error);
  db.close();
});
