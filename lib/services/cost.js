// Cost basis for the answers (P15, ADR 0011): read-only, from cost_facts and
// round_prices only. One function decides whether a position has a cost the app may
// show (costOfPosition); every answer that shows a cost goes through it, so the
// holders table, the position drawer, the X-Ray and the firm book cannot disagree.
//
// A cost is reported at an N-CSR date (twice a year); positions are marked at every
// N-PORT. A position shows a cost when either
//   - its filing is the cost's own filing (same fund, accession and instrument, same
//     shares), or
//   - the cost is from an earlier filing of the same fund and instrument, and every
//     position leg since then (to this one) has the same shares and no split: the same
//     shares, still held, so the same cost ("carried": true).
// Anything else has no cost. Totals (a holder, a company in a firm's book) show a
// cost only when every position under them has one.
const { memo } = require('./memo');

const SHARES_EXACT = 1e-6;

function index(db) {
  return memo(db, 'cost:index', () => {
    const facts = new Map(); // fund|instrument -> facts, oldest first
    for (const f of db.prepare('SELECT * FROM cost_facts ORDER BY report_date, ncsr_accession, line_no').all()) {
      const k = `${f.fund_key}|${f.instrument_key}`;
      if (!facts.has(k)) facts.set(k, []);
      facts.get(k).push(f);
    }
    // the legs that decide whether a cost carries forward: same fund and instrument
    const legs = new Map();
    const legsOf = db.prepare(
      `SELECT report_date, accession, balance, split, per_share FROM position_facts
       WHERE fund_key = ? AND instrument_key = ? ORDER BY report_date`
    );
    for (const [k, list] of facts) {
      const f = list[0];
      legs.set(k, legsOf.all(f.fund_key, f.instrument_key));
    }
    const rounds = new Map(); // company -> confirmed round prices
    for (const r of db.prepare('SELECT * FROM round_prices ORDER BY acquired_on').all()) {
      if (!rounds.has(r.company_id)) rounds.set(r.company_id, []);
      rounds.get(r.company_id).push(r);
    }
    const splits = new Map(); // company|class -> report dates with a recorded split
    for (const s of db
      .prepare('SELECT company_id, class_label, report_date FROM position_facts WHERE split IS NOT NULL')
      .all()) {
      const k = `${s.company_id}|${s.class_label}`;
      if (!splits.has(k)) splits.set(k, []);
      splits.get(k).push(s.report_date);
    }
    const filings = db.prepare("SELECT COUNT(*) n FROM ncsr_filings WHERE status = 'ok'").get().n;
    return { facts, legs, rounds, splits, filings };
  });
}

const shape = (f, { valueUsd, carried }) => ({
  usd: f.cost_usd,
  shares: f.shares,
  perShare: f.single_lot ? f.cost_per_share : null,
  acquiredFirst: f.acquired_first,
  acquiredLast: f.acquired_last,
  singleLot: !!f.single_lot,
  asOf: f.report_date,
  carried,
  valueToCost: f.cost_usd > 0 && valueUsd != null ? valueUsd / f.cost_usd : null,
  ncsrAccession: f.ncsr_accession,
  nportAccession: f.nport_accession,
});

// p: { fundKey, accession, reportDate, instrumentKey, balance, valueUsd }. The cost of
// exactly this position, or null.
function costOfPosition(db, p) {
  if (!p || !p.fundKey || !p.instrumentKey || !(p.balance > 0)) return null;
  const ix = index(db);
  const k = `${p.fundKey}|${p.instrumentKey}`;
  const list = ix.facts.get(k);
  if (!list) return null;
  const same = list.find(f => f.nport_accession === p.accession);
  if (same) return Math.abs(same.shares - p.balance) <= SHARES_EXACT ? shape(same, { ...p, carried: false }) : null;
  // the latest earlier cost, carried only through unchanged legs with no split
  const earlier = list.filter(f => f.report_date < p.reportDate);
  const f = earlier[earlier.length - 1];
  if (!f || Math.abs(f.shares - p.balance) > SHARES_EXACT) return null;
  const between = ix.legs.get(k).filter(l => l.report_date > f.report_date && l.report_date <= p.reportDate);
  if (!between.length || between[between.length - 1].accession !== p.accession) return null;
  if (between.some(l => l.split != null || !l.per_share || Math.abs(l.balance - f.shares) > SHARES_EXACT)) return null;
  return shape(f, { ...p, carried: true });
}

// The sum over positions that all have a cost; null when any of them has none.
function costOfAll(costs, valueUsd) {
  if (!costs.length || costs.some(c => !c)) return null;
  const usd = costs.reduce((s, c) => s + c.usd, 0);
  return { usd, valueToCost: usd > 0 && valueUsd != null ? valueUsd / usd : null, positions: costs.length };
}

