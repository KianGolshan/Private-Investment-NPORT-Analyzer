// Security-level views of one company: its share classes and every fund's
// per-share mark on each (ROADMAP §6 class comparison, mark disagreement).
// Rules (DATA-QUALITY traps 34 and 40, LESSONS 39): per-share marks come from
// share rows only; funds are compared as filed, at the same mark date; a gap
// is a ratio of prices, never a guessed valuation method.
const {
  exposureAsOf,
  companyRows,
  companyHistory,
  keepCanonical,
  rowInfo,
  INACTIVE_DAYS,
} = require('../analytics/asof');
const { fundFirms } = require('./firm');
const { withFundLabels } = require('./company');

const { classOf, classOfRow } = require('./classes');

// Prices filed as value / shares differ in the 9th digit; a spread under a
// hundredth of a cent per $100 is no spread.
const pct = (a, b) => {
  const v = (a / b - 1) * 100;
  return Math.abs(v) < 1e-4 ? 0 : v;
};

const median = xs => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// The firms that advise a fund (not sub-advisers): [{ id, name }].
function firmsOfFund(db) {
  const { byFund } = fundFirms(db);
  const names = new Map(
    db
      .prepare('SELECT id, name FROM managers')
      .all()
      .map(m => [m.id, m.name])
  );
  return fundKey =>
    (byFund.get(fundKey) || [])
      .filter(x => x.role !== 'subadviser')
      .map(x => ({ id: x.managerId, name: names.get(x.managerId) }));
}
const firmText = firms => firms.map(f => f.name).join(' / ') || null;

// As of D: each class held, with every fund's mark on it. Marks are grouped by
// mark date (funds file on staggered calendars); the spread is computed only
// within one mark date. withinFiling: in each filing that marks 2+ classes,
// each class's mark against the filing's lowest (F30: Fidelity marks Series D
// 5.76% above Series E-H).
function classesAsOf(db, ref, date) {
  const x = exposureAsOf(db, { ...ref, date });
  const firmsOf = firmsOfFund(db);
  const labelOf = new Map(withFundLabels(x.holdings).map(h => [h.fundKey, h.label]));
  const classes = new Map();
  const withinFiling = [];
  for (const h of x.holdings) {
    const priced = h.positions.filter(p => p.pricePerShare != null);
    const low = priced.length > 1 ? Math.min(...priced.map(p => p.pricePerShare)) : null;
    for (const p of h.positions) {
      const k = classOfRow(p);
      const c = classes.get(k) || classes.set(k, { instrument: k, value: 0, marks: [] }).get(k);
      c.value += p.valueUsd;
      c.marks.push({
        fundKey: h.fundKey,
        fund: labelOf.get(h.fundKey),
        firm: firmText(firmsOf(h.fundKey)),
        firms: firmsOf(h.fundKey),
        cik: h.cik,
        markDate: h.markDate,
        accession: h.accession,
        balance: p.balance,
        unit: p.unit,
        pricePerShare: p.pricePerShare,
        pricePerUnit: p.pricePerUnit,
        value: p.valueUsd,
        viaSpv: p.viaSpv,
        kind: p.kind,
        vsFilingLowPct: low && p.pricePerShare != null ? pct(p.pricePerShare, low) : null,
      });
    }
    if (low)
      withinFiling.push({
        fundKey: h.fundKey,
        fund: labelOf.get(h.fundKey),
        firm: firmText(firmsOf(h.fundKey)),
        firms: firmsOf(h.fundKey),
        cik: h.cik,
        markDate: h.markDate,
        accession: h.accession,
        classes: priced
          .map(p => ({
            instrument: classOfRow(p),
            pricePerShare: p.pricePerShare,
            vsLowPct: pct(p.pricePerShare, low),
          }))
          .sort((a, b) => b.pricePerShare - a.pricePerShare),
      });
  }
  const result = [...classes.values()].map(c => {
    const byDate = new Map();
    for (const m of c.marks)
      if (m.pricePerShare != null) (byDate.get(m.markDate) || byDate.set(m.markDate, []).get(m.markDate)).push(m);
    return {
      instrument: c.instrument,
      value: c.value,
      funds: new Set(c.marks.map(m => m.fundKey)).size,
      byMarkDate: [...byDate]
        .map(([markDate, ms]) => {
          const prices = ms.map(m => m.pricePerShare);
          const low = Math.min(...prices);
          const high = Math.max(...prices);
          return {
            markDate,
            funds: ms.length,
            median: median(prices),
            low,
            high,
            spreadPct: low > 0 ? pct(high, low) : null,
            firms: [...new Map(ms.flatMap(m => m.firms).map(f => [f.id, f])).values()],
          };
        })
        .sort((a, b) => b.markDate.localeCompare(a.markDate)),
      marks: c.marks.sort((a, b) => b.markDate.localeCompare(a.markDate) || b.value - a.value),
    };
  });
  return {
    date: x.date,
    classes: result.sort((a, b) => b.value - a.value),
    withinFiling: withinFiling.filter(w => w.classes.some(c => c.vsLowPct > 0)),
  };
}

