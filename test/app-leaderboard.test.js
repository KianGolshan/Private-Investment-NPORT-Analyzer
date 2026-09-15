// Basket Leaderboard tests — the cross-security rollup shown above Batch
// Search / Watchlist results (see computeLeaderboardRows/
// renderBasketLeaderboardSectionHTML/sortBasketLeaderboard in
// public/app.js). Runs the real app in jsdom (see test/helpers/loadApp.js),
// same harness as test/app-xray.test.js.
//
// The one correctness property worth pinning explicitly: dispersion must be
// computed from each fund's LATEST holding only, never pooled across every
// report date a fund has filed — pooling would conflate one fund's price
// DRIFT over time with genuine cross-fund DISAGREEMENT, which is the wrong
// signal for "dispersion" (see the comment above computeLeaderboardRows).
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

// A single equity holding row, shaped like what groupAndDedupe buckets
// (chartValue/reportDate/instrumentType — the fields computeLeaderboardRows
// actually reads).
function holding({ chartValue, reportDate, instrumentType = 'equity' }) {
  return { instrumentType, chartValue, reportDate, shares: 1, instrumentKey: 'k' };
}

// Builds one security's { equity: {...}, debt: {}, derivative: {}, indirect: {} }
// bucket set directly — the same shape groupAndDedupe/renderBatchResults use
// — from a map of company -> holdings[], skipping the network round trip.
function buckets(companiesMap) {
  return { equity: companiesMap, debt: {}, derivative: {}, indirect: {} };
}

test("computeLeaderboardRows: dispersion/latest/age come from each fund's LATEST holding only, not pooled across all its filings", async () => {
  const { window } = await loadApp();
  const batchResults = {
    Anthropic: buckets({
      // Fund A drifted from $50 (old) to $500 (latest) — that drift must
      // NOT count toward dispersion; only its $500 latest value should.
      'Fund A': [
        holding({ chartValue: 50, reportDate: '2023-01-01' }),
        holding({ chartValue: 500, reportDate: '2024-06-30' }),
      ],
      // A later report date than Fund A's, so "latestValue" is unambiguous.
      'Fund B': [holding({ chartValue: 520, reportDate: '2024-07-31' })],
    }),
  };
  const rows = window.computeLeaderboardRows(batchResults);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.security, 'Anthropic');
  assert.equal(row.fundCount, 2);
  // min/max must be 500-520 (both funds' LATEST marks), not 50-520 (which
  // would happen if Fund A's stale $50 leaked into the range).
  assert.equal(row.minValue, 500);
  assert.equal(row.maxValue, 520);
  assert.equal(
    row.latestValue,
    520,
    'latestValue tracks the most recently DATED mark across the whole security (Fund B, 2024-07-31)'
  );
  assert.equal(row.latestDate, '2024-07-31');
  const expectedMedian = (500 + 520) / 2;
  const expectedDispersion = ((520 - 500) / expectedMedian) * 100;
  assert.ok(Math.abs(row.dispersionPct - expectedDispersion) < 1e-9);
});

test('computeLeaderboardRows: a security with only one reporting fund has zero dispersion, not null/NaN', async () => {
  const { window } = await loadApp();
  const batchResults = { Solo: buckets({ 'Only Fund': [holding({ chartValue: 100, reportDate: '2024-01-01' })] }) };
  const rows = window.computeLeaderboardRows(batchResults);
  assert.equal(rows[0].dispersionPct, 0);
  assert.equal(rows[0].fundCount, 1);
});

test('computeLeaderboardRows: age is computed in whole days from the most recent reportDate to now', async () => {
  const { window } = await loadApp();
  const daysAgo = 45;
  const reportDate = new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);
  const batchResults = { X: buckets({ F: [holding({ chartValue: 10, reportDate })] }) };
  const row = window.computeLeaderboardRows(batchResults)[0];
  assert.ok(Math.abs(row.ageDays - daysAgo) <= 1, `expected ~${daysAgo} days, got ${row.ageDays}`);
});

test('computeLeaderboardRows: skips a security whose only holdings have no usable chartValue, instead of crashing', async () => {
  const { window } = await loadApp();
  const batchResults = { Broken: buckets({ F: [holding({ chartValue: null, reportDate: '2024-01-01' })] }) };
  assert.deepEqual(window.computeLeaderboardRows(batchResults), []);
});

