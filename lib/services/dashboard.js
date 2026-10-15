// The tracked-list dashboard (ROADMAP §6): every tracked company with its
// holders and value as of D and 12 months earlier (the market rule, ADR 0004),
// its most-held share class's median per-share mark now and a year earlier
// (as filed, same-date medians), the spread of that class's marks at the
// newest date, and how many funds carry a stale mark. The 12-month mark change
// is the median of each fund's own change on one instrument, split-adjusted
// (lib/analytics/splits.js), both ends reported within 123 days of their dates: a
// class label's market median across a reorganization would compare different
// securities (OpenAI's pre-restructuring units at $1.47). Kept until the next
// refresh. Each tracked company's class marks and history do not depend on the
// date, so they are read once per generation (dashboardInputs); a new date then
// costs two market reads, not ~4.8 s of every company's history (review H1).
const { topCompanies, newestReportDate } = require('./market');
const { classMarks, staleMarks } = require('./marks');
const { companyHistory, INACTIVE_DAYS } = require('../analytics/asof');
const { memo } = require('./memo');
const { ServiceError, isIsoDate } = require('./errors');

const yearBefore = d => new Date(Date.parse(d) - 365 * 86400000).toISOString().slice(0, 10);
const latestOnOrBefore = (series, d) => series.filter(s => s.markDate <= d).pop() || null;
const near = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400000 <= INACTIVE_DAYS;
const median = xs => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null;
};

// Each fund's split-adjusted per-share change on one instrument from `then` to
// `d` (price in latest-share terms = price / splitFactor): one observation per
// fund × instrument (F06), with the fund it came from (the dashboard counts
// distinct funds, review R14).
function fundMarkChanges(history, then, d) {
  const out = [];
  for (const f of history)
    for (const s of f.series) {
      const pts = s.points.filter(p => p.pricePerShare != null && p.pricePerShare > 0);
      const a = latestOnOrBefore(pts, then);
      const b = latestOnOrBefore(pts, d);
      if (!a || !b || a === b || !near(a.markDate, then) || !near(b.markDate, d)) continue;
      out.push({ fundKey: f.fundKey, change: b.pricePerShare / b.splitFactor / (a.pricePerShare / a.splitFactor) - 1 });
    }
  return out;
}

// Per tracked company: { series: classMarks(...).series, history:
// companyHistory(...) }, kept for the generation (memo PINNED: a crawler asking
// for many dates cannot evict it and make every date pay for it again).
function dashboardInputs(db) {
  return memo(db, 'dashboard:inputs', () => {
    const out = new Map();
    for (const { company_id: id } of db.prepare('SELECT company_id FROM tracked_companies').all()) {
      const ref = { companyId: id };
      out.set(id, { series: classMarks(db, ref).series, history: companyHistory(db, ref) });
    }
    return out;
  });
}

function trackedDashboard(db, { date } = {}) {
  const d = date || newestReportDate(db);
  if (!isIsoDate(d)) throw new ServiceError(400, 'date must be an ISO date (YYYY-MM-DD)');
  return memo(db, `dashboard:${d}`, () => {
    const then = yearBefore(d);
    const now = new Map(topCompanies(db, { date: d, limit: 1e6 }).results.map(r => [r.companyId, r]));
    const ago = new Map(topCompanies(db, { date: then, limit: 1e6 }).results.map(r => [r.companyId, r]));
    const inputs = dashboardInputs(db);
    const tracked = db
      .prepare('SELECT c.id, c.name FROM tracked_companies t JOIN companies c ON c.id = t.company_id ORDER BY c.name')
      .all();
    const rows = tracked.map(c => {
      const ref = { companyId: c.id };
      const input = inputs.get(c.id);
      const marks = input.series.filter(s => s.markDate <= d);
      // The class with the most fund marks over the year: the company's most-held class.
      const counts = new Map();
      for (const s of marks.filter(x => x.markDate > then))
        counts.set(s.instrument, (counts.get(s.instrument) || 0) + s.funds);
      const main = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || null;
      const series = marks.filter(s => s.instrument === main);
      const latest = latestOnOrBefore(series, d);
      const changes = fundMarkChanges(input.history, then, d);
      const n = now.get(c.id);
      const a = ago.get(c.id);
      return {
        companyId: c.id,
        name: c.name,
        funds: n?.funds || 0,
        value: n?.value || 0,
        fundsYearAgo: a?.funds || 0,
        valueYearAgo: a?.value || 0,
        holderChange: (n?.funds || 0) - (a?.funds || 0),
        mainClass: main,
        markDate: latest?.markDate || null,
        median: latest?.median ?? null,
        markChange12mPct: changes.length ? median(changes.map(c => c.change)) * 100 : null,
        markChangeFunds: new Set(changes.map(c => c.fundKey)).size,
        dispersionPct: latest && latest.funds > 1 && latest.low > 0 ? (latest.high / latest.low - 1) * 100 : null,
        staleFunds: new Set(staleMarks(db, ref, { asOf: d, inputs: input }).stale.map(x => x.fundKey)).size,
      };
    });
    return { date: d, yearAgo: then, companies: rows.sort((x, y) => y.value - x.value) };
  });
}

module.exports = { trackedDashboard };
