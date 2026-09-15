// Fund X-Ray browser-side test suite: the "Top Funds" dropdown, the
// search -> filings -> render pipeline, QoQ/YoY period comparison, and CSV
// export — none of which parsers.test.js or server.test.js exercise, since
// those cover the pure extraction math and the Express routes respectively.
// This is the third leg: the actual public/app.js code that wires the two
// together and puts numbers on screen.
//
// Runs the REAL public/index.html + public/app.js in a jsdom window (see
// test/helpers/loadApp.js) rather than re-implementing any UI logic here —
// every assertion below is checking production code, not a test double of
// it. Network calls are stubbed per-test with explicit fixture payloads
// (never real numbers made up on the spot); several tests specifically
// change one fixture value and confirm the rendered output changes to
// match, as a direct check against silently-hardcoded/stale UI output.
//
// Run with: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers/loadApp');

// Waits for pending microtasks/macrotasks (an in-flight fetchJSON chain,
// e.g. the fire-and-forget async work inside searchFundXray/runFundXray) to
// settle before assertions run.
async function tick(window, ms = 20) {
  await new Promise(resolve => window.setTimeout(resolve, ms));
}

function jsonResponse(body) {
  return { ok: true, json: async () => body };
}

// A minimal-but-realistic Fund X-Ray API payload, with every field the
// renderer reads. Individual tests override specific fields to prove the
// render reacts to THIS data, not a hardcoded default.
function makeXray(overrides = {}) {
  return {
    fund: {
      registrantName: 'Test Fund Trust',
      seriesName: 'Test Growth Fund',
      reportDate: '2024-03-31',
      netAssets: 10_000_000,
    },
    totalHoldingsCount: 40,
    publicHoldingsCount: 38,
    privateHoldingsCount: 2,
    privateValueUSD: 450_000,
    totalValueUSD: 9_500_000,
    privatePctOfNetAssets: 4.5,
    privatePctOfHoldingsValue: 4.7368,
    byInstrumentType: { equity: 400_000, derivative: 50_000 },
    byCountry: { US: 450_000 },
    privateHoldings: [
      {
        name: 'Startco Inc',
        instrumentType: 'equity',
        instrumentLabel: 'Preferred Series C',
        country: 'US',
        fairValLevel: '3',
        shares: 1000,
        pricePerShare: 400,
        pctOfNetAssets: 4.0,
        marketValue: 400_000,
        cusip: '000000000',
        title: 'Preferred Series C',
        isRestrictedSec: 'Y',
      },
      {
        name: 'Warrantco',
        instrumentType: 'derivative',
        instrumentLabel: 'Warrant',
        country: 'US',
        fairValLevel: '3',
        shares: 500,
        pricePerShare: 100,
        pctOfNetAssets: 0.5,
        marketValue: 50_000,
        cusip: '',
        title: 'Warrant expiring 2027',
        isRestrictedSec: 'N',
      },
    ],
    topPrivateHoldings: [],
    ...overrides,
  };
}

function makeFundXrayFetch(xrayByAccession) {
  return async url => {
    const m = url.match(/\/api\/fund-xray\?cik=([^&]+)&accession=([^&]+)/);
    if (m) {
      const accession = decodeURIComponent(m[2]);
      const xray = xrayByAccession[accession];
      if (!xray) return jsonResponse({ success: false, error: 'no fixture for ' + accession });
      return jsonResponse({ success: true, xray, cached: false });
    }
    return jsonResponse({});
  };
}

// ── TOP_FUND_GROUPS data integrity ──────────────────────────────────────────
// This is the entire "index" now (see README's Fund X-Ray section) — a
// hand-curated static list, not derived from anything at runtime. These
// checks guard its basic shape: every group non-empty, every name a real
// non-empty string, no accidental duplicate entries.

