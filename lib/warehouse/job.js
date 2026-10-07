// The one write path into the warehouse (P6c R2, staff review F03/F04/F11;
// ADR 0009). Every job that changes data (the refresh, ingests, N-CEN, the
// review import, "make this a company", backfills) runs through runJob:
//
//   1. take the job lock (a lock file next to the warehouse with an owner
//      token and a heartbeat; a lock whose process is gone is stale, and so is
//      one from another host whose heartbeat stopped; a live process on this
//      host is never taken over). The token is checked again before publishing,
//      so a job that lost its lock publishes nothing (P6d, review R03);
//   2. copy the published generation to a candidate file (SQLite backup API;
//      readers keep reading the published one);
//   3. run the job on the candidate, under a refresh_runs row;
//   4. rebuild everything derived from stored rows (refresh.rebuildDerived);
//   5. validate the candidate (integrity, schema, row counts against the
//      published generation, derived tables present);
//   6. record generation_meta and publish: the candidate becomes
//      generations/warehouse-<id>.db and the `warehouse.db` symlink is swapped
//      to it in one rename. Readers that see the new link open the new file;
//      the previous generation is kept for rollback.
//
// Generation ids never repeat (review R01): they come from generations/SEQUENCE,
// outside the data, and a rollback publishes the older contents as a new
// generation. A published file is never overwritten.
//
// A job given `curationDir` (the review import, "make this a company") works on
// a staged copy of the reviewed files. They are snapshotted into the candidate
// (curation_snapshot) and written back only after the publish (review R05), so
// a failed job leaves data/review exactly as it was.
//
// The link rename is the commit point. A job that fails before it leaves the
// published generation untouched and the candidate is deleted. A failure after
// it (pruning, writing state or curation files back) is reported as a warning
// on a published job, never as a failed one (review R09). The last job's state
// (running, ok, partial, failed) is written to `<warehouse>.job.json`, apart
// from the data version.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');
const { openWarehouse, defaultWarehousePath, migrationFiles, generationOf } = require('./db');
const { claimRun, rebuildDerived } = require('./refresh');
const { pathsOf, writeState, jobState } = require('./job-state');

const ROOT = path.join(__dirname, '..', '..');
const HEARTBEAT_MS = 30 * 1000;
const STALE_LOCK_MS = 10 * 60 * 1000; // no heartbeat for 10 minutes: the holder is gone
const KEEP_GENERATIONS = 2; // the published one and the one before it
// Validation: a job may not shrink these tables by more than this share of the
// published generation's rows (a bad source or a broken rule), unless allowed.
const MAX_SHRINK = 0.02;

