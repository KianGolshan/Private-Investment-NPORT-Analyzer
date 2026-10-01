// Fund answers from the warehouse (ROADMAP §5b task 3, ADR 0008): Fund X-Ray
// on stored data. Pure functions over a read-only db handle, shared by the web
// server and P7.
//
// A fund is its fund_key; only its canonical filings are offered (an amendment
// replaces the filing it amends, trap 1). The private book follows the
// company's status (ADR 0003), not fair-value Level 3 as v1 did:
//   - rows of a curated private company count;
//   - rows no company claims count when their unreviewed entity looks private
//     (category company, linked, vehicle or fund), labeled "unreviewed";
//   - rows of a listed company, or of an unreviewed name that looks listed
//     (listed, level12), are shown apart as not private, with the reason;
//   - debt is never in the private book; it joins the capital structure.
// Denominators come from filing_totals (every row of the filing, migration
// 0015); v1's own Level-3 figure is returned beside ours for comparison.
//
// The answer keeps v1's xray shape (buildFundXRay), so v1's comparison and
// returns math (buildFundXRayComparison, buildPositionReturns) and its
// capital-structure grouping run unchanged on warehouse data.
const {
  buildFundXRayComparison,
  buildPositionReturns,
  buildIssuerCapitalStructure,
  instrumentKeyOf,
  issuerKeyOf,
} = require('../../parsers');
const { classifyStored } = require('../warehouse/keep-rule');
const { LABEL } = require('./company');
const { ServiceError, daysBetween } = require('./errors');

const PRIVATE_CATEGORIES = new Set(['company', 'linked', 'vehicle', 'fund']);
const CATEGORY_LABEL = {
  company: 'operating company',
  linked: 'linked to a reviewed company',
  vehicle: 'opaque holding vehicle',
  fund: 'fund interest',
  listed: 'listed',
  level12: 'looks listed (Level 1/2)',
};
const MAX_RETURN_FILINGS = 12;
// A few filings store tens of thousands of rows (Blue Owl Alternative Credit
// Fund: 26,219 loan-level receivables in one filing, DATA-QUALITY trap 45).
// Totals always cover every row; lists return the largest MAX_LIST_ROWS, and
// lot accounting refuses a period with more than MAX_RETURN_POSITIONS.
const MAX_LIST_ROWS = 2000;
const MAX_RETURN_POSITIONS = 5000;
// "BlackRock Global Allocation Fund" is filed as "…Fund, Inc."
const LEGAL_SUFFIX = / (inc|llc|corp|corporation|ltd|co|lp|trust inc)$/;

const FundError = ServiceError;

// Every canonical filing of a fund, newest first.
function fundFilings(db, fundKey) {
  return db
    .prepare(
      `SELECT accession, report_date reportDate, filing_date filingDate, form, source, versions, net_assets netAssets
       FROM fund_filing_timeline WHERE fund_key = ? ORDER BY report_date DESC`
    )
    .all(fundKey);
}

function findFund(db, fundKey) {
  const f = db.prepare('SELECT * FROM fund_names WHERE fund_key = ?').get(String(fundKey || ''));
  if (!f) return null;
  const newest = db.prepare('SELECT MAX(last_report_date) d FROM fund_names').get().d;
  const inactive = daysBetween(f.last_report_date, newest) > 123;
  return {
    fundKey: f.fund_key,
    cik: f.cik,
    seriesId: f.series_id,
    seriesName: f.series_name,
    registrant: f.registrant,
    firstReportDate: f.first_report_date,
    lastReportDate: f.last_report_date,
    lastAccession: f.last_accession,
    lastNetAssets: f.last_net_assets,
    filings: f.filings,
    inactive,
  };
}

