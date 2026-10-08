// Phase 2: EDGAR catch-up (form index + primary_doc.xml) and refresh.
// Offline, against REAL data: test/fixtures/edgar/form_2026QTR2_sample.idx
// holds the real 2026 QTR2 index lines for the 7 bulk-fixture filings, and
// their real primary_doc.xml (trimmed) sits in test/fixtures/bulk/xml/.
// EDGAR is mocked with nock; nothing here touches the network.
process.env.SEC_MIN_INTERVAL_MS = '0';
process.env.SEC_USER_AGENT = 'Test Suite test@example.com';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const nock = require('nock');
const { PassThrough } = require('node:stream');
const { tmpDir } = require('./helpers/tmp');

const { openWarehouse } = require('../lib/warehouse/db');
const { ingestBulkZip } = require('../lib/warehouse/bulk-ingest');
const { ingestDelta, parseFormIndex, indexQuarters, defaultSince } = require('../lib/warehouse/delta');
const { downloadQuarter } = require('../lib/warehouse/bulk-source');
const { refresh, claimRun, republishedQuarters, STALE_RUN_MS } = require('../lib/warehouse/refresh');

const SEC = 'https://www.sec.gov';
const BULK = path.join(__dirname, 'fixtures', 'bulk');
const ZIP = path.join(BULK, 'mini_nport.zip');
const INDEX = fs.readFileSync(path.join(__dirname, 'fixtures', 'edgar', 'form_2026QTR2_sample.idx'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(BULK, 'manifest.json'), 'utf8'));
const ENTRIES = parseFormIndex(INDEX, { since: '2026-01-01', until: '2026-12-31' });
const KEPT_TOTAL = Object.values(manifest.filings).reduce((n, f) => n + f.keptHoldingIds.length, 0);

const FIELDS = [
  'issuer_name',
  'title',
  'cusip',
  'lei',
  'isin',
  'ticker',
  'other_id',
  'other_id_desc',
  'balance',
  'unit',
  'currency',
  'value_usd',
  'pct_nav',
  'asset_cat',
  'other_asset',
  'issuer_type',
  'country',
  'restricted',
  'fv_level',
  'deriv_cat',
  'instrument_type',
];

test.beforeEach(() => {
  nock.cleanAll();
  nock.disableNetConnect();
});
test.after(() => nock.enableNetConnect());

function mockIndex(times = 1) {
  nock(SEC).get('/Archives/edgar/full-index/2026/QTR2/form.idx').times(times).reply(200, INDEX);
}
function mockXml({ skip = [] } = {}) {
  for (const e of ENTRIES) {
    const route = `/Archives/edgar/data/${e.cik}/${e.accession.replace(/-/g, '')}/primary_doc.xml`;
    if (skip.includes(e.accession)) nock(SEC).get(route).reply(404, 'Not Found');
    else
      nock(SEC)
        .get(route)
        .reply(200, fs.readFileSync(path.join(BULK, 'xml', `${e.accession}.xml`), 'utf8'));
  }
}

test('parseFormIndex: reads real EDGAR form.idx lines, only NPORT-P(/A), inside the date window', () => {
  assert.equal(ENTRIES.length, 8);
  const gfa = ENTRIES.find(e => e.accession === '0001193125-26-182055');
  assert.deepEqual(
    { form: gfa.form, cik: gfa.cik, filingDate: gfa.filingDate },
    { form: 'NPORT-P', cik: '44201', filingDate: '2026-04-27' }
  );
  assert.ok(!/^10-Q/m.test(ENTRIES.map(e => e.form).join('\n')), 'other forms ignored');
  const window = parseFormIndex(INDEX, { since: '2026-05-26', until: '2026-05-29' });
  assert.deepEqual(window.map(e => e.filingDate).sort(), ['2026-05-26', '2026-05-27', '2026-05-29', '2026-05-29']);
});

test('indexQuarters: spans quarter and year boundaries', () => {
  assert.deepEqual(indexQuarters('2026-06-30', '2026-09-28'), ['2026/QTR2', '2026/QTR3']);
  assert.deepEqual(indexQuarters('2025-12-31', '2026-01-02'), ['2025/QTR4', '2026/QTR1']);
  assert.deepEqual(indexQuarters('2026-07-01', '2026-07-01'), ['2026/QTR3']);
});