class JobError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// The published file: the link's target, the file itself (a warehouse from
// before generations), or null (none yet).
function publishedFile(dbPath) {
  try {
    const st = fs.lstatSync(dbPath);
    return st.isSymbolicLink() ? fs.realpathSync(dbPath) : dbPath;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

const alive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

// The job lock. Exclusive create, with an owner token: the heartbeat and the
// release touch the lock only while it still carries this job's token, and
// assertOwned() is called before publishing (a job whose lock was taken over
// publishes nothing). A lock is taken over only when its process is gone (same
// host), or, for a lock from another host or with no readable pid, when its
// heartbeat stopped more than STALE_LOCK_MS ago. A live process on this host is
// never taken over: its heartbeat timer cannot fire during long synchronous
// SQLite work, so a stopped heartbeat does not mean it ended.
function acquireLock(dbPath, kind, { now = Date.now } = {}) {
  const { lock } = pathsOf(dbPath);
  const token = crypto.randomBytes(16).toString('hex');
  const owned = () => {
    try {
      return JSON.parse(fs.readFileSync(lock, 'utf8')).token === token;
    } catch {
      return false;
    }
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lock, 'wx');
      fs.writeSync(
        fd,
        JSON.stringify({
          pid: process.pid,
          host: os.hostname(),
          kind,
          startedAt: new Date(now()).toISOString(),
          token,
        })
      );
      fs.closeSync(fd);
      const beat = setInterval(() => {
        try {
          if (!owned()) return; // taken over: assertOwned() stops the publish
          const t = new Date();
          fs.utimesSync(lock, t, t);
        } catch {
          // lock removed under us: assertOwned() reports it
        }
      }, HEARTBEAT_MS);
      beat.unref();
      return {
        token,
        owned,
        assertOwned() {
          if (!owned())
            throw new JobError(409, `the job lock ${lock} was taken over by another process; nothing published`);
        },
        release() {
          clearInterval(beat);
          if (owned()) fs.rmSync(lock, { force: true });
        },
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let holder = {};
      try {
        holder = JSON.parse(fs.readFileSync(lock, 'utf8'));
      } catch {
        // half-written lock: judged by its age alone
      }
      const age = now() - fs.statSync(lock).mtimeMs;
      const sameHost = !holder.host || holder.host === os.hostname();
      const live = sameHost && holder.pid && alive(holder.pid);
      const gone = sameHost && holder.pid && !live;
      if (attempt === 0 && (gone || (!live && age > STALE_LOCK_MS))) {
        fs.rmSync(lock, { force: true });
        continue;
      }
      throw new JobError(
        409,
        `a ${holder.kind || 'warehouse'} job is already running (pid ${holder.pid}, started ${holder.startedAt}); ` +
          `try again when it finishes (if no job is running, remove ${lock})`
      );
    }
  }
  throw new JobError(409, 'could not take the job lock');
}

// Durability around the commit point: the generation file, then the directory
// entries that name it (a no-op where a directory cannot be opened for sync).
function fsyncPath(p) {
  let fd;
  try {
    fd = fs.openSync(p, 'r');
    fs.fsyncSync(fd);
  } catch (err) {
    if (!['EISDIR', 'EINVAL', 'EPERM', 'EBADF'].includes(err.code)) throw err;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// The next generation id: above the SEQUENCE file, every generation file and
// the version the data records, so a rollback (which restores an older
// generation_meta) can never hand out an id again. Call it under the lock.
const GEN_FILE = /^warehouse-(\d+)\.db$/;
function nextGenerationId(dbPath, db) {
  const p = pathsOf(dbPath);
  const seqFile = path.join(p.generations, 'SEQUENCE');
  let seq = 0;
  try {
    seq = Number(fs.readFileSync(seqFile, 'utf8').trim()) || 0;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const files = fs
    .readdirSync(p.generations)
    .map(f => Number((f.match(GEN_FILE) || [])[1]))
    .filter(Number.isInteger);
  // the data's own version: generation_meta, or the last finished run of a
  // warehouse from before generations (what readers reported as its refreshId)
  const recorded = generationOf(db);
  const id = Math.max(seq, recorded, ...files) + 1;
  const tmp = `${seqFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${id}\n`);
  fsyncPath(tmp);
  fs.renameSync(tmp, seqFile);
  return id;
}

// ---- curation (review R05, R18) ----
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const PENDING = '.pending-publish.json';
const curationFiles = dir =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isFile() && !e.name.startsWith('.'))
    .map(e => e.name)
    .sort();
const writeAtomic = (file, data) => {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fsyncPath(tmp);
  fs.renameSync(tmp, file);
};

// A staged copy of the reviewed files for one job, and their bytes as read.
function stageCuration(dir) {
  const pending = path.join(dir, PENDING);
  if (fs.existsSync(pending))
    throw new JobError(
      409,
      `${pending}: an earlier curation job published generation ${JSON.parse(fs.readFileSync(pending, 'utf8')).generation} ` +
        'but did not finish writing its files back; run npm run warehouse -- --sync-curation first'
    );
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'vantage-curation-'));
  const original = new Map();
  for (const f of curationFiles(dir)) {
    const buf = fs.readFileSync(path.join(dir, f));
    original.set(f, buf);
    fs.writeFileSync(path.join(stage, f), buf);
  }
  return { dir, stage, original };
}