// Funds by series id, CIK, fund key or name (every word a prefix). Ranking:
// an exact id, then a name equal to the query, a name starting with it, a name
// containing it as a phrase, any other match; the fund's own series name beats
// its registrant's (a trust named "Fidelity Contrafund" files other funds too);
// ties go to funds still reporting, then the longer history.
function searchFunds(db, text, { limit = 10 } = {}) {
  const q = String(text || '').trim();
  if (!q) return [];
  const exact = db
    .prepare(
      `SELECT fund_key FROM fund_names WHERE fund_key = ? OR series_id = ? OR cik = ?
       ORDER BY last_report_date DESC LIMIT ?`
    )
    .all(q.toUpperCase(), q.toUpperCase(), q.replace(/^0+/, ''), limit)
    .map(r => r.fund_key);
  const norm = t =>
    String(t || '')
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean)
      .join(' ')
      .replace(LEGAL_SUFFIX, '');
  const phrase = norm(q);
  const scored = new Map();
  if (phrase) {
    const match = phrase
      .split(' ')
      .map(w => `"${w}"*`)
      .join(' ');
    const rows = db
      .prepare(
        `SELECT s.name, n.series_name, n.fund_key, n.last_report_date, n.filings FROM fund_search s
         JOIN fund_names n ON n.fund_key = s.fund_key WHERE fund_search MATCH ? LIMIT 2000`
      )
      .all(match);
    const tierOf = name =>
      name === phrase ? 0 : name.startsWith(phrase) ? 1 : ` ${name} `.includes(` ${phrase} `) ? 2 : 3;
    for (const r of rows) {
      const tier = Math.min(2 * tierOf(norm(r.series_name)), 2 * tierOf(norm(r.name)) + 1);
      const prev = scored.get(r.fund_key);
      if (!prev || tier < prev.tier) scored.set(r.fund_key, { ...r, tier });
    }
  }
  const named = [...scored.values()]
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        b.last_report_date.localeCompare(a.last_report_date) ||
        b.filings - a.filings ||
        a.fund_key.localeCompare(b.fund_key)
    )
    .map(r => r.fund_key);
  return [...new Set([...exact, ...named])].slice(0, limit).map(k => findFund(db, k));
}

// A stored row in the shape extractAllHoldings() gives v1's X-Ray code.
function v1Holding(r, isPrivate) {
  const pricePerUnit = r.balance ? r.value_usd / r.balance : null;
  const c = classifyStored(
    {
      title: r.title,
      name: r.issuer_name,
      unit: r.unit,
      assetCat: r.asset_cat,
      otherAsset: r.other_asset,
      derivCat: r.deriv_cat,
    },
    pricePerUnit
  );
  const name = r.issuer_name || r.title || '';
  return {
    name,
    issuer: '',
    title: r.title || '',
    shares: r.balance,
    marketValue: r.value_usd || 0,
    // v1's per-unit price (value / balance), which its comparison and returns
    // math use; shown as "per share" only for share rows (trap 40).
    pricePerShare: pricePerUnit,
    unit: r.unit,
    perShare: r.unit === 'NS',
    cusip: r.cusip || '',
    ticker: r.ticker || '',
    instrumentType: r.instrument_type,
    instrumentLabel: c.instrumentLabel,
    instrumentKey: instrumentKeyOf({
      otherId: r.other_id,
      cusip: r.cusip,
      title: r.title,
      name,
      assetCat: r.asset_cat,
    }),
    filerId: r.other_id || '',
    isPrivate,
    fairValLevel: r.fv_level || '',
    isRestrictedSec: r.restricted || '',
    pctOfNetAssets: r.pct_nav || 0,
    country: r.country || '',
    rowKey: r.row_key,
  };
}

