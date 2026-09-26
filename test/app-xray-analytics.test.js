// Fund X-Ray UI: capital-structure section, the mark-implied returns flow
// (request shape, results, errors, stale runs), and regression tests for the
// unescaped-error-message XSS gap (server `error` strings and exception text
// were interpolated into innerHTML raw).
//
// Run with: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers/loadApp');
const { mockBackend, xrayPayload, jsonResponse } = require('./helpers/fakes');

const tick = (window, ms = 30) => new Promise(r => window.setTimeout(r, ms));
const HOSTILE = '<img src=x onerror=alert(1)>';

function filingList(n) {
  return Array.from({ length: n }, (_, i) => ({
    accession: `0000000000-24-${String(100 - i).padStart(6, '0')}`,
    filingDate: '2024-08-01',
    reportDate: `2024-${String(12 - i).padStart(2, '0')}-31`,
  }));
}

function backend({ filings = filingList(10), xray = xrayPayload(), returns, calls = [], xrayError } = {}) {
  return mockBackend(
    {
      '/api/config': () => ({}),
      '/api/search-fund': () => ({ matches: [{ cik: '555', name: 'Test Fund Inc', filings }], totalMatches: 1 }),
      '/api/fund-xray': () => (xrayError ? { success: false, error: xrayError } : { success: true, xray }),
      '/api/fund-xray-returns': () =>
        returns || {
          success: true,
          returns: {
            positions: [
              {
                title: 'ACME INC PFD A',
                name: 'ACME INC',
                firstDate: '2024-03-31',
                lastDate: '2024-12-31',
                status: 'open',
                invested: 1e6,
                realized: 0,
                currentValue: 1.5e6,
                moic: 1.5,
                irr: 0.4,
                entryIsWindowStart: false,
                lotsUnavailable: false,
                chainedFrom: null,
                events: [],
              },
            ],
            summary: {
              moic: 1.5,
              irr: 0.4,
              invested: 1e6,
              realized: 0,
              currentValue: 1.5e6,
              partialSales: 0,
              leftPrivateBook: 0,
              positionCount: 1,
              periodCount: 8,
              windowStartCount: 0,
              excludedCount: 0,
              firstDate: '2024-03-31',
              lastDate: '2024-12-31',
            },
          },
        },
    },
    calls
  );
}

async function openFund(fetchImpl) {
  const app = await loadApp({ fetchImpl });
  app.document.getElementById('xrayFundInput').value = 'Test Fund';
  await app.window.searchFundXray();
  await tick(app.window);
  return app;
}

test('capital structure section renders for multi-tranche issuers and is absent otherwise', async () => {
  const withCs = xrayPayload({
    capitalStructure: [
      {
        issuer: 'KANDOU HOLDING SA',
        totalValueUSD: 7.15e6,
        pctOfNetAssets: 0.4,
        debtPctOfExposure: 84.6,
        weightedDebtCouponPct: 7,
        multiTranche: true,
        instruments: [
          {
            title: 'KANDOU TL 7.0% 03-31-26',
            instrumentType: 'debt',
            instrumentLabel: 'Term Loan',
            marketValue: 6.05e6,
            couponPct: 7,
            maturity: '03-31-26',
          },
          { title: 'KANDOU PFD SER D', instrumentType: 'equity', instrumentLabel: 'Preferred D', marketValue: 1.1e6 },
        ],
      },
    ],
  });
  const a = await openFund(backend({ xray: withCs }));
  const text = a.document.getElementById('resultsContainer').textContent;
  assert.match(text, /Capital Structure by Private Issuer/);
  assert.match(text, /KANDOU HOLDING SA/);
  assert.match(text, /84\.6% debt/);

  const b = await openFund(backend());
  assert.doesNotMatch(b.document.getElementById('resultsContainer').textContent, /Capital Structure by Private Issuer/);
});

