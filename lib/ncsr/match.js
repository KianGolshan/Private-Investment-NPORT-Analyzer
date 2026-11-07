// Joins an N-CSR fund's restricted (cost) rows to the same fund's N-PORT holdings
// at the same date. N-CSR and N-PORT usually print the same shares and values
// (Fidelity Growth Company Fund, Growth Fund of America; ncsr-research.md), so a row
// is joined by its numbers, never by its name (LESSONS 15, 33). Names only pair a
// cost row with its schedule row inside the N-CSR itself.
//
// Each result says how it was found:
//   exact      one N-PORT row with the same shares and value
//   legs       N-PORT rows of one issuer that add up to the shares and value (custody legs
//              that the N-CSR prints as one line: Stripe Class B PHYSICAL + DRS; Tubulis
//              rights = 11 CVR lines)
//   combined   2-3 N-CSR rows that add up to one N-PORT row (a holding vehicle that N-PORT
//              files under its own name: Fidelity's GROWTHCO TB HOLDINGS LLC = Tory Burch
//              Class A + Class B)
//   value      one N-PORT row with the same shares but another value (the two filings
//              value it differently at the same date; listed with both values, not joined)
//   ambiguous  more than one N-PORT row fits, or the cost row shares its name with another
//              (paired with a schedule row by order, which the filing does not prove)
//   debt       a note or bond (coupon in the name): the warehouse keeps equity-type rows only
//   none       no N-PORT row fits (reported, never guessed)
const JOINED = new Set(['exact', 'legs', 'combined']);

// How far an N-CSR value may be from N-PORT's. Fidelity prints whole dollars (N-PORT
// has cents). Capital Group prints thousands that can sit up to $999 from N-PORT's value
// (SMALLCAP World 2026-03-31: PsiQuantum Series E 49,993 vs $49,992,421; Yotpo Series C
// 338 vs $338,555), so a thousands value may be a full unit away.
const tolerance = unit => (unit === 1 ? 1.5 : unit + 1);

// A note or bond as both families print it: a coupon at the end of the name, with or
// without a maturity ("Neutron Holdings Inc 4% 5/22/2027", "Enevate Corp 6%",
// "Evozyne Inc 6% 9/13/2028 pay-in-kind"), or the words notes / bonds ("PayClip, Inc.,
// convertible notes, 4.50% Cash 12/15/2028"). A preferred share with a dividend rate
// ("Stripe, LLC, Series I, 6.00% noncumulative preferred shares") is not debt.
const isDebtName = name =>
  !/preferred|shares\b/i.test(name) &&
  (/\b\d+(?:\.\d+)?%(?:\s+\d{1,2}\/\d{1,2}\/\d{4})?(?:\s+pay-in-kind)?$/i.test(name) ||
    /\b(?:notes?|bonds?|debentures?)\b/i.test(name));

// Pair each cost row with the schedule row it describes. Only rows carrying the
// filing's restricted mark are candidates. A name printed once pairs by name (and by
// value when the cost table has one, Capital Group); a name printed several times pairs
// by order and is flagged.
function pairWithSchedule(fund) {
  const mark = fund.restrictedTotal && fund.restrictedTotal.mark;
  const pool = fund.schedule.filter(r => !mark || r.marks.includes(mark));
  const byName = new Map();
  for (const r of pool) {
    if (!byName.has(r.name)) byName.set(r.name, []);
    byName.get(r.name).push(r);
  }
  const taken = new Map();
  const tol = tolerance(fund.unit);
  // a cost-table name may keep its footnote numbers ("Skyryse, Inc., Series B, preferred shares
  // 1,2,4", Capital Group 2024): tried without them only when the name as printed has no row
  const keyOf = name => {
    if (byName.has(name)) return name;
    const bare = name.replace(/\s+\d{1,2}(?:,\d{1,2})*$/, '');
    return bare !== name && byName.has(bare) ? bare : name;
  };
  return fund.restricted.map(c => {
    if (c.inline) return { ...c, pairedByOrder: false, scheduleFound: true }; // T. Rowe Price, Morgan Stanley
    const key = keyOf(c.name);
    const same = byName.get(key) || [];
    const fits =
      c.value === null ? same : same.filter(r => Math.abs(r.value - c.value) <= (c.belowUnit ? fund.unit : tol));
    const k = taken.get(key) || 0;
    const unique = fits.length === 1 && same.length === 1;
    const s = unique ? fits[0] : c.value === null ? same[k] : fits.length === 1 ? fits[0] : null;
    taken.set(key, k + 1);
    return {
      ...c,
      shares: s ? s.shares : null,
      value: c.value === null ? (s ? s.value : null) : c.value,
      pairedByOrder: !!s && !unique && c.value === null,
      scheduleFound: !!s,
    };
  });
}

