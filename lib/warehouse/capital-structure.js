// Capital-structure rows (migration 0016; ADR 0003 amended 2026-09-30): Fund
// X-Ray groups every instrument of an issuer the fund holds privately, debt
// included (v1 buildIssuerCapitalStructure: Kandou's preferred, warrants and
// term loan in one filing). The keep rule drops debt, so a debt row is kept
// here when its issuer key equals that of a kept non-debt row in the same
// filing. Shared by the bulk and EDGAR paths (test/filing-totals.test.js).
const { issuerKeyOf } = require('../../parsers');

// r: bulk field names (FUND_REPORTED_HOLDING, or edgar-rows' bulk-shaped row).
const issuerKeyOfRow = r => issuerKeyOf({ name: r.ISSUER_NAME, title: r.ISSUER_TITLE });

// Issuer keys of each filing's kept, non-debt rows.
function anchorCollector() {
  const byAccession = new Map();
  return {
    add(accession, r, instrumentType) {
      if (instrumentType === 'debt') return;
      const key = issuerKeyOfRow(r);
      if (!key) return;
      let keys = byAccession.get(accession);
      if (!keys) byAccession.set(accession, (keys = new Set()));
      keys.add(key);
    },
    hasAccession: accession => byAccession.has(accession),
    // The issuer key when a dropped row belongs in capital_structure_rows, else null.
    capitalKey(accession, r, instrumentType) {
      if (instrumentType !== 'debt') return null;
      const keys = byAccession.get(accession);
      if (!keys) return null;
      const key = issuerKeyOfRow(r);
      return key && keys.has(key) ? key : null;
    },
  };
}

const HOLDING_COLUMNS = [
  'accession',
  'row_key',
  'issuer_name',
  'title',
  'cusip',
  'lei',
  'isin',
  'ticker',
  'other_id',
  'other_id_desc',
  'balance',
  'unit',
  'currency',
  'value_usd',
  'pct_nav',
  'asset_cat',
  'other_asset',
  'issuer_type',
  'country',
  'restricted',
  'fv_level',
  'deriv_cat',
  'instrument_type',
];

function insertCapitalStatement(db) {
  const cols = ['issuer_key', ...HOLDING_COLUMNS];
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO capital_structure_rows (${cols.join(', ')}) VALUES (${cols.map(c => '@' + c).join(', ')})`
  );
  return row => stmt.run(row);
}

module.exports = { anchorCollector, issuerKeyOfRow, insertCapitalStatement, HOLDING_COLUMNS };
