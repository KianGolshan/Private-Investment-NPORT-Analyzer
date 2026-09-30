// Company answers from the warehouse (ROADMAP §5a task 5, ADR 0008), for a
// curated company (by stable id) or an unreviewed entity (by issuer key). Pure
// functions over a read-only db handle, shared by the web server and P7.
//
// Display rules (DATA-QUALITY): every fund carries its mark date and
// accession; positions held through an SPV are "indirect"; a fund still
// reporting the company at $0 is "reported at $0", an exit is "no longer
// reported"; ranges a filing gives without naming vehicles are shown in its
// words (disclosed_exposure); per-share marks come from share rows only.
const { exposureAsOf, companyHistory } = require('../analytics/asof');

const LABEL = {
  indirect: 'indirect',
  zero: 'reported at $0',
  exited: 'no longer reported',
  inactive: 'no filing within 123 days',
  unreviewed: 'unreviewed',
};

// A company by id, following a redirect when the id was merged or dropped.
function findCompany(db, id) {
  const company = db
    .prepare(
      `SELECT c.id, c.name, c.status, c.public_since, (t.company_id IS NOT NULL) tracked, t.added_at
       FROM companies c LEFT JOIN tracked_companies t ON t.company_id = c.id WHERE c.id = ?`
    )
    .get(id);
  if (company) return { company: { ...company, tracked: !!company.tracked } };
  const r = db.prepare('SELECT old_id, old_name, new_id, reason FROM company_redirects WHERE old_id = ?').get(id);
  return r ? { redirect: { from: r.old_id, name: r.old_name, to: r.new_id, reason: r.reason } } : null;
}

function findUnreviewed(db, key) {
  const e = db.prepare('SELECT * FROM unreviewed_entities WHERE key = ?').get(String(key || '').toUpperCase());
  return (
    e && {
      id: e.id,
      key: e.key,
      name: e.display_name,
      category: e.category,
      active: !!e.active,
      keys: JSON.parse(e.keys),
      names: JSON.parse(e.names),
      linkedCompanyIds: JSON.parse(e.linked_company_ids),
    }
  );
}

// What answers a company: the warehouse for private companies, live EDGAR for
// listed ones (their stored rows are only restricted/PIPE lines, trap 25) and
// for debt (not stored, ADR 0003). Unreviewed names follow their category.
function sourceFor({ company, unreviewed, instrument = 'equity' }) {
  if (instrument === 'debt') return { source: 'live', reason: 'debt is not warehoused' };
  if (company?.status === 'public' || unreviewed?.category === 'listed')
    return {
      source: 'live',
      reason:
        'listed, so answered from live EDGAR filings (the warehouse keeps only its restricted and private-placement rows)',
    };
  return { source: 'warehouse' };
}

function brandsOf(db, id) {
  return db.prepare('SELECT brand, source_accession FROM company_brands WHERE company_id = ? ORDER BY brand').all(id);
}

function statsOf(db, id) {
  return db.prepare('SELECT * FROM company_stats WHERE company_id = ?').get(id) || null;
}

// Ranges a filing gives without naming the vehicles (Fundrise, trap 24), latest per fund on or before date.
function disclosedExposure(db, companyId, date) {
  return db
    .prepare(
      `SELECT d.fund_key, d.report_date, d.basis, d.source_accession, f.registrant, f.series_name
       FROM disclosed_exposure d
       LEFT JOIN filings f ON f.accession = d.source_accession
       WHERE d.company_id = ? AND d.report_date <= ?
         AND d.report_date = (SELECT MAX(report_date) FROM disclosed_exposure x
                              WHERE x.fund_key = d.fund_key AND x.company_id = d.company_id AND x.report_date <= ?)
       ORDER BY d.fund_key`
    )
    .all(companyId, date, date)
    .map(d => ({
      fundKey: d.fund_key,
      registrant: d.registrant,
      seriesName: d.series_name,
      markDate: d.report_date,
      accession: d.source_accession,
      basis: d.basis,
    }));
}

const labelFund = h => {
  const indirect = h.positions.every(p => p.viaSpv);
  return { ...h, indirect, label: indirect ? LABEL.indirect : null };
};

// Exposure as of a date (ADR 0004). ref: { companyId } | { entityId }.
function exposure(db, ref, date, { knownAsOf } = {}) {
  const r = exposureAsOf(db, { ...ref, date, knownAsOf });
  return {
    date: r.date,
    knownAsOf: r.knownAsOf,
    funds: r.funds,
    total: r.total,
    holdings: r.holdings.map(labelFund),
    zeroValue: r.zeroValue.map(h => ({ ...h, label: LABEL.zero })),
    exited: r.exited.map(h => ({ ...h, label: LABEL.exited })),
    inactive: r.inactive.map(h => ({ ...h, label: LABEL.inactive })),
    disclosedExposure: ref.companyId != null ? disclosedExposure(db, ref.companyId, date) : [],
  };
}

// The compact point a history chart and table need.
const point = p => ({
  markDate: p.markDate,
  accession: p.accession,
  balance: p.balance,
  unit: p.unit,
  valueUsd: p.valueUsd,
  pricePerShare: p.pricePerShare,
  pricePerUnit: p.pricePerUnit,
  chartValue: p.chartValue,
  viaSpv: p.viaSpv,
  split: p.split,
  splitFactor: p.splitFactor,
});

// Every fund's instrument series at every canonical report date since the
// first filing that held the company.
function history(db, ref) {
  const funds = companyHistory(db, ref).map(f => ({
    ...f,
    series: f.series.map(s => ({
      instrumentKey: s.instrumentKey,
      title: s.points[s.points.length - 1].title || s.points[s.points.length - 1].issuerName,
      issuerName: s.points[s.points.length - 1].issuerName,
      instrumentType: s.points[s.points.length - 1].instrumentType,
      instrumentLabel: s.points[s.points.length - 1].instrumentLabel,
      chartUnit: s.points[s.points.length - 1].chartUnit,
      points: s.points.map(point),
    })),
  }));
  const dates = funds.flatMap(f => [f.firstMarkDate, f.lastMarkDate]).sort();
  return { firstMarkDate: dates[0] || null, lastMarkDate: dates[dates.length - 1] || null, funds };
}

module.exports = {
  findCompany,
  findUnreviewed,
  sourceFor,
  brandsOf,
  statsOf,
  exposure,
  history,
  disclosedExposure,
  LABEL,
};