test('mark-implied returns: requests the last 8 filings from the selected period, oldest-safe, with the right CIK', async () => {
  const calls = [];
  const { window, document } = await openFund(backend({ calls }));
  document.getElementById('xrayFilingSelect').value = '1';
  await window.runXrayReturns();
  await tick(window);
  const url = new URL(
    calls.find(u => u.includes('fund-xray-returns')),
    'http://localhost'
  );
  assert.equal(url.searchParams.get('cik'), '555');
  const accs = url.searchParams.get('accessions').split(',');
  assert.equal(accs.length, 8);
  assert.equal(accs[0], window.__state.xrayFilings[1].accession, 'starts at the selected period');
  const out = document.getElementById('xrayReturnsResult').textContent;
  assert.match(out, /1\.50×/);
  assert.match(out, /proxies built from the fund/);
  assert.equal(document.getElementById('xrayReturnsBtn').disabled, false, 'button re-enabled after the run');
});

test('mark-implied returns: fewer than two filings is explained, not requested', async () => {
  const calls = [];
  const { window, document } = await openFund(backend({ filings: filingList(1), calls }));
  await window.runXrayReturns();
  assert.match(document.getElementById('xrayReturnsResult').textContent, /at least two filings/);
  assert.equal(calls.filter(u => u.includes('fund-xray-returns')).length, 0);
});

test('mark-implied returns: server failure is shown, escaped, and re-enables the button', async () => {
  const { window, document } = await openFund(backend({ returns: { success: false, error: HOSTILE } }));
  await window.runXrayReturns();
  await tick(window);
  const out = document.getElementById('xrayReturnsResult');
  assert.match(out.textContent, /Request failed|<img/);
  assert.equal(out.querySelectorAll('img').length, 0);
  assert.equal(document.getElementById('xrayReturnsBtn').disabled, false);
});

test('mark-implied returns: a result that arrives after a new search is discarded', async () => {
  let release;
  const gate = new Promise(r => (release = r));
  const base = backend();
  const fetchImpl = async url => (url.includes('fund-xray-returns') ? (await gate, base(url)) : base(url));
  const { window, document } = await openFund(fetchImpl);
  const pending = window.runXrayReturns();
  document.getElementById('xrayFundInput').value = 'Test Fund';
  await window.searchFundXray();
  release();
  await pending;
  await tick(window);
  assert.equal(
    document.getElementById('xrayReturnsResult').textContent,
    '',
    'stale returns must not render into the new view'
  );
});

test('returns panel appears on the current snapshot only, not on a prior-period snapshot', async () => {
  const { window, document } = await openFund(backend());
  document.getElementById('xrayCompareSelect').value = '1';
  // Comparison route isn't mocked (404) — build the prior snapshot directly.
  await window.renderPriorXraySnapshot(window.__state.xrayFilings[1]);
  const prior = document.getElementById('xraySnapshotPrior');
  assert.ok(prior);
  assert.equal(prior.querySelector('#xrayReturnsBtn'), null);
  assert.equal(document.querySelectorAll('#xrayReturnsBtn').length, 1);
});

// ── escaping regressions ────────────────────────────────────────────────────

test('runFundXray: a hostile server `error` string is escaped, not injected', async () => {
  const { document } = await openFund(backend({ xrayError: HOSTILE }));
  const box = document.getElementById('msgBox');
  assert.equal(box.querySelectorAll('img').length, 0);
  assert.match(box.textContent, /Error: <img/, 'shown literally as text');
});

test('runFundXrayCompare: a hostile comparison error is escaped', async () => {
  const fetchImpl = mockBackend({
    '/api/config': () => ({}),
    '/api/search-fund': () => ({ matches: [{ cik: '1', name: 'F', filings: filingList(3) }] }),
    '/api/fund-xray': () => ({ success: true, xray: xrayPayload() }),
    '/api/fund-xray-compare': () => ({ success: false, error: HOSTILE }),
  });
  const { window, document } = await openFund(fetchImpl);
  document.getElementById('xrayCompareSelect').value = '1';
  await window.runFundXrayCompare();
  assert.equal(document.querySelectorAll('#msgBox img').length, 0);
  assert.match(document.getElementById('msgBox').textContent, /Error: <img/);
});