test('TOP_FUND_GROUPS: every group is a non-empty array of non-empty, trimmed fund names', async () => {
  const { window } = await loadApp();
  const groups = window.__state.TOP_FUND_GROUPS;
  assert.ok(Object.keys(groups).length >= 30, 'expected a substantial curated list, not a handful of names');

  for (const [manager, funds] of Object.entries(groups)) {
    assert.ok(manager.trim().length > 0, 'manager/group name must not be blank');
    assert.ok(Array.isArray(funds) && funds.length > 0, `${manager}: must list at least one fund`);
    for (const name of funds) {
      assert.equal(typeof name, 'string', `${manager}: fund entry must be a string`);
      assert.equal(name, name.trim(), `${manager}: "${name}" has leading/trailing whitespace`);
      assert.ok(name.length > 0, `${manager}: contains a blank fund name`);
    }
  }
});

test('TOP_FUND_GROUPS: no duplicate fund name appears twice (within or across groups)', async () => {
  const { window } = await loadApp();
  const groups = window.__state.TOP_FUND_GROUPS;
  const seen = new Map(); // lowercased name -> manager
  const dupes = [];
  for (const [manager, funds] of Object.entries(groups)) {
    for (const name of funds) {
      const key = name.toLowerCase();
      if (seen.has(key)) dupes.push(`"${name}" appears under both "${seen.get(key)}" and "${manager}"`);
      else seen.set(key, manager);
    }
  }
  assert.deepEqual(dupes, []);
});

test('TOP_FUND_GROUPS: no duplicate manager/group key', async () => {
  const { window } = await loadApp();
  // Object literal keys are already deduped by JS at parse time (a repeated
  // key silently overwrites the earlier one), so the real risk is TWO
  // differently-spelled keys for the same manager, not a JS-level collision.
  // This at least catches exact-string repeats introduced via merge/edit.
  const groups = window.__state.TOP_FUND_GROUPS;
  const keys = Object.keys(groups);
  assert.equal(new Set(keys.map(k => k.toLowerCase())).size, keys.length);
});

// ── populateTopFundsDropdown() ──────────────────────────────────────────────

test('populateTopFundsDropdown: renders one <option> per fund (single-fund groups bare, multi-fund groups in an <optgroup>), plus a blank placeholder', async () => {
  const { window, document } = await loadApp();
  window.populateTopFundsDropdown();

  const groups = window.__state.TOP_FUND_GROUPS;
  const totalFunds = Object.values(groups).reduce((n, funds) => n + funds.length, 0);
  const multiFundGroups = Object.values(groups).filter(funds => funds.length > 1).length;

  const select = document.getElementById('xrayTopFundsSelect');
  const options = select.querySelectorAll('option');
  const optgroups = select.querySelectorAll('optgroup');

  assert.equal(options.length, totalFunds + 1, 'every fund gets one <option>, plus the "— Pick a fund —" placeholder');
  assert.equal(options[0].value, '', 'first option is the blank placeholder');
  assert.equal(optgroups.length, multiFundGroups);
});

test('populateTopFundsDropdown: a known fund is grouped under its actual manager, with the option value equal to the exact search name', async () => {
  const { window, document } = await loadApp();
  window.populateTopFundsDropdown();
  const select = document.getElementById('xrayTopFundsSelect');

  const option = [...select.querySelectorAll('option')].find(o => o.value === 'SmallCap World Fund');
  assert.ok(option, 'SmallCap World Fund must be present as an option');
  assert.equal(option.closest('optgroup')?.label, 'Capital Group (American Funds)');
});

test('populateTopFundsDropdown: special characters in group/fund names are HTML-escaped, not injected raw', async () => {
  const { window, document } = await loadApp();
  // Real data already exercises this (BlackRock "Science & Technology",
  // "T. Rowe Price" groups use "&" not "and") — assert it round-trips
  // through the DOM as a literal "&", not broken markup or a raw ampersand
  // that could corrupt the surrounding HTML.
  window.populateTopFundsDropdown();
  const select = document.getElementById('xrayTopFundsSelect');
  const option = [...select.querySelectorAll('option')].find(o => o.value.includes('Science & Technology'));
  assert.ok(option, 'a fund with "&" in its name must still be present');
  assert.equal(
    option.textContent,
    option.value,
    'the & must render as a literal ampersand once parsed, not entities or broken tags'
  );
});

// ── selectIndexedFund() ──────────────────────────────────────────────────

