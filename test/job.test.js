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
const {
  runJob,
  rollback,
  generations,
  jobState,
  acquireLock,
  publishedFile,
  syncCuration,
} = require('../lib/warehouse/job');

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
  assert.equal(meta.run_id, r.runId);
  assert.equal(read(dbPath, 'SELECT status FROM refresh_runs WHERE id = ?', r.runId).status, 'ok');
  assert.equal(jobState(dbPath).status, 'ok');
  // published generations are immutable files with no WAL beside them
  assert.equal(read(dbPath, 'PRAGMA journal_mode').journal_mode, 'delete');
  assert.equal(fs.statSync(publishedFile(dbPath)).mode & 0o777, 0o444, 'read-only on disk');
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

test('rollback republishes the previous contents as a new generation; ids never repeat (R01)', async () => {
  const { dir, dbPath } = tmpWarehouse();
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
  const gen3File = publishedFile(dbPath);
  const r = rollback(dbPath);
  assert.equal(r.from, g3.generation);
  assert.equal(r.restores, g2.generation);
  assert.ok(r.to > g3.generation, 'a rollback is a new, higher generation');
  assert.equal(generations(dbPath).find(g => g.published).id, r.to);
  const meta = read(dbPath, 'SELECT kind, restores FROM generation_meta WHERE id = ?', r.to);
  assert.deepEqual({ ...meta }, { kind: 'rollback', restores: g2.generation });
  assert.ok(read(dbPath, 'SELECT id FROM companies WHERE name = ?', 'Anthropic (renamed in a job)'), "g2's contents");
  // the next job gets an id never used before, and no published file is overwritten
  const g4 = await runJob('curation', () => ({}), { dbPath });
  const ids = [g1, g2, g3].map(g => g.generation).concat([r.to, g4.generation]);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(g4.generation > r.to);
  assert.notEqual(publishedFile(dbPath), gen3File);
  assert.equal(fs.readFileSync(path.join(dir, 'generations', 'SEQUENCE'), 'utf8').trim(), String(g4.generation));
});

test('rollback: a second rollback has nothing older to go to; --to undoes it', async () => {
  const { dbPath } = tmpWarehouse();
  await runJob('curation', () => ({}), { dbPath });
  const g2 = await runJob('curation', db => db.exec(RENAME) && {}, { dbPath });
  const r = rollback(dbPath);
  assert.throws(() => rollback(dbPath), /no earlier generation/);
  const back = rollback(dbPath, { to: g2.generation });
  assert.equal(back.restores, g2.generation);
  assert.ok(back.to > r.to);
  assert.ok(read(dbPath, 'SELECT id FROM companies WHERE name = ?', 'Anthropic (renamed in a job)'));
});

test('a reader that misses a rollback still converges on the next publication (R01)', async () => {
  const { dbPath } = tmpWarehouse();
  await runJob('curation', () => ({}), { dbPath });
  await runJob('curation', db => db.exec(RENAME) && {}, { dbPath });
  const app = express();
  app.use(
    '/api',
    warehouseRouter(() => openWarehouseReadOnly(dbPath))
  );
  const fresh = async () => (await request(app).get('/api/freshness').expect(200)).body.refreshId;
  const name = async () => JSON.stringify((await request(app).get('/api/search?q=anthropic').expect(200)).body);
  const seen = [await fresh()];
  assert.match(await name(), /renamed in a job/);
  rollback(dbPath); // this reader asks nothing during the rollback
  const g = await runJob(
    'curation',
    db => db.exec("UPDATE companies SET name = 'Anthropic C' WHERE name = 'Anthropic'") && {},
    {
      dbPath,
    }
  );
  seen.push(await fresh());
  assert.equal(seen[1], g.generation);
  assert.ok(seen[1] > seen[0]);
  assert.match(await name(), /Anthropic C/);
  assert.doesNotMatch(await name(), /renamed in a job/);
});