test('sortLeaderboardRows: sorts by each field correctly, including descending default for numeric fields and ascending default for security name', async () => {
  const { window } = await loadApp();
  // sortLeaderboardRows executes in the jsdom window's own realm, so its
  // return value is a vm-realm Array; Array.from re-materializes it in this
  // (main) realm before mapping, since assert/strict's deepEqual otherwise
  // treats cross-realm arrays as unequal even with identical contents.
  const sortedNames = (rows, field, dir) => Array.from(window.sortLeaderboardRows(rows, field, dir), r => r.security);
  const rows = [
    { security: 'Zeta', latestValue: 10, fundCount: 1, ageDays: 5, dispersionPct: 5 },
    { security: 'Alpha', latestValue: 30, fundCount: 3, ageDays: 50, dispersionPct: 50 },
    { security: 'Mid', latestValue: 20, fundCount: 2, ageDays: 20, dispersionPct: 20 },
  ];
  assert.deepEqual(sortedNames(rows, 'security', 'asc'), ['Alpha', 'Mid', 'Zeta']);
  assert.deepEqual(sortedNames(rows, 'dispersion', 'desc'), ['Alpha', 'Mid', 'Zeta']);
  assert.deepEqual(sortedNames(rows, 'age', 'asc'), ['Zeta', 'Mid', 'Alpha']);
  assert.deepEqual(sortedNames(rows, 'funds', 'desc'), ['Alpha', 'Mid', 'Zeta']);
});

// ── Full render + interaction, via the real batch pipeline ────────────────

async function runBatchWithFixture() {
  const { window, document } = await loadApp({
    fetchImpl: async url => {
      if (url.includes('/api/search-nport?security=High')) {
        return jsonResponse({
          hits: {
            hits: [{ _source: { ciks: ['1'], adsh: 'H-1', display_names: ['Fund A'], file_date: '2024-06-30' } }],
          },
        });
      }
      if (url.includes('/api/search-nport?security=Low')) {
        return jsonResponse({
          hits: {
            hits: [{ _source: { ciks: ['2'], adsh: 'L-1', display_names: ['Fund B'], file_date: '2024-06-30' } }],
          },
        });
      }
      if (url.includes('/api/parse-nport') && url.includes('security=High')) {
        return jsonResponse({
          success: true,
          holdings: [
            { instrumentType: 'equity', chartValue: 1000, reportDate: '2024-06-30', shares: 1, instrumentKey: 'h' },
          ],
        });
      }
      if (url.includes('/api/parse-nport') && url.includes('security=Low')) {
        return jsonResponse({
          success: true,
          holdings: [
            { instrumentType: 'equity', chartValue: 100, reportDate: '2024-06-30', shares: 1, instrumentKey: 'l' },
          ],
        });
      }
      return jsonResponse({});
    },
  });
  document.getElementById('batchInput').value = 'High\nLow';
  await window.runBatchPipeline(['High', 'Low'], 25);
  await tick(window);
  return { window, document };
}

test('renderBatchResults: the leaderboard renders above the per-security sections, one row per security, sorted by dispersion by default', async () => {
  const { document } = await runBatchWithFixture();
  const leaderboard = document.getElementById('basketLeaderboard');
  assert.ok(leaderboard, 'basketLeaderboard section must be rendered');

  // It must appear BEFORE the per-security sections in the DOM.
  const container = document.getElementById('resultsContainer');
  const secSection = container.querySelector('.security-section');
  assert.ok(secSection);
  const children = [...container.children];
  assert.ok(
    children.indexOf(leaderboard) < children.indexOf(secSection),
    'leaderboard must come before the detail sections'
  );

  const names = [...leaderboard.querySelectorAll('tbody tr td:first-child')].map(td => td.textContent.trim());
  assert.deepEqual(new Set(names), new Set(['High', 'Low']));
});

test('sortBasketLeaderboard: clicking a column header re-sorts the rendered table in place, without touching the detail sections below', async () => {
  const { window, document } = await runBatchWithFixture();
  const detailHtmlBefore = document.getElementById('secsection_High').outerHTML;

  window.sortBasketLeaderboard('security'); // Alpha-asc: High, Low unaffected by value, just alpha order
  let names = [...document.querySelectorAll('#basketLeaderboard tbody tr td:first-child')].map(td =>
    td.textContent.trim()
  );
  assert.deepEqual(names, ['High', 'Low']);
  assert.match(document.querySelector('#basketLeaderboard th.sortable[onclick*="security"]').textContent, /▲/);

  window.sortBasketLeaderboard('security'); // toggle to desc
  names = [...document.querySelectorAll('#basketLeaderboard tbody tr td:first-child')].map(td => td.textContent.trim());
  assert.deepEqual(names, ['Low', 'High']);

  assert.equal(
    document.getElementById('secsection_High').outerHTML,
    detailHtmlBefore,
    'detail sections must be untouched by a leaderboard re-sort'
  );
});

test('renderBasketLeaderboardSectionHTML: an empty basket renders nothing (no empty table)', async () => {
  const { window } = await loadApp();
  assert.equal(window.renderBasketLeaderboardSectionHTML([]), '');
});
