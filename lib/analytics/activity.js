// Position changes between a fund's consecutive canonical filings: what each
// N-PORT says changed since the same fund's previous one. Funds report on
// staggered calendars, so every change is dated by the fund's own mark date and
// cites both filings. Words follow the filings, never a guessed cause
// (DATA-QUALITY Display rules): a position "first reported", "added",
// "reduced", "no longer reported" or "reported at $0" — not bought or sold.
//
// Per instrument (instrumentKey), shares are compared after split detection
// (public/splits.js), so a 3:1 split is not an add (F13). A row with no share
// count (an LP interest, trap 43) can only say its value changed.
const { detectSplit } = require('../../public/splits');
const { companyRows, privateRowsOf, rowInfo, INACTIVE_DAYS } = require('./asof');
const { classOfRow } = require('../services/classes');

// Share changes under this fraction are rounding, not trades.
const SHARE_TOLERANCE = 0.005;
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

const TYPES = {
  new: 'first reported',
  added: 'added',
  reduced: 'reduced',
  mixed: 'added and reduced across classes',
  unchanged: 'unchanged',
  exited: 'no longer reported',
  zeroed: 'reported at $0',
  firstFiling: 'held at the fund’s first stored filing',
  resumed: 'reported after a gap of more than 123 days',
};

// One fund's position in one company at one filing: its rows (counting and $0).
// prev/cur: arrays of stored rows (with `counts`), or null when the fund filed
// without the company.
function diffPosition(prev, cur) {
  const p = byKey((prev || []).filter(r => r.counts));
  const c = byKey((cur || []).filter(r => r.counts));
  if (!p.size && c.size) return { type: 'new', instruments: [...c.values()].map(r => leg(null, r)) };
  if (p.size && !cur?.length) return { type: 'exited', instruments: [...p.values()].map(r => leg(r, null)) };
  // Still reported, now at $0: the shares did not go; the mark did.
  if (p.size && !c.size)
    return {
      type: 'zeroed',
      instruments: [...p.values()]
        .map(r => leg(r, null))
        .map(l => ({ ...l, positionEffect: 0, markEffect: -l.prevValue })),
    };
  if (!p.size) return null;

  const moved = movedWithinClass(p, c);
  const [P, C] = [moved.prev, moved.cur];
  const renamed = rekeyed(P, C);
  const instruments = [];
  for (const [k, r] of C) {
    const from = renamed.get(k);
    const l = from ? { ...leg(P.get(from), r), rekeyedFrom: from } : leg(P.get(k) || null, r);
    instruments.push(moved.merged.has(k) ? { ...l, mergedKeys: moved.merged.get(k) } : l);
  }
  const paired = new Set(renamed.values());
  for (const [k, r] of P) if (!C.has(k) && !paired.has(k)) instruments.push(leg(r, null));
  const dirs = new Set(instruments.map(i => i.change));
  const up = dirs.has('added') || dirs.has('new class');
  const down = dirs.has('reduced') || dirs.has('class no longer reported');
  const type = up && down ? 'mixed' : up ? 'added' : down ? 'reduced' : 'unchanged';
  return { type, instruments };
}

// Counted rows by instrument key. Two rows of one instrument in one filing
// (lots) are one position.
function byKey(rows) {
  const m = new Map();
  for (const r of rows) {
    const k = rowInfo(r).instrumentKey;
    const x = m.get(k);
    if (x) m.set(k, { ...x, balance: (x.balance || 0) + (r.balance || 0), value_usd: x.value_usd + r.value_usd });
    else m.set(k, { ...r });
  }
  return m;
}