test('lock fencing: a job whose lock was taken over cannot release or publish (R03)', async () => {
  const { dbPath } = tmpWarehouse();
  const before = publishedFile(dbPath);
  let release;
  const held = new Promise(resolve => (release = resolve));
  const first = runJob('refresh', () => held.then(() => ({})), { dbPath });
  await new Promise(r => setTimeout(r, 50));
  // the first owner's heartbeat looks stopped and it runs on another host: a second owner takes over
  const lockFile = `${dbPath}.lock`;
  const holder = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  fs.writeFileSync(lockFile, JSON.stringify({ ...holder, host: 'elsewhere' }));
  const old = new Date(Date.now() - 11 * 60 * 1000);
  fs.utimesSync(lockFile, old, old);
  const second = acquireLock(dbPath, 'curation');
  release();
  await assert.rejects(first, err => err.status === 409 && /taken over/.test(err.message));
  assert.equal(publishedFile(dbPath), before, 'the fenced job published nothing');
  assert.ok(second.owned(), "the first job's release left the second lock in place");
  assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).token, second.token);
  second.release();
  assert.ok(!fs.existsSync(lockFile));
});

test('lock: a live process on this host is never taken over, however old its heartbeat (R03)', () => {
  const { dbPath } = tmpWarehouse();
  const lock = acquireLock(dbPath, 'refresh');
  const old = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(`${dbPath}.lock`, old, old);
  assert.throws(
    () => acquireLock(dbPath, 'curation'),
    err => err.status === 409
  );
  lock.release();
});

test('after the commit point, a cleanup failure is a warning on a published job, not a failure (R09)', async () => {
  const { dbPath } = tmpWarehouse();
  const realRm = fs.rmSync;
  // pruning fails (ENOSPC-like) once the new generation is live
  const g1 = await runJob('curation', () => ({}), { dbPath });
  await runJob('curation', () => ({}), { dbPath });
  fs.rmSync = (f, ...a) => {
    if (/warehouse-\d+\.db$/.test(String(f)))
      throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' });
    return realRm(f, ...a);
  };
  let r;
  try {
    r = await runJob('curation', db => db.exec(RENAME) && {}, { dbPath });
  } finally {
    fs.rmSync = realRm;
  }
  assert.equal(r.status, 'ok');
  assert.match(r.warning, /pruning.*ENOSPC/);
  assert.equal(generations(dbPath).find(g => g.published).id, r.generation);
  assert.equal(jobState(dbPath).status, 'ok');
  assert.match(jobState(dbPath).warning, /ENOSPC/);
  assert.ok(g1.generation < r.generation);
});

test('a job that adds a filing with no holdings after private holdings publishes with a warning (R13, trap 55)', async () => {
  const { dbPath } = tmpWarehouse();
  const r = await runJob(
    'ingest-delta',
    db => {
      // a fund with private rows at one canonical filing and a later filing
      const f = db
        .prepare(
          `SELECT c.accession, c.fund_key, c.report_date FROM canonical_filings c
           WHERE EXISTS (SELECT 1 FROM holdings h JOIN companies co ON co.id = h.company_id
                         WHERE h.accession = c.accession AND co.status = 'private')
             AND EXISTS (SELECT 1 FROM filings g WHERE g.fund_key = c.fund_key AND g.report_date > date(c.report_date, '+1 day'))
           ORDER BY c.report_date LIMIT 1`
        )
        .get();
      const cols = db
        .prepare('PRAGMA table_info(filings)')
        .all()
        .map(c => c.name);
      const set = {
        accession: "'0009999999-26-000001'",
        report_date: `date('${f.report_date}', '+1 day')`,
        net_assets: '1000000',
        source: "'edgar'",
      };
      db.exec(
        `INSERT INTO filings (${cols.join(', ')}) SELECT ${cols.map(c => set[c] ?? c).join(', ')}
         FROM filings WHERE accession = '${f.accession}'`
      );
      db.exec(`INSERT INTO filing_totals (accession, rows, value_usd, rows_listed, value_listed, rows_debt, value_debt,
               rows_l3_equity, value_l3_equity) VALUES ('0009999999-26-000001', 0, 0, 0, 0, 0, 0, 0, 0)`);
      return {};
    },
    { dbPath }
  );
  assert.equal(r.status, 'ok');
  assert.match(r.warning, /1 filing\(s\) with no holdings section.*trap 55.*0009999999-26-000001/);
  assert.match(jobState(dbPath).warning, /trap 55/);
  // the next job does not repeat a warning for a filing already published
  const again = await runJob('curation', () => ({}), { dbPath });
  assert.equal(again.warning, undefined);
});

