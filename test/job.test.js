// P6c R2 (staff review F03/F04/F11): every write is a job that builds a
// candidate, validates it and publishes it whole as a new generation; a failed
// job leaves the published warehouse exactly as it was; readers switch to a new
// generation on their next request; one job at a time.
const test = require('node:test');
const { tmpDir, removeTmp } = require('./helpers/tmp');

// Each test's warehouse copies go when it ends (54 MB each, plus generations).
test.afterEach(removeTmp);
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
  jobTimeoutMs,
} = require('../lib/warehouse/job');
const { holderGone, selfIdentity } = require('../lib/warehouse/job-state');

// The golden warehouse as a plain file, the way every warehouse looked before
// generations (refresh run 1 ok).
let golden;
function tmpWarehouse() {
  golden ??= goldenWarehouse().db.serialize();
  const dir = tmpDir('job');
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

test("V06: the fund's newest filing with no holdings warns the moment it arrives", async () => {
  const { dbPath } = tmpWarehouse();
  const r = await runJob(
    'ingest-delta',
    db => {
      // a fund whose newest canonical filing held a private company
      const f = db
        .prepare(
          `SELECT c.accession, c.fund_key, c.report_date FROM canonical_filings c
           WHERE EXISTS (SELECT 1 FROM holdings h JOIN companies co ON co.id = h.company_id
                         WHERE h.accession = c.accession AND co.status = 'private')
             AND NOT EXISTS (SELECT 1 FROM filings g WHERE g.fund_key = c.fund_key AND g.report_date > c.report_date)
           ORDER BY c.report_date DESC LIMIT 1`
        )
        .get();
      const cols = db
        .prepare('PRAGMA table_info(filings)')
        .all()
        .map(c => c.name);
      const set = {
        accession: "'0009999999-26-000003'",
        report_date: `date('${f.report_date}', '+1 month')`,
        net_assets: '1000000',
        source: "'edgar'",
      };
      db.exec(
        `INSERT INTO filings (${cols.join(', ')}) SELECT ${cols.map(c => set[c] ?? c).join(', ')}
         FROM filings WHERE accession = '${f.accession}'`
      );
      db.exec(`INSERT INTO filing_totals (accession, rows, value_usd, rows_listed, value_listed, rows_debt, value_debt,
               rows_l3_equity, value_l3_equity) VALUES ('0009999999-26-000003', 0, 0, 0, 0, 0, 0, 0, 0)`);
      return {};
    },
    { dbPath }
  );
  assert.match(r.warning || '', /trap 55.*0009999999-26-000003/);
});

const REVIEW = path.join(__dirname, '..', 'data', 'review');
function reviewCopy() {
  const dir = tmpDir('review');
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
  const reports = tmpDir('review');
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

// Codex verification V03, made general: fail every mutating filesystem step the
// job takes after its commit point (the link switch), one at a time. However it
// fails, a published job resolves as published, with the failure as a warning.
// A new post-commit step is covered without editing this test.
const MUTATING = [
  'rmSync',
  'renameSync',
  'writeFileSync',
  'appendFileSync',
  'unlinkSync',
  'symlinkSync',
  'linkSync',
  'fsyncSync',
  'chmodSync',
];
function instrument(dbPath, failAt = -1) {
  const real = {};
  const after = [];
  let committed = false;
  for (const m of MUTATING) {
    real[m] = fs[m];
    fs[m] = (...args) => {
      if (committed) {
        after.push(`${m} ${path.basename(String(args[0]))}`);
        if (after.length - 1 === failAt) throw Object.assign(new Error(`injected ${m} failure`), { code: 'EIO' });
      }
      const out = real[m](...args);
      if (m === 'renameSync' && args[1] === dbPath) committed = true; // the link switch
      return out;
    };
  }
  return { after, restore: () => Object.assign(fs, real) };
}

test('every post-commit step can fail without failing a published job (fault-injection sweep)', async () => {
  const run = async failAt => {
    removeTmp(); // the previous run's files (its results are already checked)
    const { dbPath } = tmpWarehouse();
    const dir = reviewCopy();
    // the job stages curation under os.tmpdir(); a step that fails to remove the
    // stage (injected) leaves it in a directory this test removes
    const tmpEnv = process.env.TMPDIR;
    process.env.TMPDIR = tmpDir('sweep-stage');
    await runJob('curation', () => ({}), { dbPath }); // a generation to prune later
    const before = publishedFile(dbPath);
    const probe = instrument(dbPath, failAt);
    let r;
    try {
      r = await runJob(
        'curation',
        (db, { curationDir }) => {
          fs.writeFileSync(path.join(curationDir, 'note.txt'), 'staged'); // a write-back to do
          return {};
        },
        { dbPath, curationDir: dir }
      );
    } finally {
      probe.restore();
      if (tmpEnv === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = tmpEnv;
    }
    return { r, steps: probe.after, before, after: publishedFile(dbPath), dbPath };
  };
  const clean = await run(-1);
  assert.ok(clean.steps.length >= 5, `post-commit steps seen: ${clean.steps.join(', ')}`);
  for (let i = 0; i < clean.steps.length; i++) {
    const { r, before, after, dbPath } = await run(i);
    assert.notEqual(after, before, `step ${i} (${clean.steps[i]}): published`);
    assert.ok(['ok', 'partial'].includes(r.status), `step ${i} (${clean.steps[i]}): resolved ${r.status}`);
    const lockStep = /^rmSync warehouse\.db\.lock$/.test(clean.steps[i]);
    if (!lockStep) {
      assert.ok(!fs.existsSync(`${dbPath}.lock`), `step ${i} (${clean.steps[i]}): lock released`);
      if (!/state|jobs\.log/.test(clean.steps[i]))
        assert.match(r.warning || jobState(dbPath)?.warning || '', /injected/, `step ${i} (${clean.steps[i]}): warned`);
    }
  }
});

test('every post-commit step of a rollback can fail without failing the rollback (fault-injection sweep)', async () => {
  const run = async failAt => {
    removeTmp(); // the previous run's files (its results are already checked)
    const { dbPath } = tmpWarehouse();
    await runJob('curation', () => ({}), { dbPath });
    await runJob('curation', db => db.exec(RENAME) && {}, { dbPath });
    const before = publishedFile(dbPath);
    const probe = instrument(dbPath, failAt);
    let r;
    try {
      r = rollback(dbPath);
    } finally {
      probe.restore();
    }
    return { r, steps: probe.after, before, after: publishedFile(dbPath), dbPath };
  };
  const clean = await run(-1);
  assert.ok(clean.steps.length >= 3, `post-commit steps seen: ${clean.steps.join(', ')}`);
  for (let i = 0; i < clean.steps.length; i++) {
    const { r, before, after, dbPath } = await run(i);
    assert.notEqual(after, before, `step ${i} (${clean.steps[i]}): published`);
    assert.ok(r.to > 0, `step ${i} (${clean.steps[i]}): resolved`);
    if (!/^rmSync warehouse\.db\.lock$/.test(clean.steps[i]))
      assert.ok(!fs.existsSync(`${dbPath}.lock`), `step ${i} (${clean.steps[i]}): lock released`);
  }
});

// Codex verification V02: the curation a generation records is the curation its
// derived tables were built from. A curation job reads its staged copy; any
// other job reads the generation's own snapshot, never data/review on disk.
test('derived identity reads the staged curation, then the snapshot, never the files on disk', async () => {
  const { dbPath } = tmpWarehouse();
  const dir = reviewCopy();
  const probe = read(
    dbPath,
    "SELECT key FROM unreviewed_entities WHERE active = 1 AND category = 'company' ORDER BY current_value_usd DESC LIMIT 1"
  ).key;
  const categoryOf = () => read(dbPath, 'SELECT category FROM unreviewed_entities WHERE key = ?', probe).category;
  // staged: the probe key is reviewed public; data/review on disk says nothing about it
  await runJob(
    'curation',
    (db, { curationDir }) => {
      const file = path.join(curationDir, 'curation.json');
      const c = JSON.parse(fs.readFileSync(file, 'utf8'));
      c.status = { ...c.status, [probe]: { status: 'public', evidence: 'test probe' } };
      fs.writeFileSync(file, JSON.stringify(c, null, 2));
      return {};
    },
    { dbPath, curationDir: dir }
  );
  assert.equal(categoryOf(), 'listed', 'the rebuild used the staged decision');
  const snap = JSON.parse(
    Buffer.from(read(dbPath, "SELECT content FROM curation_snapshot WHERE name = 'curation.json'").content).toString()
  );
  assert.equal(snap.status[probe].status, 'public', 'the snapshot holds what was used');
  // a refresh: the generation's snapshot, not data/review/curation.json (which lacks the decision)
  assert.equal(JSON.parse(fs.readFileSync(path.join(REVIEW, 'curation.json'), 'utf8')).status?.[probe], undefined);
  await runJob('refresh', () => ({}), { dbPath });
  assert.equal(categoryOf(), 'listed', 'the refresh used the snapshot');
  // a rollback, then a refresh: the restored generation's own snapshot
  rollback(dbPath);
  await runJob('refresh', () => ({}), { dbPath });
  assert.equal(categoryOf(), 'listed');
});

// Codex verification V01: two processes judge the same stale lock stale. The
// second has already taken it (a fresh lock with its own token) when the first
// moves the pathname: the first must give it back and answer 409.
test('a stale lock taken by someone else between inspection and takeover stays theirs (one owner)', () => {
  const { dbPath } = tmpWarehouse();
  const lockFile = `${dbPath}.lock`;
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 1, host: 'elsewhere', kind: 'refresh', token: 'stale' }));
  const old = new Date(Date.now() - 11 * 60 * 1000);
  fs.utimesSync(lockFile, old, old);
  const realRename = fs.renameSync;
  let raced = false;
  fs.renameSync = (from, to) => {
    if (from === lockFile && !raced) {
      raced = true; // the other taker wins first: a fresh lock replaces the stale one
      fs.writeFileSync(lockFile, JSON.stringify({ pid: 2, host: 'elsewhere', kind: 'curation', token: 'fresh' }));
    }
    return realRename(from, to);
  };
  try {
    assert.throws(
      () => acquireLock(dbPath, 'refresh'),
      err => err.status === 409
    );
  } finally {
    fs.renameSync = realRename;
  }
  assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).token, 'fresh', 'the other owner keeps its lock');
  assert.ok(!fs.readdirSync(path.dirname(lockFile)).some(f => f.includes('.stale-')), 'no tombstone left');
});

