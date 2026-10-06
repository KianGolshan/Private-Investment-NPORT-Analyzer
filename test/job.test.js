// P6c R2 (staff review F03/F04/F11): every write is a job that builds a
// candidate, validates it and publishes it whole as a new generation; a failed
// job leaves the published warehouse exactly as it was; readers switch to a new
// generation on their next request; one job at a time.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');
const request = require('supertest');
const { goldenWarehouse } = require('./helpers/warehouseApp');
const { openWarehouseReadOnly, generationOf } = require('../lib/warehouse/db');
const { warehouseRouter } = require('../lib/api/warehouse');
const { runJob, rollback, generations, jobState, acquireLock, publishedFile } = require('../lib/warehouse/job');

// The golden warehouse as a plain file, the way every warehouse looked before
// generations (refresh run 1 ok).
let golden;
function tmpWarehouse() {
  golden ??= goldenWarehouse().db.serialize();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vantage-job-'));
  const dbPath = path.join(dir, 'warehouse.db');
  fs.writeFileSync(dbPath, golden);
  return { dir, dbPath };
}
const read = (dbPath, sql, ...args) => {
  const db = openWarehouseReadOnly(dbPath);
  try {
    return db.prepare(sql).get(...args);
  } finally {
    db.close();
  }
};
const RENAME = "UPDATE companies SET name = 'Anthropic (renamed in a job)' WHERE name = 'Anthropic'";

test('a job publishes a new generation; the pre-generation file is kept for rollback', async () => {
  const { dir, dbPath } = tmpWarehouse();
  const r = await runJob('curation', db => db.exec(RENAME) && {}, { dbPath });
  assert.equal(r.status, 'ok');
  assert.ok(fs.lstatSync(dbPath).isSymbolicLink());
  assert.equal(publishedFile(dbPath), fs.realpathSync(path.join(dir, 'generations', `warehouse-${r.generation}.db`)));
  assert.ok(fs.existsSync(path.join(dir, 'generations', 'warehouse-0.db')), 'the old file is the rollback copy');
  assert.ok(read(dbPath, 'SELECT id FROM companies WHERE name = ?', 'Anthropic (renamed in a job)'));
  const meta = read(dbPath, 'SELECT * FROM generation_meta WHERE id = ?', r.generation);
  assert.equal(meta.kind, 'curation');
  assert.equal(meta.status, 'ok');
  assert.equal(read(dbPath, 'SELECT status FROM refresh_runs WHERE id = ?', r.generation).status, 'ok');
  assert.equal(jobState(dbPath).status, 'ok');
  // published generations are immutable files with no WAL beside them
  assert.equal(read(dbPath, 'PRAGMA journal_mode').journal_mode, 'delete');
  assert.ok(!fs.readdirSync(path.join(dir, 'generations')).some(f => /candidate|-wal$/.test(f)));
});

test('a failing job publishes nothing: the warehouse, its version and its files are as before', async () => {
  const { dir, dbPath } = tmpWarehouse();
  const first = await runJob('curation', () => ({}), { dbPath });
  const target = publishedFile(dbPath);
  await assert.rejects(
    runJob(
      'refresh',
      db => {
        db.exec(RENAME);
        throw new Error('the SEC went away halfway');
      },
      { dbPath }
    ),
    /halfway/
  );
  assert.equal(publishedFile(dbPath), target);
  assert.ok(read(dbPath, "SELECT id FROM companies WHERE name = 'Anthropic'"));
  const db = openWarehouseReadOnly(dbPath);
  assert.equal(generationOf(db), first.generation);
  db.close();
  assert.deepEqual([jobState(dbPath).status, jobState(dbPath).kind], ['failed', 'refresh']);
  assert.match(jobState(dbPath).error, /halfway/);
  assert.ok(!fs.readdirSync(path.join(dir, 'generations')).some(f => /candidate/.test(f)), 'candidate removed');
});

test('validation: a job that loses rows is refused unless the shrink is expected (F12)', async () => {
  const { dbPath } = tmpWarehouse();
  const target = publishedFile(dbPath);
  const drop = db => db.exec('DELETE FROM filings WHERE rowid % 10 = 0') && {};
  await assert.rejects(runJob('ingest-bulk', drop, { dbPath }), /validation failed.*filings/);
  assert.equal(publishedFile(dbPath), target);
  const r = await runJob('ingest-bulk', drop, { dbPath, allowShrink: true });
  assert.equal(r.status, 'ok');
});

