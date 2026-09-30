// Per-filing totals over ALL of a filing's rows, before the keep rule
// (migration 0015, ROADMAP §5b task 1). The warehouse stores private-candidate
// rows only (ADR 0003), but the fund page needs the whole book: how many rows
// and dollars the filing reports, how much of it is listed stock and debt, and
// v1 Fund X-Ray's own "private" figure (Level 3, not debt) for comparison.
//
// One collector, fed by both ingest paths with the same bulk-shaped fields, so
// a filing loaded from the SEC bulk dataset and the same filing loaded from
// EDGAR XML get identical totals (test/filing-totals.test.js, LESSONS 6).
const { num } = require('./values');
const { isEquityType, isPrivateCandidate } = require('./keep-rule');

const COLUMNS = [
  'rows',
  'value_usd',
  'rows_listed',
  'value_listed',
  'rows_debt',
  'value_debt',
  'rows_l3_equity',
  'value_l3_equity',
];

const emptyTotals = () => Object.fromEntries(COLUMNS.map(c => [c, 0]));

// A row as extractAllHoldings() counts it: a placeholder row with neither a
// balance nor a value is skipped (trap 16); negative values (shorts) count.
// r: bulk field names (FUND_REPORTED_HOLDING, or edgar-rows' bulk-shaped row);
// instrumentType: classifyInstrument's type for the same row.
function addRow(t, r, hasValidIsin, instrumentType) {
  const value = num(r.CURRENCY_VALUE);
  if (!num(r.BALANCE) && !value) return false;
  const v = value || 0;
  t.rows++;
  t.value_usd += v;
  // Listed: an equity-type row the keep rule drops (a valid ISIN/CUSIP, Level
  // 1 or 2, not restricted), i.e. stock the fund prices from a market.
  if (isEquityType(r) && !isPrivateCandidate(r, hasValidIsin)) {
    t.rows_listed++;
    t.value_listed += v;
  }
  if (instrumentType === 'debt') {
    t.rows_debt++;
    t.value_debt += v;
  } else if (String(r.FAIR_VALUE_LEVEL ?? '').trim() === '3') {
    // v1 Fund X-Ray's isPrivateEquityHolding: Level 3 and not debt.
    t.rows_l3_equity++;
    t.value_l3_equity += v;
  }
  return true;
}

function totalsCollector() {
  const byAccession = new Map();
  const get = accession => {
    let t = byAccession.get(accession);
    if (!t) byAccession.set(accession, (t = emptyTotals()));
    return t;
  };
  return {
    // Every filing gets a row, even one that reports no holdings.
    touch: accession => get(accession),
    add: (accession, r, hasValidIsin, instrumentType) => addRow(get(accession), r, hasValidIsin, instrumentType),
    get: accession => byAccession.get(accession),
    size: () => byAccession.size,
    entries: () => byAccession.entries(),
    clear: () => byAccession.clear(),
  };
}

function insertTotalsStatement(db) {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO filing_totals (accession, ${COLUMNS.join(', ')})
     VALUES (@accession, ${COLUMNS.map(c => '@' + c).join(', ')})`
  );
  return (accession, totals) => stmt.run({ accession, ...totals });
}

module.exports = { totalsCollector, insertTotalsStatement, emptyTotals, addRow, COLUMNS };
