// Cost facts and confirmed round prices (P15, migration 0024, ADR 0011): the costs the
// app may show. Rebuilt by every job after the position facts, from the N-CSR lines
// that passed the number checks at ingest, under the rest of the admission rule:
//
//   1. the line's filing is the latest read N-CSR for its series and period (an
//      amendment that could not be read withholds the whole period for that registrant);
//   2. every N-PORT row it joined belongs to one reviewed company of category
//      `company`, and is a share row (unit NS);
//   3. those rows are exactly one position leg the app already shows: the same fund,
//      filing and instrument, the same shares to the share and the same value to the
//      cent (so a cost never attaches to part of a leg, nor to two);
//   4. an entry price only for a single-date lot.
//
// A line that fails any of them is left out (cost_refusals counts why). Confirmed round
// prices: single-date lots of one company and class bought on the same date, each fund's
// latest report only, held by funds of 2+ firms, all within 0.5% of their median;
// anything less is not a round price.
const { rowInfo } = require('../analytics/asof');
const { NOMINAL_PER_SHARE } = require('../ncsr/match');

const ROUND_AGREE = 0.005;
const SHARES_EXACT = 1e-6;
const VALUE_EXACT = 0.005;

// The latest read filing for each (series, period); a period with an unreadable or
// failed amendment of the registrant gives none.
function admittedFilings(db) {
  const withheld = new Set(
    db
      .prepare("SELECT cik || '|' || period_end AS k FROM ncsr_filings WHERE form LIKE '%/A' AND status <> 'ok'")
      .all()
      .map(r => r.k)
  );
  const latest = new Map(); // series|period -> accession
  const rows = db
    .prepare(
      `SELECT f.series_id, f.period_end, f.accession, nf.cik, nf.filing_date
       FROM ncsr_funds f JOIN ncsr_filings nf ON nf.accession = f.accession
       WHERE nf.status = 'ok' AND f.series_id IS NOT NULL
       ORDER BY nf.filing_date, f.accession`
    )
    .all();
  for (const r of rows) latest.set(`${r.series_id}|${r.period_end}`, r);
  const out = new Set();
  for (const r of latest.values()) if (!withheld.has(`${r.cik}|${r.period_end}`)) out.add(r.accession);
  return { accessions: out, latestBySeries: latest };
}

