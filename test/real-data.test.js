// Offline tests whose inputs are REAL values captured from live SEC filings
// (documented next to each case) — the regression suite for bugs that only
// real data exposed: stock splits read as purchases, dummy CUSIPs pairing
// unrelated holdings, "N/A" issuer names.
//
// Sources: NPORT-P filings for Destiny Tech100 (CIK 1843974), Private Shares
// Fund (CIK 1557265), T. Rowe Price Global Stock Fund (CIK 313212).
//
// Run with: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { detectSplit } = require('../lib/analytics/splits');
const {
  extractAllHoldings,
  buildFundXRayComparison,
  buildPositionReturns,
  buildIssuerCapitalStructure,
  issuerKeyOf,
} = require('../parsers');

const xml2js = require('xml2js');
const FIXTURES = path.join(__dirname, 'fixtures');
const parseXml = file =>
  new xml2js.Parser({
    explicitArray: false,
    mergeAttrs: true,
    normalizeTags: true,
    tagNameProcessors: [xml2js.processors.stripPrefix],
  }).parseStringPromise(fs.readFileSync(path.join(FIXTURES, file), 'utf8'));
const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

const pos = (over = {}) => ({
  name: over.name || 'DXYZ SpaceX I LLC',
  issuer: '',
  title: over.title || 'DXYZ SpaceX I LLC (economic exposure to SpaceX)',
  cusip: over.cusip || '',
  instrumentType: 'indirect',
  instrumentLabel: 'Indirect',
  country: 'US',
  isPrivate: true,
  shares: over.shares,
  pricePerShare: over.pps,
  marketValue: over.mv ?? over.shares * over.pps,
  pctOfNetAssets: 0,
});
const xray = (privateHoldings, reportDate) => ({
  fund: { reportDate, seriesName: 'Destiny Tech100', registrantName: 'Destiny Tech100 Inc.' },
  privateHoldings,
  privateValueUSD: privateHoldings.reduce((s, h) => s + h.marketValue, 0),
});

// ── stock splits (real cases) ───────────────────────────────────────────────

test('detectSplit: every real split found in live data is recognized', () => {
  const real = [
    // [label, prior {shares, pps}, current {shares, pps}, expected ratio]
    ['Destiny Tech100, DXYZ SpaceX I LLC 2026-03-31 → 06-30', 135135, 529.1, 675675, 170.86, 5],
    ['Destiny Tech100, MWAM VC SpaceX-II LLC 2026-03-31 → 06-30', 42857, 483.89, 214285, 155.31, 5],
    ['Franklin Growth Opportunities, SpaceX Class A 2026-04-30 → 07-31', 142857, 526.59, 714285, 108.37, 5],
    ['VIP Technology, Runway AI Series D 2024-12-31 → 2025-03-31', 22078, 114.5, 220780, 11.48, 10],
    ['VIP Technology, Discord Series I 2025-12-31 → 2026-03-31', 200, 245.48, 2000, 22.28, 10],
    [
      'T. Rowe Price Science & Technology, Perplexity AI Series D-1 2025-12-31 → 2026-03-31',
      6081,
      695.4438,
      60810,
      69.5444,
      10,
    ],
  ];
  for (const [label, ps, pp, cs, cp, want] of real) {
    assert.equal(detectSplit({ shares: ps, pricePerShare: pp }, { shares: cs, pricePerShare: cp }), want, label);
  }
});

test('detectSplit: units restated with a re-mark (trap 63, P14): the prior side is restated, the change is mark', () => {
  // Partners Group Growth, Impilo Orphan Drugs: 0.04 sh $122,320.31 -> 88,174.80 sh $224,435.86 (raw EDGAR,
  // 0001410368-26-021560 -> 0001410368-26-056536)
  const opts = { remark: true };
  const r = detectSplit(
    { shares: 0.04, pricePerShare: 122320.31 / 0.04 },
    { shares: 88174.8, pricePerShare: 224435.86 / 88174.8 },
    opts
  );
  assert.equal(r, 88174.8 / 0.04);
  // Partners Group, EnfraGen: units in thousands one quarter, units the next
  assert.equal(
    detectSplit(
      { shares: 37786, pricePerShare: 2397.4733385380828 },
      { shares: 35172405.56, pricePerShare: 2.47551599993549 },
      opts
    ),
    35172405.56 / 37786
  );
  // 50x the units at 50x the value is a purchase, not a restatement
  assert.equal(detectSplit({ shares: 1000, pricePerShare: 10 }, { shares: 60000, pricePerShare: 10.5 }, opts), null);
  // under 50x with the price collapsing is a re-mark plus a trade, left alone
  assert.equal(
    detectSplit({ shares: 25913.08, pricePerShare: 315.63 }, { shares: 129565.4, pricePerShare: 7.7e-8 }, opts),
    null
  );
  // without the option (a class moving between keys) the stricter rules hold: Nscale's 60:1 exchange
  assert.equal(detectSplit({ shares: 17700, pricePerShare: 1290.35 }, { shares: 1062000, pricePerShare: 20.39 }), null);
  assert.equal(
    detectSplit({ shares: 0.04, pricePerShare: 3058007.75 }, { shares: 88174.8, pricePerShare: 2.5453515 }),
    null
  );
});

