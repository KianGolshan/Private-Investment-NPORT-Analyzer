// Analysis over position facts (P6b W1): the bridge, the pivot, a firm's or
// fund's investment timeline and one fund's position history. Every answer is
// built from activity legs (lib/warehouse/position-facts.js), so its numbers
// are the ones companyActivity and exposureAsOf give (tests hold them equal).
//
// Period rule (DATA-QUALITY display rules): levels are as of each period end
// (the as-of rule, ADR 0004); changes are dated by each fund's own mark date
// and summed over the window: "changes in filings with mark dates in …". A mark
// date is never relabeled to a quarter end.
//
// The bridge from start to end (each reconciles to the cent):
//   start value (as of `from`)
//   + first reported        a fund's first filing with the company (after one without)
//   + added / − reduced     shares added or removed, at the prior mark; a new or
//                           dropped class at its value (the leg's position effect)
//   − no longer reported    the fund filed without the company
//   ± mark moved            the new mark on the shares held; "reported at $0" too
//   ± value only            rows with no share count (an LP interest)
//   + started filing        held at a fund's first stored filing, or after a gap
//                           of more than 123 days
//   − stopped filing        a fund with no filing within 123 days drops out (ADR 0004)
//   = end value (as of `to`)
const { memo } = require('./memo');
const { ServiceError, isIsoDate } = require('./errors');
const { factsOf } = require('../warehouse/position-facts');
const { companyRows, INACTIVE_DAYS } = require('../analytics/asof');
const { TYPES } = require('../analytics/activity');
const { withFundLabels } = require('./company');
const { fundFirms } = require('./firm');
const { newestReportDate } = require('./market');
const scopes = require('./scope');

const DAY = 86400000;
const addDays = (d, n) => new Date(Date.parse(d) + n * DAY).toISOString().slice(0, 10);

const STEPS = [
  ['firstReported', 'first reported'],
  ['added', 'added'],
  ['reduced', 'reduced'],
  ['exited', 'no longer reported'],
  ['mark', 'mark moved'],
  ['valueOnly', 'value only (no share count)'],
  ['started', 'started filing'],
  ['stopped', 'stopped filing'],
];
const FLOW_KEYS = STEPS.map(([k]) => k);
const POSITION_KEYS = ['firstReported', 'added', 'reduced', 'exited'];

// A leg with the dates the as-of rule needs: it counts at D when
// report_date <= D < until; `stops` is the day its fund drops out for want of
// a filing (no filing within 123 days), when that comes before the next one.
function prep(l) {
  const stop = addDays(l.report_date, INACTIVE_DAYS + 1);
  const next = l.next_report_date;
  return { ...l, until: next && next < stop ? next : stop, stops: !next || next >= stop ? stop : null };
}

// Every private company's legs (the table), loaded once per refresh.
function allFacts(db) {
  return memo(db, 'facts:all', () => {
    const list = db.prepare('SELECT * FROM position_facts ORDER BY fund_key, company_id, report_date').all().map(prep);
    const byCompany = new Map();
    for (const l of list) (byCompany.get(l.company_id) || byCompany.set(l.company_id, []).get(l.company_id)).push(l);
    return { list, byCompany };
  });
}

const isPrivate = (db, companyId) =>
  db.prepare('SELECT status FROM companies WHERE id = ?').get(companyId)?.status === 'private';

// The legs an answer reads. ref: { companyId } | { entityId } | null (every
// private company). A private company's legs come from the table; class and
// kind filters, unreviewed names and listed companies' stored rows walk the
// subject's rows (the same walk, so the same legs: a test holds them equal),
// because a class filter changes what a filing "first reported" or "no longer
// reported" within the scope.
function legsFor(db, ref, scope) {
  if (!ref) {
    if (scopes.needsSubject(scope)) throw new ServiceError(400, 'class and kind filters need a company');
    const pred = scopes.legPredicate(db, scope);
    const all = allFacts(db).list;
    return pred ? all.filter(pred) : all;
  }
  if (ref.companyId != null && !scopes.needsSubject(scope) && isPrivate(db, ref.companyId)) {
    const pred = scopes.legPredicate(db, scope);
    const legs = allFacts(db).byCompany.get(ref.companyId) || [];
    return pred ? legs.filter(pred) : legs;
  }
  const only = scopes.rowPredicate(db, scope);
  const rows = companyRows(db, only ? { ...ref, only } : ref, '9999-12-31');
  return factsOf(db, rows, () => ref.companyId ?? ref.entityId).map(prep);
}

