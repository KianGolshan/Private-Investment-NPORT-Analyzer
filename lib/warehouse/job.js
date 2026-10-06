// The one write path into the warehouse (P6c R2, staff review F03/F04/F11;
// ADR 0009). Every job that changes data (the refresh, ingests, N-CEN, the
// review import, "make this a company", backfills) runs through runJob:
//
//   1. take the job lock (a lock file next to the warehouse, with a heartbeat;
//      a lock whose process is gone, or whose heartbeat stopped, is stale);
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
// A job that fails at any step leaves the published generation untouched and
// the candidate is deleted. The last job's state (running, ok, partial,
// failed) is written to `<warehouse>.job.json`, apart from the data version.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');
const { openWarehouse, defaultWarehousePath, migrationFiles } = require('./db');
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

// The job lock. Exclusive create; a lock left by a process that is gone, or
// whose heartbeat stopped more than STALE_LOCK_MS ago, is taken over. A long
// job is never expired while its heartbeat runs (unlike a fixed timeout).
function acquireLock(dbPath, kind, { now = Date.now } = {}) {
  const { lock } = pathsOf(dbPath);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lock, 'wx');
      fs.writeSync(
        fd,
        JSON.stringify({ pid: process.pid, host: os.hostname(), kind, startedAt: new Date(now()).toISOString() })
      );
      fs.closeSync(fd);
      const beat = setInterval(() => {
        try {
          const t = new Date();
          fs.utimesSync(lock, t, t);
        } catch {
          // lock removed under us: the release below reports nothing
        }
      }, HEARTBEAT_MS);
      beat.unref();
      return {
        release() {
          clearInterval(beat);
          fs.rmSync(lock, { force: true });
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
      const gone = sameHost && holder.pid && !alive(holder.pid);
      if (attempt === 0 && (gone || age > STALE_LOCK_MS)) {
        fs.rmSync(lock, { force: true });
        continue;
      }
      throw new JobError(
        409,
        `a ${holder.kind || 'warehouse'} job is already running (pid ${holder.pid}, started ${holder.startedAt}); try again when it finishes`
      );
    }
  }
  throw new JobError(409, 'could not take the job lock');
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

const COUNTED = ['filings', 'holdings', 'companies', 'managers'];
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
    .map(f => ({ f, n: Number((f.match(/^warehouse-(\d+)\.db$/) || [])[1]) }))
    .filter(g => Number.isInteger(g.n))
    .sort((a, b) => b.n - a.n);
  const kept = new Set(gens.slice(0, keep).map(g => g.f));
  if (current) kept.add(path.basename(current));
  for (const g of gens) if (!kept.has(g.f)) removeDb(path.join(p.generations, g.f));
}

// Runs fn(db, ctx) as one job and publishes the result as a new generation.
// fn returns { status: 'ok' | 'partial', note, ...anything } (partial: the
// job finished but left per-item failures queued, e.g. ingest_errors).
// Options: dbPath, log, entityReport (rebuildDerived), allowShrink, derived
// (false only for a job that changes nothing derived, never by default).
async function runJob(
  kind,
  fn,
  { dbPath = defaultWarehousePath(), log = () => {}, entityReport, allowShrink = false, derived = true } = {}
) {
  const p = pathsOf(dbPath);
  fs.mkdirSync(p.generations, { recursive: true });
  const lock = acquireLock(dbPath, kind);
  const started = new Date().toISOString();
  const candidate = path.join(p.generations, `warehouse.candidate-${process.pid}.db`);
  let db = null;
  try {
    writeState(dbPath, { kind, status: 'running', pid: process.pid, startedAt: started });
    removeDb(candidate);
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
    const result = (await fn(db, { runId, log })) || {};
    if (derived) rebuildDerived(db, { log, entityReport });
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
    db.prepare(
      'INSERT INTO generation_meta (id, kind, created_at, status, curation_rev, code_rev, note) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(runId, kind, finished, status, curationRev(), git(['rev-parse', 'HEAD']), result.note || null);
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.pragma('journal_mode = DELETE');
    db.close();
    db = null;
    const file = path.join(p.generations, `warehouse-${runId}.db`);
    fs.renameSync(candidate, file);
    publish(dbPath, file, { log });
    prune(dbPath);
    const state = {
      kind,
      status,
      generation: runId,
      pid: process.pid,
      startedAt: started,
      finishedAt: finished,
      counts,
      note: result.note || null,
    };
    writeState(dbPath, state);
    log(`published generation ${runId} (${kind}, ${status})`);
    return { ...result, runId, generation: runId, status, counts };
  } catch (err) {
    if (db) db.close();
    removeDb(candidate);
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
    lock.release();
  }
}

// Points the warehouse link back at the generation before the published one.
function rollback(dbPath = defaultWarehousePath(), { log = () => {} } = {}) {
  const p = pathsOf(dbPath);
  const lock = acquireLock(dbPath, 'rollback');
  try {
    const current = publishedFile(dbPath);
    const gens = fs
      .readdirSync(p.generations)
      .map(f => Number((f.match(/^warehouse-(\d+)\.db$/) || [])[1]))
      .filter(Number.isInteger)
      .sort((a, b) => b - a);
    const cur = Number((path.basename(current || '').match(/^warehouse-(\d+)\.db$/) || [])[1]);
    const prev = gens.find(n => n < cur);
    if (prev == null) throw new JobError(409, 'no earlier generation to roll back to');
    publish(dbPath, path.join(p.generations, `warehouse-${prev}.db`));
    writeState(dbPath, {
      kind: 'rollback',
      status: 'ok',
      generation: prev,
      finishedAt: new Date().toISOString(),
      note: `from ${cur}`,
    });
    log(`rolled back to generation ${prev} (from ${cur})`);
    return { from: cur, to: prev };
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
  generations,
  jobState,
  acquireLock,
  publishedFile,
  validate,
  JobError,
  STALE_LOCK_MS,
};
