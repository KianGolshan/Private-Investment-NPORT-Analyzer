// As-of exposure over the warehouse (docs/decisions/0004-as-of-semantics.md).
//
// exposureAsOf(db, { pattern | companyId, date }) answers "who held the company
// as of D, and for how much". For every fund that held it on or before D:
//   1. take the fund's latest canonical filing with report_date <= D, whatever
//      it contains;
//   2. no row for the company in that filing means the fund exited (0);
//      a row valued at $0 is still reported: the fund is listed under
//      zeroValue, never as an exit (GOLDEN F34);
//   3. no filing within 123 days before D means the fund is inactive
//      (excluded).
// Each fund comes back with its mark date and accession, because funds report
// on staggered fiscal calendars and "as of D" mixes dates.
//
// A company is a companyId (holdings.company_id, set from the reviewed alias
// tables, lib/entities/resolve.js), an entityId (holdings.entity_id: rows no
// company claims, grouped by identity component, lib/entities/entities.js) or
// a case-insensitive pattern over holdings.issuer_name and holdings.title (the
// research method). Positions
// held through a named SPV carry viaSpv: show them as "indirect".
const { detectSplit } = require('../../public/splits');
const { instrumentKeyOf } = require('../../parsers');
const { classifyStored } = require('../warehouse/keep-rule');

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
  const {
    pattern,
    companyId,
    entityId,
    instrument = 'equity',
    classifyBy = 'instrument_type',
    nullBalance = true,
  } = opts;
  if ([pattern, companyId, entityId].filter(v => v != null).length !== 1)
    throw new Error('exposureAsOf: pass exactly one of pattern, companyId or entityId');
  const where = [];
  const params = {};
  if (pattern != null) {
    registerRegexp(db);
    params.pattern = toPatternSource(pattern);
    where.push('(vantage_match(@pattern, h.issuer_name) OR vantage_match(@pattern, h.title))');
  } else if (companyId != null) {
    if (!Number.isInteger(companyId)) throw new Error('exposureAsOf: companyId must be an integer');
    params.companyId = companyId;
    where.push('h.company_id = @companyId');
  } else {
    if (!Number.isInteger(entityId)) throw new Error('exposureAsOf: entityId must be an integer');
    params.entityId = entityId;
    where.push('h.entity_id = @entityId');
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
  return { where: where.join(' AND '), params, counts: countsRule(nullBalance) };
}

// A row counts toward exposure when its value is positive; a row with no
// share count counts unless nullBalance is false. "No share count" is a NULL
// balance ("N/A" on SPVs, trap 16) or a balance of 0 on an interest that
// "does not issue shares" (fund-of-funds LP interests, trap 43, GOLDEN F35).
// Neither has a per-share or per-unit price.
const countsRule = nullBalance => h =>
  h.value_usd > 0 && (h.balance > 0 || (nullBalance && (h.balance == null || h.balance === 0)));

// The company's rows with their filing, before canonical selection: the rows
// that count, plus rows valued at $0 or less (a position written down to
// nothing is still reported, so its fund has not exited). Each is marked
// `counts`. Filings made after `known` are invisible. opts.only: a row
// predicate narrowing the company to a scope (services/scope.js: firm, fund,
// class, kind); every answer built on these rows then sees only that scope.
function companyRows(db, opts, known) {
  const { where, params, counts } = rowFilter(db, opts);
  const rows = db
    .prepare(
      `SELECT h.*, f.fund_key, f.report_date, f.filing_date
       FROM holdings h JOIN filings f ON f.accession = h.accession
       WHERE ${where} AND f.filing_date <= @known`
    )
    .all({ ...params, known })
    .map(r => ({ ...r, counts: counts(r) }))
    .filter(r => r.counts || !(r.value_usd > 0));
  return opts.only ? rows.filter(opts.only) : rows;
}