// Index of the first end >= d (ends ascending).
function firstAtOrAfter(ends, d) {
  let lo = 0;
  let hi = ends.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ends[mid] < d) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Where a leg's change goes in the bridge: [step, amount] pairs.
function stepsOf(l) {
  if (l.event === 'firstFiling' || l.event === 'resumed') return [['started', l.value - l.prev_value]];
  const pos =
    l.event === 'new'
      ? 'firstReported'
      : l.event === 'exited'
        ? 'exited'
        : l.position_effect >= 0
          ? 'added'
          : 'reduced';
  return [
    [pos, l.position_effect],
    ['mark', l.mark_effect],
    ['valueOnly', l.other_effect],
  ];
}

const emptyCell = () => ({ value: 0, holders: new Set(), ...Object.fromEntries(FLOW_KEYS.map(k => [k, 0])) });

// Levels at each end and flows in each period (ends[i-1], ends[i]], per row
// key. keysOf(leg) -> row keys (a co-advised fund counts for each firm).
// onFlow(key, i, leg, step, amount) is called for every flow (event counts).
function accumulate(legs, ends, keysOf, onFlow) {
  const rows = new Map();
  const cellsOf = key => rows.get(key) || rows.set(key, ends.map(emptyCell)).get(key);
  for (const l of legs) {
    const keys = keysOf(l);
    if (!keys.length) continue;
    // Levels: every end the leg is in force at.
    for (let j = firstAtOrAfter(ends, l.report_date); j < ends.length && ends[j] < l.until; j++)
      for (const k of keys) {
        const c = cellsOf(k)[j];
        c.value += l.value;
        if (l.value > 0) c.holders.add(l.fund_key);
      }
    // Flows: the period holding the leg's mark date.
    const i = firstAtOrAfter(ends, l.report_date);
    if (i >= 1 && i < ends.length && l.report_date > ends[0])
      for (const [step, amount] of stepsOf(l))
        if (amount)
          for (const k of keys) {
            cellsOf(k)[i][step] += amount;
            onFlow?.(k, i, l, step, amount);
          }
    // The fund dropped out (no filing within 123 days) inside a period.
    if (l.stops && l.value) {
      const s = firstAtOrAfter(ends, l.stops);
      if (s >= 1 && s < ends.length && l.stops > ends[0])
        for (const k of keys) {
          cellsOf(k)[s].stopped -= l.value;
          onFlow?.(k, s, l, 'stopped', -l.value);
        }
    }
  }
  return rows;
}

const checkDate = (name, d) => {
  if (!isIsoDate(d)) throw new ServiceError(400, `${name} must be an ISO date (YYYY-MM-DD)`);
  return d;
};

// The bridge from `from` to `to` for a company (ref) or every private company,
// in a scope. Reconciles: start + steps = end (to the cent; `residual`).
function bridge(db, { ref = null, scope = null, from, to } = {}) {
  const end = checkDate('to', to || newestReportDate(db));
  const start = checkDate('from', from || addDays(end, -365));
  if (start >= end) throw new ServiceError(400, 'from must be before to');
  const legs = legsFor(db, ref, scope);
  const events = new Map(STEPS.map(([k]) => [k, new Set()]));
  const cells = accumulate(
    legs,
    [start, end],
    () => ['all'],
    (k, i, l, step) => events.get(step).add(step === 'stopped' ? l.fund_key : `${l.fund_key}|${l.accession}`)
  ).get('all') || [emptyCell(), emptyCell()];
  const [s, e] = cells;
  const steps = STEPS.map(([key, label]) => ({ key, label, value: e[key], events: events.get(key).size }));
  const sum = steps.reduce((t, x) => t + x.value, 0);
  const residual = e.value - s.value - sum;
  return {
    from: start,
    to: end,
    scope: scopes.describe(scope),
    label: `changes in filings with mark dates from ${addDays(start, 1)} to ${end}`,
    start: { value: s.value, funds: s.holders.size },
    end: { value: e.value, funds: e.holders.size },
    steps,
    positionEffect: POSITION_KEYS.reduce((t, k) => t + e[k], 0),
    markEffect: e.mark,
    residual,
    reconciled: Math.abs(residual) < 0.005,
  };
}

