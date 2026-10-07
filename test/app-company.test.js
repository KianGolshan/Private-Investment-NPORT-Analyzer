// Phase 5a: the company page (public/app.js) in jsdom, served by the real
// warehouse routes over the golden fixture (test/helpers/warehouseApp.js):
// golden numbers on screen with mark dates and accessions, the display labels,
// permalinks, candidates, history through v1's renderer, and the live path
// for listed companies and unknown names.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { loadApp } = require('./helpers/loadApp');
const { jsonResponse } = require('./helpers/fakes');
const { goldenWarehouse } = require('./helpers/warehouseApp');

const { app, idOf } = goldenWarehouse();
const WAREHOUSE = /^\/api\/(search|companies|entities|freshness)(\/|$|\?)/;

// Warehouse routes go to the real router; v1's live routes are recorded and stubbed.
function backend(calls = []) {
  return async url => {
    calls.push(url);
    const u = new URL(url, 'http://localhost');
    if (WAREHOUSE.test(u.pathname)) {
      const r = await request(app).get(u.pathname + u.search);
      return jsonResponse(r.body, { ok: r.status < 400, status: r.status });
    }
    if (u.pathname === '/api/search-nport') return jsonResponse({ hits: { hits: [] } });
    return jsonResponse({});
  };
}

// Visible text with a space between elements (textContent would glue "Private" and "Tracked").
function text(document, id) {
  const walker = document.createTreeWalker(document.getElementById(id), 4 /* NodeFilter.SHOW_TEXT */);
  const parts = [];
  while (walker.nextNode()) parts.push(walker.currentNode.nodeValue);
  return parts.join(' ').replace(/\s+/g, ' ');
}

async function openAt(window, document, name, date) {
  document.getElementById('securityInput').value = name;
  await window.searchNPORT();
  if (date) {
    document.getElementById('asOfDate').value = date;
    await window.applyAsOf();
  }
}

test('company page: Anthropic at 2026-06-30 shows 117 funds / $17.26B with mark dates, accessions and labels (A2, F2, F11, F22)', async () => {
  const calls = [];
  const { window, document } = await loadApp({ fetchImpl: backend(calls) });
  await openAt(window, document, 'Anthropic', '2026-06-30');
  const page = text(document, 'companyContainer');
  assert.match(page, /Anthropic Private Tracked/);
  assert.match(page, /Funds holding 117/);
  assert.match(page, /Value \$17\.26B/);
  // F2: Growth Fund of America at its own mark date, linked to the filing.
  const gfa = [...document.querySelectorAll('#companyContainer tr')].find(tr =>
    tr.textContent.includes('0001193125-26-323081')
  );
  assert.match(gfa.textContent, /2026-05-31/);
  assert.match(gfa.textContent, /\$4\.98B/);
  // The fund links to its fund page; the filing links to EDGAR.
  assert.equal(gfa.querySelector('a').getAttribute('href'), '/fund/S000009228');
  assert.equal(
    gfa.querySelector('a[href^="https://www.sec.gov/"]').getAttribute('href'),
    'https://www.sec.gov/Archives/edgar/data/44201/000119312526323081/'
  );
  // F11: Magnitude's SPV is labeled indirect; F22: Fundrise's range in the filing's words.
  const magnitude = [...document.querySelectorAll('#companyContainer tr')].find(tr =>
    tr.textContent.includes('0000894189-26-024246')
  );
  assert.match(magnitude.textContent, /indirect/);
  assert.match(page, /Disclosed without naming vehicles.*Greater than 20%/);
  assert.equal(window.location.pathname, `/company/${idOf('Anthropic')}-anthropic`);
  assert.ok(!calls.some(u => u.includes('/api/search-nport')), 'no live EDGAR call');
});

test('company page: the history since 2023-04-28 renders through v1 sections, charts and exports', async () => {
  const { window, document } = await loadApp({ fetchImpl: backend() });
  await openAt(window, document, 'Anthropic');
  const first = Object.values(window.__state.allResults.single.equity)
    .flat()
    .map(h => h.reportDate)
    .sort()[0];
  assert.equal(first, '2023-04-28');
  assert.ok(document.querySelectorAll('#resultsContainer .fund-card').length > 0);
  assert.ok(window.Chart.instances.length > 0, 'v1 chart built');
  assert.ok(document.querySelector('#resultsContainer button[onclick="doExportCSV()"]'));
});

test('company page: a permalink with a date opens Stripe; Fidelity OTC is "no longer reported" at 2026-01-31 (F8/F9)', async () => {
  const id = idOf('Stripe');
  const { window, document } = await loadApp({
    url: `http://localhost/company/${id}-stripe?date=2026-01-31`,
    fetchImpl: backend(),
  });
  await new Promise(r => window.setTimeout(r, 300));
  const page = text(document, 'companyContainer');
  assert.match(page, /^ ?Stripe/);
  assert.match(page, /No longer reported.*0000035402-26-002031/);
  assert.equal(document.getElementById('asOfDate').value, '2026-01-31');
});

