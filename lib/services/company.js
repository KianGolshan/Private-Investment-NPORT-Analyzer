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
  // A listed company's stored rows stop when a fund's shares become listed
  // stock (the keep rule stores private-candidate rows, ADR 0003): not an exit.
  notStored: 'not in stored rows (may be listed stock now)',
  inactive: 'no filing within 123 days',
  unreviewed: 'unreviewed',
};

// Each fund's display label, unique within one answer: funds can share a name
// (American Funds' Capital World Growth & Income Fund and the AFIS series of
// the same name are two funds), so a repeated name adds its registrant, then
// its fund key.
function withFundLabels(list) {
  const nameOf = f => f.seriesName || f.registrant || f.fundKey;
  const count = (xs, key) => xs.reduce((m, x) => m.set(key(x), (m.get(key(x)) || 0) + 1), new Map());
  const byName = count(list, nameOf);
  const withRegistrant = f =>
    byName.get(nameOf(f)) > 1 && f.registrant && f.registrant !== nameOf(f)
      ? `${nameOf(f)} (${f.registrant})`
      : nameOf(f);
  const byLabel = count(list, withRegistrant);
  return list.map(f => ({
    ...f,
    label: byLabel.get(withRegistrant(f)) > 1 ? `${withRegistrant(f)} · ${f.fundKey}` : withRegistrant(f),
  }));
}

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

// An unreviewed name by its issuer key. A key that a review has since given to
// a company, or that joined another component, answers { redirect } so links
// and watchlist entries keep working: { kind: 'company', id } or
// { kind: 'unreviewed', key }.
function findUnreviewed(db, key) {
  const k = String(key || '').toUpperCase();
  const e = db.prepare('SELECT * FROM unreviewed_entities WHERE key = ?').get(k);
  if (e?.active)
    return {
      id: e.id,
      key: e.key,
      name: e.display_name,
      category: e.category,
      active: true,
      keys: JSON.parse(e.keys),
      names: JSON.parse(e.names),
      linkedCompanyIds: JSON.parse(e.linked_company_ids),
    };
  const keys = e ? JSON.parse(e.keys) : [k];
  const owner = db.prepare("SELECT company_id FROM company_aliases WHERE kind = 'issuer_key' AND pattern = ?");
  for (const x of [k, ...keys]) {
    const c = owner.get(x);
    if (c) return { redirect: { kind: 'company', id: c.company_id } };
  }
  const moved = db
    .prepare(
      `SELECT u.key FROM unreviewed_entities u, json_each(u.keys) j
       WHERE u.active = 1 AND j.value = ? ORDER BY u.current_value_usd DESC LIMIT 1`
    )
    .get(k);
  return moved && moved.key !== k ? { redirect: { kind: 'unreviewed', key: moved.key } } : null;
}

// When a listed company's listed rows were first seen (listing_evidence: Level-1
// rows with a valid ISIN/CUSIP, counted at bulk ingest for the latest 4 bulk
// quarters): evidence, not a listing date.
function listingOf(db, companyId) {
  const r = db
    .prepare(
      `SELECT MIN(quarter) first, MAX(quarter) last, SUM(rows) rows FROM listing_evidence
       WHERE issuer_key IN (SELECT pattern FROM company_aliases WHERE company_id = ? AND kind = 'issuer_key')`
    )
    .get(companyId);
  const window = db.prepare('SELECT MIN(quarter) first FROM listing_evidence').get().first;
  return r?.rows ? { firstQuarter: r.first, lastQuarter: r.last, rows: r.rows, evidenceSince: window } : null;
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
// listed: the company is listed now, so a fund whose stored rows stop is
// labeled "not in stored rows", never "no longer reported".
function exposure(db, ref, date, { knownAsOf, listed = false } = {}) {
  const r = exposureAsOf(db, { ...ref, date, knownAsOf });
  const labeled = withFundLabels([...r.holdings, ...r.zeroValue, ...r.exited, ...r.inactive]);
  const labelOf = new Map(labeled.map(f => [f.fundKey, f.label]));
  const named = h => ({ ...h, fundLabel: labelOf.get(h.fundKey) });
  return {
    date: r.date,
    knownAsOf: r.knownAsOf,
    funds: r.funds,
    total: r.total,
    holdings: r.holdings.map(labelFund).map(named),
    zeroValue: r.zeroValue.map(h => named({ ...h, label: LABEL.zero })),
    exited: r.exited.map(h => named({ ...h, label: listed ? LABEL.notStored : LABEL.exited })),
    inactive: r.inactive.map(h => named({ ...h, label: LABEL.inactive })),
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
  const funds = withFundLabels(companyHistory(db, ref)).map(f => ({
    ...f,
    series: f.series.map(s => {
      const last = s.points[s.points.length - 1];
      return {
        instrumentKey: s.instrumentKey,
        title: last.title || last.issuerName,
        issuerName: last.issuerName,
        instrumentType: last.instrumentType,
        instrumentLabel: last.instrumentLabel,
        chartUnit: last.chartUnit,
        points: s.points.map(point),
      };
    }),
  }));
  const dates = funds.flatMap(f => [f.firstMarkDate, f.lastMarkDate]).sort();
  return { firstMarkDate: dates[0] || null, lastMarkDate: dates[dates.length - 1] || null, funds };
}

module.exports = {
  findCompany,
  findUnreviewed,
  sourceFor,
  listingOf,
  withFundLabels,
  brandsOf,
  statsOf,
  exposure,
  history,
  disclosedExposure,
  LABEL,
};