test('a failure before the commit point fails the job and still releases the lock (V03)', async () => {
  const { dbPath } = tmpWarehouse();
  const dir = reviewCopy();
  const target = publishedFile(dbPath);
  const realRm = fs.rmSync;
  fs.rmSync = (f, ...a) => {
    if (String(f).includes('vantage-curation-')) throw Object.assign(new Error('injected EACCES'), { code: 'EACCES' });
    return realRm(f, ...a);
  };
  try {
    await assert.rejects(
      runJob(
        'curation',
        () => {
          throw new Error('the import failed');
        },
        { dbPath, curationDir: dir }
      ),
      /the import failed/ // the cause, not the cleanup error
    );
  } finally {
    fs.rmSync = realRm;
  }
  assert.equal(publishedFile(dbPath), target);
  assert.ok(!fs.existsSync(`${dbPath}.lock`), 'lock released');
  assert.equal(jobState(dbPath).status, 'failed');
});

// ---- P8 pre-flight (2026-10-07): every job ends, and a dead job is seen as dead ----

const noCandidate = dir =>
  assert.ok(!fs.readdirSync(path.join(dir, 'generations')).some(f => /candidate/.test(f)), 'candidate removed');

test('a job past its time limit fails, publishes nothing and releases the lock; the next job runs', async () => {
  const { dir, dbPath } = tmpWarehouse();
  const first = await runJob('curation', () => ({}), { dbPath });
  const target = publishedFile(dbPath);
  const t0 = Date.now();
  await assert.rejects(
    runJob('refresh', () => new Promise(() => {}), { dbPath, timeoutMs: 2000 }), // a source that never answers
    err => err.status === 504 && /refresh job ran past its 0 min limit; nothing published/.test(err.message)
  );
  assert.ok(Date.now() - t0 < 10000, 'it ends at the limit');
  assert.equal(publishedFile(dbPath), target);
  assert.ok(!fs.existsSync(`${dbPath}.lock`), 'lock released');
  assert.equal(jobState(dbPath).status, 'failed');
  assert.match(jobState(dbPath).error, /past its/);
  noCandidate(dir);
  const next = await runJob('curation', () => ({}), { dbPath });
  assert.ok(next.generation > first.generation);
});