// Status of a stored equity row: private (with its company or unreviewed
// entity), or not private with the reason. A private row's kind says what it
// is: an operating company, an interest in another fund, or an opaque vehicle
// (unreviewed categories, lib/entities/report.js); a reviewed company is an
// operating company.
const KIND_OF_CATEGORY = { company: 'company', linked: 'company', fund: 'fund', vehicle: 'vehicle' };
function statusOf(r) {
  if (r.company_id != null) {
    const company = { id: r.company_id, name: r.company_name, tracked: !!r.tracked };
    return r.company_status === 'private'
      ? { isPrivate: true, kind: 'company', company }
      : { isPrivate: false, company, reason: 'listed company (restricted or private-placement row)' };
  }
  if (r.entity_key) {
    const unreviewed = { key: r.entity_key, name: r.entity_name, category: r.category };
    return PRIVATE_CATEGORIES.has(r.category)
      ? { isPrivate: true, kind: KIND_OF_CATEGORY[r.category], unreviewed }
      : { isPrivate: false, unreviewed, reason: CATEGORY_LABEL[r.category] || r.category };
  }
  // No company and no entity: the refresh has not tagged this row yet.
  return { isPrivate: true, kind: 'company', unreviewed: { key: null, name: r.issuer_name, category: null } };
}
const PRIVATE_KINDS = { company: 'operating companies', fund: 'fund interests', vehicle: 'opaque vehicles' };

function labelsOf(h, st, r) {
  const out = [];
  if (st.unreviewed)
    out.push(
      `${LABEL.unreviewed}${st.unreviewed.category ? ` · ${CATEGORY_LABEL[st.unreviewed.category] || st.unreviewed.category}` : ''}`
    );
  if (r.via_spv) out.push(LABEL.indirect);
  if (!h.marketValue) out.push(LABEL.zero);
  return out;
}

function canonicalFiling(db, fundKey, accession) {
  const filings = fundFilings(db, fundKey);
  if (!filings.length) throw new FundError(404, `no fund ${fundKey}`);
  if (!accession) return { filing: filings[0], filings };
  const filing = filings.find(f => f.accession === accession);
  if (filing) return { filing, filings };
  const other = db.prepare('SELECT fund_key, report_date FROM filings WHERE accession = ?').get(accession);
  if (!other || other.fund_key !== fundKey) throw new FundError(404, `${accession} is not a filing of ${fundKey}`);
  const replaced = filings.find(f => f.reportDate === other.report_date);
  const e = new FundError(409, `${accession} was replaced by ${replaced?.accession} for ${other.report_date}`);
  e.replacedBy = replaced?.accession;
  throw e;
}