// Replaces the candidate's curation snapshot with the staged files.
function snapshotCuration(db, stage) {
  db.prepare('DELETE FROM curation_snapshot').run();
  const put = db.prepare('INSERT INTO curation_snapshot (name, sha256, content) VALUES (?, ?, ?)');
  for (const f of curationFiles(stage)) {
    const buf = fs.readFileSync(path.join(stage, f));
    put.run(f, sha256(buf), buf);
  }
}

// One digest for the snapshot a warehouse carries (null when it has none).
function curationDigest(db) {
  let rows;
  try {
    rows = db.prepare('SELECT name, sha256 FROM curation_snapshot ORDER BY name').all();
  } catch {
    return null; // before migration 0021
  }
  return rows.length ? sha256(rows.map(r => `${r.name}\0${r.sha256}\n`).join('')) : null;
}

// The staged files that differ from what the job read.
const changedCuration = ({ stage, original }) =>
  curationFiles(stage).filter(f => {
    const was = original.get(f);
    return !was || !was.equals(fs.readFileSync(path.join(stage, f)));
  });

// Writes the published generation's curation snapshot back to `dir` (after a
// job that published but did not finish writing its files). Returns the names.
function syncCuration(dbPath = defaultWarehousePath(), dir = path.join(ROOT, 'data', 'review')) {
  const db = new Database(publishedFile(dbPath), { readonly: true, fileMustExist: true });
  let rows;
  try {
    rows = db.prepare('SELECT name, content FROM curation_snapshot ORDER BY name').all();
  } finally {
    db.close();
  }
  if (!rows.length) throw new JobError(409, 'the published generation carries no curation snapshot');
  for (const r of rows) writeAtomic(path.join(dir, r.name), r.content);
  fs.rmSync(path.join(dir, PENDING), { force: true });
  return rows.map(r => r.name);
}

const git = args => {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
};
// The curation the generation was built from: the git tree of data/review,
// marked +dirty when the files had uncommitted edits (F14: which reviewed
// interpretation an answer used).
function curationRev() {
  const tree = git(['rev-parse', 'HEAD:data/review']);
  if (!tree) return null;
  return git(['status', '--porcelain', '--', 'data/review']) ? `${tree}+dirty` : tree;
}

const COUNTED = ['filings', 'holdings', 'companies', 'managers', 'ncen_advisers'];
const count = (db, t) => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;

// The candidate must be a whole, current warehouse before anyone reads it.
function validate(db, published, { allowShrink = false } = {}) {
  const problems = [];
  const check = db.pragma('quick_check', { simple: true });
  if (check !== 'ok') problems.push(`quick_check: ${check}`);
  const expected = migrationFiles().length;
  const applied = db.prepare('SELECT COUNT(*) n FROM schema_migrations').get().n;
  if (applied < expected) problems.push(`schema at ${applied} of ${expected} migrations`);
  const fk = db.pragma('foreign_key_check');
  if (fk.length) problems.push(`${fk.length} foreign key violation(s), e.g. ${JSON.stringify(fk[0])}`);
  const now = Object.fromEntries(COUNTED.map(t => [t, count(db, t)]));
  if (published && !allowShrink)
    for (const t of COUNTED) {
      const before = published[t];
      if (before && now[t] < before * (1 - MAX_SHRINK))
        problems.push(
          `${t}: ${now[t]} rows, the published generation has ${before} (more than ${MAX_SHRINK * 100}% fewer)`
        );
    }
  if (now.holdings > 0) {
    if (!count(db, 'position_facts')) problems.push('position_facts is empty');
    if (!count(db, 'company_stats')) problems.push('company_stats is empty');
    if (!count(db, 'fund_names')) problems.push('fund_names is empty');
  }
  return { counts: now, problems };
}

function countsOf(file) {
  if (!file) return null;
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return Object.fromEntries(
      COUNTED.map(t => {
        try {
          return [t, count(db, t)];
        } catch {
          return [t, 0]; // a warehouse from before the table existed
        }
      })
    );
  } finally {
    db.close();
  }
}