test('network exceptions with markup in the message are escaped in every search flow', async () => {
  const boom = async () => {
    throw new Error(HOSTILE);
  };
  const a = await loadApp({ fetchImpl: boom });
  a.document.getElementById('securityInput').value = 'x';
  await a.window.searchNPORT();
  a.document.getElementById('creditIssuerInput').value = 'x';
  await a.window.searchPrivateCredit();
  a.document.getElementById('xrayFundInput').value = 'x';
  await a.window.searchFundXray();
  assert.equal(a.document.querySelectorAll('#msgBox img').length, 0);
  assert.match(a.document.getElementById('msgBox').textContent, /Error: <img/);
});

test('fetchJSON: a non-JSON 200 rejects rather than hanging the UI', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => {
      throw new SyntaxError('Unexpected token <');
    },
  });
  const { window, document } = await loadApp({ fetchImpl });
  document.getElementById('securityInput').value = 'x';
  await window.searchNPORT();
  assert.match(document.getElementById('msgBox').textContent, /Error: Unexpected token/);
  void jsonResponse;
});

// ── multi-series trusts (real Fidelity Advisor Series I series list) ────────

const REAL_FIDELITY_SERIES = [
  ['S000017684', 'Fidelity Advisor Capital and Income Fund', '2026-07-31'],
  ['S000005121', 'Fidelity Advisor Equity Growth Fund', '2026-05-31'],
  ['S000017683', 'Fidelity Advisor Floating Rate High Income Fund', '2026-07-31'],
  ['S000005111', 'Fidelity Advisor Growth Opportunities Fund', '2026-05-31'],
  ['S000017686', 'Fidelity Advisor Mid Cap II Fund', '2026-06-30'],
].map(([seriesId, seriesName, reportDate], i) => ({
  seriesId,
  seriesName,
  reportDate,
  accession: `0000035402-26-00${6134 - i}`,
}));

function seriesBackend(calls = []) {
  return mockBackend(
    {
      '/api/config': () => ({}),
      '/api/search-fund': () => ({
        matches: [{ cik: '722574', name: 'FIDELITY ADVISOR SERIES I', filings: filingList(4) }],
        totalMatches: 1,
      }),
      '/api/fund-series': () => ({
        cik: '722574',
        registrant: 'FIDELITY ADVISOR SERIES I',
        multiSeries: true,
        series: REAL_FIDELITY_SERIES,
      }),
      '/api/fund-series-filings': p => ({
        cik: '722574',
        seriesId: p.seriesId,
        filings: [
          { accession: '0000035402-26-006134', filingDate: '2026-09-23', reportDate: '2026-07-31' },
          { accession: '0000035402-26-004039', filingDate: '2026-06-26', reportDate: '2026-04-30' },
        ],
      }),
      '/api/fund-xray': () => ({ success: true, xray: xrayPayload() }),
    },
    calls
  );
}

test('multi-series trust: shows a fund picker and does not auto-run a mixed-fund filing list', async () => {
  const calls = [];
  const { window, document } = await loadApp({ fetchImpl: seriesBackend(calls) });
  document.getElementById('xrayFundInput').value = 'Fidelity Advisor Series I';
  await window.searchFundXray();
  await tick(window);

  assert.equal(document.getElementById('xraySeriesGroup').style.display, 'flex');
  const opts = [...document.querySelectorAll('#xraySeriesSelect option')].map(o => o.textContent);
  assert.equal(opts[0], '— choose a fund —');
  assert.equal(opts.length, 1 + REAL_FIDELITY_SERIES.length);
  assert.ok(opts.includes('Fidelity Advisor Capital and Income Fund'));
  assert.deepEqual(opts.slice(1), [...opts.slice(1)].sort(), 'funds listed alphabetically');
  assert.equal(calls.filter(u => u.includes('/api/fund-xray?')).length, 0, 'nothing runs until a fund is chosen');
  assert.match(document.getElementById('msgBox').textContent, /files separately for 5 funds/);
  assert.equal(window.__state.xrayFilings.length, 0);
});

