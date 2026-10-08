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
const { curationFor } = require('./curation');
const { pathsOf, writeState, jobState, holderGone, selfIdentity } = require('./job-state');

const ROOT = path.join(__dirname, '..', '..');
const HEARTBEAT_MS = 30 * 1000;
const STALE_LOCK_MS = 10 * 60 * 1000; // no heartbeat for 10 minutes: the holder is gone
const KEEP_GENERATIONS = 2; // the published one and the one before it
// Validation: a job may not shrink these tables by more than this share of the
// published generation's rows (a bad source or a broken rule), unless allowed.
const MAX_SHRINK = 0.02;
// Every job ends (CLAUDE.md: background jobs have a terminal state). A job still
// running after this long fails, cleans up and releases the lock, so a stalled
// source cannot hold the lock night after night (P8 pre-flight, 2026-10-07).
// Measured: a refresh 0.8 min, the full 27-quarter backfill 13.6 min, the first
// catch-up 26.9 min. VANTAGE_JOB_TIMEOUT_MIN overrides it.
const DEFAULT_JOB_TIMEOUT_MS = 3 * 3600 * 1000;
function jobTimeoutMs(raw = process.env.VANTAGE_JOB_TIMEOUT_MIN) {
  const min = Number(raw);
  return raw != null && raw !== '' && Number.isFinite(min) && min > 0 ? min * 60 * 1000 : DEFAULT_JOB_TIMEOUT_MS;
}

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

