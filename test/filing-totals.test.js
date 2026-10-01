// Phase 5b task 1: per-filing totals over ALL rows, before the keep rule.
// Both ingest paths must give identical totals for the same filing (LESSONS 6),
// and those totals must equal v1 Fund X-Ray's own figures (buildFundXRay over
// extractAllHoldings) on the same real XML. Fixture: the 8 real 2026q2 filings
// in test/fixtures/bulk/ (bulk rows and primary_doc.xml trimmed to the same
// holdings, with listed and non-equity rows the keep rule drops).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { openWarehouse } = require('../lib/warehouse/db');
const { ingestBulkZip, bulkFilingExtras } = require('../lib/warehouse/bulk-ingest');
const { parseNportXml, warehouseRowsFromXml } = require('../lib/warehouse/edgar-rows');
const { COLUMNS } = require('../lib/warehouse/filing-totals');
const { extractAllHoldings, extractFundMeta, buildFundXRay } = require('../parsers');

const FIXTURE = path.join(__dirname, 'fixtures', 'bulk');
const ZIP = path.join(FIXTURE, 'mini_nport.zip');
const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'manifest.json'), 'utf8'));
const ACCESSIONS = Object.keys(manifest.filings);

const xmlOf = accession => parseNportXml(fs.readFileSync(path.join(FIXTURE, 'xml', `${accession}.xml`), 'utf8'));
const close = (a, b) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a));

function assertSameTotals(a, b, where) {
  for (const c of COLUMNS) {
    if (c.startsWith('rows')) assert.equal(a[c], b[c], `${where} ${c}`);
    else assert.ok(close(a[c], b[c]), `${where} ${c}: ${a[c]} vs ${b[c]}`);
  }
}

test('filing totals: the bulk and EDGAR-XML paths give identical totals on 8 real filings', async () => {
  const db = openWarehouse(':memory:');
  await ingestBulkZip(db, ZIP, { quarter: '2026q2', sourceUrl: 'fixture' });
  const stored = db.prepare('SELECT * FROM filing_totals WHERE accession = ?');
  let listed = 0;
  let debt = 0;
  let capital = 0;
  for (const accession of ACCESSIONS) {
    const bulk = stored.get(accession);
    assert.ok(bulk, `${accession} has a filing_totals row`);
    const edgar = warehouseRowsFromXml(await xmlOf(accession), {
      accession,
      cik: manifest.filings[accession].cik,
      filingDate: '2026-05-29',
      form: 'NPORT-P',
    });
    assertSameTotals(bulk, edgar.totals, accession);
    // Capital-structure rows: the same debt rows, whichever path read them.
    const sig = r => `${r.issuer_key}|${r.title}|${r.balance}|${r.value_usd}|${r.unit}|${r.fv_level}|${r.cusip}`;
    const bulkCapital = db.prepare('SELECT * FROM capital_structure_rows WHERE accession = ?').all(accession);
    assert.deepEqual(edgar.capital.map(sig).sort(), bulkCapital.map(sig).sort(), `${accession} capital rows`);
    assert.deepEqual(
      bulkCapital.map(r => r.row_key).sort(),
      [...manifest.filings[accession].capitalHoldingIds].sort(),
      `${accession} capital rows are the fixture's`
    );
    capital += bulkCapital.length;
    listed += bulk.rows_listed;
    debt += bulk.rows_debt;
  }
  // The fixture carries dropped rows of both kinds, so the categories are exercised.
  assert.ok(listed > 0 && debt > 0, `listed ${listed}, debt ${debt}`);
  // Real: Ardagh Group SA notes beside Ardagh Holdings SA shares; Westmoreland
  // Mining's 8% term loan beside its common stock.
  assert.equal(capital, 2);
  // Every filing in the quarter gets a row, and nothing else does.
  const n = db.prepare('SELECT COUNT(*) n FROM filing_totals').get().n;
  assert.equal(n, db.prepare('SELECT COUNT(*) n FROM filings').get().n);
  db.close();
});

test('filing totals equal v1 Fund X-Ray (buildFundXRay over extractAllHoldings) on the same XML', async () => {
  const db = openWarehouse(':memory:');
  await ingestBulkZip(db, ZIP, { quarter: '2026q2', sourceUrl: 'fixture' });
  for (const accession of ACCESSIONS) {
    const xml = await xmlOf(accession);
    const holdings = extractAllHoldings(xml);
    const v1 = buildFundXRay(holdings, extractFundMeta(xml));
    const t = db.prepare('SELECT * FROM filing_totals WHERE accession = ?').get(accession);
    assert.equal(t.rows, v1.totalHoldingsCount, `${accession} rows`);
    assert.ok(close(t.value_usd, v1.totalValueUSD), `${accession} value`);
    assert.equal(t.rows_l3_equity, v1.privateHoldingsCount, `${accession} v1 private rows`);
    assert.ok(close(t.value_l3_equity, v1.privateValueUSD), `${accession} v1 private value`);
    const debtRows = holdings.filter(h => h.instrumentType === 'debt');
    assert.equal(t.rows_debt, debtRows.length, `${accession} debt rows`);
    assert.ok(
      close(
        t.value_debt,
        debtRows.reduce((s, h) => s + h.marketValue, 0)
      ),
      `${accession} debt value`
    );
  }
  db.close();
});