test('detectSplit: real purchases and re-marks that are not splits', () => {
  // Fidelity Advisor Series I, Anthropic Series F: position built up at an unchanged mark (units ×2.468, price ×1.000)
  assert.equal(detectSplit({ shares: 38900, pricePerShare: 140.97 }, { shares: 96000, pricePerShare: 140.96 }), null);
  // Same position, next quarter: units unchanged, mark ×1.838
  assert.equal(detectSplit({ shares: 96000, pricePerShare: 140.96 }, { shares: 96000, pricePerShare: 259.14 }), null);
  // Discord Series I, all real quarters before the split: units constant, small re-marks
  assert.equal(detectSplit({ shares: 200, pricePerShare: 238.08 }, { shares: 200, pricePerShare: 247.02 }), null);
  // Fidelity OpenAI Group PBC A: position grown from 200 to 900 units while the mark rose (×4.5, price ×1.099)
  assert.equal(detectSplit({ shares: 200, pricePerShare: 434.54 }, { shares: 900, pricePerShare: 477.48 }), null);
});

test('detectSplit: real position changes that only look like splits are not splits', () => {
  // VIP Growth Opportunities, Tenstorrent Series D 2024-12-31 → 2025-03-31: units ×2.9898 (0.34% from 3) but the price did not move ($78.85 → $78.87) — a purchase.
  assert.equal(detectSplit({ shares: 5400, pricePerShare: 78.85 }, { shares: 16145, pricePerShare: 78.87 }), null);
  // Franklin Growth Opportunities, Fanatics 2026-01-31 → 04-30: units exactly halved (×0.5000) while the price FELL ($66.186 → $50.00) — a sale plus a markdown, not a 1-for-2 reverse split.
  assert.equal(detectSplit({ shares: 1029939, pricePerShare: 66.186 }, { shares: 514969, pricePerShare: 50 }), null);
  // VIP Growth Opportunities, Databricks Series J 2026-03-31 → 06-30: units ×0.0831 (1/12 within 0.3%), price up 20.6%, but total value down 90% — 91.7% of the position sold, not a reverse split.
  assert.equal(detectSplit({ shares: 3309, pricePerShare: 165.1 }, { shares: 275, pricePerShare: 199.12 }), null);
  // Select Communication Services, SpaceX 2025-11-30 → 2026-02-28: units ×5.9521 (0.8% from 6) with price ×2.48 — purchase into a marked-up name.
  assert.equal(detectSplit({ shares: 1481, pricePerShare: 212 }, { shares: 8815, pricePerShare: 526.59 }), null);
});

test('detectSplit: a real 1-for-3 reverse split (Motive Technologies, Private Shares Fund, 2025-12-31 → 2026-03-31) and the same 10-for-1 Perplexity split across four funds', () => {
  // All four Motive tranches moved together: units ÷3, price $11.46 → $34.85, value +1.4%.
  const motive = [
    [1603971, 534657],
    [788562, 262854],
    [532837, 177612.333],
    [319105, 106368.333],
  ];
  for (const [before, after] of motive) {
    const ratio = detectSplit({ shares: before, pricePerShare: 11.46 }, { shares: after, pricePerShare: 34.85 });
    assert.ok(ratio && Math.abs(ratio - 1 / 3) < 1e-9, `${before} → ${after}`);
  }
  // Perplexity AI Series D-1/E-1, 2025-12-31 → 2026-03-31, price $695.444 → $69.544, at four different funds.
  for (const [before, after] of [
    [1346, 13460],
    [40949, 409490],
    [19395, 193950],
    [10496, 104960],
    [6081, 60810],
  ]) {
    assert.equal(detectSplit({ shares: before, pricePerShare: 695.444 }, { shares: after, pricePerShare: 69.544 }), 10);
  }
});