test('ingestDelta: loads every listed filing from EDGAR XML, identical to the bulk rows, field by field', async () => {
  const db = openWarehouse(':memory:');
  mockIndex();
  mockXml();
  const stats = await ingestDelta(db, { since: '2026-04-01', until: '2026-06-30' });
  assert.equal(stats.listed, 8);
  assert.equal(stats.loaded, 8);
  assert.equal(stats.failed, 0);
  assert.equal(stats.rowsKept, KEPT_TOTAL);

  const bulk = openWarehouse(':memory:');
  await ingestBulkZip(bulk, ZIP, { quarter: '2026q2' });
  let compared = 0;
  for (const accession of Object.keys(manifest.filings)) {
    const f = db.prepare('SELECT * FROM filings WHERE accession = ?').get(accession);
    const b = bulk.prepare('SELECT * FROM filings WHERE accession = ?').get(accession);
    assert.equal(f.source, 'edgar');
    for (const k of [
      'fund_key',
      'cik',
      'series_id',
      'series_name',
      'report_date',
      'filing_date',
      'form',
      'net_assets',
      'series_lei',
      'registrant_lei',
    ]) {
      assert.equal(f[k], b[k], `${accession} filing.${k}`);
    }
    assert.match(f.registrant_lei, /^[0-9A-Z]{20}$/, `${accession} registrant LEI`);
    const edgarRows = db.prepare('SELECT * FROM holdings WHERE accession = ?').all(accession);
    const bulkRows = bulk.prepare('SELECT * FROM holdings WHERE accession = ?').all(accession);
    assert.equal(edgarRows.length, bulkRows.length, `${accession} row count`);
    const used = new Set();
    for (const r of edgarRows) {
      assert.match(r.row_key, /^doc:\d+$/);
      const i = bulkRows.findIndex((x, j) => !used.has(j) && x.title === r.title && x.value_usd === r.value_usd);
      assert.ok(i >= 0, `${accession} "${r.title}" not in bulk`);
      used.add(i);
      for (const k of FIELDS) assert.equal(r[k], bulkRows[i][k], `${accession} "${r.title}" ${k}`);
      compared++;
    }
  }
  assert.equal(compared, KEPT_TOTAL);
  db.close();
  bulk.close();
});

test('ingestDelta: resumable — a second run skips filings already loaded', async () => {
  const db = openWarehouse(':memory:');
  mockIndex(2);
  mockXml();
  await ingestDelta(db, { since: '2026-04-01', until: '2026-06-30' });
  const again = await ingestDelta(db, { since: '2026-04-01', until: '2026-06-30' });
  assert.equal(again.listed, 8);
  assert.equal(again.loaded, 0, 'no XML refetched (no interceptors left)');
  db.close();
});

test('ingestDelta: a failed filing is recorded, retried next run, and cleared once it loads', async () => {
  const db = openWarehouse(':memory:');
  const bad = '0002048251-26-004683';
  mockIndex();
  mockXml({ skip: [bad] });
  const first = await ingestDelta(db, { since: '2026-04-01', until: '2026-06-30' });
  assert.equal(first.loaded, 7);
  assert.equal(first.failed, 1);
  assert.deepEqual(db.prepare('SELECT accession, error, attempts FROM ingest_errors').all(), [
    { accession: bad, error: 'HTTP 404', attempts: 1 },
  ]);
  assert.equal(db.prepare("SELECT status FROM ingest_log WHERE kind = 'edgar'").get().status, 'failed');

  mockIndex();
  const entry = ENTRIES.find(e => e.accession === bad);
  nock(SEC)
    .get(`/Archives/edgar/data/${entry.cik}/${bad.replace(/-/g, '')}/primary_doc.xml`)
    .reply(200, fs.readFileSync(path.join(BULK, 'xml', `${bad}.xml`), 'utf8'));
  const second = await ingestDelta(db, { since: '2026-04-01', until: '2026-06-30' });
  assert.equal(second.loaded, 1);
  assert.equal(second.failed, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ingest_errors').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM filings').get().n, 8);
  db.close();
});

