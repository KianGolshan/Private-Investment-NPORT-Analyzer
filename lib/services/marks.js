// Security-level views of one company: its share classes and every fund's
// per-share mark on each (ROADMAP §6 class comparison, mark disagreement).
// Rules (DATA-QUALITY traps 34 and 40, LESSONS 39): per-share marks come from
// share rows only; funds are compared as filed, at the same mark date; a gap
// is a ratio of prices, never a guessed valuation method.
const { exposureAsOf, companyRows, rowInfo } = require('../analytics/asof');
const { fundFirms } = require('./firm');
const { withFundLabels } = require('./company');

// One spelling per class: filers write "F1" and "F-1", "Series D" and "D".
const classOf = label =>
  String(label || 'Unlabeled')
    .replace(/\b([A-Z]{1,3})-?(\d+)\b/g, '$1-$2')
    .replace(/\s+/g, ' ')
    .trim();
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

function firmNamer(db) {
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
      .map(x => names.get(x.managerId))
      .join(' / ') || null;
}

// As of D: each class held, with every fund's mark on it. Marks are grouped by
// mark date (funds file on staggered calendars); the spread is computed only
// within one mark date. withinFiling: in each filing that marks 2+ classes,
// each class's mark against the filing's lowest (F30: Fidelity marks Series D
// 5.76% above Series E-H).
function classesAsOf(db, ref, date) {
  const x = exposureAsOf(db, { ...ref, date });
  const firmOf = firmNamer(db);
  const labelOf = new Map(withFundLabels(x.holdings).map(h => [h.fundKey, h.label]));
  const classes = new Map();
  const withinFiling = [];
  for (const h of x.holdings) {
    const priced = h.positions.filter(p => p.pricePerShare != null);
    const low = priced.length > 1 ? Math.min(...priced.map(p => p.pricePerShare)) : null;
    for (const p of h.positions) {
      const k = classOf(p.instrumentLabel);
      const c = classes.get(k) || classes.set(k, { instrument: k, value: 0, marks: [] }).get(k);
      c.value += p.valueUsd;
      c.marks.push({
        fundKey: h.fundKey,
        fund: labelOf.get(h.fundKey),
        firm: firmOf(h.fundKey),
        cik: h.cik,
        markDate: h.markDate,
        accession: h.accession,
        balance: p.balance,
        unit: p.unit,
        pricePerShare: p.pricePerShare,
        pricePerUnit: p.pricePerUnit,
        value: p.valueUsd,
        viaSpv: p.viaSpv,
        vsFilingLowPct: low && p.pricePerShare != null ? pct(p.pricePerShare, low) : null,
      });
    }
    if (low)
      withinFiling.push({
        fundKey: h.fundKey,
        fund: labelOf.get(h.fundKey),
        firm: firmOf(h.fundKey),
        cik: h.cik,
        markDate: h.markDate,
        accession: h.accession,
        classes: priced
          .map(p => ({
            instrument: classOf(p.instrumentLabel),
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
            firms: [...new Set(ms.map(m => m.firm).filter(Boolean))],
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
  const firmOf = firmNamer(db);
  const groups = new Map();
  for (const r of companyRows(db, ref, '9999-12-31')) {
    if (!r.counts) continue;
    const p = rowInfo(r);
    if (p.pricePerShare == null) continue;
    const instrument = classOf(p.instrumentLabel);
    const key = `${r.report_date}\u0000${instrument}`;
    const g =
      groups.get(key) ||
      groups.set(key, { markDate: r.report_date, instrument, prices: [], funds: new Set(), firms: new Set() }).get(key);
    g.prices.push(p.pricePerShare);
    g.funds.add(r.fund_key);
    const f = firmOf(r.fund_key);
    if (f) g.firms.add(f);
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
  return { classes: [...new Set(series.map(s => s.instrument))].sort(), series };
}

module.exports = { classesAsOf, classMarks, classOf };
