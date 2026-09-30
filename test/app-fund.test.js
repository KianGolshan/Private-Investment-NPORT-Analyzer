// Phase 5b: the fund page on screen (jsdom, the real public/app.js), with
// window.fetch answered by the real warehouse routes over real rows
// (test/fixtures/fund/). Goldens on screen: F2, the F16 amendment, the F8/F9
// exit as "no longer reported", F34 "reported at $0", the capital structure,
// and the /fund/<key> permalink.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const request = require('supertest');

const { loadApp } = require('./helpers/loadApp');
const { openFixtureWarehouse } = require('./helpers/warehouseFixture');
const { rebuildFundNames } = require('../lib/warehouse/fund-names');
const { warehouseRouter } = require('../lib/api/warehouse');

const { db } = openFixtureWarehouse(path.join(__dirname, 'fixtures', 'fund', 'warehouse.json.gz'));
rebuildFundNames(db);
db.prepare(
  "INSERT INTO refresh_runs (started_at, finished_at, status) VALUES ('2026-09-30T00:00:00Z', '2026-09-30T00:01:00Z', 'ok')"
).run();
const server = express();
server.use(
  '/api',
  warehouseRouter(() => db)
);

// The browser's fetch, answered by the real routes; v1's live routes are
// recorded and refused, so a test fails if the fund page falls back to them.
function warehouseFetch(calls) {
  return async url => {
    calls.push(url);
    if (!url.startsWith('/api/funds')) return { ok: false, status: 599, json: async () => ({}) };
    const r = await request(server).get(url);
    return { ok: r.status < 400, status: r.status, json: async () => r.body };
  };
}
const tick = (window, ms = 60) => new Promise(resolve => window.setTimeout(resolve, ms));
const text = document => document.getElementById('resultsContainer').textContent.replace(/\s+/g, ' ');

test('fund page: a search opens the fund from the warehouse; F2 on screen with its mark date and accession', async () => {
  const calls = [];
  const { window, document } = await loadApp({ fetchImpl: warehouseFetch(calls) });
  document.getElementById('xrayFundInput').value = 'Growth Fund of America';
  await window.searchFundXray();
  await tick(window);
  assert.ok(
    calls.every(u => u.startsWith('/api/funds') || u === '/api/config'),
    calls.join(' ')
  );
  // Pick the 2026-05-31 filing (F2).
  const select = document.getElementById('xrayFilingSelect');
  const i = window.__state.xrayFilings.findIndex(f => f.accession === '0001193125-26-323081');
  select.value = String(i);
  await window.runFundXray();
  await tick(window);
  const t = text(document);
  assert.match(t, /Source: warehouse • mark date 2026-05-31 • accession 0001193125-26-323081/);
  assert.match(t, /v1 Figure \(Level 3\)/);
  assert.equal(window.location.pathname, '/fund/S000009228');
  assert.equal(window.location.search, ''); // F2 is the fund's newest filing: the bare permalink
  const anthropic = [...document.querySelectorAll('#resultsContainer a')].filter(
    a => a.textContent === 'ANTHROPIC PBC'
  );
  assert.ok(anthropic.length >= 2 && anthropic[0].getAttribute('href').startsWith('/company/'));
  const snap = window.__state.xraySnapshots.current.xray;
  const total = snap.privateHoldings
    .filter(h => h.company?.name === 'Anthropic')
    .reduce((s, h) => s + h.marketValue, 0);
  assert.equal(Math.round(total / 1e5) / 10, 4979.7);
});

test('fund page: the permalink opens a filing; an exit shows as "no longer reported" (F8/F9)', async () => {
  const calls = [];
  const { window, document } = await loadApp({
    fetchImpl: warehouseFetch(calls),
    url: 'http://localhost/fund/S000007191?accession=0000035402-26-002031',
  });
  await tick(window, 120);
  assert.equal(window.__state.xraySnapshots.current.xray.markDate, '2026-01-31');
  const compare = document.getElementById('xrayCompareSelect');
  compare.value = String(window.__state.xrayFilings.findIndex(f => f.accession === '0000035402-25-002966'));
  await window.onXrayCompareSelectChange();
  await tick(window, 120);
  const rows = [...document.querySelectorAll('#xrayCompareResults tbody tr')].filter(r =>
    /STRIPE/i.test(r.textContent)
  );
  assert.ok(rows.length >= 2);
  for (const r of rows) assert.match(r.textContent, /no longer reported/);
  assert.ok(calls.some(u => u.includes('/compare?current=0000035402-26-002031&prior=0000035402-25-002966')));
  assert.ok(calls.every(u => u.startsWith('/api/funds') || u === '/api/config'));
});

test('fund page: "reported at $0" (F34), unreviewed labels, not-private rows and the capital structure', async () => {
  const { window, document } = await loadApp({
    fetchImpl: warehouseFetch([]),
    url: 'http://localhost/fund/S000008787?accession=0001193125-26-371280',
  });
  await tick(window, 120);
  const mesquite = [...document.querySelectorAll('#resultsContainer tr')].find(r => /MESQUITE/.test(r.textContent));
  assert.match(mesquite.textContent, /reported at \$0/);

  const ne = await loadApp({
    fetchImpl: warehouseFetch([]),
    url: 'http://localhost/fund/S000011440?accession=0001398344-26-009765',
  });
  await tick(ne.window, 120);
  const t = text(ne.document);
  assert.match(t, /Not Counted as Private \(1\).*GETLINK SA.*listed/);
  assert.match(t, /Capital Structure by Private Issuer.*WESTMORELAND MINING HOLDINGS LLC/);
  assert.match(t, /8% MTY 11\/4\/2030/);
});

test('fund page: a search matching several funds offers a picker; a superseded filing is never offered (F16)', async () => {
  const { window, document } = await loadApp({ fetchImpl: warehouseFetch([]) });
  document.getElementById('xrayFundInput').value = 'fund';
  await window.searchFundXray();
  await tick(window);
  const options = [...document.getElementById('xraySeriesSelect').options].map(o => o.textContent);
  assert.ok(options.length > 2, options.join(' | '));
  const coatue = await loadApp({ fetchImpl: warehouseFetch([]), url: 'http://localhost/fund/CIK2044519' });
  await tick(coatue.window, 120);
  const accessions = coatue.window.__state.xrayFilings.map(f => f.accession);
  assert.ok(accessions.includes('0001410368-26-061868'));
  assert.ok(!accessions.includes('0001410368-26-056381'));
});
