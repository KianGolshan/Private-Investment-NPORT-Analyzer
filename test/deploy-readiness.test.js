// P9 W1: the warehouse router on a public deployment. A new generation is
// warmed before it is served (the old one answers meanwhile), readiness for a
// balancer and an uptime monitor, CDN-cacheable answers that never cache an
// error, and the memo's byte budget.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const { tmpDir } = require('./helpers/tmp');
const { goldenWarehouse } = require('./helpers/warehouseApp');
const { openWarehouseReadOnly, generationOf } = require('../lib/warehouse/db');
const { warehouseRouter } = require('../lib/api/warehouse');
const { runJob } = require('../lib/warehouse/job');
const { memo, memoStats } = require('../lib/services/memo');

let golden = null;
function tmpWarehouse() {
  golden ??= goldenWarehouse().db.serialize();
  const dir = tmpDir('job');
  const dbPath = path.join(dir, 'warehouse.db');
  fs.writeFileSync(dbPath, golden);
  return { dir, dbPath };
}
const RENAME = "UPDATE companies SET name = 'Anthropic (renamed in a job)' WHERE name = 'Anthropic'";
const AFTER_REFRESH = Date.parse('2026-09-30T12:00:00Z'); // the golden refresh run finished 2026-09-30T00:01Z

test('a new generation is warmed before it is served; the old one answers meanwhile, then one swap', async () => {
  const { dbPath } = tmpWarehouse();
  const first = await runJob('curation', () => ({}), { dbPath });
  const router = warehouseRouter(() => openWarehouseReadOnly(dbPath), { warmOnSwitch: true, warmDelayMs: 30 });
  const app = express().use('/api', router);
  await router.warm();
  const id = (await request(app).get('/api/search?q=anthropic').expect(200)).body.results[0].id;
  const g = await runJob('curation', db => db.exec(RENAME) && {}, { dbPath });
  // the request that sees the new link is answered from the warmed old generation
  const during = (await request(app).get(`/api/companies/${id}`).expect(200)).body;
  assert.equal(during.refreshId, first.generation);
  assert.equal(during.company.name, 'Anthropic');
  assert.equal(router.readiness({ now: AFTER_REFRESH }).switching, true);
  const f = (await request(app).get('/api/freshness').expect(200)).body;
  assert.deepEqual([f.refreshId, f.switching], [first.generation, true], 'freshness tells a tab to ask again');
  assert.equal(router.readiness({ now: AFTER_REFRESH }).ready, true, 'still ready while switching');
  // warm() during a switch is the switch
  const w = await router.warm();
  assert.equal(w.generation, g.generation);
  const after = (await request(app).get(`/api/companies/${id}`).expect(200)).body;
  assert.equal(after.refreshId, g.generation);
  assert.equal(after.company.name, 'Anthropic (renamed in a job)');
  assert.equal(router.readiness({ now: AFTER_REFRESH }).switching, false);
  assert.equal((await request(app).get('/api/freshness').expect(200)).body.switching, false);
});

test('checkSwitch moves an idle router to a new generation without a request; nothing to do is null', async () => {
  const { dbPath } = tmpWarehouse();
  await runJob('curation', () => ({}), { dbPath });
  const router = warehouseRouter(() => openWarehouseReadOnly(dbPath), { warmOnSwitch: true });
  await router.warm();
  assert.equal(router.checkSwitch(), null, 'no new generation');
  const g = await runJob('curation', db => db.exec(RENAME) && {}, { dbPath });
  const sw = router.checkSwitch();
  assert.ok(sw, 'a switch started');
  assert.equal(router.checkSwitch(), sw, 'one switch at a time');
  await sw;
  assert.equal(router.readiness({ now: AFTER_REFRESH }).generation, g.generation);
  // without warmOnSwitch (tests, tools) the next check swaps at once
  const quiet = warehouseRouter(() => openWarehouseReadOnly(dbPath));
  quiet.readiness();
  const g2 = await runJob('curation', () => ({}), { dbPath });
  assert.equal(quiet.checkSwitch(), null);
  assert.equal(quiet.readiness().generation, g2.generation);
});

