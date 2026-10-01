// Position facts (P6b W1, migration 0019): one row per change leg of every
// fund's position in every private company, at every canonical filing that
// reports the company or follows one that did. The firm, fund and market
// views (lib/services/analysis.js) read them instead of re-walking every
// fund's filings per request.
//
// Built only from the activity walk (activity.walkPosition, which runs
// diffPosition, rekeyed and leg): the same events companyActivity shows, plus
// the unchanged legs, so the value a fund reports at each filing is the sum of
// its legs there. next_report_date is the fund's next canonical filing of any
// content, so the as-of rule (ADR 0004) reads straight off the table: a fund's
// value in a company as of D is the sum of `value` over its legs with
// report_date <= D < next_report_date, if D is within 123 days of report_date.
// Rebuilt by every refresh and curation run, in one transaction, and logged.
const { walkPosition, timelines } = require('../analytics/activity');
const { rowInfo } = require('../analytics/asof');
const { classOfRow } = require('../services/classes');

// The private-company rows the facts cover: equity-type rows of companies
// with status 'private' in canonical filings, under the counting rule
// (asof.countsRule with null balances, as privateRowsOf): rows that count,
// plus rows at $0 or less (still reported, trap 42).
const PRIVATE_ROWS = `
  SELECT h.*, f.fund_key, f.report_date, f.filing_date
  FROM holdings h JOIN canonical_filings f ON f.accession = h.accession
  JOIN companies c ON c.id = h.company_id AND c.status = 'private'
  WHERE h.instrument_type IN ('equity','indirect','derivative')`;

const counts = h => h.value_usd > 0 && (h.balance > 0 || h.balance == null || h.balance === 0);

// The class label and kind of a leg's own side (the current row, else the prior).
function legOf(fundKey, subjectId, cur, prev, next, type, x, rowsByKey) {
  const r = rowsByKey.get(x.instrumentKey);
  const info = r ? rowInfo(r) : null;
  return {
    fund_key: fundKey,
    company_id: subjectId,
    accession: cur.accession,
    report_date: cur.report_date,
    filing_date: cur.filing_date,
    next_report_date: next ? next.report_date : null,
    prev_accession: prev ? prev.accession : null,
    prev_report_date: prev ? prev.report_date : null,
    event: type,
    change: x.change,
    instrument_key: x.instrumentKey,
    rekeyed_from: x.rekeyedFrom || null,
    merged_keys: x.mergedKeys ? x.mergedKeys.join(',') : null,
    // A class merged across keys (trap 52) is the class, segregated lines included.
    class_label: info
      ? x.mergedKeys
        ? classOfRow(info).replace(/ \(segregated\)$/, '')
        : classOfRow(info)
      : x.instrument,
    instrument_label: x.instrument,
    kind: info ? info.kind : x.viaSpv ? 'spv' : 'direct',
    unit: x.unit,
    title: x.title,
    balance: x.balance,
    prev_balance: x.prevBalance,
    value: x.value,
    prev_value: x.prevValue,
    price: x.price,
    prev_price: x.prevPrice,
    per_share: x.perShare ? 1 : 0,
    split: x.split,
    position_effect: x.positionEffect,
    mark_effect: x.markEffect,
    other_effect: x.otherEffect,
    pct_nav: r ? r.pct_nav : null,
  };
}

// Facts from stored rows (each with fund_key, report_date, accession and
// `counts`), for one subject or many: subjectOf(row) names the subject. The
// warehouse build passes every private-company row; a service may pass one
// company's or unreviewed name's rows (companyRows) and gets the same legs.
function factsOf(db, rows, subjectOf = r => r.company_id) {
  const byFund = new Map(); // fund -> subject -> accession -> rows
  for (const r of rows) {
    const s = subjectOf(r);
    const f = byFund.get(r.fund_key) || byFund.set(r.fund_key, new Map()).get(r.fund_key);
    const bySubject = f.get(s) || f.set(s, new Map()).get(s);
    (bySubject.get(r.accession) || bySubject.set(r.accession, []).get(r.accession)).push(r);
  }
  const out = [];
  const tl = timelines(db, [...byFund.keys()]);
  for (const [fundKey, subjects] of byFund) {
    const filings = tl.get(fundKey);
    for (const [subjectId, byAcc] of subjects)
      for (const { cur, prev, next, ev } of walkPosition(filings, byAcc, { includeUnchanged: true })) {
        // Each leg's own row: the current filing's, else the prior's (an exit).
        // Lots of one instrument are one position (diffPosition): % of NAV adds up.
        const rowsByKey = new Map();
        for (const acc of [prev?.accession, cur.accession]) {
          const lots = new Map();
          for (const r of byAcc.get(acc) || []) {
            const k = rowInfo(r).instrumentKey;
            const x = lots.get(k);
            lots.set(k, x ? { ...x, pct_nav: (x.pct_nav ?? 0) + (r.pct_nav ?? 0) } : r);
          }
          for (const [k, r] of lots) rowsByKey.set(k, r);
        }
        for (const x of ev.instruments) out.push(legOf(fundKey, subjectId, cur, prev, next, ev.type, x, rowsByKey));
      }
  }
  return out;
}

const COLUMNS = [
  'fund_key',
  'company_id',
  'accession',
  'report_date',
  'filing_date',
  'next_report_date',
  'prev_accession',
  'prev_report_date',
  'event',
  'change',
  'instrument_key',
  'rekeyed_from',
  'merged_keys',
  'class_label',
  'instrument_label',
  'kind',
  'unit',
  'title',
  'balance',
  'prev_balance',
  'value',
  'prev_value',
  'price',
  'prev_price',
  'per_share',
  'split',
  'position_effect',
  'mark_effect',
  'other_effect',
  'pct_nav',
];

function privateRows(db) {
  return db
    .prepare(PRIVATE_ROWS)
    .all()
    .map(r => ({ ...r, counts: counts(r) }))
    .filter(r => r.counts || !(r.value_usd > 0));
}

// Replaces position_facts in one transaction and logs it to ingest_log
// (kind 'position-facts'): rows read and legs written.
function buildPositionFacts(db, { log = () => {} } = {}) {
  const t0 = Date.now();
  const startedAt = new Date().toISOString();
  const logId = db
    .prepare("INSERT INTO ingest_log (kind, started_at, status) VALUES ('position-facts', ?, 'running')")
    .run(startedAt).lastInsertRowid;
  try {
    const rows = privateRows(db);
    const facts = factsOf(db, rows);
    const insert = db.prepare(
      `INSERT INTO position_facts (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(c => '@' + c).join(', ')})`
    );
    db.transaction(() => {
      db.prepare('DELETE FROM position_facts').run();
      for (const f of facts) insert.run(f);
    })();
    const filings = new Set(facts.map(f => f.accession)).size;
    db.prepare(
      "UPDATE ingest_log SET finished_at = ?, status = 'ok', filings = ?, rows_read = ?, rows_kept = ? WHERE id = ?"
    ).run(new Date().toISOString(), filings, rows.length, facts.length, logId);
    const ms = Date.now() - t0;
    log(
      `position facts: ${facts.length} legs from ${rows.length} rows in ${filings} filings (${(ms / 1000).toFixed(1)}s)`
    );
    return { rows: rows.length, legs: facts.length, filings, ms };
  } catch (err) {
    db.prepare("UPDATE ingest_log SET finished_at = ?, status = 'failed', error = ? WHERE id = ?").run(
      new Date().toISOString(),
      String(err.message),
      logId
    );
    throw err;
  }
}

module.exports = { buildPositionFacts, factsOf, privateRows, COLUMNS };