test('one job at a time: a second writer is refused (409); a lock whose process is gone is taken over', async () => {
  const { dbPath } = tmpWarehouse();
  let release;
  const held = new Promise(resolve => (release = resolve));
  const first = runJob('refresh', () => held.then(() => ({})), { dbPath });
  await new Promise(r => setTimeout(r, 50));
  await assert.rejects(
    runJob('curation', () => ({}), { dbPath }),
    err => err.status === 409 && /already running/.test(err.message)
  );
  release();
  await first;
  // a lock left by a process that ended: taken over
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout.toString();
  fs.writeFileSync(`${dbPath}.lock`, JSON.stringify({ pid: Number(dead), host: os.hostname(), kind: 'refresh' }));
  const lock = acquireLock(dbPath, 'curation');
  lock.release();
  assert.ok(!fs.existsSync(`${dbPath}.lock`));
});

test('the web server switches to a new generation on the next request; its version moves once', async () => {
  const { dbPath } = tmpWarehouse();
  await runJob('curation', () => ({}), { dbPath });
  const app = express();
  app.use(
    '/api',
    warehouseRouter(() => openWarehouseReadOnly(dbPath))
  );
  const fresh = async () => (await request(app).get('/api/freshness').expect(200)).body;
  const anthropic = async () => (await request(app).get('/api/search?q=anthropic').expect(200)).body;
  const a = await fresh();
  assert.equal(a.job.status, 'ok');
  assert.equal(a.generation.id, a.refreshId);
  const r = await runJob('curation', db => db.exec(RENAME) && {}, { dbPath });
  const b = await fresh();
  assert.equal(b.refreshId, r.generation);
  assert.ok(b.refreshId > a.refreshId);
  assert.match(JSON.stringify(await anthropic()), /renamed in a job/);
  // a failed job does not move it
  await assert.rejects(runJob('refresh', () => Promise.reject(new Error('no')), { dbPath }));
  const c = await fresh();
  assert.equal(c.refreshId, b.refreshId);
  assert.equal(c.job.status, 'failed');
});

test('rollback publishes the generation before the current one; two generations are kept', async () => {
  const { dbPath } = tmpWarehouse();
  const g1 = await runJob('curation', () => ({}), { dbPath });
  const g2 = await runJob('curation', db => db.exec(RENAME) && {}, { dbPath });
  const g3 = await runJob('curation', () => ({}), { dbPath });
  assert.deepEqual(
    generations(dbPath).map(g => [g.id, g.published]),
    [
      [g3.generation, true],
      [g2.generation, false],
    ]
  );
  assert.ok(g1.generation < g2.generation);
  const r = rollback(dbPath);
  assert.deepEqual([r.from, r.to], [g3.generation, g2.generation]);
  assert.equal(generations(dbPath).find(g => g.published).id, g2.generation);
});

test('the CLI writers run as jobs: each moves the published generation exactly once (F04)', () => {
  const { dir, dbPath } = tmpWarehouse();
  const reports = fs.mkdtempSync(path.join(os.tmpdir(), 'vantage-review-'));
  for (const f of ['aliases.csv', 'company_ids.csv', 'managers.csv', 'disclosed_exposure.csv', 'manager_ids.csv'])
    if (fs.existsSync(path.join(__dirname, '..', 'data', 'review', f)))
      fs.copyFileSync(path.join(__dirname, '..', 'data', 'review', f), path.join(reports, f));
  const gen = () => {
    const db = openWarehouseReadOnly(dbPath);
    try {
      return generationOf(db);
    } finally {
      db.close();
    }
  };
  const run = (script, args = []) => {
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', script), ...args], {
      env: { ...process.env, WAREHOUSE_DB_PATH: dbPath },
      encoding: 'utf8',
      timeout: 120000,
    });
    assert.equal(r.status, 0, `${script}: ${r.stderr}${r.stdout}`);
    return r.stdout;
  };
  const g0 = gen();
  assert.match(run('review-aliases.js', ['--dir', reports]), /published generation/);
  const g1 = gen();
  assert.ok(g1 > g0);
  run('entities-report.js', ['--out', path.join(dir, 'reports')]);
  const g2 = gen();
  assert.equal(g2, g1 + 1);
  assert.deepEqual(
    generations(dbPath).map(g => g.id),
    [g2, g1]
  );
  assert.equal(jobState(dbPath).kind, 'entities-report');
  fs.rmSync(dir, { recursive: true, force: true });
});