// Period ends (calendar month, quarter or year ends) strictly between from and to.
const PERIODS = { month: 1, quarter: 3, year: 12 };
function periodEnds(from, to, period) {
  const step = PERIODS[period];
  const out = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  m = Math.ceil(m / step) * step; // the period end at or after from's month
  for (;;) {
    const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    if (end >= to) break;
    if (end > from) out.push(end);
    m += step;
    while (m > 12) {
      m -= 12;
      y++;
    }
  }
  return out;
}
const isPeriodEnd = (d, period) => addDays(d, 1).slice(8) === '01' && Number(d.slice(5, 7)) % PERIODS[period] === 0;
const periodLabel = (d, period) =>
  period === 'year'
    ? d.slice(0, 4)
    : period === 'quarter'
      ? `${d.slice(0, 4)}Q${Math.ceil(Number(d.slice(5, 7)) / 3)}`
      : d.slice(0, 7);

const PIVOT_ROWS = ['firm', 'fund', 'company', 'class'];
const METRICS = ['value', 'holders', ...FLOW_KEYS, 'positionEffect', 'markEffect'];

// Rows (firm, fund, company or class) × periods (month, quarter or year,
// keyed by mark date): value and holders as of each period end, and the
// bridge's flows in each period. Firm rows count a co-advised fund for each
// of its firms; the total row counts every fund once.
function pivot(db, { ref = null, scope = null, rows = 'firm', period = 'quarter', from, to, limit = 50 } = {}) {
  if (!PIVOT_ROWS.includes(rows)) throw new ServiceError(400, `rows must be one of ${PIVOT_ROWS.join(', ')}`);
  if (!PERIODS[period]) throw new ServiceError(400, 'period must be month, quarter or year');
  const end = checkDate('to', to || newestReportDate(db));
  const start = checkDate('from', from || addDays(end, -730));
  if (start >= end) throw new ServiceError(400, 'from must be before to');
  const ends = [start, ...periodEnds(start, end, period), end];
  if (ends.length > 121) throw new ServiceError(400, 'at most 120 periods per pivot');
  const legs = legsFor(db, ref, scope);
  const { byFund } = fundFirms(db);
  const firmsOf = k => (byFund.get(k) || []).filter(x => x.role !== 'subadviser').map(x => x.managerId);
  const keyOf = {
    firm: l => {
      const f = firmsOf(l.fund_key);
      return f.length ? f : [0];
    },
    fund: l => [l.fund_key],
    company: l => [l.company_id],
    class: l => [`${l.company_id}\u0000${l.class_label}`],
  }[rows];
  const cells = accumulate(legs, ends, keyOf);
  const total = accumulate(legs, ends, () => ['all']).get('all') || ends.map(emptyCell);
  const out = cellsOut =>
    Object.fromEntries(
      METRICS.map(m => [
        m,
        cellsOut
          .slice(1)
          .map(c =>
            m === 'holders'
              ? c.holders.size
              : m === 'positionEffect'
                ? POSITION_KEYS.reduce((t, k) => t + c[k], 0)
                : m === 'markEffect'
                  ? c.mark
                  : c[m]
          ),
      ])
    );
  const labels = rowLabels(db, rows, [...cells.keys()]);
  const list = [...cells]
    .map(([key, c]) => ({
      key: rows === 'class' ? key.replace('\u0000', ':') : key,
      label: labels.get(key),
      startValue: c[0].value,
      ...out(c),
    }))
    .sort((a, b) => b.value[b.value.length - 1] - a.value[a.value.length - 1] || b.startValue - a.startValue);
  return {
    rows,
    period,
    from: start,
    to: end,
    scope: scopes.describe(scope),
    label: 'levels as of each period end; changes in filings with mark dates in each period',
    periods: ends.slice(1).map((d, i) => ({
      label: periodLabel(d, period),
      from: ends[i],
      to: d,
      // A window that starts or ends inside a calendar period covers part of it.
      partial: !isPeriodEnd(ends[i], period) || !isPeriodEnd(d, period),
    })),
    metrics: METRICS,
    count: list.length,
    results: list.slice(0, limit),
    total: { startValue: total[0].value, ...out(total) },
  };
}

