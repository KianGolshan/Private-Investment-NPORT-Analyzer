// Sector, industry and theme views of private operating companies (P14, ADR
// 0010): holdings as of a date grouped by label (built on Market's own answer,
// so the groups add up to Market's total), the companies in one group, and a
// per-share mark index over time.
//
// The mark index follows chains: one fund's one security, filing after filing.
// A chain's level is its mark relative to its mark in force at the window
// start, multiplied through each consecutive pair of filings (at most
// MAX_GAP_DAYS apart, both with a per-share mark, split-adjusted as the
// position legs already are: price / (prior price / split)). A chain ends when
// a pair is missing (a gap, a value-only row, a class no longer reported) and
// counts at a date only while its last mark is in force (the as-of rule).
// A company's level is the median of its chains' levels, so a step-up that
// funds report in different quarters (staggered calendars) is counted once,
// when most of its funds have reported it, never compounded. The cohort is
// fixed at the window start (companies with a mark in force then), so
// companies first reported later, at higher prices, cannot move the index: a
// repeat-sales index. The group index is the median company level (the
// typical company), shown with the 25th-75th percentile range, and a
// value-weighted index (the cohort's starting values carried at their marks).
// A date with fewer than MIN_COMPANIES companies or MIN_CHAINS chains has no
// index value.
const market = require('./market');
const analysis = require('./analysis');
const { INACTIVE_DAYS } = require('../analytics/asof');
const { taxonomy, labels, groupKeys, LEVELS, UNCLASSIFIED } = require('./sector-labels');
const { ServiceError, isIsoDate } = require('./errors');
const { memo } = require('./memo');

const MAX_GAP_DAYS = 100;
const MIN_COMPANIES = 5;
const MIN_CHAINS = 20;
const MARKED = new Set(['unchanged', 'added', 'reduced', 'reported at $0']);
const DAY = 86400000;
const PERIOD_MONTHS = { month: 1, quarter: 3, year: 12 };

function checkLevel(level) {
  if (!LEVELS.includes(level)) throw new ServiceError(400, `level must be one of ${LEVELS.join(', ')}`);
  return level;
}
function checkDate(name, d) {
  if (d != null && !isIsoDate(d)) throw new ServiceError(400, `${name} must be an ISO date (YYYY-MM-DD)`);
  return d;
}
const nameOf = (db, code) => taxonomy(db).names.get(code) || code;
const daysBetween = (a, b) => (Date.parse(b) - Date.parse(a)) / DAY;
const addDays = (d, n) => new Date(Date.parse(d) + n * DAY).toISOString().slice(0, 10);

// Market's operating companies as of a date (the same answer Market shows).
function marketRows(db, { date, knownAsOf }) {
  return market.topCompanies(db, { date, limit: 1e9, categories: ['company'], knownAsOf });
}

// Holdings by sector, industry or theme as of a date. Sectors and industries
// add up to Market's operating-company total ('unclassified' included); themes
// overlap and do not.
function totals(db, { date, knownAsOf, level = 'sector' } = {}) {
  checkLevel(level);
  checkDate('date', date);
  const top = marketRows(db, { date, knownAsOf });
  const keysOf = groupKeys(db, level);
  const groups = new Map();
  for (const c of top.results)
    for (const k of keysOf(c.companyId)) {
      const g = groups.get(k) || groups.set(k, { key: k, value: 0, companies: 0, top: [] }).get(k);
      g.value += c.value;
      g.companies++;
      if (g.top.length < 3) g.top.push({ companyId: c.companyId, name: c.name, value: c.value });
    }
  const t = taxonomy(db);
  const sectorOf = new Map(t.sectors.flatMap(s => s.industries.map(i => [i.code, s.code])));
  const list = [...groups.values()]
    .map(g => ({
      ...g,
      label: nameOf(db, g.key),
      ...(level === 'industry' && g.key !== UNCLASSIFIED ? { sector: sectorOf.get(g.key) } : {}),
      share: top.totalValue ? g.value / top.totalValue : null,
    }))
    .sort((a, b) => (a.key === UNCLASSIFIED) - (b.key === UNCLASSIFIED) || b.value - a.value);
  return {
    date: top.date,
    ...(top.knownAsOf ? { knownAsOf: top.knownAsOf } : {}),
    level,
    additive: level !== 'theme',
    taxonomyVersion: t.version,
    companies: top.companies,
    totalValue: top.totalValue,
    newestMark: top.newestMark,
    groups: list,
  };
}

