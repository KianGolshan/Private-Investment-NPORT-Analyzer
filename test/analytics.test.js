// Tests for the private-valuation analytics in parsers.js: per-issuer capital
// structure (real Kandou fixture) and mark-implied return lot accounting
// (synthetic period sequences with hand-computed expected values).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const xml2js = require('xml2js');

const {
  extractAllHoldings,
  extractFundMeta,
  buildFundXRay,
  buildIssuerCapitalStructure,
  parseDebtTerms,
  xirr,
  buildPositionReturns,
} = require('../parsers');

async function parseFixture(file) {
  const raw = fs.readFileSync(path.join(__dirname, 'fixtures', file), 'utf8');
  const parser = new xml2js.Parser({
    explicitArray: false,
    mergeAttrs: true,
    normalizeTags: true,
    tagNameProcessors: [xml2js.processors.stripPrefix],
  });
  return parser.parseStringPromise(raw);
}

const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

test('capital structure: real Kandou filing rolls preferred + warrant + 7% term loan into one issuer, debt first', async () => {
  const xml = await parseFixture('nport_kandou_multi_instrument.xml');
  const holdings = extractAllHoldings(xml);
  const cs = buildIssuerCapitalStructure(holdings, 0);

  assert.equal(cs.length, 1);
  const k = cs[0];
  assert.equal(k.multiTranche, true);
  assert.deepEqual(new Set(Object.keys(k.byType)), new Set(['equity', 'derivative', 'debt']));
  assert.equal(k.instruments[0].instrumentType, 'debt', 'senior debt sorts first');
  assert.equal(k.instruments[k.instruments.length - 1].instrumentType, 'derivative', 'warrant sorts last');
  assert.equal(k.weightedDebtCouponPct, 7);
  assert.equal(k.instruments[0].maturity, '03-31-26');
  assert.ok(close(k.totalValueUSD, 1100000 + 6050000 + 0.23, 0.01));
  assert.ok(close(k.debtPctOfExposure, (6050000 / (1100000 + 6050000 + 0.23)) * 100, 1e-4));
});

test('capital structure: attached to buildFundXRay output; public-only fund has none', async () => {
  const xml = await parseFixture('nport_kandou_multi_instrument.xml');
  const xray = buildFundXRay(extractAllHoldings(xml), extractFundMeta(xml));
  assert.equal(xray.capitalStructure.length, 1);

  const spacex = await parseFixture('nport_spacex_primary_doc.xml');
  const publicXray = buildFundXRay(extractAllHoldings(spacex), extractFundMeta(spacex));
  assert.deepEqual(publicXray.capitalStructure, []);
});

test('parseDebtTerms extracts coupon and maturity, null when absent', () => {
  assert.deepEqual(parseDebtTerms('ACME TL PP 7.5% 12-31-27'), { couponPct: 7.5, maturity: '12-31-27' });
  assert.deepEqual(parseDebtTerms('ACME NOTE'), { couponPct: null, maturity: null });
});

test('xirr: -100 then +121 two years later is 10%; one-sided or too-short flows are null', () => {
  const t0 = Date.parse('2024-01-01');
  const r = xirr([
    { t: t0, amount: -100 },
    { t: t0 + 2 * 365 * 86400000, amount: 121 },
  ]);
  assert.ok(close(r, 0.1, 1e-4));
  assert.equal(xirr([{ t: t0, amount: -100 }]), null);
  assert.equal(
    xirr([
      { t: t0, amount: -100 },
      { t: t0 + 5 * 86400000, amount: 110 },
    ]),
    null
  );
});

function holding(over) {
  const shares = over.shares;
  const pps = over.pps;
  return {
    name: over.issuer || 'ACME INC',
    issuer: over.issuer || 'ACME INC',
    title: over.title || 'ACME INC PFD SER A',
    cusip: '',
    instrumentLabel: 'Preferred A',
    shares,
    pricePerShare: pps,
    marketValue: shares * pps,
    ...over.extra,
  };
}
const period = (reportDate, hs) => ({ reportDate, xray: { privateHoldings: hs } });

test('returns: entry, mark-up, add-on, partial realization — hand-computed lot accounting', () => {
  const { positions, summary } = buildPositionReturns([
    period('2024-03-31', [holding({ shares: 100, pps: 10 })]),
    period('2024-06-30', [holding({ shares: 100, pps: 15 })]),
    period('2024-09-30', [holding({ shares: 150, pps: 20 })]), // +50 sh @20 = $1000 add-on
    period('2024-12-31', [holding({ shares: 100, pps: 20 })]), // -50 sh: proceeds $1000
  ]);

  assert.equal(positions.length, 1);
  const p = positions[0];
  assert.ok(close(p.invested, 2000));
  assert.ok(close(p.realized, 1000));
  assert.ok(close(p.currentValue, 2000));
  assert.ok(close(p.moic, 1.5));
  // Average-cost basis after the partial sale: 2000 × (1 − 50/150) = 1333.33.
  assert.ok(close(p.costBasis, 2000 * (100 / 150)), 'remaining cost basis reduced proportionally by the sale');
  assert.equal(p.entryIsWindowStart, true, 'present in the oldest filing → true entry unknown');
  assert.deepEqual(
    p.events.map(e => e.type),
    ['addon', 'partial_realization']
  );
  assert.ok(p.irr > 0);
  assert.ok(close(summary.moic, 1.5));
  assert.ok(close(summary.partialSales, 1000));
  assert.ok(close(summary.leftPrivateBook, 0));
});