// Private-company rows of many filings at once, under the same equity and
// counting rules as companyRows: every row of a curated private company
// (company_id) in the given accessions, with `counts`. For views across
// companies (a fund's changes, a firm's book, the site-wide feed).
function privateRowsOf(db, accessions) {
  const counts = countsRule(true);
  return db
    .prepare(
      `SELECT h.*, f.fund_key, f.report_date, f.filing_date, c.name company_name
       FROM holdings h JOIN filings f ON f.accession = h.accession
       JOIN companies c ON c.id = h.company_id AND c.status = 'private'
       WHERE h.accession IN (SELECT value FROM json_each(?)) AND ${EQUITY_BY.instrument_type}`
    )
    .all(JSON.stringify(accessions))
    .map(r => ({ ...r, counts: counts(r) }))
    .filter(r => r.counts || !(r.value_usd > 0));
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

// How a fund holds the company (one definition; DATA-QUALITY "indirect"):
// 'spv' through a named vehicle (aliases, via_spv: Destiny's Magnitude ANC
// III); 'fund' a fund interest the filer itself files as one (instrument_type
// indirect: Coatue's "private fund" rows, BlackRock's "Pooled Investment Fund
// Interests"); else 'direct'. Both non-direct kinds are "indirect".
const kindOf = h => (h.via_spv === 1 ? 'spv' : h.instrument_type === 'indirect' ? 'fund' : 'direct');

const rowInfo = h => {
  const pricePerUnit = h.balance > 0 ? h.value_usd / h.balance : null;
  const { instrumentLabel, chartValue, chartUnit } = classifyStored(
    {
      title: h.title,
      name: h.issuer_name,
      unit: h.unit,
      assetCat: h.asset_cat,
      otherAsset: h.other_asset,
      derivCat: h.deriv_cat,
    },
    pricePerUnit
  );
  return {
    rowKey: h.row_key,
    issuerName: h.issuer_name,
    title: h.title,
    instrumentKey: instrumentKeyOf({
      otherId: h.other_id,
      cusip: h.cusip,
      title: h.title,
      name: h.issuer_name,
      assetCat: h.asset_cat,
    }),
    balance: h.balance,
    unit: h.unit,
    valueUsd: h.value_usd,
    // A mark per share only for share rows (NS); vehicle units (OU), warrant
    // contracts (NC) and principal (PA) carry a per-unit value, not a share
    // price (DATA-QUALITY trap 40).
    pricePerShare: h.balance > 0 && h.unit === 'NS' ? pricePerUnit : null,
    pricePerUnit,
    assetCat: h.asset_cat,
    instrumentType: h.instrument_type,
    instrumentLabel,
    // v1's chart value: per share for share rows, per unit otherwise (trap 40); debt as % of par.
    chartValue: pricePerUnit == null ? null : chartValue,
    chartUnit,
    fvLevel: h.fv_level,
    viaSpv: h.via_spv === 1,
    kind: kindOf(h),
    // Conviction: the position as a share of the fund's net assets, as filed.
    pctNav: h.pct_nav,
  };
};

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
  const rows = companyRows(db, opts, known || '9999-12-31');
  const canonicalOf = canonicalFilingsFor(db, known);
  return {
    ...evaluateAt(groupRows(rows), canonicalOf, date, opts.inactiveDays ?? INACTIVE_DAYS),
    knownAsOf: known,
    instrument: opts.instrument || 'equity',
  };
}

// The company's rows by accession and the funds that ever held it.
function groupRows(rows) {
  const byAccession = new Map();
  for (const r of rows) {
    if (!byAccession.has(r.accession)) byAccession.set(r.accession, []);
    byAccession.get(r.accession).push(r);
  }
  const firstHeld = new Map(); // fund -> earliest report date with a row
  for (const r of rows)
    if (!firstHeld.has(r.fund_key) || r.report_date < firstHeld.get(r.fund_key))
      firstHeld.set(r.fund_key, r.report_date);
  return { byAccession, firstHeld };
}

// The as-of rule (ADR 0004) at one date over preloaded rows. canonicalOf(fund,
// date): the fund's canonical filings with report_date <= date, oldest first.
function evaluateAt({ byAccession, firstHeld }, canonicalOf, date, inactiveDays = INACTIVE_DAYS) {
  const holdings = [];
  const exited = [];
  const inactive = [];
  const zeroValue = [];
  const fundKeys = [...firstHeld]
    .filter(([, d]) => d <= date)
    .map(([k]) => k)
    .sort();
  for (const fundKey of fundKeys) {
    const timeline = canonicalOf(fundKey, date);
    // Only canonical filings count: a superseded filing's row is not a holding.
    const held = timeline.filter(f => byAccession.has(f.accession));
    if (!held.length) continue;
    const latest = timeline[timeline.length - 1];
    const lastHeld = held[held.length - 1];
    const info = { ...fundInfo(latest), lastHeldDate: lastHeld.report_date, lastHeldAccession: lastHeld.accession };
    if (daysBetween(latest.report_date, date) > inactiveDays) {
      inactive.push(info);
    } else if (lastHeld.accession === latest.accession) {
      const reported = byAccession.get(latest.accession);
      const counted = reported.filter(r => r.counts);
      if (counted.length) {
        const positions = counted.map(rowInfo);
        holdings.push({ ...info, value: positions.reduce((s, p) => s + p.valueUsd, 0), positions });
      } else {
        zeroValue.push({ ...info, positions: reported.map(rowInfo) });
      }
    } else {
      exited.push(info);
    }
  }
  holdings.sort((a, b) => b.value - a.value || a.fundKey.localeCompare(b.fundKey));
  return {
    date,
    funds: holdings.length,
    total: holdings.reduce((s, h) => s + h.value, 0),
    holdings,
    exited,
    inactive,
    zeroValue,
  };
}