// The companies in one group as of a date, ranked by value, with their labels.
function groupCompanies(db, { level, key, date, knownAsOf, limit = 500 } = {}) {
  checkLevel(level);
  checkDate('date', date);
  if (!key) throw new ServiceError(400, 'key is required');
  if (!taxonomy(db).names.has(key)) throw new ServiceError(404, `no ${level} "${key}"`);
  const top = marketRows(db, { date, knownAsOf });
  const keysOf = groupKeys(db, level);
  const map = labels(db);
  const rows = top.results
    .filter(c => keysOf(c.companyId).includes(key))
    .map((c, i) => {
      const l = map.get(c.companyId);
      return {
        ...c,
        rank: i + 1,
        sector: l?.sector || null,
        industry: l?.industry || null,
        industryLabel: l?.industry ? nameOf(db, l.industry) : null,
        themes: l?.themes || [],
        labelConfidence: l?.confidence || null,
      };
    });
  return {
    date: top.date,
    ...(top.knownAsOf ? { knownAsOf: top.knownAsOf } : {}),
    level,
    key,
    label: nameOf(db, key),
    companies: rows.length,
    totalValue: rows.reduce((s, r) => s + r.value, 0),
    marketTotal: top.totalValue,
    results: rows.slice(0, limit),
  };
}

const quantile = (sorted, q) => {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};
const median = xs =>
  quantile(
    [...xs].sort((a, b) => a - b),
    0.5
  );

// Every chain of operating companies' per-share legs: fund + security, legs in
// mark-date order. Built once per generation.
function chains(db) {
  return memo(db, 'sectors:chains', () => {
    const ops = market.categoryIds(db, ['company']);
    const byKey = new Map();
    for (const l of analysis.allFacts(db).list) {
      if (!ops.has(l.company_id) || !l.instrument_key) continue;
      const k = `${l.fund_key}\u0000${l.instrument_key}`;
      (byKey.get(k) || byKey.set(k, []).get(k)).push(l);
    }
    const out = [];
    for (const legs of byKey.values()) {
      legs.sort((a, b) => a.report_date.localeCompare(b.report_date));
      out.push({ companyId: legs[0].company_id, fundKey: legs[0].fund_key, legs });
    }
    return out;
  });
}

// A leg that continues its chain: a per-share mark on both sides of a gap of at
// most MAX_GAP_DAYS, from the chain's previous mark, with units comparable
// (a split or restatement is already applied; a unit count that still moves
// UNIT_JUMP times or more is a new basis, e.g. Partners Group's Amsurg going
// from 3,969,417.82 units to "1" after a sale, so the chain ends there).
const UNIT_JUMP = 50;
function continues(l, lastDate) {
  const units = l.prev_balance > 0 && l.balance > 0 ? l.balance / (l.prev_balance * (l.split || 1)) : null;
  return (
    units != null &&
    units < UNIT_JUMP &&
    units > 1 / UNIT_JUMP &&
    l.per_share &&
    MARKED.has(l.change) &&
    l.prev_price > 0 &&
    l.price != null &&
    l.price >= 0 &&
    l.prev_report_date === lastDate &&
    daysBetween(l.prev_report_date, l.report_date) <= MAX_GAP_DAYS
  );
}

// One chain's levels at each date in `dates` (ascending), relative to its mark
// in force at `start`; null where it has no mark in force. Also its starting
// value (for the value-weighted index) and its last mark date.
function chainLevels(chain, start, dates) {
  const legs = chain.legs;
  let i = legs.length - 1;
  while (i >= 0 && legs[i].report_date > start) i--;
  if (i < 0) return null;
  const base = legs[i];
  if (!(base.per_share && base.price > 0) || daysBetween(base.report_date, start) > INACTIVE_DAYS) return null;
  const steps = []; // [date, level]
  let level = 1;
  let last = base.report_date;
  for (let j = i + 1; j < legs.length; j++) {
    const l = legs[j];
    if (!continues(l, last)) break;
    level *= l.price / (l.prev_price / (l.split || 1));
    last = l.report_date;
    steps.push([last, level]);
  }
  const levels = dates.map(d => {
    let lv = 1;
    let at = base.report_date;
    for (const [date, v] of steps) {
      if (date > d) break;
      lv = v;
      at = date;
    }
    return daysBetween(at, d) <= INACTIVE_DAYS ? lv : null;
  });
  return { levels, startValue: base.value || 0, baseDate: base.report_date };
}

