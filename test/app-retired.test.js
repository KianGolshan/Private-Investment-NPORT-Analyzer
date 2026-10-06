// Phase 5b task 7: the per-filing flows are retired for private companies and
// funds. Every view (Single Security, Batch, Watchlist, Fund X-Ray with its
// comparison and returns) answers the golden private companies and funds from
// the warehouse and never calls v1's per-filing routes; those stay only for
// the live path (a listed company, an unknown name), which this test also pins.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const request = require('supertest');

const { loadApp } = require('./helpers/loadApp');
const { jsonResponse } = require('./helpers/fakes');
const { goldenWarehouse } = require('./helpers/warehouseApp');
const { openFixtureWarehouse } = require('./helpers/warehouseFixture');
const { rebuildFundNames } = require('../lib/warehouse/fund-names');
const { warehouseRouter } = require('../lib/api/warehouse');

const golden = goldenWarehouse();
const fundDb = openFixtureWarehouse(path.join(__dirname, 'fixtures', 'fund', 'warehouse.json.gz')).db;
rebuildFundNames(fundDb);
fundDb
  .prepare(
    "INSERT INTO refresh_runs (started_at, finished_at, status) VALUES ('2026-09-30T00:00:00Z', '2026-09-30T00:01:00Z', 'ok')"
  )
  .run();
const fundApp = express();
fundApp.use(
  '/api',
  warehouseRouter(() => fundDb)
);

const PER_FILING =
  /^\/api\/(search-nport|parse-nport|search-fund|fund-series|fund-series-filings|fund-xray|fund-xray-compare|fund-xray-returns)(\?|$)/;
function backend(calls) {
  return async url => {
    calls.push(url);
    const u = new URL(url, 'http://localhost');
    const target = u.pathname.startsWith('/api/funds')
      ? fundApp
      : /^\/api\/(search|companies|entities|freshness)(\/|$)/.test(u.pathname)
        ? golden.app
        : null;
    if (!target) return jsonResponse(u.pathname === '/api/search-nport' ? { hits: { hits: [] } } : {});
    const r = await request(target).get(u.pathname + u.search);
    return jsonResponse(r.body, { ok: r.status < 400, status: r.status });
  };
}
const tick = (window, ms = 150) => new Promise(resolve => window.setTimeout(resolve, ms));
const perFiling = calls => calls.filter(u => PER_FILING.test(new URL(u, 'http://localhost').pathname));

const PRIVATE = ['Anthropic', 'Stripe', 'Databricks', 'OpenAI', 'FHU US Holdings'];

test('Single Security: the golden private companies never reach the per-filing routes', async () => {
  for (const name of PRIVATE) {
    const calls = [];
    const { window, document } = await loadApp({ fetchImpl: backend(calls) });
    document.getElementById('securityInput').value = name;
    await window.searchNPORT();
    await tick(window);
    assert.deepEqual(perFiling(calls), [], name);
    assert.ok(
      calls.some(u => u.startsWith('/api/companies/')),
      name
    );
  }
});

test('Batch and Watchlist: the golden private companies never reach the per-filing routes', async () => {
  const calls = [];
  const { window, document } = await loadApp({ fetchImpl: backend(calls) });
  document.getElementById('batchInput').value = PRIVATE.join('\n');
  await window.searchBatch();
  await tick(window);
  assert.deepEqual(perFiling(calls), []);
  // The golden fixture holds rows for Anthropic, Stripe and Databricks; OpenAI and
  // FHU resolve to their companies with no rows there, and still make no live call.
  assert.deepEqual(Object.keys(window.__state.allResults.batch).sort(), ['Anthropic', 'Databricks', 'Stripe']);

  const wl = [];
  const w = await loadApp({ fetchImpl: backend(wl) });
  w.window.localStorage.setItem('nportWatchlist', JSON.stringify(PRIVATE));
  await w.window.resolveWatchlist();
  w.window.switchTab('watchlist');
  await w.window.runWatchlist();
  await tick(w.window);
  assert.deepEqual(perFiling(wl), []);
});

test('Fund X-Ray: search, filings, comparison and returns never reach the per-filing routes', async () => {
  const calls = [];
  const { window, document } = await loadApp({ fetchImpl: backend(calls) });
  document.getElementById('xrayFundInput').value = 'Growth Fund of America';
  await window.searchFundXray();
  await tick(window);
  await window.selectXrayComparison('qoq');
  await tick(window);
  await window.runXrayReturns();
  await tick(window);
  assert.deepEqual(perFiling(calls), []);
  assert.ok(calls.some(u => u.includes('/compare?')) && calls.some(u => u.includes('/returns?')));
});

test('the live path still uses them: a listed company (Pfizer, F24) and an unknown name', async () => {
  for (const name of ['Pfizer', 'Zzqx Nonexistent']) {
    const calls = [];
    const { window, document } = await loadApp({ fetchImpl: backend(calls) });
    document.getElementById('securityInput').value = name;
    await window.searchNPORT();
    await tick(window);
    assert.ok(
      perFiling(calls).some(u => u.startsWith('/api/search-nport')),
      name
    );
  }
});

// P6b W5: /legacy keeps only Private Credit; every other v1 tab points to its
// replacement in the analyst workspace.
test('W5: v1 shows only Private Credit, opens on it, and links each retired tab to its replacement', async () => {
  const { document } = await loadApp({ fetchImpl: async () => jsonResponse({}) });
  const shown = [...document.querySelectorAll('.tab')].filter(t => !t.hidden).map(t => t.textContent.trim());
  assert.deepEqual(shown, ['Private Credit Analysis']);
  assert.ok(document.getElementById('creditTab').classList.contains('active'));
  assert.ok(!document.getElementById('singleTab').classList.contains('active'));
  const links = [...document.querySelectorAll('#movedNotice a')].map(a => a.getAttribute('href'));
  for (const href of ['/', '/activity', '/firms', '/compare', '/tracked']) assert.ok(links.includes(href), href);
});