test('a generation that cannot be opened keeps the old one serving, and the next switch succeeds', async () => {
  const { dbPath } = tmpWarehouse();
  const first = await runJob('curation', () => ({}), { dbPath });
  let failNext = false;
  const router = warehouseRouter(
    () => {
      if (failNext) {
        failNext = false;
        throw new Error('disk on fire');
      }
      return openWarehouseReadOnly(dbPath);
    },
    { warmOnSwitch: true }
  );
  const app = express().use('/api', router);
  await router.warm();
  const g = await runJob('curation', db => db.exec(RENAME) && {}, { dbPath });
  failNext = true;
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    const r = await router.checkSwitch();
    assert.match(r.error, /disk on fire/);
  } finally {
    console.error = orig;
  }
  assert.match(errors.join('\n'), /serving the previous generation/);
  assert.equal((await request(app).get('/api/freshness').expect(200)).body.refreshId, first.generation);
  await router.checkSwitch();
  assert.equal((await request(app).get('/api/freshness').expect(200)).body.refreshId, g.generation);
});

test('readiness: warming, ready, fresh, stale, failed job, and no warehouse', async () => {
  const { db } = goldenWarehouse();
  const router = warehouseRouter(() => db);
  let r = router.readiness({ now: AFTER_REFRESH });
  assert.deepEqual([r.ready, r.fresh, r.reason], [false, false, 'warming up']);
  await router.warm(); // the warm-up that first readiness check started (one at a time)
  r = router.readiness({ now: AFTER_REFRESH });
  assert.deepEqual([r.ready, r.fresh, r.reason], [true, true, null]);
  assert.equal(r.refreshAgeHours, 12);
  assert.ok(r.newestFilingDate && r.newestReportDate);
  // the first, the boundary and past the limit
  r = router.readiness({ now: Date.parse('2026-10-02T00:01:00Z'), maxAgeHours: 48 });
  assert.deepEqual([r.ready, r.fresh], [true, true], 'exactly 48 h is still fresh');
  r = router.readiness({ now: Date.parse('2026-10-02T00:07:00Z'), maxAgeHours: 48 });
  assert.deepEqual([r.ready, r.fresh], [true, false]);
  assert.match(r.reason, /^last refresh 48\.1 h ago \(limit 48 h\)$/);
  // no successful refresh at all
  db.exec("UPDATE refresh_runs SET status = 'failed'");
  r = router.readiness({ now: AFTER_REFRESH });
  assert.deepEqual([r.fresh, r.refreshAgeHours], [false, null]);
  assert.match(r.reason, /unknown/);
  db.exec("UPDATE refresh_runs SET status = 'ok'");
  // the warehouse cannot be opened
  const none = warehouseRouter(() => {
    throw new Error('no such file');
  });
  r = none.readiness();
  assert.deepEqual([r.ready, r.fresh], [false, false]);
  assert.match(r.reason, /warehouse unavailable: no such file/);
});

test('readiness: a failed or interrupted last job is not fresh, but still ready', async () => {
  const { dbPath } = tmpWarehouse();
  await runJob('curation', () => ({}), { dbPath });
  await assert.rejects(
    runJob(
      'curation',
      () => {
        throw new Error('boom');
      },
      { dbPath }
    )
  );
  const router = warehouseRouter(() => openWarehouseReadOnly(dbPath));
  await router.warm();
  const r = router.readiness({ now: AFTER_REFRESH });
  assert.deepEqual([r.ready, r.fresh, r.reason, r.job.status], [true, false, 'last job failed', 'failed']);
});