function buildCostFacts(db, { log = () => {} } = {}) {
  const started = Date.now();
  const { accessions, latestBySeries } = admittedFilings(db);
  const lines = db
    .prepare(
      `SELECT c.*, f.fund_key, f.series_id, f.period_end, f.nport_accession
       FROM ncsr_costs c JOIN ncsr_funds f ON f.accession = c.accession AND f.fund_no = c.fund_no
       JOIN ncsr_filings nf ON nf.accession = c.accession
       WHERE c.refused IS NULL AND f.status = 'ok' AND nf.status = 'ok'
       ORDER BY c.accession, c.fund_no, c.line_no`
    )
    .all();
  const linksOf = db.prepare(
    'SELECT nport_accession, row_key FROM ncsr_cost_links WHERE accession = ? AND fund_no = ? AND line_no = ?'
  );
  const holding = db.prepare(
    `SELECT h.*, c.category, c.status AS company_status FROM holdings h LEFT JOIN companies c ON c.id = h.company_id
     WHERE h.accession = ? AND h.row_key = ?`
  );
  const legsAt = db.prepare(`SELECT * FROM position_facts WHERE fund_key = ? AND accession = ? AND company_id = ?`);
  const refusals = {};
  const refuse = why => {
    refusals[why] = (refusals[why] || 0) + 1;
    return null;
  };
  const facts = [];
  for (const l of lines) {
    const f = latestBySeries.get(`${l.series_id}|${l.period_end}`);
    if (!f || f.accession !== l.accession || !accessions.has(l.accession)) {
      refuse('superseded or withheld filing');
      continue;
    }
    const rows = linksOf.all(l.accession, l.fund_no, l.line_no).map(k => holding.get(k.nport_accession, k.row_key));
    if (!rows.length || rows.some(r => !r)) {
      refuse('joined row missing');
      continue;
    }
    const companyId = rows[0].company_id;
    if (!companyId || rows.some(r => r.company_id !== companyId)) {
      refuse('not one reviewed company');
      continue;
    }
    if (rows[0].category !== 'company') {
      refuse('not an operating company');
      continue;
    }
    if (rows.some(r => r.unit !== 'NS')) {
      refuse('not a share row');
      continue;
    }
    const keys = new Set(rows.map(r => rowInfo(r).instrumentKey));
    const legs = legsAt
      .all(l.fund_key, l.nport_accession, companyId)
      .filter(
        leg => keys.has(leg.instrument_key) || (leg.merged_keys && leg.merged_keys.split(',').some(k => keys.has(k)))
      );
    if (legs.length !== 1) {
      refuse(legs.length ? 'more than one position leg' : 'no position leg');
      continue;
    }
    const leg = legs[0];
    const shares = rows.reduce((s, r) => s + r.balance, 0);
    const value = rows.reduce((s, r) => s + r.value_usd, 0);
    if (
      !leg.per_share ||
      Math.abs(leg.balance - shares) > SHARES_EXACT ||
      Math.abs(leg.balance - l.shares) > SHARES_EXACT
    ) {
      refuse('leg shares differ');
      continue;
    }
    if (Math.abs(leg.value - value) > VALUE_EXACT) {
      refuse('leg value differs');
      continue;
    }
    // the line-level rule (match.js refusal) again, for lines stored before it existed
    if (l.cost_usd / leg.balance < NOMINAL_PER_SHARE) {
      refuse('nominal cost');
      continue;
    }
    const single = l.acquired_first === l.acquired_last;
    facts.push({
      ncsr_accession: l.accession,
      fund_no: l.fund_no,
      line_no: l.line_no,
      fund_key: l.fund_key,
      company_id: companyId,
      instrument_key: leg.instrument_key,
      class_label: leg.class_label,
      nport_accession: l.nport_accession,
      report_date: leg.report_date,
      shares: leg.balance,
      value_usd: leg.value,
      cost_usd: l.cost_usd,
      cost_unit: l.cost_unit,
      acquired_first: l.acquired_first,
      acquired_last: l.acquired_last,
      single_lot: single ? 1 : 0,
      cost_per_share: single ? l.cost_usd / leg.balance : null,
    });
  }
  // two lines on one leg: neither cost is the leg's cost
  const perLeg = new Map();
  for (const x of facts) {
    const k = `${x.fund_key}|${x.nport_accession}|${x.instrument_key}`;
    perLeg.set(k, (perLeg.get(k) || 0) + 1);
  }
  const kept = facts.filter(x => {
    const one = perLeg.get(`${x.fund_key}|${x.nport_accession}|${x.instrument_key}`) === 1;
    if (!one) refuse('two lines on one leg');
    return one;
  });
  const rounds = roundPrices(db, kept);
  db.transaction(() => {
    db.prepare('DELETE FROM cost_facts').run();
    db.prepare('DELETE FROM round_prices').run();
    const cols = Object.keys(kept[0] || { ncsr_accession: 0 });
    const ins = kept.length
      ? db.prepare(`INSERT INTO cost_facts (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
      : null;
    for (const x of kept) ins.run(...cols.map(c => x[c]));
    const rp = db.prepare(
      'INSERT INTO round_prices (company_id, class_label, acquired_on, price, firms, funds, evidence) VALUES (?,?,?,?,?,?,?)'
    );
    for (const r of rounds) rp.run(r.company_id, r.class_label, r.acquired_on, r.price, r.firms, r.funds, r.evidence);
  })();
  log(
    `cost facts: ${kept.length} of ${lines.length} number-checked lines admitted, ${rounds.length} confirmed round ` +
      `prices (${((Date.now() - started) / 1000).toFixed(1)} s)` +
      (Object.keys(refusals).length ? `; left out: ${JSON.stringify(refusals)}` : '')
  );
  return { admitted: kept.length, checked: lines.length, roundPrices: rounds.length, refusals };
}

// Each fund's one firm (its adviser's manager); a fund with none or several gives none.
function firmOfFund(db) {
  const out = new Map();
  for (const r of db
    .prepare(
      `SELECT fa.fund_key, GROUP_CONCAT(DISTINCT ma.manager_id) AS ids FROM fund_advisers fa
       JOIN manager_advisers ma ON ma.file_num = fa.file_num WHERE fa.role = 'adviser' GROUP BY fa.fund_key`
    )
    .all()) {
    const ids = String(r.ids).split(',');
    if (ids.length === 1) out.set(r.fund_key, Number(ids[0]));
  }
  return out;
}

// A lot says its price within ROUND_AGREE only when the printed unit's rounding (half a unit
// of cost, over its shares) is smaller than that: 459 Databricks J shares at "$42" thousand
// are $90.41 to $92.59 a share, so they neither confirm nor contradict $92.50 (2026-11-06:
// such lots had withdrawn Series J's confirmed price). The lot's own cost still shows.
const precise = x => x.shares > 0 && x.cost_unit / 2 / x.shares <= ROUND_AGREE * x.cost_per_share;

function roundPrices(db, facts) {
  const firmOf = firmOfFund(db);
  // each fund's latest report of each single-date lot
  const latest = new Map();
  for (const x of facts) {
    if (!x.single_lot || !x.class_label || !precise(x)) continue;
    const k = `${x.company_id}|${x.class_label}|${x.acquired_first}|${x.fund_key}`;
    const prev = latest.get(k);
    if (!prev || x.report_date > prev.report_date) latest.set(k, x);
  }
  const groups = new Map();
  for (const x of latest.values()) {
    const k = `${x.company_id}|${x.class_label}|${x.acquired_first}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(x);
  }
  const out = [];
  for (const lots of groups.values()) {
    const firms = new Set(lots.map(x => firmOf.get(x.fund_key)).filter(Boolean));
    if (firms.size < 2 || lots.some(x => !firmOf.has(x.fund_key))) continue;
    const prices = lots.map(x => x.cost_per_share).sort((a, b) => a - b);
    const mid =
      prices.length % 2
        ? prices[(prices.length - 1) / 2]
        : (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2;
    if (prices.some(p => Math.abs(p / mid - 1) > ROUND_AGREE)) continue;
    out.push({
      company_id: lots[0].company_id,
      class_label: lots[0].class_label,
      acquired_on: lots[0].acquired_first,
      price: mid,
      firms: firms.size,
      funds: lots.length,
      evidence: JSON.stringify(
        lots.map(x => ({
          fund_key: x.fund_key,
          firm_id: firmOf.get(x.fund_key),
          ncsr_accession: x.ncsr_accession,
          line_no: x.line_no,
          report_date: x.report_date,
          cost_per_share: x.cost_per_share,
        }))
      ),
    });
  }
  return out;
}

module.exports = { buildCostFacts, admittedFilings, roundPrices, precise, ROUND_AGREE };