function rowLabels(db, rows, keys) {
  const out = new Map();
  if (rows === 'firm') {
    const name = db.prepare('SELECT name FROM managers WHERE id = ?');
    for (const k of keys) out.set(k, k === 0 ? 'No firm on file' : name.get(k)?.name);
  } else if (rows === 'fund') {
    for (const f of fundLabels(db, keys)) out.set(f.fundKey, f.label);
  } else {
    const name = db.prepare('SELECT name FROM companies WHERE id = ?');
    for (const k of keys) {
      const [id, cls] = String(k).split('\u0000');
      const n = name.get(Number(id))?.name;
      out.set(k, rows === 'class' ? `${n} · ${cls}` : n);
    }
  }
  return out;
}

function fundLabels(db, fundKeys) {
  const get = db.prepare('SELECT fund_key, cik, registrant, series_name FROM fund_names WHERE fund_key = ?');
  return withFundLabels(
    fundKeys.map(k => {
      const f = get.get(k);
      return { fundKey: k, cik: f?.cik, registrant: f?.registrant, seriesName: f?.series_name };
    })
  );
}

// A firm's or fund's investment timeline: per company, the spans its funds
// held it (any fund in force with value), its value as of the newest report
// date, and its events by mark date (first reported, added, reduced, no longer
// reported, reported at $0, started filing), summed across the funds that
// filed that day.
function timeline(db, { firm, fund } = {}) {
  if ((firm == null) === (fund == null)) throw new ServiceError(400, 'pass firm or fund');
  const scope =
    firm != null ? { firm: [firm], fund: [], class: [], kind: [] } : { firm: [], fund: [fund], class: [], kind: [] };
  const legs = legsFor(db, null, scope);
  const asOf = newestReportDate(db);
  const byCompany = new Map();
  for (const l of legs) (byCompany.get(l.company_id) || byCompany.set(l.company_id, []).get(l.company_id)).push(l);
  const names = db.prepare('SELECT name FROM companies WHERE id = ?');
  const companies = [];
  for (const [companyId, ls] of byCompany) {
    const spans = ls
      .filter(l => l.value > 0)
      .map(l => [l.report_date, l.until])
      .sort((a, b) => a[0].localeCompare(b[0]));
    if (!spans.length) continue;
    const merged = [];
    for (const [a, b] of spans) {
      const last = merged[merged.length - 1];
      if (last && a <= last[1]) last[1] = b > last[1] ? b : last[1];
      else merged.push([a, b]);
    }
    const events = new Map();
    for (const l of ls) {
      if (l.event === 'unchanged') continue;
      const k = `${l.report_date}\u0000${l.event}`;
      const e =
        events.get(k) ||
        events
          .set(k, {
            markDate: l.report_date,
            type: l.event,
            label: TYPES[l.event],
            funds: new Set(),
            valueChange: 0,
            positionEffect: 0,
            markEffect: 0,
          })
          .get(k);
      e.funds.add(l.fund_key);
      e.valueChange += l.value - l.prev_value;
      e.positionEffect += l.position_effect;
      e.markEffect += l.mark_effect;
    }
    const now = ls.filter(l => l.report_date <= asOf && asOf < l.until);
    companies.push({
      companyId,
      name: names.get(companyId)?.name,
      firstHeld: merged[0][0],
      lastHeld: merged[merged.length - 1][1] > asOf ? null : merged[merged.length - 1][1],
      spans: merged.map(([a, b]) => ({ from: a, until: b > asOf ? null : b })),
      value: now.reduce((t, l) => t + l.value, 0),
      funds: new Set(now.filter(l => l.value > 0).map(l => l.fund_key)).size,
      positionEffect: ls.reduce((t, l) => t + l.position_effect, 0),
      markEffect: ls.reduce((t, l) => t + l.mark_effect, 0),
      events: [...events.values()]
        .map(e => ({ ...e, funds: e.funds.size }))
        .sort((a, b) => a.markDate.localeCompare(b.markDate) || a.type.localeCompare(b.type)),
    });
  }
  companies.sort((a, b) => a.firstHeld.localeCompare(b.firstHeld) || b.value - a.value);
  return {
    ...(firm != null ? { firm } : { fund }),
    asOf,
    attribution: 'current adviser (latest N-CEN)',
    companies,
  };
}