test('cache headers: browsers revalidate; a CDN may keep answers for cdnMaxAge; errors and freshness are never kept', async () => {
  const { db, idOf } = goldenWarehouse();
  const plain = express().use(
    '/api',
    warehouseRouter(() => db)
  );
  let r = await request(plain).get('/api/search?q=anthropic').expect(200);
  assert.equal(r.headers['cache-control'], 'no-cache', 'unchanged without cdnMaxAge');
  const app = express().use(
    '/api',
    warehouseRouter(() => db, { cdnMaxAge: 300, build: 'b1' })
  );
  r = await request(app)
    .get(`/api/companies/${idOf('Anthropic')}`)
    .expect(200);
  assert.equal(r.headers['cache-control'], 'public, max-age=0, must-revalidate, s-maxage=300');
  assert.match(r.headers.etag, /^W\/"r\d+-b1"$/);
  await request(app)
    .get(`/api/companies/${idOf('Anthropic')}`)
    .set('If-None-Match', r.headers.etag)
    .expect(304);
  // errors: 400, 404, 410 and a 500 carry no-store and no ETag
  for (const [url, status] of [
    ['/api/search', 400],
    ['/api/companies/424242', 404],
    ['/api/companies/abc', 400],
  ]) {
    const e = await request(app).get(url).expect(status);
    assert.equal(e.headers['cache-control'], 'no-store', url);
    assert.doesNotMatch(e.headers.etag ?? '', /^W\/"r\d+-/, `${url}: not the generation ETag`);
  }
  const broken = express().use(
    '/api',
    warehouseRouter(
      () => {
        throw new Error('gone');
      },
      { cdnMaxAge: 300 }
    )
  );
  const e = await request(broken).get('/api/search?q=x').expect(503);
  assert.equal(e.headers['cache-control'], 'no-store');
  const f = await request(app).get('/api/freshness').expect(200);
  assert.equal(f.headers['cache-control'], 'no-store');
});

test('memo: bounded by bytes; the oldest unpinned entries go first; pinned tables stay; a huge answer is not kept', () => {
  const prev = process.env.VANTAGE_MEMO_MAX_MB;
  process.env.VANTAGE_MEMO_MAX_MB = String(1 / 1024); // 1 KiB
  try {
    const { db } = goldenWarehouse();
    const blob = n => ({ s: 'x'.repeat(n) });
    let computed = 0;
    const get = (key, n) => memo(db, key, () => (computed++, blob(n)));
    get('fundFirms', 5000); // pinned: kept, not measured
    get('a', 400);
    get('b', 400);
    assert.deepEqual(memoStats(db), { entries: 3, bytes: 2 * 408 });
    get('c', 400); // over 1024: 'a' goes, the pinned one stays
    assert.equal(memoStats(db).entries, 3);
    const before = computed;
    get('fundFirms', 5000);
    get('b', 400);
    get('c', 400);
    assert.equal(computed, before, 'pinned, b and c still cached');
    get('a', 400);
    assert.equal(computed, before + 1, 'a was evicted');
    // an answer over the whole budget is returned but not kept, and evicts nothing
    const kept = memoStats(db);
    const big = get('huge', 4000);
    assert.equal(big.s.length, 4000);
    get('huge', 4000);
    assert.equal(computed, before + 3, 'computed again: never kept');
    assert.deepEqual(memoStats(db), kept);
    // a value JSON cannot serialize counts as 0 bytes and is kept
    const circ = {};
    circ.self = circ;
    assert.equal(
      memo(db, 'circular', () => circ),
      circ
    );
    assert.equal(
      memo(db, 'circular', () => ({})),
      circ
    );
  } finally {
    if (prev === undefined) delete process.env.VANTAGE_MEMO_MAX_MB;
    else process.env.VANTAGE_MEMO_MAX_MB = prev;
  }
});

test('memo: a new generation starts empty', async () => {
  const { dbPath } = tmpWarehouse();
  await runJob('curation', () => ({}), { dbPath });
  const db = openWarehouseReadOnly(dbPath);
  memo(db, 'k', () => 1);
  assert.equal(memoStats(db).entries, 1);
  assert.ok(Number.isInteger(generationOf(db)));
  db.close();
});

test('readiness starts the first warm-up itself when nothing has; ready once it ends', async () => {
  const { db } = goldenWarehouse();
  const router = warehouseRouter(() => db);
  assert.equal(router.readiness({ now: AFTER_REFRESH }).ready, false);
  const w = router.warm(); // the running one
  assert.equal(router.warm(), w);
  await w;
  assert.equal(router.readiness({ now: AFTER_REFRESH }).ready, true);
});