// A coded class (Series X, Common X, Class X) is one security (trap 50), so
// when a filer moves it to other keys within one filing, the class is the
// position (DATA-QUALITY trap 52). Fidelity moved Databricks Series G-L into
// "PC PP-SEGREGATED LINE" rows at 2026-05-31: Series I 2,463 sh became Series I
// (segregated) 2,463 sh, Series H 273,804 sh became 157,694 + 116,110 sh, the
// mark $179.70 -> $190.00. Per key that read as "added and reduced across
// classes" with the mark move on the moved shares booked as position. A class
// whose keys changed is merged into one row per side when every row is a share
// row and each side's rows carry one mark (within 1%); the merged leg keeps the
// continuing key (else the largest new one) and lists the others (mergedKeys).
// A class whose mark moved more than 4x stays per key (a share exchange).
const baseClassOf = r => {
  const cls = classOfRow(rowInfo(r)).replace(/ \(segregated\)$/, '');
  return /^(Series|Common|Class) [A-Z0-9]/.test(cls) ? cls : null;
};
const oneMark = rows => {
  const ps = rows.map(r => r.value_usd / r.balance);
  return Math.max(...ps) <= Math.min(...ps) * 1.01;
};
function movedWithinClass(prev, cur) {
  const groups = new Map();
  for (const [side, m] of [
    ['prev', prev],
    ['cur', cur],
  ])
    for (const [k, r] of m) {
      const b = baseClassOf(r);
      if (b) (groups.get(b) || groups.set(b, { prev: [], cur: [] }).get(b))[side].push(k);
    }
  // A key in both filings stays itself: Redwood Materials' 8900108 was relabeled
  // Series C -> Series D at the same $47.74 (2023-12-31); neither class merges.
  const unstable = new Set();
  for (const [k, r] of prev)
    if (cur.has(k) && baseClassOf(r) !== baseClassOf(cur.get(k)))
      for (const b of [baseClassOf(r), baseClassOf(cur.get(k))]) if (b) unstable.add(b);
  const P = new Map(prev);
  const C = new Map(cur);
  const merged = new Map();
  for (const [b, g] of groups) {
    if (!g.prev.length || !g.cur.length || unstable.has(b)) continue;
    // Merge only when a key of the class vanished or appeared.
    if (!g.prev.some(k => !cur.has(k)) && !g.cur.some(k => !prev.has(k))) continue;
    const pr = g.prev.map(k => prev.get(k));
    const cr = g.cur.map(k => cur.get(k));
    if (![...pr, ...cr].every(r => r.balance > 0 && r.unit === 'NS') || !oneMark(pr) || !oneMark(cr)) continue;
    // A share exchange the split rules do not know is not a trade: Nscale
    // Series B 17,700 sh at $1,290.35 became 1,062,000 sh at $20.39 under a new
    // issuer name (60:1, 2026-05-31). The class's mark may move at most 4x
    // (after a detected split); beyond that the keys stay apart.
    const total = (rows, f) => rows.reduce((t, r) => t + r[f], 0);
    const [ps, pv, cs, cv] = [
      total(pr, 'balance'),
      total(pr, 'value_usd'),
      total(cr, 'balance'),
      total(cr, 'value_usd'),
    ];
    const f = detectSplit({ shares: ps, pricePerShare: pv / ps }, { shares: cs, pricePerShare: cv / cs }) || 1;
    const moved = cv / cs / (pv / ps / f);
    if (!(moved >= 0.25 && moved <= 4)) continue;
    const keep =
      g.cur.find(k => g.prev.includes(k)) || g.cur.reduce((a, b) => (cur.get(b).balance > cur.get(a).balance ? b : a));
    const sum = (rows, rep) => ({
      ...rep,
      balance: rows.reduce((t, r) => t + r.balance, 0),
      value_usd: rows.reduce((t, r) => t + r.value_usd, 0),
    });
    for (const k of g.prev) P.delete(k);
    for (const k of g.cur) C.delete(k);
    P.set(keep, sum(pr, prev.get(keep) || pr[0]));
    C.set(keep, sum(cr, cur.get(keep)));
    merged.set(keep, [...new Set([...g.prev, ...g.cur])].filter(k => k !== keep).sort());
  }
  return { prev: P, cur: C, merged };
}