test('a job whose synchronous work runs past its limit is refused before the commit point', async () => {
  const { dir, dbPath } = tmpWarehouse();
  const target = publishedFile(dbPath);
  const busy = () => {
    const end = Date.now() + 1600; // no timer can fire meanwhile
    while (Date.now() < end);
    return {};
  };
  await assert.rejects(runJob('refresh', busy, { dbPath, timeoutMs: 1500 }), err => err.status === 504);
  assert.equal(publishedFile(dbPath), target);
  assert.ok(!fs.existsSync(`${dbPath}.lock`));
  noCandidate(dir);
});

test('the job time limit: 3 hours unless VANTAGE_JOB_TIMEOUT_MIN gives a positive number', () => {
  assert.equal(jobTimeoutMs(undefined), 3 * 3600 * 1000);
  assert.equal(jobTimeoutMs(''), 3 * 3600 * 1000);
  assert.equal(jobTimeoutMs('45'), 45 * 60 * 1000);
  for (const bad of ['0', '-5', 'soon']) assert.equal(jobTimeoutMs(bad), 3 * 3600 * 1000, bad);
});

test('lock: a live pid that now runs another process (pid reuse, a reboot) is taken over', () => {
  const { dbPath } = tmpWarehouse();
  const me = selfIdentity();
  const lockFile = `${dbPath}.lock`;
  const put = holder => fs.writeFileSync(lockFile, JSON.stringify({ kind: 'refresh', ...holder }));
  // this process's pid, but a start time a day earlier: another process held it
  put({ ...me, procStart: me.procStart - 86400000 });
  acquireLock(dbPath, 'curation').release();
  assert.ok(!fs.existsSync(lockFile));
  // ps unavailable: a boot time an hour off means the host rebooted since
  put({ ...me, boot: me.boot - 3600000 });
  acquireLock(dbPath, 'curation', { startOf: () => null }).release();
  assert.ok(!fs.existsSync(lockFile));
  // the same process (start time within ps's whole seconds): never taken over
  put({ ...me, procStart: me.procStart - 900 });
  assert.throws(
    () => acquireLock(dbPath, 'curation'),
    err => err.status === 409
  );
  // a lock written before start times were recorded: judged by its pid, as before
  put({ pid: me.pid, host: me.host });
  assert.throws(
    () => acquireLock(dbPath, 'curation'),
    err => err.status === 409
  );
  fs.rmSync(lockFile);
});