test('returns: a share-count reduction is a realization, never a loss', () => {
  const { positions } = buildPositionReturns([
    period('2024-03-31', [holding({ shares: 100, pps: 10 })]),
    period('2024-06-30', [holding({ shares: 50, pps: 10 })]),
  ]);
  const p = positions[0];
  assert.ok(close(p.invested, 1000));
  assert.ok(close(p.realized, 500));
  assert.ok(close(p.currentValue, 500));
  assert.ok(close(p.moic, 1.0), 'flat mark, half sold → MOIC exactly 1.0x, not 0.5x');
});

test('returns: a position first seen after the oldest filing is a true entry', () => {
  const { positions } = buildPositionReturns([
    period('2024-03-31', []),
    period('2024-06-30', [holding({ shares: 100, pps: 10 })]),
    period('2024-09-30', [holding({ shares: 100, pps: 12 })]),
  ]);
  assert.equal(positions[0].entryIsWindowStart, false);
  assert.ok(close(positions[0].moic, 1.2));
});

test('returns: instrument exiting as a same-issuer instrument appears is chained as a conversion, not a sale + new buy', () => {
  const { positions } = buildPositionReturns([
    period('2024-03-31', [holding({ shares: 100, pps: 10, title: 'ACME INC PFD SER A' })]),
    period('2024-06-30', [holding({ shares: 200, pps: 6, title: 'ACME INC COM' })]),
  ]);
  assert.equal(positions.length, 1, 'the exited preferred is merged into its successor');
  const p = positions[0];
  assert.equal(p.chainedFrom, 'ACME INC PFD SER A');
  assert.ok(close(p.invested, 1000), 'converted value is not new capital');
  assert.ok(close(p.realized, 0), 'conversion is not a realization');
  assert.ok(close(p.currentValue, 1200));
  assert.ok(close(p.moic, 1.2));
  assert.ok(close(p.costBasis, 1000), 'remaining cost basis carries through the conversion');
  assert.equal(p.entryIsWindowStart, true);
});

test('returns: a position leaving the private book with no same-issuer successor is realized at its last mark', () => {
  const { positions } = buildPositionReturns([
    period('2024-03-31', [holding({ shares: 100, pps: 10 })]),
    period('2024-06-30', [holding({ shares: 100, pps: 14 })]),
    period('2024-09-30', []),
  ]);
  const { summary } = buildPositionReturns([
    period('2024-03-31', [holding({ shares: 100, pps: 10 })]),
    period('2024-06-30', [holding({ shares: 100, pps: 14 })]),
    period('2024-09-30', []),
  ]);
  assert.ok(close(summary.leftPrivateBook, 1400));
  const p = positions[0];
  assert.equal(p.status, 'exited');
  assert.ok(close(p.realized, 1400));
  assert.ok(close(p.moic, 1.4));
  assert.equal(p.events.at(-1).type, 'left_private_book');
});

test('returns: positions without usable share/price data are excluded from the summary, not silently zeroed', () => {
  const noPrice = holding({ shares: 0, pps: 0, issuer: 'NOPRICE CO', title: 'NOPRICE CO PFD' });
  noPrice.pricePerShare = null;
  noPrice.marketValue = 500;
  const { positions, summary } = buildPositionReturns([
    period('2024-03-31', [noPrice, holding({ shares: 100, pps: 10 })]),
    period('2024-06-30', [noPrice, holding({ shares: 100, pps: 12 })]),
  ]);
  assert.equal(positions.length, 2);
  assert.equal(summary.positionCount, 1);
  assert.equal(summary.excludedCount, 1);
});

test('returns: a partial sale before a conversion keeps its realized proceeds on the chained position', () => {
  const { positions } = buildPositionReturns([
    period('2024-03-31', [holding({ shares: 100, pps: 10, title: 'ACME INC PFD SER A' })]),
    period('2024-06-30', [holding({ shares: 50, pps: 10, title: 'ACME INC PFD SER A' })]), // sells 50 → $500
    period('2024-09-30', [holding({ shares: 100, pps: 6, title: 'ACME INC COM' })]), // remaining 50 convert → $600
  ]);
  assert.equal(positions.length, 1);
  const p = positions[0];
  assert.ok(close(p.invested, 1000));
  assert.ok(close(p.realized, 500), 'earlier sale proceeds survive the conversion');
  assert.ok(close(p.currentValue, 600));
  assert.ok(close(p.moic, 1.1));
  assert.ok(close(p.costBasis, 500), 'half the original cost remains after the sale, carried through conversion');
});

test('capital structure: seniority order is debt, preferred, common, warrant', () => {
  const mk = (title, instrumentType, instrumentLabel, marketValue) => ({
    name: 'ACME',
    issuer: 'ACME',
    title,
    instrumentType,
    instrumentLabel,
    marketValue,
    isPrivate: instrumentType !== 'debt',
  });
  const [row] = buildIssuerCapitalStructure(
    [
      mk('W', 'derivative', 'Warrant', 1),
      mk('C', 'equity', 'Common', 2),
      mk('P', 'equity', 'Preferred A', 3),
      mk('D', 'debt', 'Term Loan', 4),
    ],
    0
  );
  assert.deepEqual(
    row.instruments.map(i => i.title),
    ['D', 'P', 'C', 'W']
  );
});
