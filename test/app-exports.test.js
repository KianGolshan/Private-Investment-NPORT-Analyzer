// Phase 5b task 6: exports (CSV, XLSX, PDF) from the same service data, with
// mark date, accession and source columns, every v1 column still there with
// its meaning. The real SheetJS and jsPDF (the versions index.html loads)
// render in jsdom; workbooks are read back, PDFs searched for the accession.
// Data: the golden fixture (company page) and the fund fixture (fund page).
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

function backend() {
  return async url => {
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
const tick = (window, ms = 120) => new Promise(resolve => window.setTimeout(resolve, ms));

// Captures what the page would download, as data: the CSV text, the workbook
// (written with SheetJS and read back), and the PDF bytes.
function capture(window) {
  const out = {};
  window.downloadBlob = (content, type, filename) => (out.csv = { content, filename });
  window.XLSX.writeFile = (wb, filename) => {
    const bytes = window.XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    const back = window.XLSX.read(bytes, { type: 'array' });
    out.xlsx = {
      filename,
      sheets: Object.fromEntries(
        // JSON round trip: arrays made in the page's realm, compared in Node's.
        back.SheetNames.map(n => [
          n,
          JSON.parse(JSON.stringify(window.XLSX.utils.sheet_to_json(back.Sheets[n], { header: 1 }))),
        ])
      ),
    };
  };
  window.jspdf.jsPDF.API.save = function (filename) {
    out.pdf = { filename, text: this.output() };
  };
  return out;
}
const csvRows = text => text.split('\n').map(l => l.slice(1, -1).split('","'));

const V1_SINGLE = [
  'Type',
  'Class',
  'Fund',
  'Report Date',
  'Title',
  'Shares',
  'Market Value (USD)',
  'Value',
  'Currency',
  'Source Filing URL',
];

test('company page exports: v1 columns plus mark date, accession and source; XLSX and PDF render (F2)', async () => {
  const { window, document } = await loadApp({ fetchImpl: backend(), exportLibs: true });
  const out = capture(window);
  document.getElementById('securityInput').value = 'Anthropic';
  await window.searchNPORT();
  await tick(window);

  window.doExportCSV();
  const rows = csvRows(out.csv.content);
  assert.deepEqual(rows[0], [...V1_SINGLE, 'Mark Date', 'Accession', 'Source']);
  const f2 = rows.filter(r => r[11] === '0001193125-26-323081');
  assert.ok(f2.length >= 3, 'Growth Fund of America 5/31 rows');
  for (const r of f2) {
    assert.equal(r[3], '2026-05-31'); // v1's Report Date: the mark date
    assert.equal(r[10], '2026-05-31');
    assert.equal(r[12], 'warehouse');
    assert.match(r[9], /\/Archives\/edgar\/data\/44201\/000119312526323081/);
  }
  const f2Total = f2.reduce((s, r) => s + Number(r[6]), 0);
  assert.equal(Math.round(f2Total / 1e5) / 10, 4979.7);

  window.doExportExcel();
  const sheet = out.xlsx.sheets.Equity;
  assert.deepEqual(sheet[0], [...V1_SINGLE, 'Mark Date', 'Accession', 'Source']);
  assert.equal(sheet.length, rows.filter(r => r[0] === 'Equity').length + 1);

  window.doExportPDF();
  assert.match(out.pdf.text, /^%PDF-/);
  assert.ok(out.pdf.text.includes('(0001193125-26-323081)'), 'the accession, whole, in its column');
  assert.ok(out.pdf.text.includes('(warehouse) Tj'), 'the source, whole, in its column');
});

test('fund page exports: v1 X-Ray columns plus mark date, accession, source and why each row is private', async () => {
  const { window } = await loadApp({
    fetchImpl: backend(),
    exportLibs: true,
    url: 'http://localhost/fund/S000009228?accession=0001193125-26-182055',
  });
  await tick(window);
  const out = capture(window);
  window.doXrayExportCSV('current');
  const rows = csvRows(out.csv.content);
  assert.deepEqual(rows[0].slice(0, 11), [
    'Fund',
    'Report Date',
    'Company',
    'Instrument',
    'Country',
    'Fair Value Level',
    'Restricted',
    'Shares',
    'Price / Share',
    '% of NAV',
    '$ Value',
  ]);
  assert.deepEqual(rows[0].slice(11), ['Mark Date', 'Accession', 'Source', 'Private By']);
  // F1: Anthropic G-1 $1,315,268,824.79 and F-1 $741,023,858.08 at 2026-02-28.
  const anthropic = rows.filter(r => r[14] === 'company status (Anthropic)').map(r => r[10]);
  assert.ok(anthropic.includes('1315268824.79') && anthropic.includes('741023858.08'), anthropic.join(' '));
  for (const r of rows.slice(1)) {
    assert.deepEqual([r[11], r[12], r[13]], ['2026-02-28', '0001193125-26-182055', 'warehouse']);
  }

  window.doXrayExportExcel('current');
  assert.deepEqual(out.xlsx.sheets['Fund X-Ray'][0], rows[0]);
  assert.equal(out.xlsx.sheets['Fund X-Ray'].length, rows.length);
  window.doXrayExportPDF('current');
  // One filing: mark date, accession and source once, in the header line.
  assert.match(out.pdf.text, /Mark date: 2026-02-28 · Accession: 0001193125-26-182055 · Source: warehouse/);

  // The comparison export names both filings.
  const compare = window.document.getElementById('xrayCompareSelect');
  compare.value = String(window.__state.xrayFilings.findIndex(f => f.period === '2025-11-30'));
  await window.onXrayCompareSelectChange();
  await tick(window);
  window.doXrayCompareExportCSV();
  const cmp = csvRows(out.csv.content);
  assert.deepEqual(cmp[0].slice(-5), [
    'Mark Date (Prior)',
    'Mark Date (Current)',
    'Accession (Prior)',
    'Accession (Current)',
    'Source',
  ]);
  assert.deepEqual(cmp[1].slice(-5).slice(0, 2), ['2025-11-30', '2026-02-28']);
  assert.equal(cmp[1][cmp[1].length - 2], '0001193125-26-182055');
  assert.equal(cmp[1][cmp[1].length - 1], 'warehouse');
});
