// As-of exposure over the warehouse (docs/decisions/0004-as-of-semantics.md).
//
// exposureAsOf(db, { pattern | companyId, date }) answers "who held the company
// as of D, and for how much". For every fund that held it on or before D:
//   1. take the fund's latest canonical filing with report_date <= D, whatever
//      it contains;
//   2. no row for the company in that filing means the fund exited (0);
//   3. no filing within 123 days before D means the fund is inactive
//      (excluded).
// Each fund comes back with its mark date and accession, because funds report
// on staggered fiscal calendars and "as of D" mixes dates.
//
// A company is a companyId (holdings.company_id, set from the reviewed alias
// tables, lib/entities/resolve.js) or a case-insensitive pattern over
// holdings.issuer_name and holdings.title (the research method). Positions
// held through a named SPV carry viaSpv: show them as "indirect".
const { detectSplit } = require('../../public/splits');
const { instrumentKeyOf } = require('../../parsers');

const INACTIVE_DAYS = 123;
const DAY_MS = 86400000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Row rules (decided 2026-09-28, STATUS "Phase 3 decisions"). Equity-type
// means classifyInstrument's equity, indirect (SPVs, "private fund" rows) or
// derivative (warrants): everything but debt, as v1's isPrivateEquityHolding.
// A row counts when its value is positive; a NULL balance ("N/A" on real SPV
// rows, trap 16) counts too. The research method behind GOLDEN-NUMBERS
// A1-A6 stays available: { classifyBy: 'asset_cat', nullBalance: false }.
const EQUITY_BY = {
  asset_cat: "h.asset_cat IN ('EC','EP','OTHER','DE')",
  instrument_type: "h.instrument_type IN ('equity','indirect','derivative')",
};

// Same precedence as the canonical_filings view (db/migrations/0003), limited
// to filings made on or before @known.
const KNOWN_CANONICAL = `
  SELECT f.* FROM filings f
  WHERE f.fund_key = @fundKey AND f.report_date <= @date AND f.filing_date <= @known
    AND NOT EXISTS (
      SELECT 1 FROM filings g
      WHERE g.fund_key = f.fund_key AND g.report_date = f.report_date AND g.accession <> f.accession
        AND g.filing_date <= @known
        AND (g.filing_date > f.filing_date
          OR (g.filing_date = f.filing_date AND (g.form = 'NPORT-P/A') > (f.form = 'NPORT-P/A'))
          OR (g.filing_date = f.filing_date AND (g.form = 'NPORT-P/A') = (f.form = 'NPORT-P/A')
              AND g.accession > f.accession)))
  ORDER BY f.report_date`;
const VIEW_CANONICAL = `
  SELECT * FROM canonical_filings WHERE fund_key = @fundKey AND report_date <= @date ORDER BY report_date`;

const registered = new WeakSet();
function registerRegexp(db) {
  if (registered.has(db)) return;
  const cache = new Map();
  db.function('vantage_match', { deterministic: true }, (pattern, text) => {
    if (text == null) return 0;
    let re = cache.get(pattern);
    if (!re) cache.set(pattern, (re = new RegExp(pattern, 'i')));
    return re.test(text) ? 1 : 0;
  });
  registered.add(db);
}

function toPatternSource(pattern) {
  const src = pattern instanceof RegExp ? pattern.source : pattern;
  if (typeof src !== 'string' || !src.trim())
    throw new Error('exposureAsOf: pattern must be a non-empty string or RegExp');
  new RegExp(src, 'i'); // throws on an invalid pattern
  return src;
}

function checkDate(name, d) {
  if (typeof d !== 'string' || !ISO_DATE.test(d) || Number.isNaN(Date.parse(d)))
    throw new Error(`exposureAsOf: ${name} must be an ISO date (YYYY-MM-DD), got ${JSON.stringify(d)}`);
  return d;
}

const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);

// Builds the WHERE clause selecting the company's rows under the row rule.
function rowFilter(db, opts) {
  const { pattern, companyId, instrument = 'equity', classifyBy = 'instrument_type', nullBalance = true } = opts;
  if ((pattern == null) === (companyId == null))
    throw new Error('exposureAsOf: pass exactly one of pattern or companyId');
  const where = [];
  const params = {};
  if (pattern != null) {
    registerRegexp(db);
    params.pattern = toPatternSource(pattern);
    where.push('(vantage_match(@pattern, h.issuer_name) OR vantage_match(@pattern, h.title))');
  } else {
    if (!Number.isInteger(companyId)) throw new Error('exposureAsOf: companyId must be an integer');
    params.companyId = companyId;
    where.push('h.company_id = @companyId');
  }
  if (instrument === 'equity') {
    if (!EQUITY_BY[classifyBy]) throw new Error(`exposureAsOf: unknown classifyBy ${JSON.stringify(classifyBy)}`);
    where.push(EQUITY_BY[classifyBy]);
  } else if (instrument === 'debt') {
    // The keep rule (ADR 0003) stores equity-type rows only: real DBT rows,
    // e.g. Databricks term loans, are not in the warehouse. A debt answer
    // from it would be a silent undercount.
    throw new Error('exposureAsOf: debt is not in the warehouse (equity-type rows only, ADR 0003)');
  } else if (instrument !== 'all') {
    throw new Error(`exposureAsOf: unknown instrument ${JSON.stringify(instrument)}`);
  }
  where.push('h.value_usd > 0');
  where.push(nullBalance ? '(h.balance > 0 OR h.balance IS NULL)' : 'h.balance > 0');
  return { where: where.join(' AND '), params };
}