test('company page: the A5 Stripe counts follow the as-of date (49 / 35 / 34 / 37)', async () => {
  const { window, document } = await loadApp({ fetchImpl: backend() });
  const counts = [];
  for (const d of ['2025-06-30', '2025-12-31', '2026-03-31', '2026-06-30']) {
    await openAt(window, document, 'Stripe', d);
    counts.push(Number(text(document, 'companyContainer').match(/Funds holding (\d+)/)[1]));
  }
  assert.deepEqual(counts, [49, 35, 34, 37]);
});

test('knownAsOf: "only what was public on that date" shows Anthropic 82 / $6.23B at 2026-06-30 (A4)', async () => {
  const { window, document } = await loadApp({ fetchImpl: backend() });
  await openAt(window, document, 'Anthropic');
  document.getElementById('asOfDate').value = '2026-06-30';
  document.getElementById('knownAsOf').checked = true;
  await window.applyAsOf();
  const page = text(document, 'companyContainer');
  assert.match(page, /Funds holding 82/);
  assert.match(page, /Value \$6\.23B/);
  assert.match(page, /as known then/);
});

test('search: several prefix matches are listed with how they matched; picking one opens it', async () => {
  const { window, document } = await loadApp({ fetchImpl: backend() });
  document.getElementById('securityInput').value = 'Data';
  await window.searchNPORT();
  const list = text(document, 'companyContainer');
  assert.match(list, /Several names match "Data"/);
  assert.match(list, /Databricks Private Tracked starts with: name “Databricks”/);
  assert.match(list, /Vast Data Private .*contains: name “Vast Data”/);
  const i = [...document.querySelectorAll('.candidate')].findIndex(b => /^\s*Databricks\b/.test(b.textContent));
  await window.openCandidate(i);
  assert.match(text(document, 'companyContainer'), /^ ?Databricks .*Funds holding \d+/);
  assert.match(text(document, 'companyContainer'), /Other matches: Dataminr/);
});

test('routing: a listed company runs the live path under "Live, not warehoused" (SpaceX is public)', async () => {
  const calls = [];
  const { window, document } = await loadApp({ fetchImpl: backend(calls) });
  document.getElementById('securityInput').value = 'Space Exploration Technologies';
  await window.searchNPORT();
  await new Promise(r => window.setTimeout(r, 50));
  assert.match(text(document, 'companyContainer'), /Live, not warehoused.*is listed/);
  assert.ok(calls.some(u => u.startsWith('/api/search-nport?security=Space%20Exploration%20Technologies')));
});

test('routing: a name the warehouse has never seen runs the live path, labeled', async () => {
  const calls = [];
  const { window, document } = await loadApp({ fetchImpl: backend(calls) });
  document.getElementById('securityInput').value = 'Zzqx Nonexistent Holdings';
  await window.searchNPORT();
  await new Promise(r => window.setTimeout(r, 50));
  assert.match(text(document, 'companyContainer'), /Live, not warehoused.*No company or reported name/);
  assert.ok(calls.some(u => u.startsWith('/api/search-nport?security=Zzqx')));
});

test('company page: two funds that share a name are two lines, never one (Capital World Growth & Income, F17)', async () => {
  const { window, document } = await loadApp({ fetchImpl: backend() });
  await openAt(window, document, 'Anthropic');
  const equity = window.__state.allResults.single.equity;
  const cwgi = Object.keys(equity).filter(k => k.startsWith('Capital World Growth & Income Fund'));
  assert.equal(cwgi.length, 2, cwgi.join(' | '));
  for (const k of cwgi) assert.equal(new Set(equity[k].map(r => r.fundKey)).size, 1, k);
});

test('company page: a similar spelling lists candidates instead of opening by itself', async () => {
  const { window, document } = await loadApp({ fetchImpl: backend() });
  await openAt(window, document, 'Databriks');
  const page = text(document, 'companyContainer');
  assert.match(page, /Several names match "Databriks"/);
  assert.match(page, /similar spelling/);
});

test('company page: a listed company opens on the live path with a link to its stored rows (SpaceX is public)', async () => {
  const { window, document } = await loadApp({ fetchImpl: backend() });
  await window.openCompany(idOf('Space Exploration Technologies'));
  assert.match(text(document, 'companyContainer'), /Private-era marks and restricted rows \(warehouse\)/);
  await window.openCompany(idOf('Space Exploration Technologies'), { stored: true });
  const page = text(document, 'companyContainer');
  assert.match(page, /Listed company: stored rows only/);
  assert.match(page, /Current holdings \(live EDGAR\)/);
});