// A filer re-keys a position (a new instrument id for the same holding): T. Rowe
// Price's Canva common went TC1HS9QX6 -> 5654443 at 2022-12-31 with the same
// 58,155 shares. Unpaired, that reads as one class sold and another bought, and
// the mark move lands in the position effect. A key that disappears pairs with
// one that appears when, in the same fund's consecutive filings, they are the
// only such pair with that class label (classOfRow) and the filer's own numbers
// carry over: the same share count (within the share tolerance) or the same
// per-unit mark (within 1%). Returns newKey -> oldKey.
function rekeyed(prev, cur) {
  const out = new Map();
  const byClass = (m, keep) => {
    const g = new Map();
    for (const [k, r] of m)
      if (keep(k)) {
        const cls = classOfRow(rowInfo(r));
        (g.get(cls) || g.set(cls, []).get(cls)).push([k, r]);
      }
    return g;
  };
  const gone = byClass(prev, k => !cur.has(k));
  const fresh = byClass(cur, k => !prev.has(k));
  for (const [cls, olds] of gone) {
    const news = fresh.get(cls);
    if (olds.length !== 1 || news?.length !== 1) continue;
    const [[oldKey, a]] = olds;
    const [[newKey, b]] = news;
    const sameShares = a.balance > 0 && b.balance > 0 && Math.abs(b.balance / a.balance - 1) <= SHARE_TOLERANCE;
    const pa = a.balance > 0 ? a.value_usd / a.balance : null;
    const pb = b.balance > 0 ? b.value_usd / b.balance : null;
    const sameMark = pa > 0 && pb > 0 && Math.abs(pb / pa - 1) <= 0.01;
    if (sameShares || sameMark) out.set(newKey, oldKey);
  }
  // Relabeled too: Coatue's 433,333 Databricks units ($82,333,270) went
  // 990AASZB6 "DATABRICKS, INC." -> EQT_268664 "Databricks, Inc." -> INTERNAL1
  // "DATABRICKS INC. - SERIES K PREFERRED" (2026-03-31, 2026-06-30), so the class
  // labels differ. The fund's one remaining vanished key pairs with its one
  // remaining new key when the unit, the share count and the value all carry
  // over (value within 1%).
  const taken = new Set(out.values());
  const restGone = [...prev].filter(([k]) => !cur.has(k) && !taken.has(k));
  const restNew = [...cur].filter(([k]) => !prev.has(k) && !out.has(k));
  if (restGone.length === 1 && restNew.length === 1) {
    const [[oldKey, a]] = restGone;
    const [[newKey, b]] = restNew;
    if (
      a.unit === b.unit &&
      a.balance > 0 &&
      b.balance > 0 &&
      Math.abs(b.balance / a.balance - 1) <= SHARE_TOLERANCE &&
      a.value_usd > 0 &&
      Math.abs(b.value_usd / a.value_usd - 1) <= 0.01
    )
      out.set(newKey, oldKey);
  }
  return out;
}

// One instrument across two filings. Prices are per share for share rows and
// per unit otherwise (trap 40); the prior side is restated for a detected split.
// Every leg splits its value change into a position effect (shares changed, at
// the prior mark) and a mark effect (the new mark on the shares now held):
//   position = (shares - prevShares*f) * prevPrice/f,  mark = shares * (price - prevPrice/f)
// which sum to value - prevValue exactly. A new class is all position, a class
// no longer reported is all position (negative); a row with no share count can
// only say its value changed (otherEffect).
function leg(prev, cur) {
  const a = prev && rowInfo(prev);
  const b = cur && rowInfo(cur);
  const base = b || a;
  const out = {
    instrumentKey: base.instrumentKey,
    instrument: base.instrumentLabel,
    title: base.title || base.issuerName,
    unit: base.unit,
    viaSpv: base.viaSpv,
    prevBalance: a ? a.balance : null,
    balance: b ? b.balance : null,
    prevValue: a ? a.valueUsd : 0,
    value: b ? b.valueUsd : 0,
    prevPrice: a ? (a.pricePerShare ?? a.pricePerUnit) : null,
    price: b ? (b.pricePerShare ?? b.pricePerUnit) : null,
    perShare: (b || a).pricePerShare != null,
    split: null,
  };
  if (!a) return { ...out, change: 'new class', positionEffect: out.value, markEffect: 0, otherEffect: 0 };
  if (!b)
    return {
      ...out,
      change: 'class no longer reported',
      positionEffect: -out.prevValue,
      markEffect: 0,
      otherEffect: 0,
    };
  const split =
    a.balance > 0 && b.balance > 0
      ? detectSplit(
          { shares: a.balance, pricePerShare: a.pricePerUnit },
          { shares: b.balance, pricePerShare: b.pricePerUnit }
        )
      : null;
  out.split = split || null;
  const f = split || 1;
  if (out.prevPrice != null && out.price != null && out.prevPrice > 0)
    out.priceChangePct = (out.price / (out.prevPrice / f) - 1) * 100;
  if (!(a.balance > 0 && b.balance > 0))
    return { ...out, change: 'value only', positionEffect: 0, markEffect: 0, otherEffect: out.value - out.prevValue };
  const prevAdj = a.balance * f;
  out.balanceChange = b.balance - prevAdj;
  const rel = out.balanceChange / prevAdj;
  const prevUnit = a.pricePerUnit / f;
  out.positionEffect = out.balanceChange * prevUnit;
  out.markEffect = b.balance * (b.pricePerUnit - prevUnit);
  out.otherEffect = 0;
  return { ...out, change: rel > SHARE_TOLERANCE ? 'added' : rel < -SHARE_TOLERANCE ? 'reduced' : 'unchanged' };
}