const removeDb = file => {
  for (const f of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) fs.rmSync(f, { force: true });
};

// Swaps the warehouse link to `file` (a generation in generations/) in one
// rename. A warehouse from before generations (a plain file) is checkpointed
// and moved into generations/ first, so it stays as the rollback copy.
function publish(dbPath, file, { log = () => {} } = {}) {
  const p = pathsOf(dbPath);
  const st = (() => {
    try {
      return fs.lstatSync(dbPath);
    } catch {
      return null;
    }
  })();
  if (st && !st.isSymbolicLink()) {
    // fold any WAL into the file before it moves (readers may still hold it)
    const old = new Database(dbPath);
    try {
      old.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      old.close();
    }
    const moved = path.join(p.generations, 'warehouse-0.db');
    fs.renameSync(dbPath, moved);
    for (const ext of ['-wal', '-shm']) fs.rmSync(`${dbPath}${ext}`, { force: true });
    log(`moved the pre-generation warehouse to ${path.relative(p.dir, moved)}`);
  }
  const tmp = `${dbPath}.link-${process.pid}`;
  fs.rmSync(tmp, { force: true });
  fs.symlinkSync(path.relative(p.dir, file), tmp);
  fs.renameSync(tmp, dbPath);
}

// Keeps the published generation and the one before it; older files go (a
// reader still holding one keeps its open file until it closes).
function prune(dbPath, keep = KEEP_GENERATIONS) {
  const p = pathsOf(dbPath);
  const current = publishedFile(dbPath);
  const gens = fs
    .readdirSync(p.generations)
    .map(f => ({ f, n: generationIdOf(f) }))
    .filter(g => Number.isInteger(g.n))
    .sort((a, b) => b.n - a.n);
  const kept = new Set(gens.slice(0, keep).map(g => g.f));
  if (current) kept.add(path.basename(current));
  for (const g of gens) if (!kept.has(g.f)) removeDb(path.join(p.generations, g.f));
}

// Publishes a closed candidate file as generation `id`: the commit point.
// Checks the lock first, never overwrites a published file, and syncs the file
// and the directory so the new link survives a crash.
function commit(dbPath, lock, candidate, id, { log }) {
  const p = pathsOf(dbPath);
  const file = path.join(p.generations, `warehouse-${id}.db`);
  if (fs.existsSync(file)) throw new JobError(500, `${file} already exists; a generation is never overwritten`);
  lock.assertOwned();
  // read-only on disk: nothing can reopen a published generation read-write
  // (generation 24 was switched to WAL two minutes after it was published)
  fs.chmodSync(candidate, 0o444);
  fsyncPath(candidate);
  fs.renameSync(candidate, file);
  publish(dbPath, file, { log }); // the commit point
  for (const d of [p.generations, p.dir])
    try {
      fsyncPath(d);
    } catch (err) {
      log(`published, but syncing ${d} failed: ${err.message}`);
    }
  return file;
}