// The job lock. Exclusive create, with an owner token: the heartbeat and the
// release touch the lock only while it still carries this job's token, and
// assertOwned() is called before publishing (a job whose lock was taken over
// publishes nothing). A lock is taken over only when its process is gone (same
// host: the pid has ended, or now runs a process with another start time, or the
// host rebooted; job-state.holderGone), or, for a lock from another host or with
// no readable pid, when its heartbeat stopped more than STALE_LOCK_MS ago. A live
// process on this host is never taken over: its heartbeat timer cannot fire
// during long synchronous SQLite work, so a stopped heartbeat does not mean it
// ended.
function acquireLock(dbPath, kind, { now = Date.now, startOf } = {}) {
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
          ...selfIdentity(),
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
      const ended = holderGone(holder, startOf ? { startOf } : undefined);
      const gone = ended === true;
      const live = ended === false;
      if (attempt === 0 && (gone || (!live && age > STALE_LOCK_MS))) {
        // Take the stale lock atomically (Codex verification V01): move it aside,
        // then check that what moved is the lock judged stale. Another taker may
        // have replaced it in between; that lock is put back (link fails if a
        // newer one exists) and this caller gets a 409, so at most one wins.
        const tomb = `${lock}.stale-${process.pid}-${token.slice(0, 8)}`;
        try {
          fs.renameSync(lock, tomb);
        } catch (e) {
          if (e.code === 'ENOENT') continue; // already gone: race for the create
          throw e;
        }
        let moved = {};
        try {
          moved = JSON.parse(fs.readFileSync(tomb, 'utf8'));
        } catch {
          // half-written: judged as it was
        }
        if (moved.token !== holder.token || moved.pid !== holder.pid) {
          try {
            fs.linkSync(tomb, lock);
          } catch {
            // a newer lock exists already; it stands
          }
          fs.rmSync(tomb, { force: true });
          throw new JobError(409, 'another process took the job lock at the same moment; try again');
        }
        fs.rmSync(tomb, { force: true });
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
function stageCuration(dir, dbPath) {
  const pending = path.join(dir, PENDING);
  if (fs.existsSync(pending)) {
    const { generation } = JSON.parse(fs.readFileSync(pending, 'utf8'));
    // Written just before an earlier job's commit. If that generation was never
    // published (the job died before the link switch), data/review was never
    // touched: drop the marker. If it was, its files must be written back first.
    if (!publishedGenerations(dbPath).includes(generation)) fs.rmSync(pending, { force: true });
    else
      throw new JobError(
        409,
        `${pending}: an earlier curation job published generation ${generation} but did not finish writing its files ` +
          'back; run npm run warehouse -- --sync-curation first'
      );
  }
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

// The generations the published warehouse descends from (its generation_meta
// rows): a pending marker naming one of them was committed.
function publishedGenerations(dbPath) {
  const file = publishedFile(dbPath);
  if (!file) return [];
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return db
      .prepare('SELECT id FROM generation_meta')
      .all()
      .map(r => r.id);
  } catch {
    return [];
  } finally {
    db.close();
  }
}

// Writes the published generation's curation snapshot back to `dir` (after a
// job that published but did not finish writing its files). Under the job lock,
// so it never races a curation job. Returns the names.
function syncCuration(dbPath = defaultWarehousePath(), dir = path.join(ROOT, 'data', 'review')) {
  const lock = acquireLock(dbPath, 'sync-curation');
  try {
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
  } finally {
    lock.release();
  }
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

// Filings that would read as exits without being any (review R13, DATA-QUALITY
// trap 55): a fund's canonical filing with no holdings and positive net assets,
// right after a filing that held private companies, including the fund's newest
// filing, the moment it first turns holdings into apparent exits (Codex
// verification V06). Real filings do omit the holdings section (BMO Funds,
// 2020-11-30: $1.9B of net assets, no <invstOrSecs>; a fund's final filing);
// they are stored as filed, a job that adds one says so, and the exit it causes
// reads "the filing lists no holdings" (services/company.js). 0 on generation 29.
const EMPTY_AFTER_PRIVATE = `
  SELECT f.accession FROM canonical_filings f JOIN filing_totals t USING (accession)
  WHERE t.rows = 0 AND f.net_assets > 0
    AND EXISTS (SELECT 1 FROM holdings h JOIN companies c ON c.id = h.company_id
                WHERE c.status = 'private' AND h.accession = (SELECT p.accession FROM canonical_filings p
                  WHERE p.fund_key = f.fund_key AND p.report_date < f.report_date ORDER BY p.report_date DESC LIMIT 1))`;
function emptyAfterPrivate(db) {
  try {
    return db
      .prepare(EMPTY_AFTER_PRIVATE)
      .all()
      .map(r => r.accession);
  } catch {
    return []; // a warehouse from before filing_totals
  }
}

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
  const warnings = [];
  const empty = emptyAfterPrivate(db);
  const known = new Set(published?.emptyAfterPrivate || []);
  const added = empty.filter(a => !known.has(a));
  if (added.length)
    warnings.push(
      `${added.length} filing(s) with no holdings section after private holdings would read as exits ` +
        `(DATA-QUALITY trap 55): ${added.slice(0, 5).join(', ')}`
    );
  return { counts: now, problems, warnings };
}

function countsOf(file) {
  if (!file) return null;
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return {
      ...Object.fromEntries(
        COUNTED.map(t => {
          try {
            return [t, count(db, t)];
          } catch {
            return [t, 0]; // a warehouse from before the table existed
          }
        })
      ),
      emptyAfterPrivate: emptyAfterPrivate(db),
    };
  } finally {
    db.close();
  }
}

// Room a job needs before it starts: a candidate the size of the published
// warehouse plus headroom for a bulk zip (up to 690 MB, 2022q3) and growth. A
// job that would fill the disk fails before it copies anything (P8 pre-flight:
// leaked test files had the disk at 94%).
const DISK_HEADROOM = 1024 ** 3;
const diskFreeBytes = dir => {
  const st = fs.statfsSync(dir);
  return st.bavail * st.bsize;
};
function checkDiskRoom(dir, published, { freeBytes = diskFreeBytes } = {}) {
  const need = (published ? fs.statSync(published).size : 0) + DISK_HEADROOM;
  const free = freeBytes(dir);
  if (free < need)
    throw new JobError(
      507,
      `not enough free disk for a job: ${(free / 1024 ** 3).toFixed(2)} GiB free in ${dir}, ` +
        `${(need / 1024 ** 3).toFixed(2)} GiB needed (a candidate copy plus ${DISK_HEADROOM / 1024 ** 3} GiB); nothing changed`
    );
  return { free, need };
}

const removeDb = file => {
  for (const f of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) fs.rmSync(f, { force: true });
};

// Candidates left by jobs that died before cleaning up (killed, a crash: about
// the size of the warehouse each). Only the lock holder builds a candidate, so
// under the lock every candidate file is stale. Returns the names removed.
const CANDIDATE = /^warehouse\.candidate-\d+\.db(-wal|-shm|-journal)?$/;
function removeStaleCandidates(dbPath) {
  const dir = pathsOf(dbPath).generations;
  const stale = fs.readdirSync(dir).filter(f => CANDIDATE.test(f));
  for (const f of stale) fs.rmSync(path.join(dir, f), { force: true });
  return stale;
}

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
  // after it, failures are warnings the caller reports (never thrown)
  const warnings = [];
  for (const d of [p.generations, p.dir])
    try {
      fsyncPath(d);
    } catch (err) {
      warnings.push(`syncing ${d}: ${err.message}`);
      log(`published, but syncing ${d} failed: ${err.message}`);
    }
  return { file, warnings };
}

