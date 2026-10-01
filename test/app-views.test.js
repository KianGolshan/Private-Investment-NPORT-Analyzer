// Phase 6 views on screen (public/views.js in jsdom), served by the real
// warehouse routes over the golden fixture: goldens visible with their mark
// dates and filings.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { loadApp } = require('./helpers/loadApp');
const { jsonResponse } = require('./helpers/fakes');
const { goldenWarehouse } = require('./helpers/warehouseApp');

const { app, idOf, firmIdOf } = goldenWarehouse();
const WAREHOUSE = /^\/api\/(search|companies|entities|freshness|market|feed|firms|funds)(\/|$|\?)/;
function backend() {
  return async url => {
    const u = new URL(url, 'http://localhost');
    if (WAREHOUSE.test(u.pathname)) {
      const r = await request(app)
        .get(u.pathname + u.search)
        .set('Accept-Encoding', 'identity');
      return jsonResponse(r.body, { ok: r.status < 400, status: r.status });
    }
    return jsonResponse({ hits: { hits: [] } });
  };
}
// Visible text with a space between elements (textContent glues cells together).
function spaced(node) {
  const walker = node.ownerDocument.createTreeWalker(node, 4 /* NodeFilter.SHOW_TEXT */);
  const parts = [];
  while (walker.nextNode()) parts.push(walker.currentNode.nodeValue);
  return parts.join(' ').replace(/\s+/g, ' ');
}
const text = (document, id) => spaced(document.getElementById(id));

test('company page: Activity shows Fidelity OTC no longer reporting Stripe (F8/F9) with both filings', async () => {
  const { window, document } = await loadApp({ fetchImpl: backend() });
  await window.openCompany(idOf('Stripe'));
  await window.showCompanyView('activity');
  document.getElementById('activityFilter').value = 'exited';
  window.renderCompanyActivity();
  const row = [...document.querySelectorAll('#companyViewBox tr')].find(tr =>
    tr.textContent.includes('0000035402-26-002031')
  );
  assert.ok(row, 'the F9 filing is on screen');
  assert.match(row.textContent, /no longer reported/);
  assert.match(row.textContent, /2026-01-31/);
  assert.match(row.textContent, /prior 2025-10-31/);
});

test('company page: Share classes show Fidelity Series D 5.76% above its other classes (F30)', async () => {
  const { window, document } = await loadApp({ fetchImpl: backend() });
  await window.openCompany(idOf('Anthropic'), { date: '2026-05-31' });
  await window.showCompanyView('classes');
  assert.match(text(document, 'companyViewBox'), /Preferred D \$622\.94 \(\+5\.76%\)/);
});

test('firm page: Capital Group holds Anthropic in 9 funds / $8.46B at 2026-06-30 (A3), each mark with its date', async () => {
  const { window, document } = await loadApp({ fetchImpl: backend() });
  window.switchTab('firms', { skipUrlReset: true });
  await window.openFirm(firmIdOf('Capital Group (American Funds)'), { date: '2026-06-30' });
  const row = [...document.querySelectorAll('#firmsContainer tr')].find(tr => /^\s*Anthropic/.test(tr.textContent));
  assert.match(spaced(row), /Anthropic Tracked 9 \$8\.46B/);
  assert.match(spaced(row), /Growth Fund of America · Preferred G-1 · 5,075,585 @ \$589\.01\/sh · 2026-05-31/);
});

test('market tab: Anthropic leads at 2026-06-30 with 117 funds / $17.26B (A2)', async () => {
  const { window, document } = await loadApp({ fetchImpl: backend() });
  window.switchTab('market', { skipUrlReset: true });
  document.getElementById('marketDate').value = '2026-06-30';
  await window.loadMarket();
  const first = spaced(document.querySelector('#marketContainer tbody tr'));
  assert.match(first, /1 Anthropic Tracked 117 \$17\.26B/);
});