// One canonical filing's X-Ray (default: the fund's newest).
function xray(db, fundKey, accession) {
  const { filing, filings } = canonicalFiling(db, fundKey, accession);
  const meta = db.prepare('SELECT * FROM filings WHERE accession = ?').get(filing.accession);
  const totals = db.prepare('SELECT * FROM filing_totals WHERE accession = ?').get(filing.accession) || null;
  const rows = db
    .prepare(
      `SELECT h.*, c.name company_name, c.status company_status, t.company_id tracked,
         u.key entity_key, u.display_name entity_name, u.category
       FROM holdings h
       LEFT JOIN companies c ON c.id = h.company_id
       LEFT JOIN tracked_companies t ON t.company_id = h.company_id
       LEFT JOIN unreviewed_entities u ON u.id = h.entity_id AND h.company_id IS NULL
       WHERE h.accession = ? ORDER BY h.row_key`
    )
    .all(filing.accession);
  const capitalRows = db
    .prepare('SELECT * FROM capital_structure_rows WHERE accession = ? ORDER BY row_key')
    .all(filing.accession);

  // The capital structure groups by company where the rows name one: a filer
  // can spell one issuer two ways in a filing (T. Rowe's "OpenAI Group PCB"
  // beside "OPENAI GROUP PBC", F36), which v1's grouping by filed name splits.
  // A stored debt row takes the company of the private row it was kept beside
  // (same issuer key, migration 0016).
  const companyOfKey = new Map();
  for (const r of rows)
    if (r.company_id != null) companyOfKey.set(issuerKeyOf({ name: r.issuer_name, title: r.title }), r.company_name);
  const withCompany = (h, r) => {
    const name =
      r.company_name || companyOfKey.get(r.issuer_key || issuerKeyOf({ name: r.issuer_name, title: r.title }));
    return name ? { ...h, issuer: name } : h;
  };
  const privateHoldings = [];
  const notPrivate = [];
  const all = [];
  for (const r of rows) {
    if (r.instrument_type === 'debt') {
      all.push(withCompany(v1Holding(r, false), r));
      continue;
    }
    const st = statusOf(r);
    const h = {
      ...v1Holding(r, st.isPrivate),
      privateKind: st.kind || null,
      company: st.company || null,
      unreviewed: st.unreviewed || null,
    };
    h.labels = labelsOf(h, st, r);
    all.push(withCompany(h, r));
    if (st.isPrivate) privateHoldings.push(h);
    else notPrivate.push({ ...h, reason: st.reason });
  }
  for (const r of capitalRows) all.push(withCompany(v1Holding(r, false), r));
  const byValue = (a, b) => b.marketValue - a.marketValue || String(a.rowKey).localeCompare(String(b.rowKey));
  privateHoldings.sort(byValue);
  notPrivate.sort(byValue);

  const sum = list => list.reduce((s, h) => s + (h.marketValue || 0), 0);
  const privateValueUSD = sum(privateHoldings);
  const totalValueUSD = totals ? totals.value_usd : null;
  const totalHoldingsCount = totals ? totals.rows : null;
  const netAssets = meta.net_assets > 0 ? meta.net_assets : totalValueUSD;
  const byInstrumentType = {};
  const byCountry = {};
  const privateByKind = Object.fromEntries(
    Object.entries(PRIVATE_KINDS).map(([k, label]) => [k, { label, rows: 0, valueUSD: 0 }])
  );
  for (const h of privateHoldings) {
    privateByKind[h.privateKind].rows++;
    privateByKind[h.privateKind].valueUSD += h.marketValue;
    byInstrumentType[h.instrumentType] = (byInstrumentType[h.instrumentType] || 0) + h.marketValue;
    const country = h.country || 'Unknown';
    byCountry[country] = (byCountry[country] || 0) + h.marketValue;
  }
  return {
    fund: {
      fundKey,
      cik: meta.cik,
      seriesId: meta.series_id,
      registrantName: meta.registrant || '',
      seriesName: meta.series_name || '',
      reportDate: meta.report_date,
      netAssets: meta.net_assets,
      totalAssets: meta.total_assets,
    },
    filing: { ...filing, cik: meta.cik },
    markDate: meta.report_date,
    accession: filing.accession,
    totalHoldingsCount,
    publicHoldingsCount: totalHoldingsCount != null ? totalHoldingsCount - privateHoldings.length : null,
    privateHoldingsCount: privateHoldings.length,
    privateValueUSD,
    privateByKind,
    totalValueUSD,
    privatePctOfNetAssets: netAssets ? (privateValueUSD / netAssets) * 100 : null,
    privatePctOfHoldingsValue: totalValueUSD ? (privateValueUSD / totalValueUSD) * 100 : null,
    listedValueUSD: totals ? totals.value_listed : null,
    debtValueUSD: totals ? totals.value_debt : null,
    // v1 Fund X-Ray's figure for the same filing: Level 3 and not debt.
    v1Level3: totals ? { rows: totals.rows_l3_equity, valueUSD: totals.value_l3_equity } : null,
    byInstrumentType,
    byCountry,
    privateHoldings,
    notPrivate,
    topPrivateHoldings: privateHoldings.slice(0, 10),
    capitalStructure: buildIssuerCapitalStructure(all, meta.net_assets > 0 ? meta.net_assets : 0),
    filingsCount: filings.length,
  };
}