test('detectSplit: units restated at the same value (trap 63, F58) restate the prior side by the exact ratio', () => {
  const at = (shares, value) => ({ shares, pricePerShare: value / shares });
  // PGIM High Yield, Ferrellgas escrow preferred, id INTERNAL B8A9598C3:
  // 0001752724-21-157139 (2021-05-28) → 0001752724-21-224848 (2021-08-31), $135,375,000 both.
  assert.equal(detectSplit(at(135375, 135375000), at(135375000, 135375000)), 1000);
  // Partners Group Private Equity, AmSurg HoldCo 2L, id 902TTWII7:
  // 0001410368-25-001817 → 0001410368-25-032775, $27,103,511.25 both.
  const amsurg = detectSplit(at(896098, 27103511.25), at(21902252.04, 27103511.25));
  assert.ok(Math.abs(amsurg - 21902252.04 / 896098) < 1e-9, String(amsurg));
  // EntrepreneurShares, Anduril Holdings SPV LP, id ANDURLSPV:
  // 0000910472-25-004877 → 0000910472-26-003239, $3,000,000 both.
  assert.ok(Math.abs(detectSplit(at(70588.23, 3e6), at(3e6, 3e6)) - 3e6 / 70588.23) < 1e-9);
  // the other way: Endeavor, 323,000 → 323 shares at $323,000 (0001752724-24-270317 → 0001752724-25-042103)
  assert.ok(Math.abs(detectSplit(at(323000, 323000), at(323, 323000)) - 0.001) < 1e-12);
  // Below 10× a flat value stays a share exchange (Mesquite ×2.41, F52) ...
  assert.equal(detectSplit(at(1000, 43895191), at(2411, 43895191 * 1.0066)), null);
  // ... and 10× more shares with a value that moved over 1% is a purchase, not a restatement.
  assert.equal(detectSplit(at(1000, 1e6), at(10500, 1.05e6)), null);
  assert.equal(detectSplit(at(1000, 1e6), at(23000, 1.02e6)), null);
});

test('activity: a units restatement is neither a position nor a mark change (Ferrellgas, live bug: "added $153B")', () => {
  const { diffPosition } = require('../lib/analytics/activity');
  const row = (row_key, balance) => ({
    row_key,
    issuer_name: 'FERRELLGAS ESCROW LLC 3/30/31 Equity Preferred',
    title: 'FERRELLGAS ESCROW LLC 3/30/31 Equity Preferred',
    other_id: 'B8A9598C3',
    cusip: null,
    asset_cat: 'EP',
    balance,
    unit: 'NS',
    value_usd: 135375000,
    instrument_type: 'equity',
    via_spv: 0,
    counts: true,
  });
  const ev = diffPosition([row('a', 135375)], [row('b', 135375000)]);
  assert.equal(ev.type, 'unchanged');
  const [l] = ev.instruments;
  assert.equal(l.change, 'unchanged');
  assert.equal(l.split, 1000);
  assert.equal(l.positionEffect, 0);
  assert.equal(l.markEffect, 0);
  assert.equal(l.priceChangePct, 0);
});

test('detectSplit: refuses missing or non-positive inputs', () => {
  assert.equal(detectSplit(null, { shares: 1, pricePerShare: 1 }), null);
  assert.equal(detectSplit({ shares: 0, pricePerShare: 10 }, { shares: 5, pricePerShare: 2 }), null);
  assert.equal(detectSplit({ shares: 10, pricePerShare: NaN }, { shares: 50, pricePerShare: 2 }), null);
});

test('comparison: a real 5-for-1 split is not booked as position sizing or a markdown (DXYZ SpaceX I LLC)', () => {
  const prior = xray([pos({ shares: 135135, pps: 529.1, mv: 71499929 })], '2026-03-31');
  const current = xray([pos({ shares: 675675, pps: 170.86, mv: 115445831 })], '2026-06-30');
  const cmp = buildFundXRayComparison(current, prior);
  const p = cmp.positions[0];
  assert.equal(p.status, 'held');
  assert.equal(p.splitRatio, 5);
  const valueDelta = 115445831 - 71499929;
  assert.ok(close(p.priceEffectUSD, valueDelta, 1), 'entire change is a re-mark');
  assert.ok(close(p.shareEffectUSD, 0, 1), 'no position sizing effect');
  assert.ok(cmp.insights.topMarkups.items.length === 1, 'shows as a markup');
  assert.equal(cmp.insights.topMarkdowns.items.length, 0, 'not a markdown');
  assert.equal(cmp.insights.increased.items.length, 0, 'not a purchase');
  assert.ok(
    p.pricePerShare.deltaPct > 60 && p.pricePerShare.deltaPct < 62,
    `split-adjusted price change +61.5%, got ${p.pricePerShare.deltaPct}`
  );
  assert.ok(close(p.shares.delta, 0, 1e-6), 'split-adjusted share change is zero');
});