test('selectIndexedFund(""): a no-op — no fetch, input left untouched', async () => {
  let fetchCalled = false;
  const { window, document } = await loadApp({
    fetchImpl: async () => jsonResponse({}), // absorbs the init IIFE's own /api/config call
  });
  window.fetch = async () => {
    fetchCalled = true;
    return jsonResponse({});
  };
  document.getElementById('xrayFundInput').value = 'unchanged';
  window.selectIndexedFund('');
  assert.equal(fetchCalled, false);
  assert.equal(document.getElementById('xrayFundInput').value, 'unchanged');
});

test('selectIndexedFund(name): fills the search box and runs the exact same search a manual lookup would (no separate/parallel code path)', async () => {
  const { window, document } = await loadApp();
  const calledUrls = [];
  window.fetch = async url => {
    calledUrls.push(url);
    if (url.includes('/api/search-fund')) {
      return jsonResponse({
        matches: [
          {
            cik: '2043954',
            name: 'REX ETF Trust',
            filings: [{ accession: '0000894189-26-024397', filingDate: '2026-07-15', reportDate: '2026-06-30' }],
          },
        ],
      });
    }
    if (url.includes('/api/fund-xray?')) {
      return jsonResponse({ success: true, xray: makeXray() });
    }
    return jsonResponse({});
  };

  window.selectIndexedFund('REX ETF Trust');
  await tick(window);

  assert.equal(document.getElementById('xrayFundInput').value, 'REX ETF Trust');
  assert.ok(
    calledUrls[0].startsWith('/api/search-fund?fund='),
    'must go through the same /api/search-fund lookup as a manual search'
  );
  assert.ok(
    calledUrls.some(u => u.startsWith('/api/fund-xray?')),
    'must auto-load the resulting filing, same as searchFundXray()'
  );
});

// ── searchFundXray(): merge + sort across multiple CIK matches ────────────
// This merge/sort happens entirely client-side (the server route just
// returns { matches }, one entry per resolved CIK) — a real place for a bug
// to hide, and a path parsers.test.js/server.test.js structurally cannot
// reach.

test('searchFundXray: empty input shows an error and makes no network call', async () => {
  const { window, document } = await loadApp();
  let fetchCalled = false;
  window.fetch = async () => {
    fetchCalled = true;
    return jsonResponse({});
  };
  document.getElementById('xrayFundInput').value = '   ';
  await window.searchFundXray();
  assert.equal(fetchCalled, false);
  assert.match(document.getElementById('msgBox').textContent, /enter a fund/i);
});

test('searchFundXray: no EDGAR match shows the specific not-found guidance, not a generic error', async () => {
  const { window, document } = await loadApp({
    fetchImpl: async url => (url.includes('/api/search-fund') ? jsonResponse({ matches: [] }) : jsonResponse({})),
  });
  document.getElementById('xrayFundInput').value = 'TotallyFakeFundXYZ';
  await window.searchFundXray();
  assert.match(document.getElementById('msgBox').textContent, /No NPORT-P filings found/);
});

test('searchFundXray: filings from MULTIPLE matched CIKs are merged into one list and globally sorted newest-first (not sorted per-match)', async () => {
  const { window, document } = await loadApp({
    fetchImpl: makeCombinedFetch({
      '/api/search-fund': () =>
        jsonResponse({
          matches: [
            {
              cik: '100',
              name: 'Ambiguous Fund Series A',
              filings: [
                { accession: 'A-OLD', filingDate: '2023-01-15', reportDate: '2022-12-31' },
                { accession: 'A-NEW', filingDate: '2024-07-15', reportDate: '2024-06-30' },
              ],
            },
            {
              cik: '200',
              name: 'Ambiguous Fund Series B',
              filings: [{ accession: 'B-MID', filingDate: '2023-10-15', reportDate: '2023-09-30' }],
            },
          ],
        }),
      '/api/fund-xray?': () => jsonResponse({ success: true, xray: makeXray() }),
    }),
  });
  document.getElementById('xrayFundInput').value = 'Ambiguous Fund';
  await window.searchFundXray();
  await tick(window);

  const filings = window.__state.xrayFilings;
  assert.equal(filings.length, 3, 'all filings across both matches must be present');
  // Array.from re-materializes the array in THIS realm — filings is a vm
  // (jsdom window) realm Array, and assert/strict's deepEqual (deepStrictEqual)
  // treats cross-realm arrays as unequal even with identical contents.
  assert.deepEqual(
    Array.from(filings, f => f.accession),
    ['A-NEW', 'B-MID', 'A-OLD'],
    'must be sorted newest-first across BOTH matches combined, not grouped by match'
  );

  // The auto-run after search must load the newest filing across ALL
  // matches — i.e. A-NEW (2024-06-30), not simply the first match's own
  // newest (which would also be A-NEW here, so this also implicitly checks
  // xrayFilingSelect's option order lines up with the sort).
  assert.equal(document.getElementById('xrayFilingSelect').options[0].value, '0');
  assert.match(document.getElementById('xrayFilingSelect').options[0].textContent, /A-NEW|2024-06-30/);

  assert.match(
    document.getElementById('msgBox').textContent,
    /matched 2 funds/,
    'ambiguous-name banner must fire when >1 match'
  );
});