test('filing totals: the backfill reader equals ingest, and re-loading a quarter replaces totals', async () => {
  const db = openWarehouse(':memory:');
  await ingestBulkZip(db, ZIP, { quarter: '2026q2', sourceUrl: 'fixture' });
  const fromZip = (await bulkFilingExtras(ZIP)).totals;
  for (const accession of ACCESSIONS) {
    const t = db.prepare('SELECT * FROM filing_totals WHERE accession = ?').get(accession);
    assertSameTotals(t, fromZip.get(accession), accession);
  }
  const before = db.prepare('SELECT COUNT(*) n, SUM(value_usd) v FROM filing_totals').get();
  await ingestBulkZip(db, ZIP, { quarter: '2026q2', sourceUrl: 'fixture' });
  assert.deepEqual(db.prepare('SELECT COUNT(*) n, SUM(value_usd) v FROM filing_totals').get(), before);
  // Deleting a filing cascades to its totals.
  db.prepare('DELETE FROM filings WHERE accession = ?').run(ACCESSIONS[0]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM filing_totals WHERE accession = ?').get(ACCESSIONS[0]).n, 0);
  db.close();
});

test('backfill: bulk totals from the zip and catch-up totals from the XML restore exactly what ingest wrote', async () => {
  const { backfillBulkTotals, backfillEdgarTotals } = require('../lib/warehouse/totals-backfill');
  const db = openWarehouse(':memory:');
  await ingestBulkZip(db, ZIP, { quarter: '2026q2', sourceUrl: 'fixture' });
  const all = () => db.prepare('SELECT * FROM filing_totals ORDER BY accession').all();
  const expected = all();

  db.prepare('DELETE FROM filing_totals').run();
  const download = async (quarter, dir) => {
    const dest = path.join(dir, `${quarter}.zip`);
    fs.copyFileSync(ZIP, dest);
    return { path: dest };
  };
  const bulk = await backfillBulkTotals(db, { download });
  assert.deepEqual(
    bulk.done.map(d => d.quarter),
    ['2026q2']
  );
  assert.equal(bulk.left, 0);
  assert.deepEqual(all(), expected);
  // Resumable: nothing left to do.
  assert.equal((await backfillBulkTotals(db, { download })).done.length, 0);

  // The same filings as catch-up filings, re-read from their XML.
  db.prepare(
    "UPDATE filings SET source = 'edgar' WHERE accession IN (" + ACCESSIONS.map(() => '?').join(',') + ')'
  ).run(...ACCESSIONS);
  db.prepare('DELETE FROM filing_totals WHERE accession IN (' + ACCESSIONS.map(() => '?').join(',') + ')').run(
    ...ACCESSIONS
  );
  const fetchRows = async entry => warehouseRowsFromXml(await xmlOf(entry.accession), entry);
  const edgar = await backfillEdgarTotals(db, { fetchRows, concurrency: 2 });
  assert.equal(edgar.loaded, ACCESSIONS.length);
  assert.deepEqual(edgar.failed, []);
  assert.deepEqual(edgar.keptMismatch, [], 'the re-read filing keeps the same rows as the stored ones');
  assert.equal(edgar.left, 0);
  const got = all();
  for (let i = 0; i < expected.length; i++) assertSameTotals(got[i], expected[i], expected[i].accession);
  db.close();
});

test('capital structure: a debt row joins only an issuer held privately in the same filing (v1 Kandou case)', async () => {
  // Real: Kandou's Series D preferred, warrants and 7.0% term loan in one filing.
  const xml = await parseNportXml(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'nport_kandou_multi_instrument.xml'), 'utf8')
  );
  const r = warehouseRowsFromXml(xml, { accession: 'kandou', cik: '1', filingDate: '2026-01-01', form: 'NPORT-P' });
  assert.deepEqual(
    r.holdings.map(h => h.instrument_type),
    ['equity', 'derivative']
  );
  assert.equal(r.capital.length, 1);
  assert.equal(r.capital[0].issuer_key, 'KANDOU');
  assert.equal(r.capital[0].instrument_type, 'debt');
  assert.equal(r.totals.rows_capital, 1);
  // Debt of an issuer the fund does not hold privately stays out (the fixture's
  // plain non-equity rows).
  const db = openWarehouse(':memory:');
  await ingestBulkZip(db, ZIP, { quarter: '2026q2', sourceUrl: 'fixture' });
  const n = db.prepare("SELECT COUNT(*) n FROM capital_structure_rows WHERE instrument_type != 'debt'").get().n;
  assert.equal(n, 0);
  db.close();
});
