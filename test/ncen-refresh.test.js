// Phase 4: the N-CEN refresh path (data set page -> verified download ->
// ingest -> EDGAR top-up), offline. SEC is mocked with nock and serves the
// real files in test/fixtures/ncen/.
process.env.SEC_MIN_INTERVAL_MS = '0';
process.env.SEC_USER_AGENT = 'Test Suite test@example.com';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const nock = require('nock');

const { openWarehouse } = require('../lib/warehouse/db');
const { refreshNcen } = require('../lib/warehouse/ncen');

const SEC = 'https://www.sec.gov';
const NCEN = path.join(__dirname, 'fixtures', 'ncen');
const ZIP = fs.readFileSync(path.join(NCEN, 'mini_ncen.zip'));
const GFA = '0001193125-25-282335'; // in EDGAR's index, missing from the data sets
const PAGE = `<a href="/files/dera/data/form-n-cen-data-sets/2026q1_ncen.zip">2026 Q1</a>`;
// One real form.idx line per filing: the 4 data set filings and the EDGAR-only one.
const INDEX = [
  `N-CEN            AMERICAN FUNDS INSURANCE SERIES                729528      2026-03-16  edgar/data/729528/0001193125-26-108005.txt`,
  `N-CEN            Touchstone ETF Trust                           1919700     2026-03-13  edgar/data/1919700/0001193125-26-105983.txt`,
  `N-CEN            Coatue Innovative Strategies Fund              2044519     2026-03-16  edgar/data/2044519/0001410368-26-026363.txt`,
  `N-CEN            Destiny Tech100 Inc.                           1843974     2026-03-13  edgar/data/1843974/0000894189-26-007823.txt`,
  `N-CEN            GROWTH FUND OF AMERICA                         44201       2025-11-14  edgar/data/44201/${GFA}.txt`,
  `NPORT-P          GROWTH FUND OF AMERICA                         44201       2025-11-14  edgar/data/44201/0000000000-25-000001.txt`,
].join('\n');

test.beforeEach(() => {
  nock.cleanAll();
  nock.disableNetConnect();
});
test.after(() => nock.enableNetConnect());

function mockSec({ zip = ZIP, contentLength } = {}) {
  nock(SEC).get('/data-research/sec-markets-data/form-n-cen-data-sets').reply(200, PAGE);
  nock(SEC)
    .get('/files/dera/data/form-n-cen-data-sets/2026q1_ncen.zip')
    .reply(200, zip, { 'Content-Length': String(contentLength ?? zip.length) });
  nock(SEC)
    .get(/\/Archives\/edgar\/full-index\/\d{4}\/QTR[1-4]\/form\.idx/)
    .times(100)
    .reply(200, INDEX);
  nock(SEC)
    .get(`/Archives/edgar/data/44201/${GFA.replace(/-/g, '')}/primary_doc.xml`)
    .reply(200, fs.readFileSync(path.join(NCEN, 'xml', `${GFA}.xml`)));
}

test('refreshNcen: loads a new data set, reads only the missing filing from EDGAR, and is resumable', async () => {
  const db = openWarehouse(':memory:');
  mockSec();
  const first = await refreshNcen(db);
  assert.deepEqual(first.datasets, [{ quarter: '2026q1', filings: 4, rows: 62 }]);
  assert.deepEqual([first.topUp.listed, first.topUp.fetched, first.topUp.failed], [5, 1, []]);
  const sources = db.prepare('SELECT source, COUNT(*) n FROM ncen_filings GROUP BY source ORDER BY source').all();
  assert.deepEqual(sources, [
    { source: 'dataset:2026q1', n: 4 },
    { source: 'edgar', n: 1 },
  ]);
  const gfa = db.prepare('SELECT series_id, file_num, role FROM ncen_advisers WHERE accession = ?').all(GFA);
  assert.deepEqual(gfa, [{ series_id: 'S000009228', file_num: '801-8055', role: 'adviser' }]);

  nock.cleanAll();
  nock(SEC).get('/data-research/sec-markets-data/form-n-cen-data-sets').reply(200, PAGE);
  nock(SEC)
    .get(/\/Archives\/edgar\/full-index\/\d{4}\/QTR[1-4]\/form\.idx/)
    .times(100)
    .reply(200, INDEX);
  const second = await refreshNcen(db);
  assert.deepEqual(second.datasets, []);
  assert.deepEqual([second.topUp.listed, second.topUp.fetched], [5, 0]);
});

test('refreshNcen: a truncated data set download fails loudly and loads nothing', async () => {
  const db = openWarehouse(':memory:');
  mockSec({ zip: ZIP.subarray(0, 100), contentLength: ZIP.length });
  // axios aborts on the length mismatch; downloadDataset re-checks the length too.
  await assert.rejects(refreshNcen(db), /truncated download|aborted/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ncen_filings').get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM ingest_log WHERE kind = 'ncen' AND status = 'ok'").get().n, 0);
});

test('refreshNcen: a filing EDGAR cannot serve is reported and retried on the next run', async () => {
  const db = openWarehouse(':memory:');
  nock(SEC).get('/data-research/sec-markets-data/form-n-cen-data-sets').reply(200, PAGE);
  nock(SEC)
    .get('/files/dera/data/form-n-cen-data-sets/2026q1_ncen.zip')
    .reply(200, ZIP, { 'Content-Length': String(ZIP.length) });
  nock(SEC)
    .get(/\/Archives\/edgar\/full-index\/\d{4}\/QTR[1-4]\/form\.idx/)
    .times(100)
    .reply(200, INDEX);
  nock(SEC)
    .get(`/Archives/edgar/data/44201/${GFA.replace(/-/g, '')}/primary_doc.xml`)
    .times(3)
    .reply(404, 'Not Found');
  const r = await refreshNcen(db);
  assert.equal(r.topUp.failed.length, 1);
  assert.equal(r.topUp.failed[0].accession, GFA);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ncen_filings WHERE accession = ?').get(GFA).n, 0);
});
