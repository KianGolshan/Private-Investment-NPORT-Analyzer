// End-to-end UI flows for Single Security, Batch Search, Watchlist and Private
// Credit — the real public/index.html + app.js in jsdom, backend mocked at the
// fetch boundary (test/helpers/fakes.js), charts recorded by a fake Chart.
// Covers: validation, empty/error states, rendering, filters, reference lines,
// stale-search races, URL deep-links, CSV export contents, and escaping.
//
// Run with: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers/loadApp');
const { mockBackend, nportHit, holding, creditHolding, jsonResponse } = require('./helpers/fakes');

const tick = (window, ms = 30) => new Promise(r => window.setTimeout(r, ms));
const msg = document => document.getElementById('msgBox').textContent;

// Three funds each holding ACME at different marks/dates.
function acmeBackend(extra = {}) {
  const hits = [
    nportHit({ cik: '1', adsh: 'A-1', name: 'Fund One', period: '2024-03-31' }),
    nportHit({ cik: '2', adsh: 'A-2', name: 'Fund Two', period: '2024-06-30' }),
    nportHit({ cik: '3', adsh: 'A-3', name: 'Fund Three', period: '2024-06-30' }),
  ];
  const marks = { 'A-1': 10, 'A-2': 12, 'A-3': 20 };
  const dates = { 'A-1': '2024-03-31', 'A-2': '2024-06-30', 'A-3': '2024-06-30' };
  return mockBackend({
    '/api/config': () => ({ userAgentConfigured: true }),
    '/api/search-nport': () => ({ hits: { hits: hits } }),
    '/api/parse-nport': p => ({
      success: true,
      holdings: [holding({ pps: marks[p.accession], reportDate: dates[p.accession], title: 'ACME INC COM' })],
    }),
    ...extra,
  });
}

// ── tabs & deep links ───────────────────────────────────────────────────────

test('switchTab: only the chosen tab is active and the others are hidden', async () => {
  const { window, document } = await loadApp();
  for (const tab of ['single', 'batch', 'credit', 'watchlist', 'xray']) {
    window.switchTab(tab);
    const active = [...document.querySelectorAll('.tab-content')].filter(t => t.classList.contains('active'));
    assert.equal(active.length, 1, `exactly one active panel for ${tab}`);
    assert.equal(active[0].id, tab + 'Tab');
  }
});

test('deep link ?security= prefills and auto-runs Single Security', async () => {
  const calls = [];
  const { window, document } = await loadApp({
    url: 'http://localhost/?security=Acme&limit=25',
    fetchImpl:
      acmeBackend() &&
      mockBackend({ '/api/config': () => ({}), '/api/search-nport': () => ({ hits: { hits: [] } }) }, calls),
  });
  await tick(window);
  assert.equal(document.getElementById('securityInput').value, 'Acme');
  assert.equal(document.getElementById('filingLimit').value, '25');
  assert.ok(calls.some(u => u.includes('/api/search-nport?security=Acme')));
});

test('deep link ?tab=credit&issuer= switches tab and runs Private Credit; bare ?tab=xray just switches', async () => {
  const calls = [];
  const a = await loadApp({
    url: 'http://localhost/?tab=credit&issuer=Acme&limit=40',
    fetchImpl: mockBackend({ '/api/config': () => ({}), '/api/search-10q': () => ({ filings: [] }) }, calls),
  });
  await tick(a.window);
  assert.ok(a.document.getElementById('creditTab').classList.contains('active'));
  assert.equal(a.document.getElementById('creditFilingLimit').value, '40');
  assert.ok(calls.some(u => u.includes('/api/search-10q?issuer=Acme')));

  const b = await loadApp({ url: 'http://localhost/?tab=xray' });
  assert.ok(b.document.getElementById('xrayTab').classList.contains('active'));
});

