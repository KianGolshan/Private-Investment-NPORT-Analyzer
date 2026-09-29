// Loads one SEC DERA N-PORT quarterly dataset zip into the warehouse.
//
// Stores every filing (SUBMISSION ⋈ REGISTRANT ⋈ FUND_REPORTED_INFO) and the
// private-candidate holdings: equity-type rows (EC, EP, OTHER, and warrants)
// that are fair-value Level 3, restricted, or carry no check-digit-valid
// ISIN/CUSIP. Measured on 2026q2: keeps ~70.7k of ~5.35M holding rows, and
// all 1,613 rows naming the 20 tracked private companies, including real
// Level-1/2 private rows with junk identifiers (docs/DATA-QUALITY.md trap 7).
//
// Reads IDENTIFIERS before FUND_REPORTED_HOLDING so each holding can be
// decided as it streams; ~670k rows/quarter would otherwise wait on an ISIN.
const { openZip, readTable } = require('./tsv-zip');
const { isValidCusip, isValidIsin, fundKeyOf } = require('./identifiers');
const { classifyInstrument } = require('../../parsers');

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

// Placeholder text ("N/A", "", "NONE") -> null.
function text(value) {
  const t = String(value ?? '').trim();
  return !t || /^(N\/?A|NONE|NULL|NIL|-+)$/i.test(t) ? null : t;
}

function num(value) {
  const t = String(value ?? '').trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function stripCik(value) {
  const t = String(value ?? '')
    .replace(/\D/g, '')
    .replace(/^0+/, '');
  return t || null;
}

function isEquityType(row) {
  const deriv = String(row.DERIVATIVE_CAT || '').trim();
  if (deriv) return deriv === 'WAR';
  return row.ASSET_CAT === 'EC' || row.ASSET_CAT === 'EP' || row.ASSET_CAT === 'OTHER';
}

function isPrivateCandidate(row, hasValidIsin) {
  if (!isEquityType(row)) return false;
  // Same placeholder rule as extractAllHoldings: a row with neither a balance
  // nor a value carries nothing (real: Destiny Tech100 reports "Rhenium Bolt
  // 2021, LLC" with <balance>N/A</balance> and valUSD 0).
  if (!num(row.BALANCE) && !num(row.CURRENCY_VALUE)) return false;
  if (String(row.FAIR_VALUE_LEVEL).trim() === '3') return true;
  if (String(row.IS_RESTRICTED_SECURITY).trim().toUpperCase() === 'Y') return true;
  return !hasValidIsin && !isValidCusip(row.ISSUER_CUSIP);
}

// Rebuilds the fields classifyInstrument() reads from parsed XML, so bulk
// rows get exactly the instrument type the live parser assigns. In the XML,
// category OTHER only exists as <assetConditional assetCat="OTHER" desc=…/>,
// which the bulk dataset flattens to ASSET_CAT=OTHER + OTHER_ASSET=desc.
function instrumentTypeOf(row) {
  const inv = {
    title: row.ISSUER_TITLE,
    name: row.ISSUER_NAME,
    units: row.UNIT,
    assetCat: row.ASSET_CAT === 'OTHER' ? undefined : row.ASSET_CAT,
  };
  if (row.ASSET_CAT === 'OTHER') inv.assetConditional = { assetCat: 'OTHER', desc: row.OTHER_ASSET || undefined };
  if (row.DERIVATIVE_CAT) inv.derivativeInfo = { optionsWaptionWarrantDeriv: { derivCat: row.DERIVATIVE_CAT } };
  return classifyInstrument(inv, null, null).instrumentType;
}

async function ingestBulkZip(db, zipPath, { quarter, sourceUrl = null, sha256 = null, bytes = null } = {}) {
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
    await readTable(archive, 'REGISTRANT.tsv', r => registrants.set(r.ACCESSION_NUMBER, r));
    const fundInfo = new Map();
    await readTable(archive, 'FUND_REPORTED_INFO.tsv', r => fundInfo.set(r.ACCESSION_NUMBER, r));
    const filings = [];
    await readTable(archive, 'SUBMISSION.tsv', r => {
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
        report_date: bulkDateToIso(r.REPORT_DATE),
        filing_date: bulkDateToIso(r.FILING_DATE),
        form: text(r.SUB_TYPE),
        net_assets: num(info.NET_ASSETS),
        total_assets: num(info.TOTAL_ASSETS),
        source,
      });
    });
    registrants.clear();
    fundInfo.clear();

    // Holdings with a valid ISIN (HOLDING_ID is numeric in every DERA release).
    const isinHolders = new Set();
    await readTable(archive, 'IDENTIFIERS.tsv', r => {
      if (isValidIsin(r.IDENTIFIER_ISIN)) isinHolders.add(Number(r.HOLDING_ID));
    });

    const kept = new Map();
    const rowsRead = await readTable(archive, 'FUND_REPORTED_HOLDING.tsv', r => {
      if (!isPrivateCandidate(r, isinHolders.has(Number(r.HOLDING_ID)))) return;
      kept.set(r.HOLDING_ID, {
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
        instrument_type: instrumentTypeOf(r),
      });
    });
    isinHolders.clear();

    // Second, cheap pass over IDENTIFIERS: attach ids to kept rows only.
    await readTable(archive, 'IDENTIFIERS.tsv', r => {
      const h = kept.get(r.HOLDING_ID);
      if (!h) return;
      h.isin = h.isin || text(r.IDENTIFIER_ISIN);
      h.ticker = h.ticker || text(r.IDENTIFIER_TICKER);
      if (!h.other_id && text(r.OTHER_IDENTIFIER)) {
        h.other_id = text(r.OTHER_IDENTIFIER);
        h.other_id_desc = text(r.OTHER_IDENTIFIER_DESC);
      }
    });

    const insertFiling = db.prepare(
      `INSERT OR REPLACE INTO filings (accession, fund_key, cik, series_id, registrant, series_name, report_date,
         filing_date, form, net_assets, total_assets, source)
       VALUES (@accession, @fund_key, @cik, @series_id, @registrant, @series_name, @report_date, @filing_date,
         @form, @net_assets, @total_assets, @source)`
    );
    const insertHolding = db.prepare(
      `INSERT INTO holdings (accession, row_key, issuer_name, title, cusip, lei, isin, ticker, other_id, other_id_desc,
         balance, unit, currency, value_usd, pct_nav, asset_cat, other_asset, issuer_type, country, restricted,
         fv_level, deriv_cat, instrument_type)
       VALUES (@accession, @row_key, @issuer_name, @title, @cusip, @lei, @isin, @ticker, @other_id, @other_id_desc,
         @balance, @unit, @currency, @value_usd, @pct_nav, @asset_cat, @other_asset, @issuer_type, @country,
         @restricted, @fv_level, @deriv_cat, @instrument_type)`
    );
    // One transaction per quarter: re-running a quarter replaces it exactly.
    // Deleting a filing cascades to its holdings.
    db.transaction(() => {
      db.prepare('DELETE FROM filings WHERE source = ?').run(source);
      for (const f of filings) insertFiling.run(f);
      for (const h of kept.values()) insertHolding.run(h);
    })();

    const stats = { quarter, filings: filings.length, rowsRead, rowsKept: kept.size };
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

module.exports = { ingestBulkZip, bulkDateToIso, isPrivateCandidate, isEquityType, instrumentTypeOf };
