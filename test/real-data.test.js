// Offline tests whose inputs are REAL values captured from live SEC filings
// (documented next to each case) — the regression suite for bugs that only
// real data exposed: stock splits read as purchases, dummy CUSIPs pairing
// unrelated holdings, "N/A" issuer names, multi-series trusts.
//
// Sources: NPORT-P filings for Destiny Tech100 (CIK 1843974), Private Shares
// Fund (CIK 1557265), Fidelity Advisor Series I (CIK 722574), T. Rowe Price
// Global Stock Fund (CIK 313212), SMALLCAP World Fund (CIK 858744).
//
// Run with: npm test

process.env.CACHE_DB_PATH = ':memory:';
process.env.SEC_MIN_INTERVAL_MS = '0';
process.env.SEC_USER_AGENT = 'Test Suite test@example.com';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const nock = require('nock');
const request = require('supertest');

const app = require('../server');
const { detectSplit } = require('../public/splits.js');
const {
  extractHoldings,
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
const SEC = 'https://www.sec.gov';
const DATA_SEC = 'https://data.sec.gov';

test.beforeEach(() => {
  nock.cleanAll();
  nock.disableNetConnect();
  nock.enableNetConnect(/127\.0\.0\.1/);
});
test.after(() => nock.enableNetConnect());

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

// ── multi-series trusts (real Fidelity Advisor Series I payloads) ──────────

test('GET /api/fund-series-filings: returns one series’ own NPORT-P history from EDGAR’s series feed, with report dates joined from the registrant', async () => {
  const feed = fs.readFileSync(path.join(FIXTURES, 'edgar_series_feed_S000017684.xml'), 'utf8');
  // Real registrant history for Fidelity Advisor Series I (newest filings): two DIFFERENT funds filed for
  // 2026-07-31 (…006134 Capital and Income, …006133 Floating Rate High Income) — the multi-series signature.
  const submissions = {
    name: 'FIDELITY ADVISOR SERIES I',
    filings: {
      recent: {
        form: ['NPORT-P', 'NPORT-P', 'NPORT-P'],
        accessionNumber: ['0000035402-26-006134', '0000035402-26-006133', '0000035402-26-004039'],
        filingDate: ['2026-09-23', '2026-09-23', '2026-06-26'],
        reportDate: ['2026-07-31', '2026-07-31', '2026-04-30'],
        primaryDocument: ['primary_doc.xml', 'primary_doc.xml', 'primary_doc.xml'],
      },
      files: [],
    },
  };
  nock(DATA_SEC).get('/submissions/CIK0000722574.json').reply(200, submissions);
  nock(SEC)
    .get('/cgi-bin/browse-edgar')
    .query(q => q.CIK === 'S000017684' && q.type === 'NPORT-P')
    .reply(200, feed);

  const res = await request(app).get('/api/fund-series-filings?cik=0000722574&seriesId=S000017684');
  assert.equal(res.status, 200);
  assert.equal(res.body.filings.length, 28, 'the series feed has 28 real NPORT-P filings');
  assert.equal(res.body.filings[0].accession, '0000035402-26-006134');
  assert.equal(res.body.filings[0].reportDate, '2026-07-31', 'report date joined from registrant history');
  assert.equal(res.body.filings[1].reportDate, '2026-04-30');
  assert.ok(res.body.filings.every(f => /^\d{10}-\d{2}-\d{6}$/.test(f.accession)));
});

test('GET /api/fund-series-filings: validates the series id', async () => {
  assert.equal((await request(app).get('/api/fund-series-filings?cik=1&seriesId=nope')).status, 400);
  assert.equal((await request(app).get('/api/fund-series-filings?seriesId=S000017684')).status, 400);
});

test('GET /api/fund-series: a single-series registrant (real SMALLCAP World Fund history) is reported as such, without header fetches', async () => {
  const submissions = JSON.parse(
    fs.readFileSync(path.join(FIXTURES, 'submissions_smallcap_world_fund_recent.json'), 'utf8')
  );
  nock(DATA_SEC).get('/submissions/CIK0000858744.json').reply(200, submissions);
  const res = await request(app).get('/api/fund-series?cik=858744');
  assert.equal(res.status, 200);
  assert.equal(res.body.multiSeries, false);
  assert.deepEqual(res.body.series, []);
});

test('GET /api/fund-series: a multi-series trust lists each fund by reading only the filing headers (two real Fidelity Advisor headers)', async () => {
  const ci = fs.readFileSync(path.join(FIXTURES, 'nport_header_fidelity_advisor_capital_income.xml'), 'utf8');
  const frhi = fs.readFileSync(path.join(FIXTURES, 'nport_header_fidelity_advisor_floating_rate.xml'), 'utf8');
  // Registrant history is cached from the previous test (same real payload): two funds filed for 2026-07-31.
  nock(SEC)
    .get('/Archives/edgar/data/722574/000003540226006134/primary_doc.xml')
    .reply(200, ci, { 'Content-Type': 'text/xml' });
  nock(SEC)
    .get('/Archives/edgar/data/722574/000003540226006133/primary_doc.xml')
    .reply(200, frhi, { 'Content-Type': 'text/xml' });
  nock(SEC)
    .get('/Archives/edgar/data/722574/000003540226004039/primary_doc.xml')
    .reply(200, ci, { 'Content-Type': 'text/xml' });

  const res = await request(app).get('/api/fund-series?cik=0000722574');
  assert.equal(res.status, 200);
  assert.equal(res.body.multiSeries, true);
  assert.deepEqual(
    res.body.series.map(s => [s.seriesId, s.seriesName]),
    [
      ['S000017684', 'Fidelity Advisor Capital and Income Fund'],
      ['S000017683', 'Fidelity Advisor Floating Rate High Income Fund'],
    ].sort((a, b) => a[1].localeCompare(b[1])),
    'both real funds listed once each, alphabetically'
  );
});

test('GET /api/fund-series: one filing per period but a duplicated period (an amendment, real: SkyBridge G II Fund) does not invent a fund picker', async () => {
  // Same registrant CIK is reused with a different real history shape via a fresh CIK path.
  const ci = fs.readFileSync(path.join(FIXTURES, 'nport_header_fidelity_advisor_capital_income.xml'), 'utf8');
  const submissions = {
    name: 'SKYBRIDGE G II FUND',
    filings: {
      recent: {
        form: ['NPORT-P', 'NPORT-P'],
        accessionNumber: ['0001520568-22-000005', '0001520568-22-000004'],
        filingDate: ['2022-05-27', '2022-05-26'],
        reportDate: ['2022-03-31', '2022-03-31'],
        primaryDocument: ['primary_doc.xml', 'primary_doc.xml'],
      },
      files: [],
    },
  };
  nock(DATA_SEC).get('/submissions/CIK0001520568.json').reply(200, submissions);
  nock(SEC)
    .get(/\/Archives\/edgar\/data\/1520568\/00015205682200000[45]\/primary_doc\.xml/)
    .times(2)
    .reply(200, ci, { 'Content-Type': 'text/xml' });
  const res = await request(app).get('/api/fund-series?cik=1520568');
  assert.equal(res.body.multiSeries, false, 'both filings are the same fund → nothing to choose between');
  assert.deepEqual(res.body.series, []);
});

// ── real T. Rowe Price filing where <name> is the literal "N/A" ─────────────

test('real T. Rowe NPORT-P (Global Stock Fund, 2024-10-31): holdings named "N/A" are found by company search via their title, and carry series and instrument ids', async () => {
  const xml = await parseXml('nport_trowe_na_names.xml');
  const found = extractHoldings(xml, 'Databricks');
  assert.deepEqual(
    found.map(h => [h.name, h.shares, Math.round(h.pricePerShare * 100) / 100, h.seriesName]),
    [
      ['DATABRICKS INC PP', 307914, 87.37, 'T. Rowe Price Global Stock Fund'],
      ['DATABRICKS SER I CVT PFD STOCK PP', 37125, 87.37, 'T. Rowe Price Global Stock Fund'],
    ],
    'searching "Databricks" found nothing before: <name> was "N/A" and only name/issuer/ticker were searched'
  );
  assert.equal(extractHoldings(xml, 'Lightmatter').length, 1);

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