// Every canonical filing of the given funds, oldest first per fund.
function timelines(db, fundKeys) {
  const out = new Map(fundKeys.map(k => [k, []]));
  const stmt = db.prepare(
    `SELECT accession, fund_key, cik, series_id, registrant, series_name, report_date, filing_date, form, net_assets
     FROM canonical_filings WHERE fund_key IN (SELECT value FROM json_each(?)) ORDER BY fund_key, report_date`
  );
  for (const f of stmt.all(JSON.stringify(fundKeys))) out.get(f.fund_key).push(f);
  return out;
}

const fundOf = f => ({
  fundKey: f.fund_key,
  cik: f.cik,
  registrant: f.registrant,
  seriesName: f.series_name,
});

// A company's (or unreviewed entity's) position changes in every fund that
// ever held it, newest first. ref: { companyId } | { entityId }. Options:
// since/until (mark dates), types (event types to keep), includeUnchanged.
function companyActivity(db, ref, { since, until, types, includeUnchanged = false } = {}) {
  const rows = companyRows(db, ref, '9999-12-31');
  const byAcc = new Map();
  for (const r of rows) (byAcc.get(r.accession) || byAcc.set(r.accession, []).get(r.accession)).push(r);
  const tl = timelines(db, [...new Set(rows.map(r => r.fund_key))]);
  const events = [];
  for (const [, filings] of tl)
    for (const { cur, prev, ev } of walkPosition(filings, byAcc, { includeUnchanged }))
      events.push(eventOf(cur, prev, ev));
  return filterEvents(events, { since, until, types });
}

// One fund's position in one subject across its canonical filings (oldest
// first): the change at each filing that reports the subject or follows one
// that did. byAcc: accession -> the subject's rows in that filing. The one walk
// behind companyActivity and the position facts (lib/warehouse/position-facts.js).
const held = rows => [...byKey(rows.filter(r => r.counts)).values()].map(r => leg(null, r));
function walkPosition(filings, byAcc, { includeUnchanged = false } = {}) {
  const out = [];
  for (let i = 0; i < filings.length; i++) {
    const cur = filings[i];
    const prev = filings[i - 1] || null;
    const curRows = byAcc.get(cur.accession) || null;
    const prevRows = prev ? byAcc.get(prev.accession) || null : null;
    if (!curRows && !prevRows) continue;
    let ev;
    if (!prev) {
      if (!curRows?.some(r => r.counts)) continue;
      ev = { type: 'firstFiling', instruments: held(curRows) };
    } else if (daysBetween(prev.report_date, cur.report_date) > INACTIVE_DAYS) {
      if (!curRows?.some(r => r.counts)) continue;
      ev = { type: 'resumed', instruments: held(curRows) };
    } else ev = diffPosition(prevRows, curRows);
    if (!ev) continue;
    if (ev.type === 'unchanged' && !includeUnchanged && !ev.instruments.some(x => Math.abs(x.priceChangePct || 0) > 0))
      continue;
    out.push({ cur, prev, next: filings[i + 1] || null, ev });
  }
  return out;
}

const sumOf = (legs, k) => legs.reduce((s, x) => s + (x[k] || 0), 0);

function eventOf(cur, prev, ev) {
  const value = ev.instruments.reduce((s, x) => s + (x.value || 0), 0);
  const prevValue = ev.instruments.reduce((s, x) => s + (x.prevValue || 0), 0);
  const priced = ev.instruments.filter(x => x.priceChangePct != null);
  const moved = priced.some(x => Math.abs(x.priceChangePct) > 0.005);
  return {
    ...fundOf(cur),
    type: ev.type,
    label: ev.type === 'unchanged' && moved ? 'mark moved' : TYPES[ev.type],
    markDate: cur.report_date,
    filingDate: cur.filing_date,
    accession: cur.accession,
    prevMarkDate: prev?.report_date || null,
    prevAccession: prev?.accession || null,
    value,
    prevValue,
    valueChange: value - prevValue,
    // valueChange = positionEffect + markEffect + otherEffect (leg())
    positionEffect: sumOf(ev.instruments, 'positionEffect'),
    markEffect: sumOf(ev.instruments, 'markEffect'),
    otherEffect: sumOf(ev.instruments, 'otherEffect'),
    // The mark move of the largest priced instrument (per share or per unit).
    markChangePct: priced.length
      ? priced.reduce((a, b) => (Math.max(a.value, a.prevValue) >= Math.max(b.value, b.prevValue) ? a : b))
          .priceChangePct
      : null,
    instruments: ev.instruments,
  };
}