test('returns: real DXYZ SpaceX I LLC history — the 5-for-1 split adds no capital; MOIC = 115.4M / 54.5M', () => {
  const series = [
    ['2025-12-31', 135135, 403.3, 54499946],
    ['2026-03-31', 135135, 529.1, 71499929],
    ['2026-06-30', 675675, 170.86, 115445831],
  ];
  const { positions, summary } = buildPositionReturns(
    series.map(([d, sh, pps, mv]) => ({ reportDate: d, xray: xray([pos({ shares: sh, pps, mv })], d) }))
  );
  assert.equal(positions.length, 1);
  const p = positions[0];
  assert.ok(close(p.invested, 135135 * 403.3, 1), `invested ${p.invested}`);
  assert.ok(close(p.moic, 115445831 / (135135 * 403.3), 1e-9));
  assert.equal(p.lots.length, 1, 'no add-on lot created by the split');
  assert.deepEqual(
    p.events.map(e => e.type),
    ['split']
  );
  assert.equal(p.events[0].ratio, 5);
  assert.ok(close(p.lots[0].shares, 675675, 1e-6), 'lot units restated onto the post-split basis');
  assert.ok(summary.moic > 2.1 && summary.moic < 2.13);
});

// ── dummy CUSIPs & N/A names (real T. Rowe Price Global Stock Fund rows) ────

test('comparison: unrelated holdings sharing dummy CUSIP "000000000" are not paired with each other (T. Rowe Price Global Stock, 2024-10-31 → 2025-01-31)', () => {
  const mk = (title, shares, pps, name = 'N/A') => ({
    ...pos({ shares, pps, title, name }),
    cusip: '000000000',
    instrumentType: 'equity',
  });
  const prior = xray(
    [
      mk('DATABRICKS INC PP', 307914, 87.37),
      mk('LIGHTMATTER SER D CVT PFD PP', 131020, 80.2305),
      mk('DATABRICKS SER I CVT PFD STOCK PP', 37125, 87.37),
    ],
    '2024-10-31'
  );
  const current = xray(
    [
      mk('DATABRICKS INC PP', 307914, 92.5),
      mk('LIGHTMATTER SER D CVT PFD PP', 131020, 80.2305),
      mk('DATABRICKS SER I CVT PFD STOCK PP', 37125, 92.5),
    ],
    '2025-01-31'
  );
  const cmp = buildFundXRayComparison(current, prior);
  assert.equal(cmp.positions.length, 3);
  assert.ok(
    cmp.positions.every(p => p.status === 'held'),
    'each holding matches its own predecessor'
  );
  const lm = cmp.positions.find(p => /LIGHTMATTER/.test(p.title));
  assert.ok(close(lm.pricePerShare.delta, 0, 1e-9), 'Lightmatter unchanged — not compared against a Databricks row');
  const db = cmp.positions.find(p => p.title === 'DATABRICKS INC PP');
  assert.ok(close(db.pricePerShare.deltaPct, (92.5 / 87.37 - 1) * 100, 1e-6));
});

test('issuerKeyOf: real security descriptions from T. Rowe/Fidelity/Capital filings reduce to the company', () => {
  const cases = {
    'WAYMO LLC SER A-2 CVT PFD UNITS PP': 'WAYMO',
    'Lightmatter SER D CVT PFD PP': 'LIGHTMATTER',
    'CANVA CLASS B COMMON STOCK PP': 'CANVA',
    'DATABRICKS INC-CL A PP': 'DATABRICKS',
    'Anthropic PBC SER F-1 CVT PFD PP': 'ANTHROPIC',
    'ANTHROPIC PBC SERIES G PC PP': 'ANTHROPIC',
    'OPENAI GROUP PBC A-2 PC PP': 'OPENAI',
    'KANDOU HOLDING SA PFD SER D PP (PHYSICAL) (NOT LISTED OR TRADING)': 'KANDOU',
    'KANDOU HOLDING SA WTS 1:1 @ USD 3.50 08-18-28 PP (PHYSICAL) (NOT LISTED OR TRADING)': 'KANDOU',
    'KANDOU HOLDING SA TL PP (PHYSICAL) 7.0% 03-31-26': 'KANDOU',
    'XSIGHT LABS LTD SER F WT 07/24/32 PP': 'XSIGHT LABS',
  };
  for (const [name, key] of Object.entries(cases)) assert.equal(issuerKeyOf({ name }), key, name);
});