// Confirmed round prices of a company, newest first. A price is left out once a split is
// recorded for its class after the reports it rests on: its per-share basis has changed.
function roundPricesOf(db, companyId) {
  const ix = index(db);
  return (ix.rounds.get(companyId) || [])
    .map(r => {
      const evidence = JSON.parse(r.evidence);
      const asOf = evidence.reduce((m, e) => (e.report_date > m ? e.report_date : m), '');
      return { r, evidence, asOf };
    })
    .filter(({ r, asOf }) => !(ix.splits.get(`${companyId}|${r.class_label}`) || []).some(d => d > asOf))
    .map(({ r, evidence, asOf }) => ({
      classLabel: r.class_label,
      acquiredOn: r.acquired_on,
      price: r.price,
      firms: r.firms,
      funds: r.funds,
      asOf,
      evidence: evidence.map(e => ({
        fundKey: e.fund_key,
        firmId: e.firm_id,
        ncsrAccession: e.ncsr_accession,
        reportDate: e.report_date,
        costPerShare: e.cost_per_share,
      })),
    }))
    .sort((a, b) => b.acquiredOn.localeCompare(a.acquiredOn) || a.classLabel.localeCompare(b.classLabel));
}

const hasCosts = db => index(db).facts.size > 0;

// --- answers: each adds `cost` (and on totals `costCoverage`) only where a cost exists, so
// an answer without one is exactly what it was before P15 (scripts/snapshot-api.js) ---

// Holders (exposure): each position, and a holder whose positions all have one.
function withExposureCosts(db, e) {
  if (!hasCosts(db)) return e;
  const holding = h => {
    const positions = (h.positions || []).map(p => {
      const cost = costOfPosition(db, {
        fundKey: h.fundKey,
        accession: h.accession,
        reportDate: h.markDate,
        instrumentKey: p.instrumentKey,
        balance: p.unit === 'NS' ? p.balance : null,
        valueUsd: p.valueUsd,
      });
      return cost ? { ...p, cost } : p;
    });
    const all = costOfAll(
      positions.map(p => p.cost || null),
      h.value
    );
    return { ...h, positions, ...(all ? { cost: all } : {}) };
  };
  return { ...e, holdings: (e.holdings || []).map(holding) };
}

// One fund's position history (the drawer): each leg at its own filing.
function withLegCosts(db, fundKey, ph) {
  if (!hasCosts(db) || !ph || !ph.legs) return ph;
  const legs = ph.legs.map(l => {
    const cost =
      l.unit === 'NS'
        ? costOfPosition(db, {
            fundKey,
            accession: l.accession,
            reportDate: l.markDate,
            instrumentKey: l.instrumentKey,
            balance: l.balance,
            valueUsd: l.value,
          })
        : null;
    return cost ? { ...l, cost } : l;
  });
  return { ...ph, legs };
}

// Fund X-Ray: each private row with a cost; the share of private value with one.
function withXrayCosts(db, fundKey, full, display) {
  if (!hasCosts(db)) return display;
  const costOf = h =>
    h.unit === 'NS' && h.company
      ? costOfPosition(db, {
          fundKey,
          accession: full.accession,
          reportDate: full.markDate,
          instrumentKey: h.instrumentKey,
          balance: h.shares,
          valueUsd: h.marketValue,
        })
      : null;
  const costs = new Map();
  for (const h of full.privateHoldings) {
    const c = costOf(h);
    if (c) costs.set(h.rowKey, c);
  }
  if (!costs.size) return display;
  const add = h => (costs.has(h.rowKey) ? { ...h, cost: costs.get(h.rowKey) } : h);
  const valueWithCost = full.privateHoldings.filter(h => costs.has(h.rowKey)).reduce((s, h) => s + h.marketValue, 0);
  const costUsd = [...costs.values()].reduce((s, c) => s + c.usd, 0);
  return {
    ...display,
    privateHoldings: display.privateHoldings.map(add),
    topPrivateHoldings: display.topPrivateHoldings.map(add),
    costCoverage: {
      positions: costs.size,
      valueUsd: valueWithCost,
      costUsd,
      share: full.privateValueUSD > 0 ? valueWithCost / full.privateValueUSD : null,
      valueToCost: costUsd > 0 ? valueWithCost / costUsd : null,
    },
  };
}

// A firm's book: each position, and a company whose positions (all funds) all have one.
// The book's positions carry no instrument key: the one position leg with the same fund,
// filing, company, shares and value names it, or the position has no cost.
function withBookCosts(db, book) {
  if (!hasCosts(db) || !book || !book.byCompany) return book;
  const legs = db.prepare(
    'SELECT instrument_key, balance, value FROM position_facts WHERE fund_key = ? AND accession = ? AND company_id = ?'
  );
  const byCompany = book.byCompany.map(c => {
    const positions = c.positions.map(p => {
      if (p.unit !== 'NS') return p;
      const hit = legs
        .all(p.fundKey, p.accession, c.companyId)
        .filter(l => Math.abs(l.balance - p.balance) <= SHARES_EXACT && Math.abs(l.value - p.value) < 0.005);
      if (hit.length !== 1) return p;
      const cost = costOfPosition(db, {
        fundKey: p.fundKey,
        accession: p.accession,
        reportDate: p.markDate,
        instrumentKey: hit[0].instrument_key,
        balance: p.balance,
        valueUsd: p.value,
      });
      return cost ? { ...p, cost } : p;
    });
    const all = costOfAll(
      positions.map(p => p.cost || null),
      c.value
    );
    return { ...c, positions, ...(all ? { cost: all } : {}) };
  });
  return { ...book, byCompany };
}

module.exports = {
  costOfPosition,
  costOfAll,
  roundPricesOf,
  hasCosts,
  index,
  withExposureCosts,
  withLegCosts,
  withXrayCosts,
  withBookCosts,
};