// Exposure at many dates with one read: the same rule as exposureAsOf (a test
// holds them equal), for trend lines. No knownAsOf. Returns one compact point
// per date: funds, total, and the funds that entered or left since the
// previous date.
function exposureSeries(db, opts = {}) {
  const dates = (opts.dates || []).map(d => checkDate('date', d));
  const rows = companyRows(db, opts, '9999-12-31');
  const grouped = groupRows(rows);
  const funds = [...grouped.firstHeld.keys()];
  const timelines = new Map(funds.map(f => [f, []]));
  const all = db.prepare(
    `SELECT * FROM canonical_filings WHERE fund_key IN (SELECT value FROM json_each(?)) ORDER BY fund_key, report_date`
  );
  for (const f of all.all(JSON.stringify(funds))) timelines.get(f.fund_key).push(f);
  const canonicalOf = (fundKey, date) => {
    const t = timelines.get(fundKey) || [];
    let n = 0;
    while (n < t.length && t[n].report_date <= date) n++;
    return t.slice(0, n);
  };
  let prev = new Set();
  return dates.map(date => {
    const r = evaluateAt(grouped, canonicalOf, date, opts.inactiveDays ?? INACTIVE_DAYS);
    const now = new Set(r.holdings.map(h => h.fundKey));
    const point = {
      date,
      funds: r.funds,
      total: r.total,
      entered: [...now].filter(k => !prev.has(k)).length,
      left: [...prev].filter(k => !now.has(k)).length,
      zeroValue: r.zeroValue.length,
    };
    prev = now;
    return point;
  });
}

// Month ends from `from` through `to` (ISO dates), for trend lines.
function monthEnds(from, to) {
  const out = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  for (;;) {
    const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    if (end > to) break;
    out.push(end);
    if (++m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

// One fund's positions in the company across its canonical filings, grouped
// into (fund, instrument) series, with splits flagged by public/splits.js.
// A split is compared with the previous filing that reported the instrument.
function instrumentHistory(db, opts = {}) {
  const { fundKey } = opts;
  if (!fundKey) throw new Error('instrumentHistory: fundKey is required');
  const date = opts.date ? checkDate('date', opts.date) : '9999-12-31';
  const rows = companyRows(db, opts, '9999-12-31').filter(
    r => r.counts && r.fund_key === fundKey && r.report_date <= date
  );
  const canonical = new Set(canonicalFilingsFor(db, null)(fundKey, date).map(f => f.accession));
  return instrumentSeries(rows.filter(r => canonical.has(r.accession)));
}

// One fund's canonical rows -> (instrument) series with splits flagged.
function instrumentSeries(rows) {
  const series = new Map();
  const order = (a, b) =>
    a.report_date.localeCompare(b.report_date) ||
    a.accession.localeCompare(b.accession) ||
    String(a.row_key).localeCompare(String(b.row_key), 'en', { numeric: true });
  for (const r of [...rows].sort(order)) {
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
            { shares: prev.balance, pricePerShare: prev.pricePerUnit },
            { shares: p.balance, pricePerShare: p.pricePerUnit }
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

// Every fund's series for a company (companyId, entityId or pattern) at every
// canonical report date: one query for the rows, one for the canonical
// filings. Rows valued at $0 are left out of the series (trap 42).
// Only rows of canonical filings: an amended filing's rows are not marks.
function keepCanonical(db, rows) {
  const accessions = [...new Set(rows.map(r => r.accession))];
  const canonical = new Set(
    db
      .prepare(`SELECT accession FROM canonical_filings WHERE accession IN (SELECT value FROM json_each(?))`)
      .all(JSON.stringify(accessions))
      .map(r => r.accession)
  );
  return rows.filter(r => canonical.has(r.accession));
}

function companyHistory(db, opts = {}) {
  const rows = keepCanonical(
    db,
    companyRows(db, opts, '9999-12-31').filter(r => r.counts)
  );
  const byFund = new Map();
  for (const r of rows) {
    if (!byFund.has(r.fund_key)) byFund.set(r.fund_key, []);
    byFund.get(r.fund_key).push(r);
  }
  const fundOf = db.prepare(
    'SELECT * FROM filings WHERE fund_key = ? ORDER BY report_date DESC, filing_date DESC LIMIT 1'
  );
  return [...byFund]
    .map(([fundKey, fundRows]) => {
      const f = fundOf.get(fundKey);
      const dates = fundRows.map(r => r.report_date).sort();
      return {
        fundKey,
        cik: f.cik,
        registrant: f.registrant,
        seriesName: f.series_name,
        firstMarkDate: dates[0],
        lastMarkDate: dates[dates.length - 1],
        series: instrumentSeries(fundRows),
      };
    })
    .sort((a, b) =>
      a.firstMarkDate < b.firstMarkDate
        ? -1
        : a.firstMarkDate > b.firstMarkDate
          ? 1
          : a.fundKey.localeCompare(b.fundKey)
    );
}

module.exports = {
  kindOf,
  exposureAsOf,
  exposureSeries,
  monthEnds,
  instrumentHistory,
  companyHistory,
  companyRows,
  keepCanonical,
  privateRowsOf,
  rowInfo,
  INACTIVE_DAYS,
};