const legOut = l => ({
  markDate: l.report_date,
  accession: l.accession,
  filingDate: l.filing_date,
  prevMarkDate: l.prev_report_date,
  prevAccession: l.prev_accession,
  nextMarkDate: l.next_report_date,
  event: l.event,
  label: TYPES[l.event],
  change: l.change,
  instrumentKey: l.instrument_key,
  rekeyedFrom: l.rekeyed_from,
  mergedKeys: l.merged_keys ? l.merged_keys.split(',') : null,
  classLabel: l.class_label,
  instrument: l.instrument_label,
  kind: l.kind,
  unit: l.unit,
  title: l.title,
  balance: l.balance,
  prevBalance: l.prev_balance,
  price: l.price,
  prevPrice: l.prev_price,
  perShare: !!l.per_share,
  value: l.value,
  prevValue: l.prev_value,
  split: l.split,
  positionEffect: l.position_effect,
  markEffect: l.mark_effect,
  otherEffect: l.other_effect,
  pctNav: l.pct_nav,
});

// One fund's position in a company across its whole history: every leg at
// every filing (shares, mark, value, the change and its effects).
function positionHistory(db, ref, fundKey, { instrumentKey, scope } = {}) {
  const key = String(fundKey || '').toUpperCase();
  const legs = legsFor(db, ref, scope)
    .filter(l => l.fund_key === key && (!instrumentKey || l.instrument_key === instrumentKey))
    .sort((a, b) => a.report_date.localeCompare(b.report_date) || a.instrument_key.localeCompare(b.instrument_key));
  if (!legs.length) throw new ServiceError(404, `fund ${key} has no position in this company`);
  const [f] = fundLabels(db, [key]);
  return { fund: f, legs: legs.map(legOut) };
}

// Each fund's legs in force as of D (the as-of rule): its latest filing's
// change against the filing before (shares, mark, position and mark effects),
// for the holders table. Value sums equal exposureAsOf (the facts' rule).
function legsAt(db, ref, { scope, date } = {}) {
  const d = checkDate('date', date || newestReportDate(db));
  const legs = legsFor(db, ref, scope).filter(l => l.report_date <= d && d < l.until);
  return { date: d, legs: legs.map(l => ({ fundKey: l.fund_key, ...legOut(l) })) };
}

// Per-share marks by (company, class, mark date) across every fund, from the
// facts: share rows held (value > 0) as filed at that date (LESSONS 39: funds
// compared at the same mark date only). Built once per refresh.
function marksByDate(db) {
  return memo(db, 'facts:marksByDate', () => {
    const m = new Map();
    for (const l of allFacts(db).list) {
      if (!(l.value > 0 && l.per_share && l.price > 0)) continue;
      const k = `${l.company_id}\u0000${l.class_label}\u0000${l.report_date}`;
      (m.get(k) || m.set(k, []).get(k)).push({ fundKey: l.fund_key, price: l.price });
    }
    return m;
  });
}
const medianOf = xs => {
  const s = [...xs].sort((a, b) => a - b);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
};

