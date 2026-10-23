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
// when most of its funds have reported it, never compounded.
// The group index (markIndex) is chain-linked repeat sales: each period's
// change is the average return of the companies marked at both ends of it
// (winsorized at 5%; the median and 25th-75th percentiles alongside) and the return
// weighted by their values at the period start. A company first reported
// later, at a higher price, joins without moving the level. A period with
// fewer than MIN_COMPANIES companies or MIN_CHAINS chains has no change; the
// index starts at the first period with enough and stops at a later one
// without. companyMarkChanges keeps a fixed cohort (marked at the start).
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
// Two more pairs are not mark moves, so the chain ends there too (trap 68):
// - a mark up from a placeholder: a stake carried at a token price (below
//   NOMINAL_PRICE a share, e.g. Arctic Canadian Diamond at $0.000006 then
//   $354.32) or rising UNIT_JUMP times or more in one step. A fall to a token
//   price is a real write-down and stays (Intarcia $4.89 to $0.00001).
// - a unit restatement: units move RESTATED times or more while the value
//   stays within VALUE_BAND, so the price moves only by the units (Climeworks
//   58,205,144.23 units at $1.49 to 7,823,400 at $11.09, both $86.7M).
const UNIT_JUMP = 50;
const NOMINAL_PRICE = 0.001;
const WINSOR = 0.05;
const RESTATED = 3;
const VALUE_BAND = [0.8, 1.25];
// The average company's return: the mean with the lowest and highest WINSOR
// share capped at those percentiles (winsorized), so one re-mark cannot carry
// a group. The median often reads 0: many private marks do not move.
function averageReturn(returns) {
  const sorted = [...returns].sort((a, b) => a - b);
  const lo = quantile(sorted, WINSOR);
  const hi = quantile(sorted, 1 - WINSOR);
  return sorted.reduce((t, r) => t + Math.min(hi, Math.max(lo, r)), 0) / sorted.length;
}
function restated(units, priceRatio) {
  const value = units * priceRatio;
  return (units >= RESTATED || units <= 1 / RESTATED) && value >= VALUE_BAND[0] && value <= VALUE_BAND[1];
}
function continues(l, lastDate) {
  const units = l.prev_balance > 0 && l.balance > 0 ? l.balance / (l.prev_balance * (l.split || 1)) : null;
  const priceRatio = l.prev_price > 0 && l.price != null ? l.price / (l.prev_price / (l.split || 1)) : null;
  return (
    units != null &&
    units < UNIT_JUMP &&
    units > 1 / UNIT_JUMP &&
    priceRatio != null &&
    priceRatio < UNIT_JUMP &&
    l.prev_price / (l.split || 1) >= NOMINAL_PRICE &&
    !restated(units, priceRatio) &&
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
  // own keys only: a lookup alone let __proto__ and constructor through (500s found by the API fuzz)
  if (!Object.hasOwn(PERIOD_MONTHS, period)) throw new ServiceError(400, 'period must be month, quarter or year');
  checkDate('from', from);
  checkDate('to', to);
  const newestMark = market.newestPrivateMark(db);
  const end = to || newestMark;
  if (!end) throw new ServiceError(404, 'no marks in this warehouse');
  // by default two years back, from the period end on or before then (no partial first period)
  const start =
    from || analysis.periodEnds(addDays(end, -1100), addDays(end, -730), period).at(-1) || addDays(end, -730);
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

// A chain's segments: runs of consecutive per-share marks (continues()), each
// mark with `cum`, the product of the segment's pair returns since its first
// mark, and the position's value. A gap, a value-only row or a unit jump
// starts a new segment.
function segmentsOf(chain) {
  const segs = [];
  let cur = null;
  for (const l of chain.legs) {
    if (cur && continues(l, cur.last)) {
      const prev = cur.marks[cur.marks.length - 1].cum;
      cur.marks.push({
        date: l.report_date,
        cum: prev * (l.price / (l.prev_price / (l.split || 1))),
        value: l.value || 0,
      });
      cur.last = l.report_date;
    } else if (l.per_share && l.price > 0) {
      cur = { marks: [{ date: l.report_date, cum: 1, value: l.value || 0 }], last: l.report_date };
      segs.push(cur);
    } else cur = null;
  }
  return segs;
}

// The mark of a segment in force at d (its latest on or before d, no older than
// the as-of rule allows), or null.
function inForce(seg, d) {
  let m = null;
  for (const x of seg.marks) {
    if (x.date > d) break;
    m = x;
  }
  return m && daysBetween(m.date, d) <= INACTIVE_DAYS ? m : null;
}

// Each company's period returns over `dates`: its level is the median of its
// segments' levels; a segment that starts later is spliced in at the company's
// level when it first counts, so a step-up funds report in different periods
// counts once. A period's return needs a segment in force at both ends.
function companyReturns(db, { dates, keep }) {
  const byCo = new Map();
  for (const c of chains(db)) {
    if (keep && !keep(c.companyId)) continue;
    const segs = segmentsOf(c);
    if (segs.length) (byCo.get(c.companyId) || byCo.set(c.companyId, []).get(c.companyId)).push(...segs);
  }
  const out = new Map();
  for (const [id, segs] of byCo) {
    const anchor = new Map(); // segment -> multiplier onto the company level
    let level = null;
    const periods = dates.map(() => null);
    dates.forEach((d, k) => {
      const now = segs.map(sg => [sg, inForce(sg, d)]).filter(([, m]) => m);
      // the period's return: the median level now over the median level at the
      // period start, over the same segments (in force at both ends), so a
      // segment that ends or starts cannot move it
      if (k > 0 && level != null) {
        const both = now
          .filter(([sg]) => anchor.has(sg))
          .map(([sg, m]) => [sg, m, inForce(sg, dates[k - 1])])
          .filter(([, , p]) => p);
        const before = median(both.map(([sg, , p]) => anchor.get(sg) * p.cum));
        if (both.length && before > 0) {
          const ret = median(both.map(([sg, m]) => anchor.get(sg) * m.cum)) / before - 1;
          level *= 1 + ret;
          periods[k] = {
            ret,
            weight: both.reduce((t, [, , p]) => t + p.value, 0),
            chains: both.length,
            unchanged: both.filter(([, m, p]) => m.cum === p.cum).length,
          };
        }
      }
      if (!now.length) level = null;
      else if (level == null) level = 1; // the company's first mark in the window
      for (const [sg, m] of now) if (!anchor.has(sg) && m.cum > 0) anchor.set(sg, level / m.cum);
      for (const sg of [...anchor.keys()]) if (!now.some(([x]) => x === sg)) anchor.delete(sg);
    });
    out.set(id, periods);
  }
  return out;
}

// The per-share mark index for groups at one level over calendar periods,
// chain-linked: each period's change is the average company return (5%
// winsorized; the median and the value-weighted one alongside) over the
// companies marked at both ends of the period,
// so companies first reported later join without moving the level. The index
// starts at 100 at the first period with enough companies, and stops at a
// later period without enough.
function markIndex(db, { level = 'sector', keys, period = 'quarter', from, to } = {}) {
  checkLevel(level);
  const { start, end, dates, newestMark } = windowOf(db, { from, to, period });
  const keysOf = groupKeys(db, level);
  const known = taxonomy(db).names;
  for (const k of keys || []) if (!known.has(k)) throw new ServiceError(404, `no ${level} "${k}"`);
  const want = keys ? new Set(keys) : null;
  const cos = companyReturns(db, { dates, keep: want ? id => keysOf(id).some(k => want.has(k)) : null });
  const members = new Map();
  for (const id of cos.keys())
    for (const k of keysOf(id)) {
      if (want && !want.has(k)) continue;
      (members.get(k) || members.set(k, []).get(k)).push(id);
    }
  const groups = [...(want ? [...want] : [...members.keys()])].map(k => {
    const ids = members.get(k) || [];
    let index = null;
    let valueIndex = null;
    let stopped = false;
    const measured = new Set();
    const points = dates.map((d, i) => {
      const rs = i === 0 ? [] : ids.map(id => [id, cos.get(id)[i]]).filter(([, p]) => p);
      rs.forEach(([id]) => measured.add(id));
      const returns = rs.map(([, p]) => p.ret).sort((a, b) => a - b);
      const chainsN = rs.reduce((t, [, p]) => t + p.chains, 0);
      const sufficient = rs.length >= MIN_COMPANIES && chainsN >= MIN_CHAINS;
      const avg = sufficient ? averageReturn(returns) : null;
      const w = rs.reduce((t, [, p]) => t + p.weight, 0);
      const vw = sufficient && w > 0 ? rs.reduce((t, [, p]) => t + p.weight * p.ret, 0) / w : null;
      if (i > 0 && !stopped) {
        if (sufficient) {
          if (index == null) {
            index = 100;
            valueIndex = 100;
          }
          index *= 1 + avg;
          if (vw != null) valueIndex *= 1 + vw;
        } else if (index != null) stopped = true;
      }
      // the start of the series: 100 at the date before its first measured period
      const startsHere = i < dates.length - 1 && index == null && !stopped;
      return {
        date: d,
        label: i === 0 ? 'start' : periodLabel(d, period),
        partial: i > 0 && (!isPeriodEnd(dates[i - 1], period) || !isPeriodEnd(d, period) || d > newestMark),
        companies: rs.length,
        chains: chainsN,
        sufficient,
        index: stopped ? null : index,
        valueIndex: stopped ? null : index == null ? null : valueIndex,
        change: avg,
        median: sufficient ? quantile(returns, 0.5) : null,
        valueChange: vw,
        p25: sufficient ? quantile(returns, 0.25) : null,
        p75: sufficient ? quantile(returns, 0.75) : null,
        unchanged: chainsN ? rs.reduce((t, [, p]) => t + p.unchanged, 0) / chainsN : null,
        up: i === 0 ? null : returns.filter(r => r > 1e-12).length,
        down: i === 0 ? null : returns.filter(r => r < -1e-12).length,
        startsHere,
      };
    });
    // 100 on the date the series starts from (the period before its first value)
    const first = points.findIndex(p => p.index != null);
    if (first > 0) {
      points[first - 1].index = 100;
      points[first - 1].valueIndex = 100;
    }
    for (const p of points) delete p.startsHere;
    return { key: k, label: nameOf(db, k), cohort: measured.size, points };
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
      company:
        "median of its chains' levels, a later chain spliced in at the company's level (a step-up funds report in different quarters counts once)",
      group:
        'chain-linked: each period, the average return of the companies marked at both ends, the lowest and highest 5% capped at the 5th and 95th percentiles; the median and a value-weighted return alongside',
      minimum: `${MIN_COMPANIES} companies and ${MIN_CHAINS} chains in a period; the index starts at the first such period and stops at a later one without`,
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
  companyReturns,
  windowOf,
  continues,
  averageReturn,
  MAX_GAP_DAYS,
  MIN_COMPANIES,
  MIN_CHAINS,
};