test('multi-series trust: choosing a fund loads only that series’ filings and runs the X-Ray on its newest', async () => {
  const calls = [];
  const { window, document } = await loadApp({ fetchImpl: seriesBackend(calls) });
  document.getElementById('xrayFundInput').value = 'Fidelity Advisor Series I';
  await window.searchFundXray();
  await tick(window);

  const select = document.getElementById('xraySeriesSelect');
  const idx = [...select.options].findIndex(o => o.textContent === 'Fidelity Advisor Capital and Income Fund');
  select.value = select.options[idx].value;
  await window.onXraySeriesChange();
  await tick(window);

  const sfCall = calls.find(u => u.includes('/api/fund-series-filings'));
  assert.match(sfCall, /seriesId=S000017684/);
  assert.equal(window.__state.xrayFilings.length, 2, 'only this series’ filings, not the whole trust');
  assert.ok(window.__state.xrayFilings.every(f => f.company === 'Fidelity Advisor Capital and Income Fund'));
  assert.match(
    calls.find(u => u.includes('/api/fund-xray?')),
    /accession=0000035402-26-006134/
  );
  assert.match(document.getElementById('resultsContainer').textContent, /Private Equity Exposure/i);

  // "vs Prior Quarter" now compares within the series (the only other filing is this series' own prior quarter).
  assert.equal(window.findXrayComparisonIndex(0, 'qoq'), 1);

  select.value = '';
  await window.onXraySeriesChange();
  assert.equal(document.getElementById('resultsContainer').innerHTML, '');
});

test('single-series registrants (fund-series says multiSeries:false) keep the original one-step flow', async () => {
  const fetchImpl = mockBackend({
    '/api/config': () => ({}),
    '/api/search-fund': () => ({
      matches: [{ cik: '858744', name: 'SMALLCAP WORLD FUND INC', filings: filingList(3) }],
    }),
    '/api/fund-series': () => ({ cik: '858744', multiSeries: false, series: [] }),
    '/api/fund-xray': () => ({ success: true, xray: xrayPayload() }),
  });
  const { window, document } = await loadApp({ fetchImpl });
  document.getElementById('xrayFundInput').value = 'SMALLCAP World Fund';
  await window.searchFundXray();
  await tick(window);
  assert.equal(document.getElementById('xraySeriesGroup').style.display, 'none');
  assert.equal(window.__state.xrayFilings.length, 3);
  assert.match(document.getElementById('resultsContainer').textContent, /Private Equity Exposure/i);
});

test('fund-series lookup failure degrades to the original flow instead of blocking the search', async () => {
  const fetchImpl = mockBackend({
    '/api/config': () => ({}),
    '/api/search-fund': () => ({ matches: [{ cik: '1', name: 'X', filings: filingList(2) }] }),
    '/api/fund-series': () => jsonResponse({}, { ok: false, status: 500 }),
    '/api/fund-xray': () => ({ success: true, xray: xrayPayload() }),
  });
  const { window, document } = await loadApp({ fetchImpl });
  document.getElementById('xrayFundInput').value = 'X';
  await window.searchFundXray();
  await tick(window);
  assert.equal(window.__state.xrayFilings.length, 2);
  assert.match(document.getElementById('resultsContainer').textContent, /Private Equity Exposure/i);
});

test('export file names are readable (real: "Fidelity_32_Advisor_32_Growth_32_..." came from encoding every symbol as its char code)', async () => {
  const xray = xrayPayload({
    fund: {
      registrantName: 'Fidelity Advisor Series I',
      seriesName: 'Fidelity Advisor Growth Opportunities Fund',
      reportDate: '2026-05-31',
      netAssets: 1e9,
    },
  });
  const { window } = await openFund(backend({ xray }));
  let name;
  window.downloadBlob = (_c, _t, n) => (name = n);
  window.doXrayExportCSV('current');
  assert.match(name, /^fund_xray_Fidelity_Advisor_Growth_Opportunities_Fund_2026_05_31_\d{4}-\d{2}-\d{2}/);
  assert.doesNotMatch(name, /_32_|_45_/);
});