function makeCombinedFetch(routes) {
  return async url => {
    for (const [prefix, handler] of Object.entries(routes)) {
      if (url.includes(prefix)) return handler(url);
    }
    return jsonResponse({});
  };
}

// ── runFundXray(): the render reflects exactly what the API returned ──────
// Each test below changes one input value and checks the corresponding
// rendered figure changes to match — proof the number on screen is threaded
// through from the (mocked) API response, not a stale/hardcoded string.

async function setUpSinglePeriod(xray, { accession = 'ACC-1', period = '2024-03-31' } = {}) {
  const { window, document } = await loadApp({
    fetchImpl: makeCombinedFetch({
      '/api/search-fund': () =>
        jsonResponse({
          matches: [
            {
              cik: '999',
              name: xray.fund.registrantName,
              filings: [{ accession, filingDate: period, reportDate: period }],
            },
          ],
        }),
      '/api/fund-xray?': makeFundXrayFetch({ [accession]: xray }),
    }),
  });
  document.getElementById('xrayFundInput').value = xray.fund.registrantName;
  await window.searchFundXray();
  await tick(window);
  return { window, document };
}

test('runFundXray: Private Equity Exposure stat reflects privateValueUSD exactly (compact-formatted), not a hardcoded figure', async () => {
  const xray = makeXray({ privateValueUSD: 1_234_567 });
  const { document } = await setUpSinglePeriod(xray);
  const html = document.getElementById('resultsContainer').innerHTML;
  assert.match(
    html,
    /\$1\.23M/,
    'must reflect the exact mocked privateValueUSD via fmtCompactCurrency, not any other number'
  );
});

test('runFundXray: changing privateValueUSD between two independent renders changes the on-screen figure accordingly', async () => {
  const lowXray = makeXray({ privateValueUSD: 10_000 });
  const { document: doc1 } = await setUpSinglePeriod(lowXray, { accession: 'ACC-LOW' });
  assert.match(doc1.getElementById('resultsContainer').innerHTML, /\$10\.0K/);

  const highXray = makeXray({ privateValueUSD: 987_000_000 });
  const { document: doc2 } = await setUpSinglePeriod(highXray, { accession: 'ACC-HIGH' });
  assert.match(doc2.getElementById('resultsContainer').innerHTML, /\$987\.00M/);
});

test("runFundXray: every private holding row shows that holding's own name/instrument/country/value — not a placeholder", async () => {
  const xray = makeXray();
  const { document } = await setUpSinglePeriod(xray);
  const html = document.getElementById('resultsContainer').innerHTML;
  assert.match(html, /Startco Inc/);
  assert.match(html, /Preferred Series C/);
  assert.match(html, /Warrantco/);
  assert.match(html, /\$400\.0K|\$400,000|\$400\.00K/); // Startco's marketValue, compact-formatted
});

test('runFundXray: a fund with zero private holdings shows the explicit "no private equity" message, not an empty/broken table', async () => {
  const xray = makeXray({
    privateHoldingsCount: 0,
    privateValueUSD: 0,
    privateHoldings: [],
    byInstrumentType: {},
    byCountry: {},
  });
  const { document } = await setUpSinglePeriod(xray);
  const html = document.getElementById('resultsContainer').innerHTML;
  assert.match(html, /No private equity holdings/);
  assert.doesNotMatch(
    html,
    /<table>[\s\S]*Company[\s\S]*<\/table>/,
    'must not render a holdings table when there are no rows'
  );
});