// All of the company's rows (under the row rule) with their filing, before
// canonical selection. Filings made after `known` are invisible.
function companyRows(db, opts, known) {
  const { where, params } = rowFilter(db, opts);
  return db
    .prepare(
      `SELECT h.*, f.fund_key, f.report_date, f.filing_date
       FROM holdings h JOIN filings f ON f.accession = h.accession
       WHERE ${where} AND f.filing_date <= @known`
    )
    .all({ ...params, known });
}

const fundInfo = f => ({
  fundKey: f.fund_key,
  cik: f.cik,
  seriesId: f.series_id,
  registrant: f.registrant,
  seriesName: f.series_name,
  markDate: f.report_date,
  filingDate: f.filing_date,
  accession: f.accession,
  form: f.form,
  source: f.source,
});

const rowInfo = h => ({
  rowKey: h.row_key,
  issuerName: h.issuer_name,
  title: h.title,
  instrumentKey: instrumentKeyOf({ otherId: h.other_id, cusip: h.cusip, title: h.title, name: h.issuer_name }),
  balance: h.balance,
  unit: h.unit,
  valueUsd: h.value_usd,
  pricePerShare: h.balance > 0 ? h.value_usd / h.balance : null,
  assetCat: h.asset_cat,
  instrumentType: h.instrument_type,
  fvLevel: h.fv_level,
  viaSpv: h.via_spv === 1,
});

// knownAsOf: true (= date) or an ISO date. Only filings made on or before it
// count, including amendments: "what was public on that day".
function resolveKnown(knownAsOf, date) {
  if (knownAsOf == null || knownAsOf === false) return null;
  if (knownAsOf === true) return date;
  return checkDate('knownAsOf', knownAsOf);
}

function canonicalFilingsFor(db, known) {
  const stmt = db.prepare(known ? KNOWN_CANONICAL : VIEW_CANONICAL);
  return (fundKey, date) => stmt.all(known ? { fundKey, date, known } : { fundKey, date });
}

function exposureAsOf(db, opts = {}) {
  const date = checkDate('date', opts.date);
  const known = resolveKnown(opts.knownAsOf, date);
  const inactiveDays = opts.inactiveDays ?? INACTIVE_DAYS;
  const rows = companyRows(db, opts, known || '9999-12-31');
  const canonicalOf = canonicalFilingsFor(db, known);

  const rowsByAccession = new Map();
  for (const r of rows) {
    if (!rowsByAccession.has(r.accession)) rowsByAccession.set(r.accession, []);
    rowsByAccession.get(r.accession).push(r);
  }

  const holdings = [];
  const exited = [];
  const inactive = [];
  const fundKeys = [...new Set(rows.filter(r => r.report_date <= date).map(r => r.fund_key))].sort();
  for (const fundKey of fundKeys) {
    const timeline = canonicalOf(fundKey, date);
    // Only canonical filings count: a superseded filing's row is not a holding.
    const held = timeline.filter(f => rowsByAccession.has(f.accession));
    if (!held.length) continue;
    const latest = timeline[timeline.length - 1];
    const lastHeld = held[held.length - 1];
    const info = { ...fundInfo(latest), lastHeldDate: lastHeld.report_date, lastHeldAccession: lastHeld.accession };
    if (daysBetween(latest.report_date, date) > inactiveDays) {
      inactive.push(info);
    } else if (lastHeld.accession === latest.accession) {
      const positions = rowsByAccession.get(latest.accession).map(rowInfo);
      const value = positions.reduce((s, p) => s + p.valueUsd, 0);
      holdings.push({ ...info, value, positions });
    } else {
      exited.push(info);
    }
  }
  holdings.sort((a, b) => b.value - a.value || a.fundKey.localeCompare(b.fundKey));
  return {
    date,
    knownAsOf: known,
    instrument: opts.instrument || 'equity',
    funds: holdings.length,
    total: holdings.reduce((s, h) => s + h.value, 0),
    holdings,
    exited,
    inactive,
  };
}

// One fund's positions in the company across its canonical filings, grouped
// into (fund, instrument) series, with splits flagged by public/splits.js.
// A split is compared with the previous filing that reported the instrument.
function instrumentHistory(db, opts = {}) {
  const { fundKey } = opts;
  if (!fundKey) throw new Error('instrumentHistory: fundKey is required');
  const date = opts.date ? checkDate('date', opts.date) : '9999-12-31';
  const rows = companyRows(db, opts, '9999-12-31').filter(r => r.fund_key === fundKey && r.report_date <= date);
  const canonical = new Set(canonicalFilingsFor(db, null)(fundKey, date).map(f => f.accession));
  const series = new Map();
  for (const r of rows
    .filter(r => canonical.has(r.accession))
    .sort((a, b) => (a.report_date < b.report_date ? -1 : 1))) {
    const p = { markDate: r.report_date, accession: r.accession, ...rowInfo(r) };
    if (!series.has(p.instrumentKey)) series.set(p.instrumentKey, []);
    series.get(p.instrumentKey).push(p);
  }
  return [...series].map(([instrumentKey, points]) => {
    let factor = 1; // multiply balance by splitFactor to express it in latest-share terms
    const out = points.map((p, i) => {
      const prev = points[i - 1];
      const split = prev
        ? detectSplit(
            { shares: prev.balance, pricePerShare: prev.pricePerShare },
            { shares: p.balance, pricePerShare: p.pricePerShare }
          )
        : null;
      return { ...p, split };
    });
    for (let i = out.length - 1; i >= 0; i--) {
      out[i].splitFactor = factor;
      if (out[i].split) factor *= out[i].split;
    }
    return { instrumentKey, points: out };
  });
}

module.exports = { exposureAsOf, instrumentHistory, INACTIVE_DAYS };