test('holderGone: ended, reused, rebooted, alive, another host, no pid', () => {
  const me = selfIdentity();
  const dead = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout);
  assert.equal(holderGone({ ...me, pid: dead }), true);
  assert.equal(holderGone({ ...me, procStart: me.procStart + 60000 }), true);
  assert.equal(holderGone({ ...me, procStart: undefined, boot: me.boot + 7200000 }), true);
  assert.equal(holderGone(me), false);
  assert.equal(holderGone({ ...me, host: 'another-host' }), null);
  assert.equal(holderGone({ host: me.host }), null);
});

test('a job state left "running" by a process that ended reads as interrupted, in jobState and /freshness', async () => {
  const { dbPath } = tmpWarehouse();
  await runJob('curation', () => ({}), { dbPath });
  const me = selfIdentity();
  const dead = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout);
  const put = s =>
    fs.writeFileSync(
      `${dbPath}.job.json`,
      JSON.stringify({ kind: 'refresh', startedAt: 'x', status: 'running', ...s })
    );
  const app = express().use(
    '/api',
    warehouseRouter(() => openWarehouseReadOnly(dbPath))
  );
  const job = async () => (await request(app).get('/api/freshness').expect(200)).body.job;

  put({ ...me, pid: dead });
  assert.equal(jobState(dbPath).status, 'interrupted');
  const j = await job();
  assert.equal(j.status, 'interrupted');
  assert.match(j.error, new RegExp(`refresh job's process \\(pid ${dead}\\) ended without finishing`));
  put({ ...me, procStart: me.procStart - 86400000 }); // the pid was reused
  assert.equal((await job()).status, 'interrupted');
  put(me); // the job really is running
  assert.equal((await job()).status, 'running');
});

// The drill behind both (ROADMAP §8 crash drills): a job killed mid-run leaves
// its lock and a "running" state; the state reads as interrupted, and the next
// job takes the lock over and publishes.
test('crash drill: a job killed with SIGKILL mid-run blocks nothing; the next job publishes', async () => {
  const { dir, dbPath } = tmpWarehouse();
  const first = await runJob('curation', () => ({}), { dbPath });
  const marker = path.join(dir, 'started');
  const child = require('child_process').spawn(
    process.execPath,
    [
      '-e',
      `require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'warehouse', 'job.js'))})
        .runJob('refresh', () => { require('fs').writeFileSync(${JSON.stringify(marker)}, ''); return new Promise(() => {}); },
          { dbPath: ${JSON.stringify(dbPath)} });`,
    ],
    { stdio: 'ignore' }
  );
  const t0 = Date.now();
  while (!fs.existsSync(marker)) {
    assert.ok(Date.now() - t0 < 30000, 'the child job started');
    await new Promise(r => setTimeout(r, 50));
  }
  assert.equal(jobState(dbPath).status, 'running');
  const exited = new Promise(r => child.on('exit', r));
  child.kill('SIGKILL');
  await exited;
  assert.ok(fs.existsSync(`${dbPath}.lock`), 'the killed job left its lock');
  const left = fs.readdirSync(path.join(dir, 'generations')).filter(f => /candidate/.test(f));
  assert.ok(left.length, 'and its candidate');
  assert.equal(jobState(dbPath).status, 'interrupted');
  const next = await runJob('curation', () => ({}), { dbPath });
  assert.ok(next.generation > first.generation, 'the lock was taken over and the job published');
  noCandidate(dir); // the killed job's candidate (~ the warehouse's size) is gone
  assert.ok(!fs.existsSync(`${dbPath}.lock`));
  assert.equal(jobState(dbPath).status, 'ok');
});

