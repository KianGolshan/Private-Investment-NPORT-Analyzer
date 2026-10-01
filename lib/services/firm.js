// Firm (manager) answers (ROADMAP §6, ADR 0007). A fund belongs to a firm when
// the firm's adviser entity is the fund's adviser on its latest N-CEN
// (fund_advisers role 'adviser' → manager_advisers), else when the fund's
// registrant CIK is the firm's (manager_registrants, for funds with no N-CEN
// adviser). A fund the firm only sub-advises is listed apart and is not in
// its book. A fund with two advisers counts for both firms.
const { exposureAsOf, companyRows, keepCanonical, rowInfo } = require('../analytics/asof');
const { fundChanges } = require('../analytics/activity');
const { activeFilings, COUNTS, newestReportDate } = require('./market');
const { memo } = require('./memo');
const { ServiceError, isIsoDate } = require('./errors');
const { withFundLabels } = require('./company');

// fund_key -> [{ managerId, role }], and manager -> { managed, subadvised }.
function fundFirms(db) {
  return memo(db, 'fundFirms', () => {
    const byFund = new Map();
    const add = (fundKey, managerId, role) => {
      const list = byFund.get(fundKey) || byFund.set(fundKey, []).get(fundKey);
      if (!list.some(x => x.managerId === managerId && x.role === role)) list.push({ managerId, role });
    };
    for (const r of db
      .prepare(
        `SELECT DISTINCT fa.fund_key, ma.manager_id, fa.role FROM fund_advisers fa
         JOIN manager_advisers ma ON ma.file_num = fa.file_num ORDER BY 1, 2, 3`
      )
      .all())
      add(r.fund_key, r.manager_id, r.role);
    const advised = new Set(
      db
        .prepare("SELECT DISTINCT fund_key FROM fund_advisers WHERE role = 'adviser'")
        .all()
        .map(r => r.fund_key)
    );
    for (const r of db
      .prepare(
        `SELECT DISTINCT f.fund_key, mr.manager_id FROM (SELECT DISTINCT fund_key, cik FROM filings) f
         JOIN manager_registrants mr ON mr.cik = f.cik ORDER BY 1, 2`
      )
      .all())
      if (!advised.has(r.fund_key)) add(r.fund_key, r.manager_id, 'registrant');
    const byFirm = new Map();
    for (const [fundKey, list] of byFund)
      for (const { managerId, role } of list) {
        const f = byFirm.get(managerId) || byFirm.set(managerId, { managed: [], subadvised: [] }).get(managerId);
        (role === 'subadviser' ? f.subadvised : f.managed).push(fundKey);
      }
    return { byFund, byFirm };
  });
}

function findFirm(db, id) {
  const m = db.prepare('SELECT id, name FROM managers WHERE id = ?').get(id);
  if (!m) throw new ServiceError(404, `no firm ${id}`);
  const funds = fundFirms(db).byFirm.get(m.id) || { managed: [], subadvised: [] };
  return { ...m, fundsManaged: funds.managed.length, fundsSubadvised: funds.subadvised.length };
}

const dateOr = (db, date) => {
  const d = date || newestReportDate(db);
  if (!isIsoDate(d)) throw new ServiceError(400, 'date must be an ISO date (YYYY-MM-DD)');
  return d;
};

// The private rows of the given funds' active filings as of D (ADR 0004).
function bookRows(db, fundKeys, date) {
  return db
    .prepare(
      `WITH ${activeFilings(true)}
       SELECT h.*, a.fund_key, a.report_date, f.filing_date, f.registrant, f.series_name, f.cik, f.net_assets,
         c.name company_name, (t.company_id IS NOT NULL) tracked
       FROM active a JOIN holdings h ON h.accession = a.accession
       JOIN filings f ON f.accession = a.accession
       JOIN companies c ON c.id = h.company_id AND c.status = 'private'
       LEFT JOIN tracked_companies t ON t.company_id = c.id
       WHERE ${COUNTS}`
    )
    .all({ date, funds: JSON.stringify(fundKeys) });
}

// Every firm with private holdings as of D, by value.
function firms(db, { date, q, limit = 600 } = {}) {
  const d = dateOr(db, date);
  const list = memo(db, `firms:${d}`, () => {
    const { byFirm } = fundFirms(db);
    const names = new Map(
      db
        .prepare('SELECT id, name FROM managers')
        .all()
        .map(m => [m.id, m.name])
    );
    const firmsOfFund = new Map();
    for (const [id, f] of byFirm)
      for (const k of f.managed) (firmsOfFund.get(k) || firmsOfFund.set(k, []).get(k)).push(id);
    const totals = new Map();
    for (const r of bookRows(db, [...firmsOfFund.keys()], d))
      for (const id of firmsOfFund.get(r.fund_key) || []) {
        const t = totals.get(id) || totals.set(id, { value: 0, funds: new Set(), companies: new Set() }).get(id);
        t.value += r.value_usd;
        t.funds.add(r.fund_key);
        t.companies.add(r.company_id);
      }
    return [...byFirm]
      .map(([id, f]) => {
        const t = totals.get(id);
        return {
          id,
          name: names.get(id),
          fundsManaged: f.managed.length,
          fundsHolding: t ? t.funds.size : 0,
          companies: t ? t.companies.size : 0,
          value: t ? t.value : 0,
        };
      })
      .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
  });
  const needle = String(q || '')
    .trim()
    .toLowerCase();
  const kept = needle ? list.filter(f => f.name.toLowerCase().includes(needle)) : list;
  return { date: d, count: kept.length, results: kept.slice(0, limit) };
}