test('deep link with a hostile ?security= value never injects markup', async () => {
  const { window, document } = await loadApp({
    url: 'http://localhost/?security=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E',
    fetchImpl: mockBackend({ '/api/config': () => ({}), '/api/search-nport': () => ({ hits: { hits: [] } }) }),
  });
  await tick(window);
  assert.equal(document.querySelectorAll('#msgBox img, #resultsContainer img').length, 0);
});

// ── Single Security ─────────────────────────────────────────────────────────

test('searchNPORT: empty input asks for a name and makes no request', async () => {
  const calls = [];
  const { window, document } = await loadApp({ fetchImpl: mockBackend({ '/api/config': () => ({}) }, calls) });
  document.getElementById('securityInput').value = '   ';
  await window.searchNPORT();
  assert.match(msg(document), /enter a security/i);
  assert.equal(calls.filter(u => u.includes('search-nport')).length, 0);
});

test('searchNPORT: no filings → error message, no results, no charts', async () => {
  const { window, document } = await loadApp({
    fetchImpl: mockBackend({ '/api/config': () => ({}), '/api/search-nport': () => ({ hits: { hits: [] } }) }),
  });
  document.getElementById('securityInput').value = 'Nothing';
  await window.searchNPORT();
  assert.match(msg(document), /No NPORT-P filings found/);
  assert.equal(document.getElementById('resultsContainer').innerHTML, '');
  assert.equal(window.Chart.instances.length, 0);
});

test('searchNPORT: renders stats, one card per fund, a chart, and the filter/reference panels', async () => {
  const { window, document } = await loadApp({ fetchImpl: acmeBackend() });
  document.getElementById('securityInput').value = 'ACME';
  await window.searchNPORT();
  await tick(window);

  assert.match(msg(document), /Found 3 holding\(s\) across 3 fund\(s\)/);
  assert.equal(document.querySelectorAll('.fund-card').length, 3);
  assert.equal(window.Chart.instances.length, 1);
  assert.equal(document.getElementById('dateFilterPanel').style.display, 'block');
  assert.equal(document.getElementById('referencePanel').style.display, 'block');
  const stats = document.getElementById('statsGrid').textContent;
  assert.match(stats, /\$20\.00/, 'max mark shown in range');
  assert.match(stats, /\$10\.00/, 'min mark shown in range');
  assert.equal(window.location.search.includes('security=ACME'), true, 'URL updated for sharing');
});

test('searchNPORT: partial parse failures are reported as a warning, not hidden', async () => {
  const backend = acmeBackend({
    '/api/parse-nport': p =>
      p.accession === 'A-2'
        ? { success: false, holdings: [], error: 'boom' }
        : { success: true, holdings: [holding({ pps: 10, reportDate: '2024-06-30' })] },
  });
  const { window, document } = await loadApp({ fetchImpl: backend });
  document.getElementById('securityInput').value = 'ACME';
  await window.searchNPORT();
  await tick(window);
  assert.ok(document.querySelector('#msgBox .alert-warning'));
  assert.match(msg(document), /1 filing\(s\) failed to parse/);
});

test('searchNPORT: a network failure surfaces as an error, never a blank page', async () => {
  const { window, document } = await loadApp({
    fetchImpl: mockBackend({
      '/api/config': () => ({}),
      '/api/search-nport': () => jsonResponse({}, { ok: false, status: 500 }),
    }),
  });
  document.getElementById('securityInput').value = 'ACME';
  await window.searchNPORT();
  assert.match(msg(document), /Error: HTTP 500/);
});

test('searchNPORT: a 429 gets the friendly rate-limit message', async () => {
  const { window, document } = await loadApp({
    fetchImpl: mockBackend({
      '/api/config': () => ({}),
      '/api/search-nport': () => jsonResponse({}, { ok: false, status: 429 }),
    }),
  });
  document.getElementById('securityInput').value = 'ACME';
  await window.searchNPORT();
  assert.match(msg(document), /Too many requests/);
});

