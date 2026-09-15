// Regression tests for a real reflected-XSS gap found in review: several
// showMsg()/showProgress() calls across Single Security, Batch, Private
// Credit, Watchlist, and Fund X-Ray interpolated a raw user-typed string
// straight into innerHTML without the esc() helper already used everywhere
// else in the file. Real impact: applyURLParams() auto-runs a search from
// ?security=... on page load, so an unescaped value here is a genuine
// shareable-link XSS vector, not just a local curiosity.
//
// Also covers the 429 fetchJSON fix: SEC rate-limiting used to surface to
// the user as a bare "HTTP 429" even though the backend already exhausts
// its own retries first.
//
// Uses the same real-app jsdom harness as test/app-xray.test.js (see
// test/helpers/loadApp.js) — every assertion runs against production code.
//
// Run with: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers/loadApp');

function jsonResponse(body) {
  return { ok: true, json: async () => body };
}
async function tick(window, ms = 20) {
  await new Promise(resolve => window.setTimeout(resolve, ms));
}

const XSS_NAME = '<img src=x onerror=alert(1)>Evilco';
const XSS_ESCAPED = '&lt;img src=x onerror=alert(1)&gt;Evilco';

test('searchNPORT: a security name with HTML in it is escaped in the "no holdings found" message', async () => {
  const { window, document } = await loadApp({
    fetchImpl: async url => {
      if (url.includes('/api/search-nport')) {
        return jsonResponse({
          hits: { hits: [{ _source: { ciks: ['1'], adsh: 'A-1', display_names: ['Fund'], file_date: '2024-01-01' } }] },
        });
      }
      if (url.includes('/api/parse-nport')) return jsonResponse({ success: true, holdings: [] });
      return jsonResponse({});
    },
  });
  document.getElementById('securityInput').value = XSS_NAME;
  await window.searchNPORT();
  await tick(window);

  const html = document.getElementById('msgBox').innerHTML;
  assert.doesNotMatch(html, /<img/, 'the raw tag must never appear in the rendered message');
  assert.match(html, new RegExp(XSS_ESCAPED.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('searchPrivateCredit: an issuer name with HTML in it is escaped in the "no schedule of investments" message', async () => {
  const { window, document } = await loadApp({
    fetchImpl: async url => {
      if (url.includes('/api/search-10q')) {
        return jsonResponse({
          filings: [{ cik: '1', accession: 'A-1', company: 'BDC Fund', period: '2024-03-31', confirmed: true }],
          bdcFunds: ['BDC Fund'],
          confirmed: 1,
        });
      }
      if (url.includes('/api/parse-10q')) return jsonResponse({ success: true, holdings: [] });
      return jsonResponse({});
    },
  });
  document.getElementById('creditIssuerInput').value = XSS_NAME;
  await window.searchPrivateCredit();
  await tick(window);

  const html = document.getElementById('msgBox').innerHTML;
  assert.doesNotMatch(html, /<img/);
  assert.match(html, new RegExp(XSS_ESCAPED.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('addWatchlistItem: an issuer name with HTML in it renders as inert text, never a live element, in both the list and the "already on your watchlist" message', async () => {
  const { window, document } = await loadApp();

  const input = document.getElementById('watchlistInput');
  input.value = XSS_NAME;
  window.addWatchlistItem();

  // The real risk surface is the <span> TEXT content (element-injection);
  // data-name="..." is an ATTRIBUTE value, where a literal `<`/`>` is inert
  // HTML and browsers legitimately don't re-escape it on serialization — so
  // the correct check there is no live <img> element, not a raw-string
  // match against innerHTML (which would false-positive on that attribute).
  const container = document.getElementById('watchlistItems');
  assert.equal(container.querySelectorAll('img').length, 0, 'no real <img> element must be created from the name');
  assert.equal(
    container.querySelector('span').textContent,
    XSS_NAME,
    'the name must render as literal text, not be interpreted as markup'
  );

  // Adding the exact same (case-insensitive) name again hits the "already on
  // your watchlist" showMsg() branch instead — this one IS raw innerHTML
  // text content, so the direct <img> substring check is the right one.
  input.value = XSS_NAME.toUpperCase();
  window.addWatchlistItem();
  const msgHtml = document.getElementById('msgBox').innerHTML;
  assert.doesNotMatch(msgHtml, /<img/i);
  assert.match(msgHtml, /&lt;img/i);
});

test('addWatchlistItem: a name containing a double-quote cannot break out of the data-name attribute', async () => {
  const { window, document } = await loadApp();
  const quoteName = '" onclick="alert(1)';
  document.getElementById('watchlistInput').value = quoteName;
  window.addWatchlistItem();

  const btn = document.getElementById('watchlistItems').querySelector('button.btn-red');
  assert.equal(
    btn.getAttribute('data-name'),
    quoteName,
    'the quote must be preserved as data, not used to inject a second attribute'
  );
  assert.equal(
    btn.getAttribute('onclick'),
    'removeWatchlistItem(this.dataset.name)',
    'the real onclick handler must be untouched'
  );
});

test('quickAddToWatchlist: the "Added ..." confirmation escapes HTML in the name', async () => {
  const { window, document } = await loadApp();
  document.getElementById('securityInput').value = XSS_NAME;
  window.quickAddToWatchlist('securityInput');
  const html = document.getElementById('msgBox').innerHTML;
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test('Fund X-Ray: the ambiguous-match banner escapes HTML in the searched fund name', async () => {
  const { window, document } = await loadApp({
    fetchImpl: async url => {
      if (url.includes('/api/search-fund')) {
        return jsonResponse({
          matches: [
            {
              cik: '1',
              name: 'Fund A',
              filings: [{ accession: 'A-1', filingDate: '2024-01-01', reportDate: '2023-12-31' }],
            },
            {
              cik: '2',
              name: 'Fund B',
              filings: [{ accession: 'B-1', filingDate: '2024-01-01', reportDate: '2023-12-31' }],
            },
          ],
        });
      }
      // Must succeed (not error) — runFundXray() auto-fires right after
      // this test's ambiguous-match message and would otherwise overwrite
      // #msgBox with its own error message before this test can inspect it.
      if (url.includes('/api/fund-xray?')) {
        return jsonResponse({
          success: true,
          xray: {
            fund: { registrantName: 'Fund A', reportDate: '2023-12-31', netAssets: 1000 },
            totalHoldingsCount: 0,
            publicHoldingsCount: 0,
            privateHoldingsCount: 0,
            privateValueUSD: 0,
            totalValueUSD: 0,
            privatePctOfNetAssets: 0,
            privatePctOfHoldingsValue: 0,
            byInstrumentType: {},
            byCountry: {},
            privateHoldings: [],
            topPrivateHoldings: [],
          },
        });
      }
      return jsonResponse({});
    },
  });
  document.getElementById('xrayFundInput').value = XSS_NAME;
  await window.searchFundXray();
  await tick(window);

  const html = document.getElementById('msgBox').innerHTML;
  assert.doesNotMatch(html, /<img/);
  assert.match(html, new RegExp(XSS_ESCAPED.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('runBatchPipeline (Batch Search): the in-progress "Searching N/M: <name>" text escapes HTML in the security name', async () => {
  // showProgress() is called synchronously before each security's fetch —
  // capture progressBox's content the moment the mocked fetch for that
  // security fires, since runBatchPipeline moves on immediately after.
  let progressHtmlDuringFetch = null;
  const { window, document } = await loadApp({
    fetchImpl: async url => {
      if (url.includes('/api/search-nport')) {
        progressHtmlDuringFetch = document.getElementById('progressBox').innerHTML;
        return jsonResponse({ hits: { hits: [] } }); // no filings -> loop moves on, nothing else to mock
      }
      return jsonResponse({});
    },
  });
  await window.runBatchPipeline([XSS_NAME], 25);
  assert.ok(progressHtmlDuringFetch, 'progress box must have been populated before the fetch fired');
  assert.doesNotMatch(progressHtmlDuringFetch, /<img/);
  assert.match(progressHtmlDuringFetch, /&lt;img/);
});

// ── fetchJSON: 429 gets a specific, actionable message ─────────────────────

test('fetchJSON: a 429 response throws a clear rate-limit message, not a bare "HTTP 429"', async () => {
  const { window } = await loadApp();
  window.fetch = async () => ({ ok: false, status: 429, json: async () => ({}) });
  await assert.rejects(() => window.fetchJSON('/api/search-nport?security=x'), /wait a moment and try again/i);
});

test('fetchJSON: a non-429 error status still throws the generic "HTTP <status>" (unchanged behavior)', async () => {
  const { window } = await loadApp();
  window.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  await assert.rejects(() => window.fetchJSON('/api/search-nport?security=x'), /HTTP 500/);
});