test('ingestDelta: an earlier failure is retried after the index window moves past it, up to 5 attempts (R12)', async () => {
  const db = openWarehouse(':memory:');
  const bad = '0002048251-26-004683';
  const entry = ENTRIES.find(e => e.accession === bad);
  mockIndex();
  mockXml({ skip: [bad] });
  await ingestDelta(db, { since: '2026-04-01', until: '2026-06-30' });
  assert.equal(db.prepare('SELECT attempts FROM ingest_errors WHERE accession = ?').get(bad).attempts, 1);
  // the next window starts after the failed filing's date: the index no longer lists it
  const after = new Date(Date.parse(entry.filingDate) + 86400000).toISOString().slice(0, 10);
  mockIndex();
  nock(SEC)
    .get(`/Archives/edgar/data/${entry.cik}/${bad.replace(/-/g, '')}/primary_doc.xml`)
    .reply(200, fs.readFileSync(path.join(BULK, 'xml', `${bad}.xml`), 'utf8'));
  const later = await ingestDelta(db, { since: after, until: '2026-06-30' });
  assert.equal(later.retried, 1);
  assert.equal(later.loaded, 1);
  assert.ok(db.prepare('SELECT 1 FROM filings WHERE accession = ?').get(bad));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ingest_errors').get().n, 0);
  // a filing that failed 5 times stays queued for review and is not fetched again
  db.prepare(
    "INSERT INTO ingest_errors (accession, cik, filing_date, form, error, attempts, last_attempt_at) VALUES ('0000000001-26-000001', '1', '2026-04-02', 'NPORT-P', 'HTTP 404', 5, '2026-10-06')"
  ).run();
  mockIndex();
  const capped = await ingestDelta(db, { since: after, until: '2026-06-30' });
  assert.equal(capped.retried, 0);
  db.close();
});

test('ingestDelta: a dropped connection (real: EPIPE / stalled socket) is retried instead of failing the filing', async () => {
  const db = openWarehouse(':memory:');
  const flaky = '0002048251-26-002806';
  const entry = ENTRIES.find(e => e.accession === flaky);
  mockIndex();
  mockXml({ skip: [] });
  nock.removeInterceptor({
    hostname: 'www.sec.gov',
    proto: 'https',
    path: `/Archives/edgar/data/${entry.cik}/${flaky.replace(/-/g, '')}/primary_doc.xml`,
  });
  nock(SEC)
    .get(`/Archives/edgar/data/${entry.cik}/${flaky.replace(/-/g, '')}/primary_doc.xml`)
    .replyWithError({ code: 'EPIPE', message: 'write EPIPE' })
    .get(`/Archives/edgar/data/${entry.cik}/${flaky.replace(/-/g, '')}/primary_doc.xml`)
    .reply(200, fs.readFileSync(path.join(BULK, 'xml', `${flaky}.xml`), 'utf8'));
  const stats = await ingestDelta(db, { since: '2026-04-01', until: '2026-06-30' });
  assert.equal(stats.failed, 0);
  assert.equal(stats.loaded, 8);
  db.close();
});

test('ingestDelta: a truncated primary_doc.xml falls back to the full submission text', async () => {
  // Real case: EDGAR served 0000940400-26-033042's primary_doc.xml cut off
  // mid-holding while its .txt submission held the complete XML. Reproduced
  // here with a real fixture filing, truncated the same way.
  const db = openWarehouse(':memory:');
  const acc = '0000894189-26-016628';
  const entry = ENTRIES.find(e => e.accession === acc);
  const full = fs.readFileSync(path.join(BULK, 'xml', `${acc}.xml`), 'utf8');
  const cut = full.slice(0, full.indexOf('<securityLending>', full.length / 2));
  const submission = `<SEC-DOCUMENT>\n<DOCUMENT>\n<TYPE>NPORT-P\n<TEXT>\n<XML>\n${full}\n</XML>\n</TEXT>\n</DOCUMENT>\n</SEC-DOCUMENT>\n`;
  const base = `/Archives/edgar/data/${entry.cik}/${acc.replace(/-/g, '')}`;
  mockIndex();
  mockXml({ skip: [acc] });
  nock.removeInterceptor({ hostname: 'www.sec.gov', proto: 'https', path: `${base}/primary_doc.xml` });
  nock(SEC).get(`${base}/primary_doc.xml`).reply(200, cut).get(`${base}/${acc}.txt`).reply(200, submission);
  const stats = await ingestDelta(db, { since: '2026-04-01', until: '2026-06-30' });
  assert.equal(stats.failed, 0);
  assert.equal(
    db.prepare('SELECT COUNT(*) n FROM holdings WHERE accession = ?').get(acc).n,
    manifest.filings[acc].keptHoldingIds.length,
    'every kept holding recovered from the full submission'
  );
  db.close();
});