test('searchNPORT: an older, slower search never overwrites a newer one', async () => {
  let release;
  const gate = new Promise(r => (release = r));
  const backend = mockBackend({
    '/api/config': () => ({}),
    '/api/search-nport': async p => {
      if (p.security === 'SLOW') await gate;
      return { hits: { hits: [nportHit({ cik: '9', adsh: 'X-' + p.security, name: 'Fund ' + p.security })] } };
    },
    '/api/parse-nport': p => ({
      success: true,
      holdings: [holding({ name: p.security, title: p.security + ' COM', instrumentKey: p.security })],
    }),
  });
  const { window, document } = await loadApp({ fetchImpl: backend });
  document.getElementById('securityInput').value = 'SLOW';
  const slow = window.searchNPORT();
  document.getElementById('securityInput').value = 'FAST';
  await window.searchNPORT();
  release();
  await slow;
  await tick(window);
  assert.match(document.getElementById('resultsContainer').textContent, /Fund FAST/);
  assert.doesNotMatch(document.getElementById('resultsContainer').textContent, /Fund SLOW/);
});

test('mixed instrument types split into separate sections with an explanatory banner', async () => {
  const backend = acmeBackend({
    '/api/parse-nport': p =>
      p.accession === 'A-1'
        ? {
            success: true,
            holdings: [
              holding({ title: 'ACME PFD', instrumentLabel: 'Preferred' }),
              holding({
                title: 'ACME TL 7%',
                instrumentType: 'debt',
                instrumentLabel: 'Term Loan',
                chartUnit: 'pct_of_par',
                chartValue: 98,
              }),
            ],
          }
        : { success: true, holdings: [] },
  });
  const { window, document } = await loadApp({ fetchImpl: backend });
  document.getElementById('securityInput').value = 'ACME';
  await window.searchNPORT();
  await tick(window);
  assert.equal(document.querySelectorAll('.instrument-section').length, 2);
  assert.match(document.getElementById('resultsContainer').textContent, /aren't directly comparable/);
  assert.equal(window.Chart.instances.length, 2);
});

test('date filter hides out-of-range rows, updates the count, and Clear restores them', async () => {
  const { window, document } = await loadApp({ fetchImpl: acmeBackend() });
  document.getElementById('securityInput').value = 'ACME';
  await window.searchNPORT();
  await tick(window);

  document.getElementById('startDate').value = '2024-06-01';
  document.getElementById('endDate').value = '2024-12-31';
  window.applyDateFilter();
  assert.match(msg(document), /2 data point\(s\) visible/);
  assert.equal(document.querySelectorAll('tr.row-hidden').length, 1);

  window.clearDateFilter();
  assert.match(msg(document), /3 data point\(s\) visible/);
  assert.equal(document.querySelectorAll('tr.row-hidden').length, 0);
});

test('reference price: rejects junk, then adds a divergence stat vs the peer median; Clear removes it', async () => {
  const { window, document } = await loadApp({ fetchImpl: acmeBackend() });
  document.getElementById('securityInput').value = 'ACME';
  await window.searchNPORT();
  await tick(window);

  for (const bad of ['', 'abc', '-5', '0']) {
    document.getElementById('referencePrice').value = bad;
    window.applyReference();
    assert.match(msg(document), /valid positive reference price/, `rejects "${bad}"`);
  }
  document.getElementById('referencePrice').value = '15';
  window.applyReference();
  assert.match(document.getElementById('statsGrid').textContent, /Reference vs Peer Median/);
  window.clearReference();
  assert.doesNotMatch(document.getElementById('statsGrid').textContent, /Reference vs Peer Median/);
});

test('class chips: toggling a chip hides that class everywhere and re-plots', async () => {
  const backend = acmeBackend({
    '/api/parse-nport': p => ({
      success: true,
      holdings: [
        holding({ instrumentLabel: 'Preferred A', title: 'P-' + p.accession, instrumentKey: 'P' + p.accession }),
        holding({ instrumentLabel: 'Common', title: 'C-' + p.accession, instrumentKey: 'C' + p.accession }),
      ],
    }),
  });
  const { window, document } = await loadApp({ fetchImpl: backend });
  document.getElementById('securityInput').value = 'ACME';
  await window.searchNPORT();
  await tick(window);
  const chips = [...document.querySelectorAll('.class-chips .chip')];
  assert.deepEqual(chips.map(c => c.textContent).sort(), ['Common', 'Preferred A']);
  const updatesBefore = window.Chart.instances[0].updates;
  window.toggleClassChip(chips.find(c => c.textContent === 'Common'));
  const hidden = [...document.querySelectorAll('tr.row-hidden')];
  assert.equal(hidden.length, 3);
  assert.ok(hidden.every(r => r.dataset.label === 'Common'));
  assert.ok(window.Chart.instances[0].updates > updatesBefore);
});

test('Single Security CSV export contains only visible rows and escapes quotes', async () => {
  const backend = acmeBackend({
    '/api/parse-nport': p => ({
      success: true,
      holdings: [
        holding({
          title: 'ACME "QUOTED" COM',
          pps: 10,
          reportDate: p.accession === 'A-1' ? '2024-03-31' : '2024-06-30',
        }),
      ],
    }),
  });
  const { window, document } = await loadApp({ fetchImpl: backend });
  let captured;
  window.downloadBlob = (content, type, filename) => (captured = { content, type, filename });
  document.getElementById('securityInput').value = 'ACME';
  await window.searchNPORT();
  await tick(window);
  document.getElementById('startDate').value = '2024-06-01';
  window.applyDateFilter();
  window.doExportCSV();
  const lines = captured.content.split('\n');
  assert.equal(captured.type, 'text/csv');
  assert.match(captured.filename, /^nport_single_.*\.csv$/);
  assert.equal(lines.length, 1 + 2, 'header + the two in-range rows');
  assert.ok(lines[1].includes('"ACME ""QUOTED"" COM"'));
});

// ── Batch & Watchlist ───────────────────────────────────────────────────────

test('searchBatch: validates empty input and the 10-security cap', async () => {
  const { window, document } = await loadApp({ fetchImpl: acmeBackend() });
  document.getElementById('batchInput').value = '  \n ';
  await window.searchBatch();
  assert.match(msg(document), /at least one security/i);
  document.getElementById('batchInput').value = Array.from({ length: 11 }, (_, i) => 'S' + i).join('\n');
  await window.searchBatch();
  assert.match(msg(document), /Maximum 10/);
});

test('searchBatch: one section per security that has holdings, plus a leaderboard; misses are counted', async () => {
  const backend = mockBackend({
    '/api/config': () => ({}),
    '/api/search-nport': p => ({
      hits: {
        hits:
          p.security === 'GHOST' ? [] : [nportHit({ cik: '1', adsh: 'B-' + p.security, name: 'Fund ' + p.security })],
      },
    }),
    '/api/parse-nport': p => ({
      success: true,
      holdings: [holding({ title: p.security + ' COM', instrumentKey: p.security, pps: 50 })],
    }),
  });
  const { window, document } = await loadApp({ fetchImpl: backend });
  document.getElementById('batchInput').value = 'ALPHA\nBETA\nGHOST';
  await window.searchBatch();
  await tick(window);
  assert.match(msg(document), /holdings for 2 of 3 securities/);
  assert.equal(document.querySelectorAll('[id^="secsection_"]').length, 2);
  assert.ok(document.getElementById('basketLeaderboard'));
  assert.equal(document.getElementById('batchDateFilterPanel').style.display, 'block');
});

test('searchBatch: nothing found anywhere → a single clear error', async () => {
  const { window, document } = await loadApp({
    fetchImpl: mockBackend({ '/api/config': () => ({}), '/api/search-nport': () => ({ hits: { hits: [] } }) }),
  });
  document.getElementById('batchInput').value = 'A\nB';
  await window.searchBatch();
  assert.match(msg(document), /No holdings found for any/);
});

test('watchlist: add, de-dupe (case-insensitive), persist, remove, and escape names', async () => {
  const { window, document } = await loadApp();
  const input = document.getElementById('watchlistInput');
  input.value = 'Anthropic';
  window.addWatchlistItem();
  input.value = 'anthropic';
  window.addWatchlistItem();
  assert.match(msg(document), /already on your watchlist/);
  input.value = '<b>Evil</b>';
  window.addWatchlistItem();

  assert.deepEqual(JSON.parse(window.localStorage.getItem('nportWatchlist')), ['Anthropic', '<b>Evil</b>']);
  assert.equal(document.getElementById('watchlistCount').textContent, '2');
  assert.equal(document.querySelectorAll('#watchlistItems b').length, 0, 'names are escaped');
  assert.equal(document.getElementById('watchlistRunBtn').disabled, false);

  window.removeWatchlistItem('Anthropic');
  window.removeWatchlistItem('<b>Evil</b>');
  assert.equal(document.getElementById('watchlistCount').textContent, '0');
  assert.equal(document.getElementById('watchlistRunBtn').disabled, true);
  assert.match(document.getElementById('watchlistItems').textContent, /No issuers saved yet/);
});

test('watchlist: survives corrupted localStorage and an empty run is refused', async () => {
  const { window, document } = await loadApp();
  window.localStorage.setItem('nportWatchlist', '{not json');
  assert.equal(window.getWatchlist().length, 0);
  await window.runWatchlist();
  assert.match(msg(document), /watchlist is empty/i);
});

test('watchlist run uses the watchlist date-filter panel, not the batch one', async () => {
  const { window, document } = await loadApp({ fetchImpl: acmeBackend() });
  window.localStorage.setItem('nportWatchlist', JSON.stringify(['ACME']));
  window.switchTab('watchlist');
  await window.runWatchlist();
  await tick(window);
  assert.equal(document.getElementById('watchlistDateFilterPanel').style.display, 'block');
  assert.notEqual(document.getElementById('batchDateFilterPanel').style.display, 'block');
});

test('batch reference price is per security and validated', async () => {
  const { window, document } = await loadApp({ fetchImpl: acmeBackend() });
  document.getElementById('batchInput').value = 'ACME';
  await window.searchBatch();
  await tick(window);
  const input = document.querySelector('[id^="ref_"]');
  input.value = 'x';
  window.applyBatchReference('ACME', input.id);
  assert.match(msg(document), /valid positive reference price/);
  input.value = '11';
  window.applyBatchReference('ACME', input.id);
  assert.match(document.getElementById('statsGrid_ACME').textContent, /Reference vs Peer Median/);
  window.clearBatchReference('ACME', input.id);
  assert.doesNotMatch(document.getElementById('statsGrid_ACME').textContent, /Reference vs Peer Median/);
});

// ── Private Credit ──────────────────────────────────────────────────────────

function creditBackend(overrides = {}) {
  return mockBackend({
    '/api/config': () => ({}),
    '/api/search-10q': () => ({
      bdcFunds: ['Alpha BDC', 'Beta BDC'],
      confirmed: 2,
      filings: [
        { cik: '1', accession: 'C-1', company: 'Alpha BDC', period: '2024-03-31', confirmed: true },
        { cik: '1', accession: 'C-2', company: 'Alpha BDC', period: '2024-06-30', confirmed: true },
        { cik: '2', accession: 'C-3', company: 'Beta BDC', period: '2024-06-30', confirmed: false },
      ],
    }),
    '/api/parse-10q': p => ({
      success: true,
      holdings: [
        creditHolding({
          reportDate: p.reportDate,
          fairValueMark: { 'C-1': 99, 'C-2': 92, 'C-3': 88 }[p.accession],
          principal: 1e6,
          fairValue: { 'C-1': 990000, 'C-2': 920000, 'C-3': 880000 }[p.accession],
        }),
      ],
    }),
    ...overrides,
  });
}

test('searchPrivateCredit: validates input; empty and error states are explicit', async () => {
  const a = await loadApp({ fetchImpl: creditBackend({ '/api/search-10q': () => ({ filings: [] }) }) });
  await a.window.searchPrivateCredit();
  assert.match(msg(a.document), /enter an issuer/i);
  a.document.getElementById('creditIssuerInput').value = 'Nobody';
  await a.window.searchPrivateCredit();
  assert.match(msg(a.document), /No BDC 10-Q filings found/);

  const b = await loadApp({
    fetchImpl: creditBackend({ '/api/parse-10q': () => ({ success: true, holdings: [] }) }),
  });
  b.document.getElementById('creditIssuerInput').value = 'Acme';
  await b.window.searchPrivateCredit();
  assert.match(msg(b.document), /No schedule of investments data found/);
});

test('searchPrivateCredit: renders per-BDC cards, stats, a chart and both panels', async () => {
  const { window, document } = await loadApp({ fetchImpl: creditBackend() });
  document.getElementById('creditIssuerInput').value = 'Acme';
  await window.searchPrivateCredit();
  await tick(window);
  assert.match(msg(document), /3 holding tranche\(s\) across 2 BDC fund\(s\)/);
  const html = document.getElementById('resultsContainer').textContent;
  assert.match(html, /Alpha BDC/);
  assert.match(html, /Beta BDC/);
  assert.equal(document.getElementById('creditDateFilterPanel').style.display, 'block');
  assert.equal(document.getElementById('creditReferencePanel').style.display, 'block');
  assert.ok(window.Chart.instances.length >= 1);
});

test('private credit: date filter, reference mark, and CSV export reflect what is visible', async () => {
  const { window, document } = await loadApp({ fetchImpl: creditBackend() });
  let captured;
  window.downloadBlob = (content, type, filename) => (captured = { content, filename });
  document.getElementById('creditIssuerInput').value = 'Acme';
  await window.searchPrivateCredit();
  await tick(window);

  document.getElementById('creditReferenceMark').value = '95';
  window.applyCreditReference();
  assert.match(document.getElementById('resultsContainer').textContent, /Reference/);
  window.clearCreditReference();

  document.getElementById('creditStartDate').value = '2024-06-01';
  window.applyCreditDateFilter();
  window.doCreditExportCSV();
  const lines = captured.content.trim().split('\n');
  assert.equal(lines.length, 1 + 2, 'header + the two June rows');
  assert.match(captured.filename, /\.csv$/);
});

test('private credit: a hostile company name in results is escaped', async () => {
  const backend = creditBackend({
    '/api/search-10q': () => ({
      bdcFunds: ['<img src=x onerror=alert(1)>'],
      confirmed: 1,
      filings: [
        { cik: '1', accession: 'C-1', company: '<img src=x onerror=alert(1)>', period: '2024-03-31', confirmed: true },
      ],
    }),
  });
  const { window, document } = await loadApp({ fetchImpl: backend });
  document.getElementById('creditIssuerInput').value = 'Acme';
  await window.searchPrivateCredit();
  await tick(window);
  assert.equal(document.querySelectorAll('#resultsContainer img, #msgBox img').length, 0);
});

test('clearResults destroys every chart it created (no leaked canvases between searches)', async () => {
  const { window, document } = await loadApp({ fetchImpl: acmeBackend() });
  document.getElementById('securityInput').value = 'ACME';
  await window.searchNPORT();
  await tick(window);
  const first = [...window.Chart.instances];
  assert.ok(first.length >= 1);
  await window.searchNPORT();
  await tick(window);
  assert.ok(
    first.every(c => c.destroyed),
    'previous search charts destroyed'
  );
});