test('runFundXray: a null privatePctOfNetAssets renders as "—", never "NaN%" or a fabricated 0%', async () => {
  const xray = makeXray({ privatePctOfNetAssets: null });
  const { document } = await setUpSinglePeriod(xray);
  const html = document.getElementById('resultsContainer').innerHTML;
  assert.doesNotMatch(html, /NaN/);
  assert.match(html, /% of Fund Net Assets<\/div>\s*<div class="stat-value">—<\/div>/);
});

test('runFundXray: a holding name containing HTML is escaped in the rendered table, not injected as markup', async () => {
  const xray = makeXray({
    privateHoldings: [
      {
        name: '<img src=x onerror=alert(1)>Evilco',
        instrumentType: 'equity',
        instrumentLabel: 'Common',
        country: 'US',
        fairValLevel: '3',
        shares: 1,
        pricePerShare: 1,
        pctOfNetAssets: 0.1,
        marketValue: 100,
      },
    ],
  });
  const { document } = await setUpSinglePeriod(xray);
  const html = document.getElementById('resultsContainer').innerHTML;
  assert.doesNotMatch(html, /<img/, 'a holding name must never inject a raw HTML tag');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;Evilco/);
});

// ── findXrayComparisonIndex(): QoQ / YoY date-range logic (pure function) ──

function periods(dates) {
  return dates.map((d, i) => ({ cik: '1', accession: 'A' + i, company: 'F', period: d, fileDate: d }));
}

test('findXrayComparisonIndex: QoQ picks the very next (older) filing in the list', async () => {
  // xrayFilings is newest-first, exactly as searchFundXray leaves it. The
  // function reads that module-level state, which only the real search flow
  // can populate (see loadApp.js's note on const/let scoping) — so route a
  // real search through it with these exact periods, then check the pure
  // function directly against case data the assertions can reason about.
  const fakeFilings = periods(['2024-09-30', '2024-06-30', '2024-03-31']);
  const withState = await loadAppWithFilings(fakeFilings);
  assert.equal(withState.window.findXrayComparisonIndex(0, 'qoq'), 1);
  assert.equal(
    withState.window.findXrayComparisonIndex(2, 'qoq'),
    -1,
    'the oldest filing has no older filing to compare against'
  );
});

test('findXrayComparisonIndex: YoY matches the filing closest to 365 days back, within the +/-45 day tolerance', async () => {
  const fakeFilings = periods(['2024-09-30', '2024-06-28', '2023-09-29', '2022-09-30']);
  const withState = await loadAppWithFilings(fakeFilings);
  // 2024-09-30 -> 2023-09-29 is 367 days back (within tolerance) and closer
  // to 365 than 2022-09-30 (731 days back, outside tolerance entirely).
  assert.equal(withState.window.findXrayComparisonIndex(0, 'yoy'), 2);
});

test('findXrayComparisonIndex: YoY returns -1 when nothing falls within the 320-410 day window (a fund with a gap in its filing history)', async () => {
  const fakeFilings = periods(['2024-09-30', '2022-01-15']); // ~2.7 years back, no candidate in range
  const withState = await loadAppWithFilings(fakeFilings);
  assert.equal(withState.window.findXrayComparisonIndex(0, 'yoy'), -1);
});

// Populates the real module-level xrayFilings array by driving one search
// through searchFundXray(), with a stub xray so runFundXray()'s own render
// doesn't error out — used by tests above that need real filings state to
// exercise findXrayComparisonIndex/selectXrayComparison/runFundXrayCompare
// against a controlled set of periods.
async function loadAppWithFilings(filings) {
  const xrayByAccession = {};
  for (const f of filings)
    xrayByAccession[f.accession] = makeXray({ fund: { registrantName: 'F', reportDate: f.period, netAssets: 1000 } });
  const { window, document } = await loadApp({
    fetchImpl: makeCombinedFetch({
      '/api/search-fund': () =>
        jsonResponse({
          matches: [
            {
              cik: '1',
              name: 'F',
              filings: filings.map(f => ({ accession: f.accession, filingDate: f.fileDate, reportDate: f.period })),
            },
          ],
        }),
      '/api/fund-xray?': makeFundXrayFetch(xrayByAccession),
    }),
  });
  document.getElementById('xrayFundInput').value = 'F';
  await window.searchFundXray();
  await tick(window);
  return { window, document, xrayByAccession };
}