// A firm's private book as of D: by company (value, funds, each position with
// its fund, mark date, accession and per-share or per-unit mark) and by fund.
function firmBook(db, id, { date } = {}) {
  const firm = findFirm(db, id);
  const d = dateOr(db, date);
  const { managed, subadvised } = fundFirms(db).byFirm.get(firm.id) || { managed: [], subadvised: [] };
  const rows = bookRows(db, managed, d);
  const fundsHeld = withFundLabels(
    [...new Map(rows.map(r => [r.fund_key, r])).values()].map(r => ({
      fundKey: r.fund_key,
      cik: r.cik,
      registrant: r.registrant,
      seriesName: r.series_name,
      markDate: r.report_date,
      accession: r.accession,
      netAssets: r.net_assets,
    }))
  );
  const labelOf = new Map(fundsHeld.map(f => [f.fundKey, f.label]));
  const companies = new Map();
  const funds = new Map(fundsHeld.map(f => [f.fundKey, { ...f, value: 0, companies: new Set() }]));
  for (const r of rows) {
    const p = rowInfo(r);
    const c =
      companies.get(r.company_id) ||
      companies
        .set(r.company_id, {
          companyId: r.company_id,
          name: r.company_name,
          tracked: !!r.tracked,
          value: 0,
          funds: new Set(),
          positions: [],
        })
        .get(r.company_id);
    c.value += r.value_usd;
    c.funds.add(r.fund_key);
    c.positions.push({
      fundKey: r.fund_key,
      fund: labelOf.get(r.fund_key),
      cik: r.cik,
      markDate: r.report_date,
      accession: r.accession,
      instrument: p.instrumentLabel,
      title: p.title,
      balance: p.balance,
      unit: p.unit,
      pricePerShare: p.pricePerShare,
      pricePerUnit: p.pricePerUnit,
      value: p.valueUsd,
      pctNav: r.pct_nav,
      viaSpv: p.viaSpv,
    });
    const f = funds.get(r.fund_key);
    f.value += r.value_usd;
    f.companies.add(r.company_id);
  }
  const byCompany = [...companies.values()]
    .map(c => ({ ...c, funds: c.funds.size, positions: c.positions.sort((a, b) => b.value - a.value) }))
    .sort((a, b) => b.value - a.value);
  return {
    firm,
    date: d,
    value: byCompany.reduce((s, c) => s + c.value, 0),
    companies: byCompany.length,
    byCompany,
    byFund: [...funds.values()].map(f => ({ ...f, companies: f.companies.size })).sort((a, b) => b.value - a.value),
    subadvisedFunds: subadvised.length,
  };
}

// The firm's marks in one company at every report date, by class: the median,
// low and high per-share mark across the firm's funds that filed that date (as
// filed, never restated across funds: LESSONS 39), share rows only (trap 40).
function firmMarks(db, id, companyId) {
  const firm = findFirm(db, id);
  const managed = new Set((fundFirms(db).byFirm.get(firm.id) || { managed: [] }).managed);
  const groups = new Map();
  for (const r of keepCanonical(db, companyRows(db, { companyId }, '9999-12-31'))) {
    if (!r.counts || !managed.has(r.fund_key)) continue;
    const p = rowInfo(r);
    if (p.pricePerShare == null) continue;
    const key = `${r.report_date}\u0000${p.instrumentLabel}`;
    const g =
      groups.get(key) ||
      groups.set(key, { markDate: r.report_date, instrument: p.instrumentLabel, marks: [], funds: new Set() }).get(key);
    g.marks.push({ fundKey: r.fund_key, price: p.pricePerShare, accession: r.accession });
    g.funds.add(r.fund_key);
  }
  const series = [...groups.values()]
    .map(g => {
      const prices = g.marks.map(m => m.price).sort((a, b) => a - b);
      const mid = prices.length >> 1;
      return {
        markDate: g.markDate,
        instrument: g.instrument,
        funds: g.funds.size,
        median: prices.length % 2 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2,
        low: prices[0],
        high: prices[prices.length - 1],
        accessions: [...new Set(g.marks.map(m => m.accession))],
      };
    })
    .sort((a, b) => a.markDate.localeCompare(b.markDate) || a.instrument.localeCompare(b.instrument));
  return { firm, companyId, months: new Set(series.map(s => s.markDate.slice(5, 7))).size, series };
}

// The firm's position changes across its funds' filings with mark dates from
// `since` (default: one year before the newest report date).
function firmChanges(db, id, { since, until } = {}) {
  const firm = findFirm(db, id);
  const managed = (fundFirms(db).byFirm.get(firm.id) || { managed: [] }).managed;
  const newest = newestReportDate(db);
  const from = since || new Date(Date.parse(newest) - 365 * 86400000).toISOString().slice(0, 10);
  const events = fundChanges(db, { fundKeys: managed, markSince: from, markUntil: until });
  const funds = withFundLabels([...new Map(events.map(e => [e.fundKey, e])).values()]);
  const labelOf = new Map(funds.map(f => [f.fundKey, f.label]));
  return {
    firm,
    since: from,
    until: until || newest,
    events: events.map(e => ({ ...e, fundLabel: labelOf.get(e.fundKey) })),
  };
}

// The same answer as the firm book, through exposureAsOf (for tests: LESSONS 32).
function firmExposureByCompany(db, id, companyId, date) {
  const managed = new Set((fundFirms(db).byFirm.get(Number(id)) || { managed: [] }).managed);
  const r = exposureAsOf(db, { companyId, date });
  const held = r.holdings.filter(h => managed.has(h.fundKey));
  return { funds: held.length, value: held.reduce((s, h) => s + h.value, 0) };
}

module.exports = { firms, findFirm, firmBook, firmMarks, firmChanges, firmExposureByCompany, fundFirms };