test('issuerKeyOf: a placeholder "N/A" name falls back to the title instead of grouping every such holding together', () => {
  assert.equal(issuerKeyOf({ name: 'N/A', issuer: '', title: 'LIGHTMATTER SER D CVT PFD PP' }), 'LIGHTMATTER');
  assert.equal(issuerKeyOf({ name: 'N/A', issuer: '', title: 'DATABRICKS INC PP' }), 'DATABRICKS');
  assert.notEqual(issuerKeyOf({ name: 'N/A', title: 'WAYMO LLC PP' }), issuerKeyOf({ name: 'N/A', title: 'CANVA PP' }));
});

test('capital structure: T. Rowe-style holdings (issuer empty, name = full description) roll up per company, not per instrument', () => {
  const mk = (name, type, label, mv) => ({
    name,
    issuer: '',
    title: name,
    instrumentType: type,
    instrumentLabel: label,
    marketValue: mv,
    isPrivate: type !== 'debt',
  });
  const rows = buildIssuerCapitalStructure(
    [
      mk('DATABRICKS INC PP', 'equity', 'Common', 28480000),
      mk('DATABRICKS SER F CVT PFD STCK PP', 'equity', 'Preferred F', 14170000),
      mk('DATABRICKS SER H CVT PFD STOCK PP', 'equity', 'Preferred H', 6540000),
      mk('LIGHTMATTER SER D CVT PFD PP', 'equity', 'Preferred D', 10511800),
    ],
    0
  );
  assert.equal(rows.length, 2);
  const db = rows.find(r => r.issuer.toUpperCase().startsWith('DATABRICKS'));
  assert.equal(db.instruments.length, 3);
  assert.ok(close(db.totalValueUSD, 28480000 + 14170000 + 6540000));
});

// ── real T. Rowe Price filing where <name> is the literal "N/A" ─────────────

test('real T. Rowe NPORT-P (Global Stock Fund, 2024-10-31): holdings named "N/A" take their title as the name, and carry instrument ids', async () => {
  const xml = await parseXml('nport_trowe_na_names.xml');
  const all = extractAllHoldings(xml);
  assert.equal(all.length, 3);
  assert.ok(
    all.every(h => h.name && h.name !== 'N/A'),
    'the placeholder name is replaced by the security title'
  );
  assert.deepEqual(
    all.map(h => issuerKeyOf(h)),
    ['DATABRICKS', 'DATABRICKS', 'LIGHTMATTER']
  );
  assert.ok(
    all.every(h => h.cusip === '000000000'),
    'all three carry the same dummy CUSIP'
  );
  assert.deepEqual(
    all.map(h => h.filerId),
    ['TC1NGB2O7', 'TC2YS62M4', 'TC77CG730'],
    "the filer's own ids (identifiers.other) are distinct — what position tracking keys on"
  );
});

test('comparison across two real T. Rowe periods pairs holdings by the filer id even though every CUSIP is the dummy 000000000', async () => {
  const xml = await parseXml('nport_trowe_na_names.xml');
  const prior = extractAllHoldings(xml).map(h => ({ ...h, isPrivate: true }));
  // Next quarter the same three positions exist with new marks (2025-01-31 real values: Databricks $92.50, Lightmatter D $80.2305).
  const current = prior.map(h => ({
    ...h,
    pricePerShare: /LIGHTMATTER/.test(h.title) ? 80.2305 : 92.5,
    marketValue: h.shares * (/LIGHTMATTER/.test(h.title) ? 80.2305 : 92.5),
  }));
  const cmp = buildFundXRayComparison(
    { fund: { reportDate: '2025-01-31' }, privateHoldings: current, privateValueUSD: 1 },
    { fund: { reportDate: '2024-10-31' }, privateHoldings: prior, privateValueUSD: 1 }
  );
  assert.equal(cmp.positions.length, 3);
  assert.ok(cmp.positions.every(p => p.status === 'held'));
  assert.equal(
    cmp.totals.issuerCount.current,
    2,
    'Databricks ×2 tranches + Lightmatter = 2 companies, not 3 instruments'
  );
});
