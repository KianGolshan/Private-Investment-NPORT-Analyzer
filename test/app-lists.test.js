// Phase 5b task 4: Batch and Watchlist on the company services, in jsdom
// (the real public/app.js) with fetch answered by the real warehouse routes
// over the golden fixture (real rows + the committed data/review/ files).
// Watchlist names from v1 become ids once, through search; names without a
// strong match stay visible as "unmatched" until the user confirms one.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { loadApp } = require('./helpers/loadApp');
const { goldenWarehouse } = require('./helpers/warehouseApp');

const { app, idOf } = goldenWarehouse();

// Warehouse routes answered for real; v1's live routes recorded and answered
// with no hits (so a test sees which path each name took).
function backend(calls) {
  return async url => {
    calls.push(url);
    if (url.startsWith('/api/search-nport'))
      return { ok: true, status: 200, json: async () => ({ hits: { hits: [] } }) };
    if (!/^\/api\/(search|companies|entities)/.test(url)) return { ok: true, status: 200, json: async () => ({}) };
    const r = await request(app).get(url);
    return { ok: r.status < 400, status: r.status, json: async () => r.body };
  };
}
const tick = (window, ms = 80) => new Promise(resolve => window.setTimeout(resolve, ms));

test('watchlist: v1 name entries become company ids once; weak or no match stays "unmatched" and can be confirmed', async () => {
  const calls = [];
  const { window, document } = await loadApp({ fetchImpl: backend(calls) });
  window.localStorage.setItem('nportWatchlist', JSON.stringify(['Anthropic', 'Open AI', 'Data', 'Zzqx Nonexistent']));
  await window.resolveWatchlist();
  const list = JSON.parse(window.localStorage.getItem('nportWatchlist'));
  const by = n => list.find(e => e.name === n);
  assert.deepEqual([by('Anthropic').kind, by('Anthropic').ref], ['company', idOf('Anthropic')]);
  assert.deepEqual(
    [by('Open AI').kind, by('Open AI').ref, by('Open AI').matched],
    ['company', idOf('OpenAI'), 'OpenAI']
  );
  // "Data" only starts several names (Databricks, Dataminr, Vast Data): the user confirms one.
  assert.equal(by('Data').unmatched, true);
  assert.deepEqual(
    by('Data').candidates.map(c => c.name),
    ['Databricks', 'Dataminr', 'Vast Data']
  );
  assert.equal(by('Zzqx Nonexistent').unmatched, true);
  assert.deepEqual(by('Zzqx Nonexistent').candidates, []);
  const text = document.getElementById('watchlistItems').textContent;
  assert.match(text, /Data\s+unmatched/);
  // Resolved once: a second pass makes no search call.
  const before = calls.length;
  await window.resolveWatchlist();
  assert.equal(calls.length, before);
  // Confirming the candidate stores the id.
  const i = list.findIndex(e => e.name === 'Data');
  window.confirmWatchlistMatch('Data', 'wlpick_' + i);
  const after = JSON.parse(window.localStorage.getItem('nportWatchlist')).find(e => e.name === 'Data');
  assert.deepEqual([after.kind, after.ref, after.unmatched], ['company', idOf('Databricks'), undefined]);
});

test('watchlist: adding a name that resolves to a company already listed does not duplicate it', async () => {
  const { window } = await loadApp({ fetchImpl: backend([]) });
  window.localStorage.setItem(
    'nportWatchlist',
    JSON.stringify([{ name: 'OpenAI', kind: 'company', ref: idOf('OpenAI') }])
  );
  window.document.getElementById('watchlistInput').value = 'Open AI';
  window.addWatchlistItem();
  await tick(window);
  await window.resolveWatchlist();
  const list = JSON.parse(window.localStorage.getItem('nportWatchlist'));
  assert.equal(list.length, 1);
});

test('batch: a private company answers from the warehouse (every filing), an unmatched name from the live path, each labeled', async () => {
  const calls = [];
  const { window, document } = await loadApp({ fetchImpl: backend(calls) });
  document.getElementById('batchInput').value = 'Stripe\nZzqx Nonexistent';
  await window.searchBatch();
  await tick(window);
  assert.ok(calls.includes(`/api/companies/${idOf('Stripe')}/history`));
  assert.ok(calls.some(u => u.startsWith('/api/search-nport?security=Zzqx')));
  assert.ok(!calls.some(u => u.startsWith('/api/search-nport?security=Stripe')));
  const header = document.querySelector('.security-section-header').textContent;
  assert.match(header, /Stripe\s+warehouse/);
  // A5's history start, from the warehouse, not a 25-filing window.
  const rows = window.__state.allResults.batch.Stripe.equity;
  const first = Object.values(rows)
    .flat()
    .map(h => h.reportDate)
    .sort()[0];
  assert.equal(first, '2019-12-31');
});

test('watchlist run: ids go straight to the history route', async () => {
  const calls = [];
  const { window } = await loadApp({ fetchImpl: backend(calls) });
  window.localStorage.setItem(
    'nportWatchlist',
    JSON.stringify([{ name: 'Databricks', kind: 'company', ref: idOf('Databricks') }])
  );
  window.switchTab('watchlist');
  await window.runWatchlist();
  await tick(window);
  assert.ok(calls.includes(`/api/companies/${idOf('Databricks')}/history`));
  assert.ok(!calls.some(u => u.startsWith('/api/search?')));
  assert.ok(window.__state.allResults.batch.Databricks);
});