test('bulk replaces catch-up rows for the filings it covers; totals are unchanged', async () => {
  const db = openWarehouse(':memory:');
  mockIndex();
  mockXml();
  await ingestDelta(db, { since: '2026-04-01', until: '2026-06-30' });
  const before = db.prepare('SELECT COUNT(*) n, SUM(value_usd) v FROM holdings').get();
  await ingestBulkZip(db, ZIP, { quarter: '2026q2' });
  const after = db.prepare('SELECT COUNT(*) n, SUM(value_usd) v FROM holdings').get();
  assert.deepEqual(after, before);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM filings WHERE source = 'edgar'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM holdings WHERE row_key LIKE 'doc:%'").get().n, 0);
  db.close();
});

test('refresh: loads a newly published bulk quarter, then catches up from its newest filing date', async () => {
  const db = openWarehouse(':memory:');
  const page = '<a href="/files/dera/data/form-n-port-data-sets/2026q2_nport.zip">2026 Q2</a>';
  const zipBytes = fs.readFileSync(ZIP);
  nock(SEC).get('/data-research/sec-markets-data/form-n-port-data-sets').times(2).reply(200, page);
  nock(SEC)
    .get('/files/dera/data/form-n-port-data-sets/2026q2_nport.zip')
    .reply(200, zipBytes, { 'Content-Length': String(zipBytes.length) });
  mockIndex(2);

  const first = await refresh(db, { until: '2026-06-30', ncen: false });
  assert.equal(first.status, 'ok');
  assert.deepEqual(first.bulkQuartersAdded, ['2026q2']);
  assert.equal(first.since, defaultSince(db));
  assert.equal(first.since, '2026-06-26', 'newest filing date in the fixture quarter');
  assert.equal(first.loaded, 0, 'the one filing listed on/after 2026-06-26 is already in bulk');
  assert.equal(first.uncovered, 0);

  // The second run checks the loaded quarter is unchanged on the SEC (HEAD).
  nock(SEC)
    .head('/files/dera/data/form-n-port-data-sets/2026q2_nport.zip')
    .reply(200, '', { 'Content-Length': String(zipBytes.length) });
  const second = await refresh(db, { until: '2026-06-30', ncen: false });
  assert.deepEqual(second.bulkQuartersAdded, [], 'nothing new published');
  const runs = db.prepare('SELECT status, bulk_quarters_added, delta_since FROM refresh_runs ORDER BY id').all();
  assert.deepEqual(runs, [
    { status: 'ok', bulk_quarters_added: '2026q2', delta_since: '2026-06-26' },
    { status: 'ok', bulk_quarters_added: '', delta_since: '2026-06-26' },
  ]);
  db.close();
});

test('refresh: a quarter the SEC re-posts at a different size is reloaded (trap 41)', async () => {
  const db = openWarehouse(':memory:');
  const page = '<a href="/files/dera/data/form-n-port-data-sets/2026q2_nport.zip">2026 Q2</a>';
  const zipBytes = fs.readFileSync(ZIP);
  const zipPath = '/files/dera/data/form-n-port-data-sets/2026q2_nport.zip';
  nock(SEC).get('/data-research/sec-markets-data/form-n-port-data-sets').times(2).reply(200, page);
  nock(SEC)
    .get(zipPath)
    .times(2)
    .reply(200, zipBytes, { 'Content-Length': String(zipBytes.length) });
  mockIndex(2);
  await refresh(db, { until: '2026-06-30', ncen: false, checkRepublished: false });
  // Stored as loaded 1 byte smaller than the SEC now serves it: re-posted.
  db.prepare("UPDATE ingest_log SET zip_bytes = zip_bytes - 1 WHERE kind = 'bulk'").run();
  nock(SEC)
    .head(zipPath)
    .reply(200, '', { 'Content-Length': String(zipBytes.length) });
  const r = await refresh(db, { until: '2026-06-30', ncen: false });
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.bulkQuartersAdded, ['2026q2']);
  const loads = db.prepare("SELECT zip_bytes FROM ingest_log WHERE kind = 'bulk' AND status = 'ok' ORDER BY id").all();
  assert.deepEqual(
    loads.map(l => l.zip_bytes),
    [zipBytes.length - 1, zipBytes.length]
  );
  db.close();
});