// Runs fn(db, ctx) as one job and publishes the result as a new generation.
// fn returns { status: 'ok' | 'partial', note, ...anything } (partial: the
// job finished but left per-item failures queued, e.g. ingest_errors).
// ctx: { runId, log, curationDir, curation } (curationDir: the staged reviewed
// files, when the job was given one; curation(): the decisions every derived
// step must read, lib/warehouse/curation.js).
// Options: dbPath, log, entityReport (rebuildDerived), allowShrink, derived
// (false only for a job that changes nothing derived, never by default),
// curationDir (the reviewed files this job reads and may rewrite), timeoutMs
// (the job's time limit), freeBytes (dir => free bytes; tests). The limit is checked while the job awaits (the copy,
// fn) and between its synchronous steps, which cannot be interrupted. A job
// past it fails before the commit point; fn may still be running, so a CLI
// exits after a failed job instead of waiting for it.
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
    timeoutMs = jobTimeoutMs(),
    freeBytes,
  } = {}
) {
  const p = pathsOf(dbPath);
  fs.mkdirSync(p.generations, { recursive: true });
  const lock = acquireLock(dbPath, kind);
  const started = new Date().toISOString();
  const deadlineAt = Date.now() + timeoutMs;
  const overdue = () =>
    new JobError(504, `the ${kind} job ran past its ${Math.round(timeoutMs / 60000)} min limit; nothing published`);
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(overdue()), timeoutMs);
  });
  deadline.catch(() => {}); // settled by the race below, or never awaited
  const inTime = work => Promise.race([work, deadline]);
  const checkTime = () => {
    if (Date.now() > deadlineAt) throw overdue();
  };
  const candidate = path.join(p.generations, `warehouse.candidate-${process.pid}.db`);
  let db = null;
  let curation = null;
  let pendingWritten = false;
  let committed = false;
  // After the commit point a log callback must not throw either.
  const say = (...a) => {
    try {
      log(...a);
    } catch {
      // the job's outcome does not depend on its logger
    }
  };
  try {
    writeState(dbPath, { kind, status: 'running', ...selfIdentity(), startedAt: started });
    const stale = removeStaleCandidates(dbPath);
    if (stale.length) say(`removed ${stale.length} file(s) left by an interrupted job: ${stale.join(', ')}`);
    const source = publishedFile(dbPath);
    checkDiskRoom(p.generations, source, freeBytes ? { freeBytes } : undefined);
    if (curationDir) curation = stageCuration(curationDir, dbPath);
    if (source) {
      const src = new Database(source, { readonly: true, fileMustExist: true });
      try {
        await inTime(src.backup(candidate));
      } finally {
        src.close();
      }
    }
    const before = countsOf(source);
    db = openWarehouse(candidate);
    const runId = claimRun(db, new Date(), kind, { exclusive: true });
    // The curation every derived step reads: the staged copy, else this
    // generation's snapshot (V02); read after fn, which may rewrite staged files.
    const curationOf = () => curationFor(db, { stage: curation?.stage ?? null, log }).curation;
    const result =
      (await inTime(
        Promise.resolve().then(() => fn(db, { runId, log, curationDir: curation?.stage ?? null, curation: curationOf }))
      )) || {};
    checkTime();
    if (derived) rebuildDerived(db, { log, entityReport, curation: curationOf() });
    if (curation) snapshotCuration(db, curation.stage);
    checkTime();
    const { counts, problems, warnings: checks } = validate(db, before, { allowShrink });
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
    checkTime();
    const { warnings: synced } = commit(dbPath, lock, candidate, generation, { log: say });
    committed = true;
    // Published (Codex verification V03): every step from here on, including
    // the cleanup in `finally`, is a warning on a published job, never an error.
    const warnings = [...checks, ...synced];
    for (const w of checks) say(`warning: ${w}`);
    const after = (what, step) => {
      try {
        step();
      } catch (err) {
        warnings.push(`${what}: ${err.message}`);
        say(`published generation ${generation}, but ${what} failed: ${err.message}`);
      }
    };
    after('pruning old generations', () => prune(dbPath));
    if (changed.length)
      after(`writing ${changed.join(', ')} back to ${curation.dir}`, () => {
        for (const f of changed) writeAtomic(path.join(curation.dir, f), fs.readFileSync(path.join(curation.stage, f)));
        fs.rmSync(path.join(curation.dir, PENDING), { force: true });
      });
    if (curation)
      after('removing the staged curation', () => fs.rmSync(curation.stage, { recursive: true, force: true }));
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
    say(`published generation ${generation} (${kind}, ${status})`);
    return {
      ...result,
      runId,
      generation,
      status,
      counts,
      ...(warnings.length ? { warning: warnings.join('; ') } : {}),
    };
  } catch (err) {
    // Before the commit point (every step after it is caught above): the job
    // failed and nothing was published. Cleanup must not mask the cause.
    const quietly = step => {
      try {
        step();
      } catch (e) {
        say(`cleanup after a failed job: ${e.message}`);
      }
    };
    if (db) quietly(() => db.close());
    quietly(() => removeDb(candidate));
    if (pendingWritten) quietly(() => fs.rmSync(path.join(curation.dir, PENDING), { force: true }));
    if (curation) quietly(() => fs.rmSync(curation.stage, { recursive: true, force: true }));
    quietly(() =>
      writeState(dbPath, {
        kind,
        status: 'failed',
        pid: process.pid,
        startedAt: started,
        finishedAt: new Date().toISOString(),
        error: String(err.message),
      })
    );
    throw err;
  } finally {
    clearTimeout(timer);
    // Always attempted, never fatal: a published job stays published.
    try {
      lock.release();
    } catch (e) {
      say(`${committed ? 'published, but ' : ''}releasing the job lock failed: ${e.message}`);
    }
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

// The generation whose contents an open warehouse holds (its newest
// generation_meta row, or the one that row restored); null before generations.
function contentsOfDb(db) {
  try {
    const g = db.prepare('SELECT id, restores FROM generation_meta ORDER BY id DESC LIMIT 1').get();
    return g ? (g.restores ?? g.id) : null;
  } catch {
    return null;
  }
}

// Publishes a copy of `source` (a kept generation, or a backup) as a NEW
// generation under the job lock (review R01, R02): ids only increase, so every
// cache keyed on the generation (server memo, ETag, the browser) moves exactly
// as it does for a job. The copy is migrated, so contents built before a
// migration still open for readers. pick(current) runs under the lock and
// returns { file, contents, note }. Works on an empty host too: the new id
// follows the source's own generation_meta (nextGenerationId).
function republish(dbPath, kind, pick, { log = () => {} } = {}) {
  const p = pathsOf(dbPath);
  fs.mkdirSync(p.generations, { recursive: true });
  const lock = acquireLock(dbPath, kind);
  const candidate = path.join(p.generations, `warehouse.candidate-${process.pid}.db`);
  const done = kind === 'rollback' ? 'rolled back' : 'restored';
  const started = new Date().toISOString();
  let db = null;
  try {
    const current = publishedFile(dbPath);
    const { file, contents, note } = pick(current);
    checkDiskRoom(p.generations, file);
    removeStaleCandidates(dbPath);
    fs.copyFileSync(file, candidate, fs.constants.COPYFILE_FICLONE);
    fs.chmodSync(candidate, 0o644); // the copy keeps the source's read-only mode
    db = openWarehouse(candidate);
    const generation = nextGenerationId(dbPath, db);
    const finished = new Date().toISOString();
    db.prepare(
      `INSERT INTO generation_meta (id, kind, created_at, status, curation_rev, code_rev, note, restores, curation_digest)
       VALUES (?, ?, ?, 'ok', ?, ?, ?, ?, ?)`
    ).run(generation, kind, finished, curationRev(), git(['rev-parse', 'HEAD']), note, contents, curationDigest(db));
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.pragma('journal_mode = DELETE');
    db.close();
    db = null;
    const { warnings } = commit(dbPath, lock, candidate, generation, { log });
    // Published: as in runJob, nothing from here on fails it (V03).
    const after = (what, step) => {
      try {
        step();
      } catch (err) {
        warnings.push(`${what}: ${err.message}`);
        log(`${done}, but ${what} failed: ${err.message}`);
      }
    };
    after('pruning old generations', () => prune(dbPath));
    after('writing the job state', () =>
      writeState(dbPath, {
        kind,
        status: 'ok',
        generation,
        startedAt: started,
        finishedAt: finished,
        note,
        ...(warnings.length ? { warning: warnings.join('; ') } : {}),
      })
    );
    log(`published generation ${generation}: ${note}`);
    return {
      from: generationIdOf(current) || null,
      to: generation,
      restores: contents,
      ...(warnings.length ? { warning: warnings.join('; ') } : {}),
    };
  } catch (err) {
    try {
      if (db) db.close();
      removeDb(candidate);
    } catch (e) {
      log(`cleanup after a failed ${kind}: ${e.message}`);
    }
    throw err;
  } finally {
    try {
      lock.release();
    } catch (e) {
      log(`releasing the job lock failed: ${e.message}`);
    }
  }
}

// Rolls back by publishing older contents as a new generation. The default
// target is the kept generation with the newest contents older than the
// published one's; `to` names a kept generation explicitly (also to undo a
// rollback).
function rollback(dbPath = defaultWarehousePath(), { log = () => {}, to = null } = {}) {
  const p = pathsOf(dbPath);
  return republish(
    dbPath,
    'rollback',
    current => {
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
      return {
        file: path.join(p.generations, `warehouse-${target.id}.db`),
        contents: target.contents,
        note: `restores generation ${target.contents} (from ${target.id}); abandons ${cur}`,
      };
    },
    { log }
  );
}

// Restores a backup (lib/warehouse/backup.js) as a new generation: onto an
// empty host (no warehouse yet) or over the published one. The file must match
// its recorded SHA-256 and pass an integrity check before anything changes.
function restoreBackup(file, dbPath = defaultWarehousePath(), { log = () => {}, sha256: expected } = {}) {
  if (!fs.existsSync(file)) throw new JobError(404, `${file}: no such backup`);
  const want =
    expected ??
    (fs.existsSync(`${file}.sha256`) ? fs.readFileSync(`${file}.sha256`, 'utf8').trim().split(/\s+/)[0] : null);
  if (!want) throw new JobError(409, `${file}: no recorded SHA-256 (${file}.sha256); refusing an unverified backup`);
  const have = sha256File(file);
  if (have !== want)
    throw new JobError(409, `${file}: SHA-256 ${have} does not match the recorded ${want}; nothing restored`);
  const src = new Database(file, { readonly: true, fileMustExist: true });
  let contents;
  try {
    const check = src.pragma('quick_check', { simple: true });
    if (check !== 'ok') throw new JobError(409, `${file}: quick_check ${check}; nothing restored`);
    contents = contentsOfDb(src);
  } finally {
    src.close();
  }
  if (contents == null) throw new JobError(409, `${file}: not a warehouse generation (no generation_meta)`);
  return republish(
    dbPath,
    'restore',
    current => ({
      file,
      contents,
      note:
        `restores generation ${contents} from backup ${path.basename(file)}` +
        (current ? `; abandons ${generationIdOf(current)}` : ' onto an empty host'),
    }),
    { log }
  );
}

// SHA-256 of a file, streamed in 1 MB blocks (a generation is ~580 MB).
function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
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
  restoreBackup,
  sha256File,
  contentsOfDb,
  syncCuration,
  generations,
  jobState,
  acquireLock,
  publishedFile,
  validate,
  JobError,
  STALE_LOCK_MS,
  jobTimeoutMs,
  checkDiskRoom,
};