const REVIEW = path.join(__dirname, '..', 'data', 'review');
function reviewCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vantage-review-'));
  for (const f of fs.readdirSync(REVIEW)) fs.copyFileSync(path.join(REVIEW, f), path.join(dir, f));
  return dir;
}
const snapshotOf = dir => Object.fromEntries(fs.readdirSync(dir).map(f => [f, fs.readFileSync(path.join(dir, f))]));

test('curation: a failed job leaves the reviewed files byte for byte as they were (R05)', async () => {
  const { dbPath } = tmpWarehouse();
  const dir = reviewCopy();
  const before = snapshotOf(dir);
  const target = publishedFile(dbPath);
  // the import rewrites the ledgers in the staged copy, then a later stage fails
  for (const stage of ['import', 'validation']) {
    await assert.rejects(
      runJob(
        'curation',
        (db, { curationDir }) => {
          assert.notEqual(curationDir, dir);
          fs.appendFileSync(path.join(curationDir, 'company_ids.csv'), '9999,Never Published,,\n');
          if (stage === 'import') throw new Error('disclosure import failed');
          db.exec('DELETE FROM filings WHERE rowid % 10 = 0'); // validation refuses the shrink
          return {};
        },
        { dbPath, curationDir: dir }
      ),
      stage === 'import' ? /disclosure import failed/ : /validation failed/
    );
    assert.deepEqual(snapshotOf(dir), before, `files unchanged after a failed ${stage}`);
    assert.equal(publishedFile(dbPath), target);
  }
});

test('curation: a published job writes its files back and records the exact snapshot (R05, R18)', async () => {
  const { dbPath } = tmpWarehouse();
  const dir = reviewCopy();
  const r = await runJob(
    'curation',
    (db, { curationDir }) => {
      fs.appendFileSync(path.join(curationDir, 'company_ids.csv'), '');
      fs.writeFileSync(path.join(curationDir, 'note.txt'), 'staged');
      return {};
    },
    { dbPath, curationDir: dir }
  );
  assert.equal(fs.readFileSync(path.join(dir, 'note.txt'), 'utf8'), 'staged');
  assert.ok(!fs.existsSync(path.join(dir, '.pending-publish.json')));
  const meta = read(dbPath, 'SELECT curation_digest FROM generation_meta WHERE id = ?', r.generation);
  assert.match(meta.curation_digest, /^[0-9a-f]{64}$/);
  const snap = read(dbPath, "SELECT content FROM curation_snapshot WHERE name = 'aliases.csv'");
  assert.ok(Buffer.from(snap.content).equals(fs.readFileSync(path.join(dir, 'aliases.csv'))));
  // answers and their basis name the exact curation (R18)
  const app = express();
  app.use(
    '/api',
    warehouseRouter(() => openWarehouseReadOnly(dbPath))
  );
  const f = (await request(app).get('/api/freshness').expect(200)).body;
  assert.equal(f.generation.curationDigest, meta.curation_digest);
  const top = (await request(app).get('/api/market/top').expect(200)).body;
  assert.deepEqual([top.basis.generation, top.basis.curationDigest], [r.generation, meta.curation_digest]);
  // a crash after the publish, before the write-back: the next curation job refuses until synced
  fs.writeFileSync(path.join(dir, '.pending-publish.json'), JSON.stringify({ generation: r.generation, files: [] }));
  fs.writeFileSync(path.join(dir, 'note.txt'), 'lost');
  await assert.rejects(
    runJob('curation', () => ({}), { dbPath, curationDir: dir }),
    /--sync-curation/
  );
  syncCuration(dbPath, dir);
  assert.equal(fs.readFileSync(path.join(dir, 'note.txt'), 'utf8'), 'staged');
  assert.ok(!fs.existsSync(path.join(dir, '.pending-publish.json')));
  // a job without curation carries the snapshot and its digest forward
  const g = await runJob('refresh', () => ({}), { dbPath });
  assert.equal(
    read(dbPath, 'SELECT curation_digest d FROM generation_meta WHERE id = ?', g.generation).d,
    meta.curation_digest
  );
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