// Runs fn(db, ctx) as one job and publishes the result as a new generation.
// fn returns { status: 'ok' | 'partial', note, ...anything } (partial: the
// job finished but left per-item failures queued, e.g. ingest_errors).
// ctx: { runId, log, curationDir } (curationDir: the staged reviewed files,
// when the job was given one).
// Options: dbPath, log, entityReport (rebuildDerived), allowShrink, derived
// (false only for a job that changes nothing derived, never by default),
// curationDir (the reviewed files this job reads and may rewrite).
async function runJob(
  kind,
  fn,
  {
    dbPath = defaultWarehousePath(),
    log = () => {},
    entityReport,
    allowShrink = false,
    derived = true,
    curationDir = null,
  } = {}
) {
  const p = pathsOf(dbPath);
  fs.mkdirSync(p.generations, { recursive: true });
  const lock = acquireLock(dbPath, kind);
  const started = new Date().toISOString();
  const candidate = path.join(p.generations, `warehouse.candidate-${process.pid}.db`);
  let db = null;
  let curation = null;
  let pendingWritten = false;
  try {
    writeState(dbPath, { kind, status: 'running', pid: process.pid, startedAt: started });
    removeDb(candidate);
    if (curationDir) curation = stageCuration(curationDir);
    const source = publishedFile(dbPath);
    if (source) {
      const src = new Database(source, { readonly: true, fileMustExist: true });
      try {
        await src.backup(candidate);
      } finally {
        src.close();
      }
    }
    const before = countsOf(source);
    db = openWarehouse(candidate);
    const runId = claimRun(db, new Date(), kind, { exclusive: true });
    const result = (await fn(db, { runId, log, curationDir: curation?.stage ?? null })) || {};
    if (derived) rebuildDerived(db, { log, entityReport });
    if (curation) snapshotCuration(db, curation.stage);
    const { counts, problems } = validate(db, before, { allowShrink });
    if (problems.length) throw new JobError(500, `validation failed, nothing published: ${problems.join('; ')}`);
    const status = result.status === 'partial' ? 'partial' : 'ok';
    const finished = new Date().toISOString();
    db.prepare('UPDATE refresh_runs SET finished_at = ?, status = ?, error = ? WHERE id = ?').run(
      finished,
      status,
      result.note || null,
      runId
    );
    const generation = nextGenerationId(dbPath, db);
    db.prepare(
      `INSERT INTO generation_meta (id, kind, created_at, status, curation_rev, code_rev, note, run_id, curation_digest)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      generation,
      kind,
      finished,
      status,
      curationRev(),
      git(['rev-parse', 'HEAD']),
      result.note || null,
      runId,
      curationDigest(db)
    );
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.pragma('journal_mode = DELETE');
    db.close();
    db = null;
    const changed = curation ? changedCuration(curation) : [];
    if (changed.length) {
      writeAtomic(path.join(curation.dir, PENDING), JSON.stringify({ generation, files: changed }));
      pendingWritten = true;
    }
    commit(dbPath, lock, candidate, generation, { log });
    // Published. Nothing below may turn this job into a failure.
    const warnings = [];
    const after = (what, step) => {
      try {
        step();
      } catch (err) {
        warnings.push(`${what}: ${err.message}`);
        log(`published generation ${generation}, but ${what} failed: ${err.message}`);
      }
    };
    after('pruning old generations', () => prune(dbPath));
    if (changed.length)
      after(`writing ${changed.join(', ')} back to ${curation.dir}`, () => {
        for (const f of changed) writeAtomic(path.join(curation.dir, f), fs.readFileSync(path.join(curation.stage, f)));
        fs.rmSync(path.join(curation.dir, PENDING), { force: true });
      });
    const warning = warnings.join('; ') || null;
    after('writing the job state', () =>
      writeState(dbPath, {
        kind,
        status,
        generation,
        pid: process.pid,
        startedAt: started,
        finishedAt: finished,
        counts,
        note: result.note || null,
        ...(warning ? { warning } : {}),
      })
    );
    log(`published generation ${generation} (${kind}, ${status})`);
    return {
      ...result,
      runId,
      generation,
      status,
      counts,
      ...(warnings.length ? { warning: warnings.join('; ') } : {}),
    };
  } catch (err) {
    if (db) db.close();
    removeDb(candidate);
    if (pendingWritten) fs.rmSync(path.join(curation.dir, PENDING), { force: true });
    writeState(dbPath, {
      kind,
      status: 'failed',
      pid: process.pid,
      startedAt: started,
      finishedAt: new Date().toISOString(),
      error: String(err.message),
    });
    throw err;
  } finally {
    if (curation) fs.rmSync(curation.stage, { recursive: true, force: true });
    lock.release();
  }
}

const generationIdOf = file => Number((path.basename(file || '').match(GEN_FILE) || [])[1]);
// The generation whose contents a file holds: itself, or the one a rollback restored.
function contentsOf(file) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const id = generationIdOf(file);
    let restores = null;
    try {
      restores = db.prepare('SELECT restores FROM generation_meta WHERE id = ?').get(id)?.restores ?? null;
    } catch {
      // before migration 0021
    }
    return restores ?? id;
  } finally {
    db.close();
  }
}

// Rolls back by publishing older contents as a NEW generation (review R01,
// R02): ids only increase, so every cache keyed on the generation (server memo,
// ETag, the browser) moves exactly as it does for a job. The default target is
// the kept generation with the newest contents older than the published one's;
// `to` names a kept generation explicitly (also to undo a rollback). The copy
// is migrated, so a rollback to a generation built before a migration still
// opens for readers.
function rollback(dbPath = defaultWarehousePath(), { log = () => {}, to = null } = {}) {
  const p = pathsOf(dbPath);
  const lock = acquireLock(dbPath, 'rollback');
  const candidate = path.join(p.generations, `warehouse.candidate-${process.pid}.db`);
  let db = null;
  try {
    const current = publishedFile(dbPath);
    const cur = generationIdOf(current);
    if (!Number.isInteger(cur)) throw new JobError(409, 'the published warehouse is not a generation');
    const curContents = contentsOf(current);
    const kept = fs
      .readdirSync(p.generations)
      .map(f => generationIdOf(f))
      .filter(n => Number.isInteger(n) && n !== cur)
      .map(id => ({ id, contents: contentsOf(path.join(p.generations, `warehouse-${id}.db`)) }));
    const target =
      to != null
        ? kept.find(g => g.id === Number(to))
        : kept.filter(g => g.contents < curContents).sort((a, b) => b.contents - a.contents || b.id - a.id)[0];
    if (!target)
      throw new JobError(409, to != null ? `no kept generation ${to}` : 'no earlier generation to roll back to');
    removeDb(candidate);
    fs.copyFileSync(path.join(p.generations, `warehouse-${target.id}.db`), candidate, fs.constants.COPYFILE_FICLONE);
    fs.chmodSync(candidate, 0o644); // the copy keeps the source's read-only mode
    db = openWarehouse(candidate);
    const generation = nextGenerationId(dbPath, db);
    const finished = new Date().toISOString();
    const note = `restores generation ${target.contents} (from ${target.id}); abandons ${cur}`;
    db.prepare(
      `INSERT INTO generation_meta (id, kind, created_at, status, curation_rev, code_rev, note, restores, curation_digest)
       VALUES (?, 'rollback', ?, 'ok', ?, ?, ?, ?, ?)`
    ).run(generation, finished, curationRev(), git(['rev-parse', 'HEAD']), note, target.contents, curationDigest(db));
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.pragma('journal_mode = DELETE');
    db.close();
    db = null;
    commit(dbPath, lock, candidate, generation, { log });
    try {
      prune(dbPath);
      writeState(dbPath, { kind: 'rollback', status: 'ok', generation, finishedAt: finished, note });
    } catch (err) {
      log(`rolled back, but cleanup failed: ${err.message}`);
    }
    log(`published generation ${generation}: ${note}`);
    return { from: cur, to: generation, restores: target.contents };
  } catch (err) {
    if (db) db.close();
    removeDb(candidate);
    throw err;
  } finally {
    lock.release();
  }
}

// Every generation file, newest first, with which one is published.
function generations(dbPath = defaultWarehousePath()) {
  const p = pathsOf(dbPath);
  const current = publishedFile(dbPath);
  if (!fs.existsSync(p.generations)) return [];
  return fs
    .readdirSync(p.generations)
    .filter(f => /^warehouse-\d+\.db$/.test(f))
    .map(f => {
      const file = path.join(p.generations, f);
      return {
        id: Number(f.match(/\d+/)[0]),
        file,
        bytes: fs.statSync(file).size,
        published: fs.realpathSync(file) === current,
      };
    })
    .sort((a, b) => b.id - a.id);
}

module.exports = {
  runJob,
  rollback,
  syncCuration,
  generations,
  jobState,
  acquireLock,
  publishedFile,
  validate,
  JobError,
  STALE_LOCK_MS,
};