test('refresh: one run at a time; a run left "running" for over 2 hours is closed as abandoned', () => {
  const db = openWarehouse(':memory:');
  const t0 = new Date('2026-09-30T06:15:00Z');
  const first = claimRun(db, t0);
  assert.throws(() => claimRun(db, new Date(t0.getTime() + 60 * 1000)), /refresh #1 is already running/);
  const later = claimRun(db, new Date(t0.getTime() + STALE_RUN_MS + 1000));
  const runs = db.prepare('SELECT id, status, error FROM refresh_runs ORDER BY id').all();
  assert.deepEqual(runs, [
    { id: first, status: 'failed', error: 'abandoned: the process ended without finishing' },
    { id: later, status: 'running', error: null },
  ]);
  db.close();
});

test('re-post detection: same size but a new Last-Modified is a re-post; unchanged validators are not (F12)', async () => {
  const db = openWarehouse(':memory:');
  db.prepare(
    "INSERT INTO ingest_log (kind, quarter, zip_bytes, started_at, status) VALUES ('bulk', '2024q1', 446989787, 'x', 'ok')"
  ).run();
  const zipPath = '/files/dera/data/form-n-port-data-sets/2024q1_nport.zip';
  const head = lastModified =>
    nock(SEC).head(zipPath).reply(200, '', { 'Content-Length': '446989787', 'Last-Modified': lastModified });
  // first check: nothing to compare the date with, size as loaded: not re-posted (recorded)
  head('Fri, 19 Jul 2024 00:59:29 GMT');
  assert.deepEqual(await republishedQuarters(db, ['2024q1'], { now: '2026-10-05T00:00:00Z' }), []);
  head('Fri, 19 Jul 2024 00:59:29 GMT');
  assert.deepEqual(await republishedQuarters(db, ['2024q1'], { now: '2026-10-06T00:00:00Z' }), []);
  // the SEC re-posts at the same size: the date gives it away
  head('Thu, 01 Oct 2026 12:00:00 GMT');
  assert.deepEqual(await republishedQuarters(db, ['2024q1'], { now: '2026-10-07T00:00:00Z' }), ['2024q1']);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM bulk_source_checks WHERE quarter = '2024q1'").get().n, 3);
  db.close();
});

// P8 pre-flight (2026-10-07): a zip body that stops arriving without closing
// used to leave the download, and the job holding the lock, waiting forever.
test('bulk download: a body that stalls fails after the idle limit and leaves no partial file', async () => {
  const dir = tmpDir('stall');
  nock(SEC)
    .get('/files/dera/data/form-n-port-data-sets/2026q2_nport.zip')
    .reply(
      200,
      () => {
        const body = new PassThrough();
        body.write(Buffer.alloc(1000)); // some data, then nothing: no end, no error
        return body;
      },
      { 'Content-Length': '5000' }
    );
  const t0 = Date.now();
  await assert.rejects(
    downloadQuarter('2026q2', dir, { idleMs: 300 }),
    /2026q2 stalled: no data for 0.3 s after 1000 bytes/
  );
  assert.ok(Date.now() - t0 < 5000, 'fails at the idle limit, not later');
  assert.deepEqual(fs.readdirSync(dir), [], 'the partial zip is removed');
});

test('bulk download: a slow body that keeps arriving is not cut off by the idle limit', async () => {
  const dir = tmpDir('slow');
  const zipBytes = fs.readFileSync(ZIP);
  nock(SEC)
    .get('/files/dera/data/form-n-port-data-sets/2026q2_nport.zip')
    .reply(
      200,
      () => {
        const s = new PassThrough();
        const parts = [zipBytes.subarray(0, 100), zipBytes.subarray(100, 200), zipBytes.subarray(200)];
        let i = 0;
        const next = () => (i < parts.length ? (s.write(parts[i++]), setTimeout(next, 150)) : s.end());
        next();
        return s;
      },
      { 'Content-Length': String(zipBytes.length) }
    );
  // 450 ms in all, but never 300 ms without data
  const z = await downloadQuarter('2026q2', dir, { idleMs: 300 });
  assert.equal(z.bytes, zipBytes.length);
  assert.deepEqual(fs.readFileSync(z.path), zipBytes);
});