// ── QoQ/YoY comparison flow: selectXrayComparison / runFundXrayCompare ────

test('selectXrayComparison(qoq): with only one filing on file, shows "no prior filing" and renders no comparison section', async () => {
  const { window, document } = await loadAppWithFilings(periods(['2024-03-31']));
  await window.selectXrayComparison('qoq');
  assert.match(document.getElementById('msgBox').textContent, /No prior filing available/);
  assert.equal(document.getElementById('xrayCompareResults'), null);
});

test('selectXrayComparison(qoq): fetches the compare route with the correct (current, prior) accession pair and renders totals matching the mocked comparison exactly', async () => {
  const filings = periods(['2024-06-30', '2024-03-31']);
  const { window, document } = await loadAppWithFilings(filings);

  const comparison = {
    current: { reportDate: '2024-06-30', registrantName: 'F', seriesName: '' },
    prior: { reportDate: '2024-03-31', registrantName: 'F', seriesName: '' },
    totals: {
      privateValueUSD: { current: 600_000, prior: 400_000, delta: 200_000, deltaPct: 50 },
      privateHoldingsCount: { current: 3, prior: 2, delta: 1, deltaPct: 50 },
      issuerCount: { current: 3, prior: 2, delta: 1, deltaPct: 50 },
      newCount: 1,
      exitedCount: 0,
      continuingCount: 2,
      valueChangeFromPrice: { amount: 150_000, pct: 37.5 },
      valueChangeFromShares: { amount: 50_000, pct: 12.5 },
      valueChangeOther: { amount: 0 },
    },
    positions: [
      {
        key: 'cusip:1',
        name: 'Newco',
        issuer: 'Newco',
        title: '',
        instrumentType: 'equity',
        instrumentLabel: 'Common',
        country: 'US',
        status: 'new',
        shares: { current: 100, prior: null, delta: null, deltaPct: null },
        marketValue: { current: 200_000, prior: null, delta: null, deltaPct: null },
        pricePerShare: { current: 2000, prior: null, delta: null, deltaPct: null },
        pctOfNetAssets: { current: 2, prior: null, delta: null, deltaPct: null },
        priceEffectUSD: null,
        shareEffectUSD: null,
      },
    ],
    insights: {
      added: { items: [{ name: 'Newco', marketValue: { current: 200_000 } }], total: 1 },
      dropped: { items: [], total: 0 },
      increased: { items: [], total: 0 },
      reduced: { items: [], total: 0 },
      topMarkups: { items: [], total: 0 },
      topMarkdowns: { items: [], total: 0 },
    },
  };

  let compareUrl = null;
  window.fetch = makeCombinedFetch({
    '/api/fund-xray-compare': url => {
      compareUrl = url;
      return jsonResponse({ success: true, comparison, cached: false });
    },
    '/api/fund-xray?': makeFundXrayFetch({
      [filings[1].accession]: makeXray({ fund: { registrantName: 'F', reportDate: '2024-03-31', netAssets: 1000 } }),
    }),
  });

  await window.selectXrayComparison('qoq');
  await tick(window);

  assert.match(
    compareUrl,
    new RegExp(`currentAccession=${filings[0].accession}.*priorAccession=${filings[1].accession}`)
  );
  const html = document.getElementById('resultsContainer').innerHTML;
  assert.match(
    html,
    /\$600\.0K|\$600\.00K/,
    'current private value must reflect the mocked comparison, not the single-period value'
  );
  assert.match(html, /Newco/, 'the newly-added position must be named in the insights');
  assert.match(
    html,
    /Most Recent Period/,
    'the underlying single-period snapshot must be relabeled once a comparison is active'
  );
});