// Every report date since the first: per class, the median, low and high
// per-share mark across all funds that filed that date, and how many firms.
// The market's price-per-share trend for the company, as filed.
function classMarks(db, ref) {
  const firmsOf = firmsOfFund(db);
  const groups = new Map();
  // Per firm too: one firm's funds on one class at one mark date (W2's per-firm
  // lines; a median across firms at nearby dates mixes their marks).
  const byFirm = new Map();
  for (const r of keepCanonical(db, companyRows(db, ref, '9999-12-31'))) {
    if (!r.counts) continue;
    const p = rowInfo(r);
    if (p.pricePerShare == null) continue;
    const instrument = classOfRow(p);
    const key = `${r.report_date}\u0000${instrument}`;
    const g =
      groups.get(key) ||
      groups.set(key, { markDate: r.report_date, instrument, prices: [], funds: new Set(), firms: new Set() }).get(key);
    g.prices.push(p.pricePerShare);
    g.funds.add(r.fund_key);
    const firms = firmsOf(r.fund_key);
    for (const f of firms) g.firms.add(f.id);
    for (const f of firms.length ? firms : [{ id: 0, name: 'No firm on file' }]) {
      const fk = `${key}\u0000${f.id}`;
      const x =
        byFirm.get(fk) ||
        byFirm
          .set(fk, { markDate: r.report_date, instrument, firmId: f.id, firm: f.name, prices: [], funds: new Set() })
          .get(fk);
      x.prices.push(p.pricePerShare);
      x.funds.add(r.fund_key);
    }
  }
  const series = [...groups.values()]
    .map(g => ({
      markDate: g.markDate,
      instrument: g.instrument,
      funds: g.funds.size,
      firms: g.firms.size,
      median: median(g.prices),
      low: Math.min(...g.prices),
      high: Math.max(...g.prices),
    }))
    .sort((a, b) => a.markDate.localeCompare(b.markDate) || a.instrument.localeCompare(b.instrument));
  const firmSeries = [...byFirm.values()]
    .map(x => ({
      markDate: x.markDate,
      instrument: x.instrument,
      firmId: x.firmId,
      firm: x.firm,
      funds: x.funds.size,
      median: median(x.prices),
      low: Math.min(...x.prices),
      high: Math.max(...x.prices),
    }))
    .sort(
      (a, b) => a.markDate.localeCompare(b.markDate) || a.instrument.localeCompare(b.instrument) || a.firmId - b.firmId
    );
  return { classes: [...new Set(series.map(s => s.instrument))].sort(), series, firmSeries };
}

// Stale marks: a fund still filing the same per-share mark on a class for
// minReports or more consecutive reports while the median mark of that class
// across all funds moved more than moveThreshold (percent) over the same
// dates. Funds still reporting (latest mark within 123 days of the newest
// report date) only. Same-date medians as filed (classMarks).
function staleMarks(db, ref, { minReports = 3, moveThreshold = 1 } = {}) {
  const newest = db.prepare('SELECT MAX(report_date) d FROM filings').get().d;
  const market = classMarks(db, ref).series;
  const medianAt = new Map(market.map(s => [`${s.instrument}\u0000${s.markDate}`, s.median]));
  const firmsOf = firmsOfFund(db);
  const out = [];
  for (const f of withFundLabels(companyHistory(db, ref)))
    for (const s of f.series) {
      const pts = s.points.filter(p => p.pricePerShare != null);
      if (pts.length < minReports) continue;
      const last = pts[pts.length - 1];
      if ((Date.parse(newest) - Date.parse(last.markDate)) / 86400000 > INACTIVE_DAYS) continue;
      let k = 1;
      while (k < pts.length && Math.abs(pts[pts.length - 1 - k].pricePerShare / last.pricePerShare - 1) < 1e-4) k++;
      if (k < minReports) continue;
      const since = pts[pts.length - k];
      const instrument = classOfRow(last);
      const m0 = medianAt.get(`${instrument}\u0000${since.markDate}`);
      const m1 = medianAt.get(`${instrument}\u0000${last.markDate}`);
      const marketMovePct = m0 && m1 ? (m1 / m0 - 1) * 100 : null;
      if (marketMovePct == null || Math.abs(marketMovePct) <= moveThreshold) continue;
      out.push({
        fundKey: f.fundKey,
        fund: f.label,
        firms: firmsOf(f.fundKey),
        cik: f.cik,
        instrument,
        pricePerShare: last.pricePerShare,
        unchangedSince: since.markDate,
        reports: k,
        lastMarkDate: last.markDate,
        accession: last.accession,
        marketMedianThen: m0,
        marketMedianNow: m1,
        marketMovePct,
      });
    }
  return {
    minReports,
    moveThreshold,
    stale: out.sort((a, b) => b.reports - a.reports || Math.abs(b.marketMovePct) - Math.abs(a.marketMovePct)),
  };
}

module.exports = { classesAsOf, classMarks, staleMarks, classOf, classOfRow, firmsOfFund };