// An X-Ray for the wire: every total as computed, lists cut to the largest rows.
// The capital structure keeps issuers held through 2+ instrument types (what
// the page shows; a single-tranche issuer is already in the holdings list).
function forDisplay(x, max = MAX_LIST_ROWS) {
  const capitalStructure = x.capitalStructure.filter(c => c.multiTranche);
  const cut = x.privateHoldings.length > max || x.notPrivate.length > max;
  if (!cut) return { ...x, capitalStructure, truncated: null };
  return {
    ...x,
    capitalStructure,
    privateHoldings: x.privateHoldings.slice(0, max),
    notPrivate: x.notPrivate.slice(0, max),
    truncated: { shown: max, privateHoldings: x.privateHoldings.length, notPrivate: x.notPrivate.length },
  };
}

// Two canonical filings of one fund, compared with v1's rules. The prior
// defaults to the filing before the current one.
function compare(db, fundKey, currentAccession, priorAccession) {
  const current = xray(db, fundKey, currentAccession);
  let prior = priorAccession;
  if (!prior) {
    const filings = fundFilings(db, fundKey);
    const i = filings.findIndex(f => f.accession === current.accession);
    prior = filings[i + 1]?.accession;
    if (!prior) throw new FundError(404, 'no earlier filing to compare with');
  }
  if (prior === current.accession) throw new FundError(400, 'current and prior must be different filings');
  const before = xray(db, fundKey, prior);
  if (before.markDate >= current.markDate) throw new FundError(400, 'the prior filing must report an earlier date');
  const comparison = buildFundXRayComparison(current, before);
  const size = p => Math.max(Math.abs(p.marketValue.current || 0), Math.abs(p.marketValue.prior || 0));
  const positionsTotal = comparison.positions.length;
  comparison.positionsTotal = positionsTotal; // the page shows "N of M"
  if (positionsTotal > MAX_LIST_ROWS)
    comparison.positions = [...comparison.positions].sort((a, b) => size(b) - size(a)).slice(0, MAX_LIST_ROWS);
  return {
    current: summary(current),
    prior: summary(before),
    comparison,
    positionsTotal,
    truncated: positionsTotal > MAX_LIST_ROWS ? { shown: MAX_LIST_ROWS, positions: positionsTotal } : null,
  };
}

const summary = x => ({
  fund: x.fund,
  accession: x.accession,
  markDate: x.markDate,
  privateValueUSD: x.privateValueUSD,
  privateHoldingsCount: x.privateHoldingsCount,
});

// Mark-implied returns across up to 12 canonical filings (default: the n
// filings ending at `accession`, newest first).
function returns(db, fundKey, { accessions, accession, n = 8 } = {}) {
  let list = accessions;
  if (!list || !list.length) {
    const filings = fundFilings(db, fundKey);
    const start = accession ? filings.findIndex(f => f.accession === accession) : 0;
    if (start < 0) throw new FundError(404, `${accession} is not a canonical filing of ${fundKey}`);
    list = filings.slice(start, start + n).map(f => f.accession);
  }
  list = [...new Set(list)];
  if (list.length < 2) throw new FundError(400, 'at least two filings are needed');
  if (list.length > MAX_RETURN_FILINGS) throw new FundError(400, `at most ${MAX_RETURN_FILINGS} filings`);
  const periods = list.map(a => {
    const x = xray(db, fundKey, a);
    if (x.privateHoldingsCount > MAX_RETURN_POSITIONS)
      throw new FundError(
        422,
        `${a} has ${x.privateHoldingsCount} private rows; mark-implied returns are computed for up to ${MAX_RETURN_POSITIONS} per filing`
      );
    return { reportDate: x.markDate, accession: x.accession, xray: x };
  });
  return {
    filings: periods.map(p => ({ accession: p.accession, markDate: p.reportDate })),
    returns: buildPositionReturns(periods),
  };
}

module.exports = {
  searchFunds,
  findFund,
  fundFilings,
  xray,
  forDisplay,
  compare,
  returns,
  FundError,
  PRIVATE_CATEGORIES,
  PRIVATE_KINDS,
  CATEGORY_LABEL,
  MAX_RETURN_FILINGS,
  MAX_LIST_ROWS,
  MAX_RETURN_POSITIONS,
};