test('runFundXrayCompare: selecting the SAME period on both sides is rejected with a clear error, not sent to the API', async () => {
  const filings = periods(['2024-06-30', '2024-03-31']);
  const { window, document } = await loadAppWithFilings(filings);
  document.getElementById('xrayCompareSelect').innerHTML = '<option value="0">a</option>';
  document.getElementById('xrayCompareSelect').value = '0'; // same as current (xrayFilingSelect defaults to "0")
  let compareFetchCalled = false;
  window.fetch = async url => {
    if (url.includes('/api/fund-xray-compare')) compareFetchCalled = true;
    return jsonResponse({});
  };
  await window.runFundXrayCompare();
  assert.equal(compareFetchCalled, false);
  assert.match(document.getElementById('msgBox').textContent, /Choose two different periods/);
});

// ── CSV export: exported rows match the underlying data exactly ───────────

test('doXrayExportCSV: exported rows contain the exact holding figures from the rendered snapshot (not re-derived/rounded differently)', async () => {
  const xray = makeXray();
  const { window } = await setUpSinglePeriod(xray);

  let captured = null;
  window.downloadBlob = (content, type, filename) => {
    captured = { content, type, filename };
  };
  window.doXrayExportCSV('current');

  assert.ok(captured, 'downloadBlob must be called');
  assert.equal(captured.type, 'text/csv');
  assert.match(captured.content, /Startco Inc/);
  assert.match(captured.content, /400000\.00/, "Startco's exact marketValue must appear, not a compact/rounded form");
  assert.match(captured.content, /Warrantco/);
});

test("doXrayCompareExportCSV: exports the currently active comparison's positions, not the single-period snapshot", async () => {
  const filings = periods(['2024-06-30', '2024-03-31']);
  const { window } = await loadAppWithFilings(filings);

  const comparison = {
    current: { reportDate: '2024-06-30', registrantName: 'F', seriesName: '' },
    prior: { reportDate: '2024-03-31', registrantName: 'F', seriesName: '' },
    totals: {
      privateValueUSD: { current: 1, prior: 1, delta: 0, deltaPct: 0 },
      privateHoldingsCount: { current: 1, prior: 1, delta: 0, deltaPct: 0 },
      issuerCount: { current: 1, prior: 1, delta: 0, deltaPct: 0 },
      newCount: 0,
      exitedCount: 0,
      continuingCount: 1,
      valueChangeFromPrice: { amount: 0, pct: 0 },
      valueChangeFromShares: { amount: 0, pct: 0 },
      valueChangeOther: { amount: 0 },
    },
    positions: [
      {
        key: 'cusip:9',
        name: 'Continuingco',
        issuer: 'Continuingco',
        title: '',
        instrumentType: 'equity',
        instrumentLabel: 'Common',
        country: 'US',
        status: 'held',
        shares: { current: 10, prior: 10, delta: 0, deltaPct: 0 },
        marketValue: { current: 12_345, prior: 12_345, delta: 0, deltaPct: 0 },
        pricePerShare: { current: 1234.5, prior: 1234.5, delta: 0, deltaPct: 0 },
        pctOfNetAssets: { current: 1, prior: 1, delta: 0, deltaPct: 0 },
        priceEffectUSD: 0,
        shareEffectUSD: 0,
      },
    ],
    insights: {
      added: { items: [], total: 0 },
      dropped: { items: [], total: 0 },
      increased: { items: [], total: 0 },
      reduced: { items: [], total: 0 },
      topMarkups: { items: [], total: 0 },
      topMarkdowns: { items: [], total: 0 },
    },
  };

  window.fetch = makeCombinedFetch({
    '/api/fund-xray-compare': () => jsonResponse({ success: true, comparison, cached: false }),
    '/api/fund-xray?': makeFundXrayFetch({
      [filings[1].accession]: makeXray({ fund: { registrantName: 'F', reportDate: '2024-03-31', netAssets: 1000 } }),
    }),
  });
  await window.selectXrayComparison('qoq');
  await tick(window);

  let captured = null;
  window.downloadBlob = (content, type, filename) => {
    captured = { content, type, filename };
  };
  window.doXrayCompareExportCSV();

  assert.ok(captured);
  assert.match(captured.content, /Continuingco/);
  assert.match(captured.content, /12345\.00/);
  assert.match(
    captured.content,
    /1234\.500000/,
    'price-per-share must be exported at full precision (6dp), not compact-rounded'
  );
});