function filterEvents(events, { since, until, types }) {
  return events
    .filter(
      e => (!since || e.markDate >= since) && (!until || e.markDate <= until) && (!types || types.includes(e.type))
    )
    .sort((a, b) => b.markDate.localeCompare(a.markDate) || a.fundKey.localeCompare(b.fundKey));
}

// Position changes in curated private companies across filings, fund-first:
// for each chosen canonical filing, every private company it or the fund's
// previous canonical filing reports. Choose filings by
//   fundKeys (+ markSince/markUntil): those funds' filings by mark date; or
//   filedSince (+ filedUntil): every canonical filing made in that window (the
//   site-wide feed of what is new).
// Unchanged positions are dropped unless their mark moved.
function fundChanges(db, { fundKeys, markSince, markUntil, filedSince, filedUntil, includeUnchanged = false } = {}) {
  let picks;
  if (fundKeys) {
    const tl = timelines(db, fundKeys);
    picks = [];
    for (const filings of tl.values())
      filings.forEach((f, i) => {
        if ((!markSince || f.report_date >= markSince) && (!markUntil || f.report_date <= markUntil))
          picks.push({ cur: f, prev: filings[i - 1] || null });
      });
  } else if (filedSince) {
    const cur = db
      .prepare(
        `SELECT accession, fund_key, cik, series_id, registrant, series_name, report_date, filing_date, form, net_assets
         FROM canonical_filings WHERE filing_date >= ? AND filing_date <= ? ORDER BY filing_date, accession`
      )
      .all(filedSince, filedUntil || '9999-12-31');
    const prevOf = db.prepare(
      `SELECT accession, fund_key, report_date, filing_date FROM canonical_filings
       WHERE fund_key = ? AND report_date < ? ORDER BY report_date DESC LIMIT 1`
    );
    picks = cur.map(f => ({ cur: f, prev: prevOf.get(f.fund_key, f.report_date) || null }));
  } else throw new Error('fundChanges: pass fundKeys or filedSince');

  const accessions = [...new Set(picks.flatMap(p => [p.cur.accession, p.prev?.accession]).filter(Boolean))];
  const rows = new Map(); // accession -> company id -> rows
  const names = new Map();
  for (const r of privateRowsOf(db, accessions)) {
    names.set(r.company_id, r.company_name);
    const byCompany = rows.get(r.accession) || rows.set(r.accession, new Map()).get(r.accession);
    (byCompany.get(r.company_id) || byCompany.set(r.company_id, []).get(r.company_id)).push(r);
  }
  const events = [];
  for (const { cur, prev } of picks) {
    const c = rows.get(cur.accession) || new Map();
    const p = (prev && rows.get(prev.accession)) || new Map();
    const gap = prev ? daysBetween(prev.report_date, cur.report_date) > INACTIVE_DAYS : true;
    for (const id of new Set([...c.keys(), ...p.keys()])) {
      let ev;
      if (gap) {
        if (!(c.get(id) || []).some(r => r.counts)) continue;
        ev = { type: prev ? 'resumed' : 'firstFiling', instruments: held(c.get(id)) };
      } else ev = diffPosition(p.get(id) || null, c.get(id) || null);
      if (!ev) continue;
      if (
        ev.type === 'unchanged' &&
        !includeUnchanged &&
        !ev.instruments.some(x => Math.abs(x.priceChangePct || 0) > 0)
      )
        continue;
      events.push({ companyId: id, company: names.get(id), ...eventOf(cur, prev, ev) });
    }
  }
  return events.sort(
    (a, b) =>
      b.filingDate.localeCompare(a.filingDate) ||
      b.markDate.localeCompare(a.markDate) ||
      Math.abs(b.valueChange) - Math.abs(a.valueChange)
  );
}

// Counts of each event type per mark month, for a trend chart.
function activityByMonth(events) {
  const months = new Map();
  for (const e of events) {
    const m = e.markDate.slice(0, 7);
    const x = months.get(m) || {
      month: m,
      new: 0,
      added: 0,
      reduced: 0,
      mixed: 0,
      exited: 0,
      zeroed: 0,
      markUps: 0,
      markDowns: 0,
    };
    if (x[e.type] != null) x[e.type]++;
    if (e.markChangePct > 0.05) x.markUps++;
    else if (e.markChangePct < -0.05) x.markDowns++;
    months.set(m, x);
  }
  return [...months.values()].sort((a, b) => a.month.localeCompare(b.month));
}

module.exports = {
  companyActivity,
  fundChanges,
  activityByMonth,
  diffPosition,
  walkPosition,
  leg,
  rekeyed,
  eventOf,
  timelines,
  TYPES,
};
