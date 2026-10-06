// Loads one SEC DERA N-PORT quarterly dataset zip into the warehouse.
//
// Stores every filing (SUBMISSION ⋈ REGISTRANT ⋈ FUND_REPORTED_INFO) and the
// private-candidate holdings: equity-type rows (EC, EP, OTHER, and warrants)
// that are fair-value Level 3, restricted, or carry no check-digit-valid
// ISIN/CUSIP. Measured on 2026q2: keeps ~70.7k of ~5.35M holding rows, and
// all 1,613 rows naming the 20 tracked private companies, including real
// Level-1/2 private rows with junk identifiers (docs/DATA-QUALITY.md trap 7).
// Also per-filing totals over all rows (filing_totals) and the debt rows of
// issuers held privately in the same filing (capital_structure_rows).
const { openZip, readTable } = require('./tsv-zip');
const { isValidIsin, fundKeyOf } = require('./identifiers');
const { text, num } = require('./values');
const { isPrivateCandidate } = require('./keep-rule');
const { classifyStored } = require('./keep-rule');
const { rekeyFunds } = require('./fund-keys');
const { listingEvidenceCollector } = require('./listing-evidence');
const { totalsCollector, insertTotalsStatement } = require('./filing-totals');
const { anchorCollector, insertCapitalStatement } = require('./capital-structure');

// The holding columns the keep rule and the stored row read (F12: a renamed
// or dropped column fails the quarter instead of loading blanks).
const HOLDING_COLUMNS = [
  'ACCESSION_NUMBER',
  'HOLDING_ID',
  'ISSUER_NAME',
  'ISSUER_TITLE',
  'ISSUER_CUSIP',
  'ISSUER_LEI',
  'BALANCE',
  'UNIT',
  'CURRENCY_CODE',
  'CURRENCY_VALUE',
  'PERCENTAGE',
  'ASSET_CAT',
  'ISSUER_TYPE',
  'INVESTMENT_COUNTRY',
  'IS_RESTRICTED_SECURITY',
  'FAIR_VALUE_LEVEL',
];
// A re-load that would replace a quarter with markedly fewer filings than the
// last good load of it is refused (a truncated or malformed re-post), unless
// the caller says the shrink is expected.
const MIN_RELOAD_SHARE = 0.9;

const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };

// '24-APR-2026' -> '2026-04-24'; anything else -> null.
function bulkDateToIso(value) {
  const m = /^(\d{1,2})-([A-Z]{3})-(\d{4})$/.exec(
    String(value || '')
      .trim()
      .toUpperCase()
  );
  if (!m || !MONTHS[m[2]]) return null;
  return `${m[3]}-${String(MONTHS[m[2]]).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

function stripCik(value) {
  const t = String(value ?? '')
    .replace(/\D/g, '')
    .replace(/^0+/, '');
  return t || null;
}

// Rebuilds the fields classifyInstrument() reads from parsed XML, so bulk
// rows get exactly the instrument type the live parser assigns. In the XML,
// category OTHER only exists as <assetConditional assetCat="OTHER" desc=…/>,
// which the bulk dataset flattens to ASSET_CAT=OTHER + OTHER_ASSET=desc.
function instrumentTypeOf(row) {
  return classifyStored({
    title: row.ISSUER_TITLE,
    name: row.ISSUER_NAME,
    unit: row.UNIT,
    assetCat: row.ASSET_CAT,
    otherAsset: row.OTHER_ASSET,
    derivCat: row.DERIVATIVE_CAT,
  }).instrumentType;
}

// A holdings-shaped row from one FUND_REPORTED_HOLDING row; ids are attached
// from IDENTIFIERS afterwards.
function bulkHoldingRow(r, instrumentType) {
  return {
    accession: r.ACCESSION_NUMBER,
    row_key: r.HOLDING_ID,
    issuer_name: text(r.ISSUER_NAME),
    title: text(r.ISSUER_TITLE),
    cusip: text(r.ISSUER_CUSIP),
    lei: text(r.ISSUER_LEI),
    isin: null,
    ticker: null,
    other_id: null,
    other_id_desc: null,
    balance: num(r.BALANCE),
    unit: text(r.UNIT),
    currency: text(r.CURRENCY_CODE),
    value_usd: num(r.CURRENCY_VALUE),
    pct_nav: num(r.PERCENTAGE),
    asset_cat: text(r.ASSET_CAT),
    other_asset: text(r.OTHER_ASSET),
    issuer_type: text(r.ISSUER_TYPE),
    country: text(r.INVESTMENT_COUNTRY),
    restricted: text(r.IS_RESTRICTED_SECURITY),
    fv_level: text(r.FAIR_VALUE_LEVEL),
    deriv_cat: text(r.DERIVATIVE_CAT),
    instrument_type: instrumentType,
  };
}

// Every row of a quarter's holdings, read once for the kept rows, totals and
// listing evidence, and once more (only filings with a kept row) for the
// capital-structure debt rows, whose anchors are known only after the first
// pass. Reads IDENTIFIERS before FUND_REPORTED_HOLDING so each holding can be
// decided as it streams; ~670k rows/quarter would otherwise wait on an ISIN.
async function readBulkRows(archive, accessions) {
  // Holdings with a valid ISIN (HOLDING_ID is numeric in every DERA release).
  const isinHolders = new Set();
  await readTable(archive, 'IDENTIFIERS.tsv', r => {
    if (isValidIsin(r.IDENTIFIER_ISIN)) isinHolders.add(Number(r.HOLDING_ID));
  });

  const kept = new Map();
  const listing = listingEvidenceCollector();
  const totals = totalsCollector();
  const anchors = anchorCollector();
  for (const a of accessions) totals.touch(a);
  const rowsRead = await readTable(
    archive,
    'FUND_REPORTED_HOLDING.tsv',
    r => {
      const hasValidIsin = isinHolders.has(Number(r.HOLDING_ID));
      const instrumentType = instrumentTypeOf(r);
      totals.add(r.ACCESSION_NUMBER, r, hasValidIsin, instrumentType);
      if (!isPrivateCandidate(r, hasValidIsin)) {
        listing.add(r, hasValidIsin);
        return;
      }
      anchors.add(r.ACCESSION_NUMBER, r, instrumentType);
      kept.set(r.HOLDING_ID, bulkHoldingRow(r, instrumentType));
    },
    { required: HOLDING_COLUMNS, minRows: 1 }
  );
  isinHolders.clear();

  const capital = new Map();
  await readTable(archive, 'FUND_REPORTED_HOLDING.tsv', r => {
    if (!anchors.hasAccession(r.ACCESSION_NUMBER) || kept.has(r.HOLDING_ID)) return;
    if (!num(r.BALANCE) && !num(r.CURRENCY_VALUE)) return; // placeholder, as extractAllHoldings
    const instrumentType = instrumentTypeOf(r);
    const key = anchors.capitalKey(r.ACCESSION_NUMBER, r, instrumentType);
    if (!key) return;
    capital.set(r.HOLDING_ID, { issuer_key: key, ...bulkHoldingRow(r, instrumentType) });
    const t = totals.get(r.ACCESSION_NUMBER);
    if (t) t.rows_capital++;
  });

  // Last, cheap pass over IDENTIFIERS: attach ids to stored rows only.
  await readTable(archive, 'IDENTIFIERS.tsv', r => {
    const h = kept.get(r.HOLDING_ID) || capital.get(r.HOLDING_ID);
    if (!h) return;
    h.isin = h.isin || text(r.IDENTIFIER_ISIN);
    h.ticker = h.ticker || text(r.IDENTIFIER_TICKER);
    if (!h.other_id && text(r.OTHER_IDENTIFIER)) {
      h.other_id = text(r.OTHER_IDENTIFIER);
      h.other_id_desc = text(r.OTHER_IDENTIFIER_DESC);
    }
  });
  return { kept, capital, totals, listing, rowsRead };
}

async function ingestBulkZip(
  db,
  zipPath,
  { quarter, sourceUrl = null, sha256 = null, bytes = null, allowShrink = false } = {}
) {
  if (!/^\d{4}q[1-4]$/.test(quarter || '')) throw new Error(`quarter must look like 2026q2, got "${quarter}"`);
  const source = `bulk:${quarter}`;
  const startedAt = new Date().toISOString();
  const logId = db
    .prepare(
      `INSERT INTO ingest_log (kind, quarter, source_url, zip_sha256, zip_bytes, started_at, status)
       VALUES ('bulk', ?, ?, ?, ?, ?, 'running')`
    )
    .run(quarter, sourceUrl, sha256, bytes, startedAt).lastInsertRowid;

  let archive = null;
  try {
    archive = await openZip(zipPath);
    const registrants = new Map();
    await readTable(archive, 'REGISTRANT.tsv', r => registrants.set(r.ACCESSION_NUMBER, r), {
      required: ['ACCESSION_NUMBER', 'CIK', 'REGISTRANT_NAME'],
      minRows: 1,
    });
    const fundInfo = new Map();
    await readTable(archive, 'FUND_REPORTED_INFO.tsv', r => fundInfo.set(r.ACCESSION_NUMBER, r), {
      required: ['ACCESSION_NUMBER', 'SERIES_ID', 'SERIES_NAME', 'NET_ASSETS'],
      minRows: 1,
    });
    const filings = [];
    await readTable(
      archive,
      'SUBMISSION.tsv',
      r => {
        const reg = registrants.get(r.ACCESSION_NUMBER) || {};
        const info = fundInfo.get(r.ACCESSION_NUMBER) || {};
        const cik = stripCik(reg.CIK);
        const seriesId = text(info.SERIES_ID);
        filings.push({
          accession: r.ACCESSION_NUMBER,
          fund_key: fundKeyOf(seriesId, cik),
          cik,
          series_id: seriesId,
          registrant: text(reg.REGISTRANT_NAME),
          series_name: text(info.SERIES_NAME),
          series_lei: text(info.SERIES_LEI),
          registrant_lei: text(reg.LEI),
          report_date: bulkDateToIso(r.REPORT_DATE),
          filing_date: bulkDateToIso(r.FILING_DATE),
          form: text(r.SUB_TYPE),
          net_assets: num(info.NET_ASSETS),
          total_assets: num(info.TOTAL_ASSETS),
          source,
        });
      },
      { required: ['ACCESSION_NUMBER', 'REPORT_DATE', 'FILING_DATE', 'SUB_TYPE'], minRows: 1 }
    );
    registrants.clear();
    fundInfo.clear();

    const { kept, capital, totals, listing, rowsRead } = await readBulkRows(
      archive,
      filings.map(f => f.accession)
    );

    // Every kept row must belong to a filing of this archive (F12: referential
    // coverage), else the archive is inconsistent and nothing is replaced.
    const known = new Set(filings.map(f => f.accession));
    let orphans = 0;
    for (const h of kept.values()) if (!known.has(h.accession)) orphans++;
    if (orphans) throw new Error(`${quarter}: ${orphans} holding row(s) belong to no filing in SUBMISSION.tsv`);
    const before = db
      .prepare("SELECT filings FROM ingest_log WHERE kind = 'bulk' AND status = 'ok' AND quarter = ? ORDER BY id DESC")
      .get(quarter)?.filings;
    if (!allowShrink && before && filings.length < before * MIN_RELOAD_SHARE)
      throw new Error(
        `${quarter}: the archive has ${filings.length} filings, the last load had ${before}; ` +
          'refusing to replace the quarter (pass allowShrink if expected)'
      );
    const insertFiling = db.prepare(
      `INSERT OR REPLACE INTO filings (accession, fund_key, cik, series_id, registrant, series_name, report_date,
         filing_date, form, net_assets, total_assets, source, series_lei, registrant_lei)
       VALUES (@accession, @fund_key, @cik, @series_id, @registrant, @series_name, @report_date, @filing_date,
         @form, @net_assets, @total_assets, @source, @series_lei, @registrant_lei)`
    );
    const insertHolding = db.prepare(
      `INSERT INTO holdings (accession, row_key, issuer_name, title, cusip, lei, isin, ticker, other_id, other_id_desc,
         balance, unit, currency, value_usd, pct_nav, asset_cat, other_asset, issuer_type, country, restricted,
         fv_level, deriv_cat, instrument_type)
       VALUES (@accession, @row_key, @issuer_name, @title, @cusip, @lei, @isin, @ticker, @other_id, @other_id_desc,
         @balance, @unit, @currency, @value_usd, @pct_nav, @asset_cat, @other_asset, @issuer_type, @country,
         @restricted, @fv_level, @deriv_cat, @instrument_type)`
    );
    const insertTotals = insertTotalsStatement(db);
    const insertCapital = insertCapitalStatement(db);
    // One transaction per quarter: re-running a quarter replaces it exactly.
    // Deleting a filing cascades to its holdings, totals and capital rows.
    db.transaction(() => {
      db.prepare('DELETE FROM filings WHERE source = ?').run(source);
      for (const f of filings) insertFiling.run(f);
      for (const h of kept.values()) insertHolding.run(h);
      for (const c of capital.values()) insertCapital(c);
      for (const f of filings) insertTotals(f.accession, totals.get(f.accession));
      listing.store(db, quarter);
      rekeyFunds(db);
    })();

    const stats = { quarter, filings: filings.length, rowsRead, rowsKept: kept.size, rowsCapital: capital.size };
    db.prepare(
      `UPDATE ingest_log SET filings = ?, rows_read = ?, rows_kept = ?, finished_at = ?, status = 'ok' WHERE id = ?`
    ).run(stats.filings, stats.rowsRead, stats.rowsKept, new Date().toISOString(), logId);
    return stats;
  } catch (err) {
    db.prepare(`UPDATE ingest_log SET finished_at = ?, status = 'failed', error = ? WHERE id = ?`).run(
      new Date().toISOString(),
      String(err && err.message ? err.message : err),
      logId
    );
    throw err;
  } finally {
    if (archive) archive.zip.close();
  }
}

// Totals and capital-structure rows only, for filings already loaded
// (scripts/backfill-filing-totals.js): the same reader as ingestBulkZip,
// without rewriting filings or holdings.
async function bulkFilingExtras(zipPath) {
  const archive = await openZip(zipPath);
  try {
    const accessions = [];
    await readTable(archive, 'SUBMISSION.tsv', r => accessions.push(r.ACCESSION_NUMBER));
    const { totals, capital } = await readBulkRows(archive, accessions);
    return { totals: new Map(totals.entries()), capital: [...capital.values()] };
  } finally {
    archive.zip.close();
  }
}

module.exports = { ingestBulkZip, bulkFilingExtras, bulkDateToIso, instrumentTypeOf };