test('a job that would fill the disk fails before copying anything; the lock is released', async () => {
  const { dir, dbPath } = tmpWarehouse();
  const target = publishedFile(dbPath);
  const size = fs.statSync(target).size;
  await assert.rejects(
    runJob('refresh', () => assert.fail('the job never starts'), { dbPath, freeBytes: () => size }),
    err => err.status === 507 && /not enough free disk for a job: .* GiB needed .*nothing changed/.test(err.message)
  );
  assert.equal(publishedFile(dbPath), target);
  assert.ok(!fs.existsSync(`${dbPath}.lock`));
  assert.equal(jobState(dbPath).status, 'failed');
  noCandidate(dir);
  // exactly enough room: the job runs
  const r = await runJob('curation', () => ({}), { dbPath, freeBytes: () => size + 1024 ** 3 });
  assert.equal(r.status, 'ok');
});

test('doctor: healthy after a job; fails on an interrupted job or a full disk; warns on what dead jobs left', async () => {
  const { doctor } = require('../lib/warehouse/doctor');
  const { dir, dbPath } = tmpWarehouse();
  await runJob('refresh', () => ({}), { dbPath });
  const tmp = tmpDir('doctor-tmp');
  const opts = { tmp, processes: () => [], freeBytes: () => 100 * 1024 ** 3 };
  const by = r => Object.fromEntries(r.checks.map(c => [c.name, c]));

  let r = doctor(dbPath, opts);
  assert.equal(r.ok, true);
  assert.deepEqual(
    r.checks.filter(c => c.status === 'fail').map(c => c.name),
    []
  );
  assert.match(by(r).warehouse.detail, /^generation \d+, generations\/warehouse-\d+\.db/);
  assert.match(by(r)['last job'].detail, /^refresh ok/);
  assert.equal(by(r)['job lock'].detail, 'free');
  assert.match(by(r).rows.detail, /filings; .* holding rows; companies .* private/);

  // what a SIGKILLed job leaves: a running state, its lock, its candidate
  const dead = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout);
  const ghost = { ...selfIdentity(), pid: dead, kind: 'refresh' };
  fs.writeFileSync(`${dbPath}.job.json`, JSON.stringify({ ...ghost, status: 'running', startedAt: 'x' }));
  fs.writeFileSync(`${dbPath}.lock`, JSON.stringify(ghost));
  fs.writeFileSync(path.join(dir, 'generations', `warehouse.candidate-${dead}.db`), 'x');
  const old = tmpDir('doctor-old');
  fs.renameSync(old, path.join(tmp, 'vantage-job-AbC123'));
  const day = new Date(Date.now() - 2 * 86400000);
  fs.utimesSync(path.join(tmp, 'vantage-job-AbC123'), day, day);
  r = doctor(dbPath, opts);
  assert.equal(r.ok, false);
  assert.equal(by(r)['last job'].status, 'fail');
  assert.match(by(r)['last job'].detail, /refresh interrupted/);
  assert.equal(by(r)['job lock'].status, 'warn');
  assert.match(by(r)['job lock'].detail, new RegExp(`process ended \\(pid ${dead}\\); the next job takes it over`));
  assert.equal(by(r).candidates.status, 'warn');
  assert.equal(by(r)['temp files'].status, 'warn');
  assert.match(by(r)['temp files'].detail, /^1 vantage-\* directories older than a day/);

  // no room for the next job
  r = doctor(dbPath, { ...opts, freeBytes: () => 1024 });
  assert.equal(by(r).disk.status, 'fail');
  assert.match(by(r).disk.detail, /not enough free disk/);

  // no warehouse at all
  r = doctor(path.join(tmpDir('doctor-none'), 'warehouse.db'), opts);
  assert.deepEqual([r.ok, r.checks[0].status], [false, 'fail']);
});