const periodLabel = (d, period) =>
  period === 'year'
    ? d.slice(0, 4)
    : period === 'quarter'
      ? `${d.slice(0, 4)}Q${Math.ceil(Number(d.slice(5, 7)) / 3)}`
      : d.slice(0, 7);
const isPeriodEnd = (d, period) =>
  addDays(d, 1).slice(8, 10) === '01' && Number(d.slice(5, 7)) % PERIOD_MONTHS[period] === 0;

// The window and its period-end dates.
function windowOf(db, { from, to, period }) {
  if (!PERIOD_MONTHS[period]) throw new ServiceError(400, 'period must be month, quarter or year');
  checkDate('from', from);
  checkDate('to', to);
  const newestMark = market.newestPrivateMark(db);
  const end = to || newestMark;
  if (!end) throw new ServiceError(404, 'no marks in this warehouse');
  const start = from || addDays(end, -730);
  if (start >= end) throw new ServiceError(400, 'from must be before to');
  const dates = [start, ...analysis.periodEnds(start, end, period), end];
  if (dates.length > 121) throw new ServiceError(400, 'at most 120 periods');
  return { start, end, dates, newestMark };
}

// Per company in the cohort: its level at each date (the median of its chains)
// and its starting value carried at each date (value-weighted).
function companyLevels(db, { start, dates, keep }) {
  const byCo = new Map();
  for (const c of chains(db)) {
    if (keep && !keep(c.companyId)) continue;
    const cl = chainLevels(c, start, dates);
    if (!cl) continue;
    (byCo.get(c.companyId) || byCo.set(c.companyId, []).get(c.companyId)).push({ ...cl, fundKey: c.fundKey });
  }
  const out = new Map();
  for (const [id, cls] of byCo) {
    const levels = dates.map((_, i) => {
      const xs = cls.map(c => c.levels[i]).filter(v => v != null);
      return xs.length ? median(xs) : null;
    });
    const carried = dates.map((_, i) => {
      let v = 0;
      let base = 0;
      for (const c of cls)
        if (c.levels[i] != null) {
          v += c.startValue * c.levels[i];
          base += c.startValue;
        }
      return base > 0 ? { value: v, base } : null;
    });
    const chainsAt = dates.map((_, i) => cls.filter(c => c.levels[i] != null).length);
    const unchangedAt = dates.map((_, i) =>
      i === 0 ? 0 : cls.filter(c => c.levels[i] != null && c.levels[i] === c.levels[i - 1]).length
    );
    out.set(id, { levels, carried, chainsAt, unchangedAt, funds: new Set(cls.map(c => c.fundKey)).size });
  }
  return out;
}