// A firm's (or one fund's) marks against everyone else's (P6b W3): for each
// company and class it holds as of D, its funds' median per-share mark at their
// mark date beside the median of every other fund that filed the same class at
// the same mark date. "Above" and "below" are as filed, within 0.5%; no method
// guessed. A date no other fund filed shows no comparison.
const SAME = 0.005;
function marksVsOthers(db, { firm, fund, date } = {}) {
  if ((firm == null) === (fund == null)) throw new ServiceError(400, 'pass firm or fund');
  const d = checkDate('date', date || newestReportDate(db));
  const scope = { firm: firm != null ? [firm] : [], fund: fund != null ? [fund] : [], class: [], kind: [] };
  const mine = scopes.fundsInScope(db, scope);
  const byDate = marksByDate(db);
  const groups = new Map();
  for (const l of legsFor(db, null, scope)) {
    if (!(l.report_date <= d && d < l.until && l.value > 0 && l.per_share && l.price > 0)) continue;
    const k = `${l.company_id}\u0000${l.class_label}\u0000${l.report_date}`;
    const g =
      groups.get(k) ||
      groups
        .set(k, {
          companyId: l.company_id,
          classLabel: l.class_label,
          markDate: l.report_date,
          prices: [],
          funds: new Set(),
          value: 0,
        })
        .get(k);
    g.prices.push(l.price);
    g.funds.add(l.fund_key);
    g.value += l.value;
  }
  const names = db.prepare('SELECT name FROM companies WHERE id = ?');
  const { byFund } = fundFirms(db);
  const rows = [...groups.entries()].map(([k, g]) => {
    const others = (byDate.get(k) || []).filter(x => !mine.has(x.fundKey));
    const firmIds = new Set(
      others.flatMap(x => (byFund.get(x.fundKey) || []).filter(f => f.role !== 'subadviser').map(f => f.managerId))
    );
    const mark = medianOf(g.prices);
    const othersMedian = others.length ? medianOf(others.map(x => x.price)) : null;
    const diffPct = othersMedian ? (mark / othersMedian - 1) * 100 : null;
    return {
      companyId: g.companyId,
      company: names.get(g.companyId)?.name,
      classLabel: g.classLabel,
      markDate: g.markDate,
      mark,
      funds: g.funds.size,
      value: g.value,
      othersMedian,
      othersLow: others.length ? Math.min(...others.map(x => x.price)) : null,
      othersHigh: others.length ? Math.max(...others.map(x => x.price)) : null,
      otherFunds: new Set(others.map(x => x.fundKey)).size,
      otherFirms: firmIds.size,
      diffPct,
      position:
        diffPct == null
          ? 'no other fund that date'
          : Math.abs(diffPct) <= SAME * 100
            ? 'same'
            : diffPct > 0
              ? 'above'
              : 'below',
    };
  });
  rows.sort((a, b) => b.value - a.value);
  const compared = rows.filter(r => r.diffPct != null);
  const sum = pos => compared.filter(r => r.position === pos).reduce((t, r) => t + r.value, 0);
  return {
    ...(firm != null ? { firm } : { fund }),
    date: d,
    tolerancePct: SAME * 100,
    summary: {
      positions: rows.length,
      compared: compared.length,
      above: compared.filter(r => r.position === 'above').length,
      same: compared.filter(r => r.position === 'same').length,
      below: compared.filter(r => r.position === 'below').length,
      valueAbove: sum('above'),
      valueSame: sum('same'),
      valueBelow: sum('below'),
    },
    rows,
  };
}

module.exports = {
  marksVsOthers,
  marksByDate,
  legsAt,
  bridge,
  pivot,
  timeline,
  positionHistory,
  legsFor,
  allFacts,
  periodEnds,
  STEPS,
  PIVOT_ROWS,
};