const sum = (rows, f) => rows.reduce((s, r) => s + f(r), 0);

// Subsets of 2 or more rows for which `ok` holds: every subset when there are at most
// 14 rows (Tubulis rights: one N-CSR line for 11 N-PORT CVR lines), else pairs and triples.
function combos(rows, ok) {
  const out = [];
  if (rows.length <= 14) {
    for (let mask = 1; mask < 1 << rows.length; mask++) {
      if ((mask & (mask - 1)) === 0) continue; // a single row
      const pick = rows.filter((_, i) => mask & (1 << i));
      if (ok(pick)) out.push(pick);
    }
    return out;
  }
  const n = Math.min(rows.length, 24);
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++) {
      if (ok([rows[a], rows[b]])) out.push([rows[a], rows[b]]);
      for (let c = b + 1; c < n; c++) if (ok([rows[a], rows[b], rows[c]])) out.push([rows[a], rows[b], rows[c]]);
    }
  return out;
}

const sameShares = (a, b) => Math.abs(a - b) < 1;

// holdings: the N-PORT rows of one filing ({ row_key, issuer_name, title, balance, value_usd,
// company_id, company_name, category, status }). Returns one result per cost row, in order.
function matchToNport(fund, holdings) {
  const tol = tolerance(fund.unit);
  const rowTol = r => (r.belowUnit ? fund.unit : tol);
  const used = new Set();
  const results = pairWithSchedule(fund).map(c => ({ ...c, match: 'none', nport: [] }));
  const open = () => results.filter(r => r.match === 'none' && r.shares !== null && r.value !== null);
  const free = () => holdings.filter(h => !used.has(h.row_key));
  const take = (r, match, rows) => {
    r.match = r.pairedByOrder ? 'ambiguous' : match;
    r.nport = rows;
    for (const h of rows) used.add(h.row_key);
  };

  // pass 1: one row with the same shares and value
  for (const r of open()) {
    const cands = free().filter(h => sameShares(h.balance, r.shares) && Math.abs(h.value_usd - r.value) <= rowTol(r));
    if (cands.length === 1) take(r, 'exact', cands);
    else if (cands.length > 1) Object.assign(r, { match: 'ambiguous', nport: cands });
  }
  // pass 2: custody legs of one issuer that add up
  for (const r of open()) {
    const groups = new Map();
    for (const h of free()) {
      const key = h.company_id ? `c${h.company_id}` : `n${h.issuer_name}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(h);
    }
    const found = [...groups.values()].flatMap(g =>
      combos(
        g,
        rows =>
          sameShares(
            sum(rows, h => h.balance),
            r.shares
          ) && Math.abs(sum(rows, h => h.value_usd) - r.value) <= rowTol(r)
      )
    );
    if (found.length === 1) take(r, 'legs', found[0]);
    else if (found.length > 1) Object.assign(r, { match: 'ambiguous', nport: found.flat() });
  }
  // pass 3: several N-CSR rows that add up to one N-PORT row (a holding vehicle)
  for (const h of free()) {
    const pool = open().filter(r => !r.pairedByOrder);
    const found = combos(
      pool,
      rows =>
        sameShares(
          sum(rows, r => r.shares),
          h.balance
        ) && Math.abs(sum(rows, r => r.value) - h.value_usd) <= tol * rows.length
    );
    if (found.length !== 1) continue;
    for (const r of found[0]) take(r, 'combined', [h]);
  }
  // pass 4: same shares, another value (listed, not joined)
  for (const r of open()) {
    if (r.shares <= 0) continue;
    const cands = free().filter(h => sameShares(h.balance, r.shares));
    if (cands.length === 1) Object.assign(r, { match: 'value', nport: cands });
  }
  for (const r of results) if (r.match === 'none' && isDebtName(r.name)) r.match = 'debt';

  return results.map(r => {
    const joined = JOINED.has(r.match);
    const h = joined || r.match === 'value' ? r.nport[0] : null;
    const singleDate = r.acquiredFirst === r.acquiredLast;
    return {
      ...r,
      companyId: joined && h ? h.company_id : null,
      companyName: joined && h ? h.company_name : null,
      category: joined && h ? h.category : null,
      status: joined && h ? h.status : null,
      nportValue: r.nport.length ? (r.match === 'combined' ? h.value_usd : sum(r.nport, x => x.value_usd)) : null,
      // an entry price only where the filing gives one lot (one date); cost and shares are both the N-CSR's
      costPerShare: r.scheduleFound && !r.pairedByOrder && singleDate && r.shares > 0 ? r.cost / r.shares : null,
      valueToCost: r.scheduleFound && !r.pairedByOrder && r.cost > 0 ? r.value / r.cost : null,
    };
  });
}

// Checks the parse against the filing's own totals, so a dropped or misread row fails the pilot.
function rawChecks(fund) {
  const t = fund.restrictedTotal;
  const mark = t && t.mark;
  const marked = mark ? fund.schedule.filter(r => r.marks.includes(mark)) : [];
  const checks = [];
  if (!t) {
    checks.push({ check: 'restricted total stated', ok: !fund.restricted.length, detail: 'no total in the filing' });
    return checks;
  }
  // each printed amount is rounded to its unit, so a sum may drift by half a unit per row
  // (Fidelity Advisor New Insights 2025-12-31: 66 rows add to $4 below the stated total)
  const drift = n => (Math.max(1, n) * fund.unit) / 2;
  if (mark) {
    const markedValue = sum(marked, r => r.value);
    const valueOk = t.value === null || Math.abs(markedValue - t.value) <= drift(marked.length);
    const countOk = marked.length === fund.restricted.length;
    checks.push({
      check: 'restricted rows in schedule = rows in cost table',
      ok: countOk,
      // the value still adds up to the stated total: the filer printed one cost line for two schedule
      // lines (Fidelity Growth Company funds 2022-2025: "DNA Script" twice in the schedule, once in the
      // cost table). Reported, not a failure of the parse.
      // With no stated total (Morgan Stanley), a restricted row printed without a cost (Infleqtion,
      // SomaLogic warrants in Inception Portfolio 2026-06-30) is reported the same way.
      severity: !countOk && valueOk ? 'note' : 'check',
      detail: `${marked.length} marked (${mark}) vs ${fund.restricted.length} cost rows`,
    });
    if (t.value !== null)
      checks.push({
        check: 'marked schedule value = stated restricted total',
        ok: valueOk,
        detail: `${markedValue} vs ${t.value}`,
      });
  }
  if (fund.restricted.every(r => r.value !== null)) {
    // a table with values (Capital Group): every cost row has its schedule row, and the
    // values add up to the Total row (the only check when no mark is printed: 2021)
    const missing = pairWithSchedule(fund).filter(r => !r.scheduleFound);
    checks.push({
      check: 'every cost row has a schedule row with its name and value',
      ok: missing.length === 0,
      detail: missing.length ? missing.map(r => r.rawName).join('; ') : `${fund.restricted.length} found`,
    });
    const value = sum(fund.restricted, r => r.value);
    if (t.value !== null)
      checks.push({
        check: 'cost-table values add up to the stated total',
        ok: Math.abs(value - t.value) <= drift(fund.restricted.length),
        detail: `${value} vs ${t.value}`,
      });
  }
  if (t.cost !== undefined) {
    const cost = sum(fund.restricted, r => r.cost);
    checks.push({
      check: 'cost rows add up to the Total row',
      ok: Math.abs(cost - t.cost) <= drift(fund.restricted.length),
      detail: `${cost} vs ${t.cost}`,
    });
  }
  return checks;
}

// The number-level admission rule (ADR 0011): only a line that validates completely may
// carry a cost into the app; any doubt, it is refused. Returns the first failed check, or
// null. r: a result of matchToNport; fundOk: the fund report passed every self-check
// outright (a "note" refuses the whole report) and maps to one series and its canonical
// N-PORT. The company-level checks (a reviewed company, a share row) run at every rebuild.
const NOMINAL_PER_SHARE = 0.01; // dollars a share
const ADMIT_VALUE = unit => (unit === 1 ? 1 : 500); // the printed unit's rounding, nothing more
function refusal(r, { fundOk, unit, setApart: apart }) {
  if (!fundOk) return 'fund report';
  if (apart && apart.has(r.name)) return 'set apart';
  if (r.match !== 'exact' && r.match !== 'legs') return r.match;
  if (r.pairedByOrder) return 'paired by order';
  if (!r.scheduleFound) return 'no schedule row';
  if (r.belowUnit) return 'below the printed unit';
  if (!(r.cost > 0)) return 'no cost';
  if (!(r.shares > 0)) return 'no shares';
  // a nominal cost: warrants or rights received with a round, allocated $1 or $2 for millions of
  // shares (Farmers Business Network warrants: $1 for 993,920; ASAPP: $2 for 2,365,967). Not a
  // price paid; its value over cost (millions of times) would mislead.
  if (r.cost / r.shares < NOMINAL_PER_SHARE) return 'nominal cost';
  const shares = sum(r.nport, h => h.balance);
  const value = sum(r.nport, h => h.value_usd);
  if (Math.abs(shares - r.shares) > 1e-6) return 'shares differ';
  if (Math.abs(value - r.value) > ADMIT_VALUE(unit)) return 'value differs';
  return null;
}

// Lines set apart (ADR 0011, amended 2026-11-06). A Fidelity fund report whose checks fail
// only because of named lines still proves every other line against the filing's own totals:
//   - a name printed a different number of times in the schedule (marked) and in the cost
//     table ("DNA Script" twice in the schedule, once in the cost table, Growth Company
//     2022-2025): that name's lines are set apart; the marked total still includes its rows;
//   - the marked rows exceed the stated restricted total by exactly the value of one row or
//     two rows, and by no other row or pair (Chobani and Trade Republic, bought in Oct and Dec
//     2025, marked restricted but outside the stated total, Blue Chip Growth 2026-01-31): those
//     rows' lines are set apart.
// At most SET_APART_MAX names. The rest of the report must then pass every check outright,
// with the set-apart rows taken out of the schedule, the cost table and the stated total.
// Anything else (a shortfall: a restricted row not read; two pairings that both fit; more
// names) fails the report as before. A set-apart line is never admitted.
const SET_APART_MAX = 3;
function setApart(fund) {
  const t = fund.restrictedTotal;
  const mark = t && t.mark;
  if (!mark || t.value === null || fund.restricted.some(r => r.inline || r.value != null)) return null;
  const marked = fund.schedule.filter(r => r.marks.includes(mark));
  const count = new Map();
  for (const r of marked) count.set(r.name, (count.get(r.name) || 0) + 1);
  for (const r of fund.restricted) count.set(r.name, (count.get(r.name) || 0) - 1);
  const names = new Map();
  for (const [name, n] of count)
    if (n !== 0) names.set(name, 'printed a different number of times in the schedule and the cost table');
  const drift = n => (Math.max(1, n) * fund.unit) / 2;
  const gap = sum(marked, r => r.value) - t.value;
  let outside = [];
  if (Math.abs(gap) > drift(marked.length)) {
    if (gap < 0) return null; // the stated total holds a restricted row not read
    const pool = marked.filter(r => !names.has(r.name));
    const fits = [];
    for (let i = 0; i < pool.length; i++) {
      if (Math.abs(pool[i].value - gap) <= drift(marked.length)) fits.push([pool[i]]);
      for (let j = i + 1; j < pool.length; j++)
        if (Math.abs(pool[i].value + pool[j].value - gap) <= drift(marked.length)) fits.push([pool[i], pool[j]]);
    }
    if (fits.length !== 1) return null;
    outside = fits[0];
    for (const r of outside) {
      // a name printed twice: setting one row apart cannot say which cost line is its own
      if ((count.get(r.name) || 0) !== 0 || marked.filter(x => x.name === r.name).length !== 1) return null;
      names.set(r.name, 'marked restricted but outside the stated restricted total');
    }
  }
  if (!names.size || names.size > SET_APART_MAX) return null;
  const inTotal = marked.filter(r => names.has(r.name) && !outside.includes(r));
  const reduced = {
    ...fund,
    schedule: fund.schedule.filter(r => !names.has(r.name)),
    restricted: fund.restricted.filter(r => !names.has(r.name)),
    restrictedTotal: {
      ...t,
      value: t.value - sum(inTotal, r => r.value),
      ...(t.cost !== undefined
        ? {
            cost:
              t.cost -
              sum(
                fund.restricted.filter(r => names.has(r.name)),
                r => r.cost
              ),
          }
        : {}),
    },
  };
  if (!reduced.restricted.length) return null;
  const checks = rawChecks(reduced);
  if (!allChecksPassed(checks)) return null;
  return { names, checks };
}

function selfChecks(fund) {
  const checks = rawChecks(fund);
  if (allChecksPassed(checks)) return checks;
  const apart = setApart(fund);
  if (!apart) return checks;
  const out = [
    ...apart.checks,
    {
      check: 'lines set apart (not admitted)',
      ok: true,
      severity: 'set apart',
      detail: [...apart.names].map(([n, why]) => `${n}: ${why}`).join('; '),
      before: checks.filter(c => !c.ok).map(c => `${c.check}: ${c.detail}`),
    },
  ];
  // not serialized: which lines refusal() sets apart
  Object.defineProperty(out, 'setApart', { value: apart.names, enumerable: false });
  return out;
}

function allChecksPassed(checks) {
  return checks.length > 0 && checks.every(c => c.ok);
}

module.exports = {
  matchToNport,
  pairWithSchedule,
  selfChecks,
  setApart,
  SET_APART_MAX,
  tolerance,
  isDebtName,
  refusal,
  allChecksPassed,
  ADMIT_VALUE,
  NOMINAL_PER_SHARE,
  JOINED,
};