// The per-share mark index for groups at one level over calendar periods.
// keys: the groups to answer (default: every group with a company in the cohort).
function markIndex(db, { level = 'sector', keys, period = 'quarter', from, to } = {}) {
  checkLevel(level);
  const { start, end, dates, newestMark } = windowOf(db, { from, to, period });
  const keysOf = groupKeys(db, level);
  const known = taxonomy(db).names;
  for (const k of keys || []) if (!known.has(k)) throw new ServiceError(404, `no ${level} "${k}"`);
  const want = keys ? new Set(keys) : null;
  const cos = companyLevels(db, {
    start,
    dates,
    keep: want ? id => keysOf(id).some(k => want.has(k)) : null,
  });
  const members = new Map();
  for (const id of cos.keys())
    for (const k of keysOf(id)) {
      if (want && !want.has(k)) continue;
      (members.get(k) || members.set(k, []).get(k)).push(id);
    }
  const groups = [...(want ? [...want] : [...members.keys()])].map(k => {
    const ids = members.get(k) || [];
    const at = i => ids.map(id => cos.get(id)).filter(c => c.levels[i] != null);
    let prevIndex = null;
    let prevValueIndex = null;
    const points = dates.map((d, i) => {
      const present = at(i);
      const lv = present.map(c => c.levels[i]).sort((a, b) => a - b);
      const chainsN = present.reduce((s, c) => s + c.chainsAt[i], 0);
      const sufficient = present.length >= MIN_COMPANIES && chainsN >= MIN_CHAINS;
      let v = 0;
      let base = 0;
      for (const c of present)
        if (c.carried[i]) {
          v += c.carried[i].value;
          base += c.carried[i].base;
        }
      const index = sufficient ? 100 * quantile(lv, 0.5) : null;
      const valueIndex = sufficient && base > 0 ? (100 * v) / base : null;
      const unchanged = i === 0 ? null : chainsN ? present.reduce((s, c) => s + c.unchangedAt[i], 0) / chainsN : null;
      const point = {
        date: d,
        label: i === 0 ? 'start' : periodLabel(d, period),
        partial: i > 0 && (!isPeriodEnd(dates[i - 1], period) || !isPeriodEnd(d, period) || d > newestMark),
        companies: present.length,
        chains: chainsN,
        sufficient,
        index,
        p25: sufficient ? 100 * quantile(lv, 0.25) : null,
        p75: sufficient ? 100 * quantile(lv, 0.75) : null,
        valueIndex,
        change: index != null && prevIndex != null ? index / prevIndex - 1 : null,
        valueChange: valueIndex != null && prevValueIndex != null ? valueIndex / prevValueIndex - 1 : null,
        unchanged,
        up:
          i === 0 ? null : present.filter(c => c.levels[i - 1] != null && c.levels[i] > c.levels[i - 1] + 1e-12).length,
        down:
          i === 0 ? null : present.filter(c => c.levels[i - 1] != null && c.levels[i] < c.levels[i - 1] - 1e-12).length,
      };
      prevIndex = index;
      prevValueIndex = valueIndex;
      return point;
    });
    return { key: k, label: nameOf(db, k), cohort: ids.length, points };
  });
  groups.sort((a, b) => b.cohort - a.cohort);
  return {
    level,
    period,
    from: start,
    to: end,
    newestMark,
    method: {
      chains: `one fund's one security; consecutive filings at most ${MAX_GAP_DAYS} days apart, split-adjusted; a mark counts while in force (${INACTIVE_DAYS} days)`,
      company: "median of its chains' levels (a step-up funds report in different quarters counts once)",
      group:
        'median company level (the typical company), fixed cohort of companies marked at the start; value-weighted alongside',
      minimum: `${MIN_COMPANIES} companies and ${MIN_CHAINS} chains at a date, or no index value at that date`,
    },
    additive: level !== 'theme',
    taxonomyVersion: taxonomy(db).version,
    groups,
  };
}

// Each company's per-share mark change over the window (its level at the end),
// for the companies in one group: "how did each AI company's mark move".
function companyMarkChanges(db, { level, key, from, to, period = 'quarter' } = {}) {
  checkLevel(level);
  if (!key) throw new ServiceError(400, 'key is required');
  if (!taxonomy(db).names.has(key)) throw new ServiceError(404, `no ${level} "${key}"`);
  const { start, end, dates } = windowOf(db, { from, to, period });
  const keysOf = groupKeys(db, level);
  const cos = companyLevels(db, { start, dates, keep: id => keysOf(id).includes(key) });
  const names = db.prepare('SELECT name FROM companies WHERE id = ?');
  const last = dates.length - 1;
  const rows = [...cos]
    .map(([id, c]) => ({
      companyId: id,
      name: names.get(id)?.name,
      change: c.levels[last] != null ? c.levels[last] - 1 : null,
      funds: c.funds,
      chains: c.chainsAt[0],
      stillMarked: c.chainsAt[last],
      path: dates.map((d, i) => ({ date: d, level: c.levels[i] })),
    }))
    .sort((a, b) => (b.change ?? -Infinity) - (a.change ?? -Infinity));
  return { level, key, label: nameOf(db, key), from: start, to: end, companies: rows };
}

module.exports = {
  totals,
  groupCompanies,
  markIndex,
  companyMarkChanges,
  MAX_GAP_DAYS,
  MIN_COMPANIES,
  MIN_CHAINS,
};