test('a period filed twice (real: SkyBridge G II Fund 2022-03-31, original + re-filing) is listed once, so "vs Prior Quarter" never compares a filing with its own duplicate', async () => {
  const filings = [
    { accession: '0001520568-22-000005', filingDate: '2022-05-27', reportDate: '2022-03-31' },
    { accession: '0001520568-22-000004', filingDate: '2022-05-26', reportDate: '2022-03-31' },
    { accession: '0001520568-21-000009', filingDate: '2021-12-29', reportDate: '2021-12-31' },
    { accession: '0001520568-21-000006', filingDate: '2021-09-28', reportDate: '2021-09-30' },
  ];
  const fetchImpl = mockBackend({
    '/api/config': () => ({}),
    '/api/search-fund': () => ({
      matches: [{ cik: '1520568', name: 'Skybridge G II Fund', filings }],
      totalMatches: 1,
    }),
    '/api/fund-series': () => ({ cik: '1520568', multiSeries: false, series: [] }),
    '/api/fund-xray': () => ({ success: true, xray: xrayPayload() }),
  });
  const { window, document } = await loadApp({ fetchImpl });
  document.getElementById('xrayFundInput').value = 'SkyBridge G II Fund';
  await window.searchFundXray();
  await tick(window);
  const periods = Array.from(window.__state.xrayFilings, f => f.period);
  assert.deepEqual(periods, ['2022-03-31', '2021-12-31', '2021-09-30']);
  assert.equal(window.__state.xrayFilings[0].accession, '0001520568-22-000005', 'the most recently filed copy wins');
  assert.equal(window.findXrayComparisonIndex(0, 'qoq'), 1);
  assert.equal(window.__state.xrayFilings[window.findXrayComparisonIndex(0, 'qoq')].period, '2021-12-31');
});

test('same-period duplicates: when the older copy is listed first, the most recently filed copy still wins (real SkyBridge G II Fund re-filing)', async () => {
  const filings = [
    { accession: '0001520568-22-000004', filingDate: '2022-05-26', reportDate: '2022-03-31' },
    { accession: '0001520568-22-000005', filingDate: '2022-05-27', reportDate: '2022-03-31' },
    { accession: '0001520568-21-000009', filingDate: '2021-12-29', reportDate: '2021-12-31' },
  ];
  const fetchImpl = mockBackend({
    '/api/config': () => ({}),
    '/api/search-fund': () => ({
      matches: [{ cik: '1520568', name: 'Skybridge G II Fund', filings }],
      totalMatches: 1,
    }),
    '/api/fund-series': () => ({ cik: '1520568', multiSeries: false, series: [] }),
    '/api/fund-xray': () => ({ success: true, xray: xrayPayload() }),
  });
  const { window, document } = await loadApp({ fetchImpl });
  document.getElementById('xrayFundInput').value = 'SkyBridge G II Fund';
  await window.searchFundXray();
  await tick(window);
  assert.equal(window.__state.xrayFilings[0].accession, '0001520568-22-000005');
});

test('export file names collapse runs of symbols (real fund: "T. Rowe Price Science & Technology Fund, Inc.")', async () => {
  const xray = xrayPayload({
    fund: {
      registrantName: 'T. Rowe Price Science & Technology Fund, Inc.',
      seriesName: 'T. Rowe Price Science & Technology Fund, Inc.',
      reportDate: '2026-04-30',
      netAssets: 1e9,
    },
  });
  const { window } = await openFund(backend({ xray }));
  let name;
  window.downloadBlob = (_c, _t, n) => (name = n);
  window.doXrayExportCSV('current');
  assert.match(name, /^fund_xray_T_Rowe_Price_Science_Technology_Fund_Inc_2026_04_30_/);
});
