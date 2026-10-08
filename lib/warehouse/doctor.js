// `npm run doctor` (ROADMAP §8): one read-only look at whether the warehouse
// and its jobs are healthy, for a person at session start or a scheduler after
// the nightly refresh. Each check is ok, warn (look at it) or fail (the next job
// or the nightly run will not work as it should); the CLI exits non-zero on a
// failure. It opens the published generation read-only and writes nothing.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { openWarehouseReadOnly, generationOf } = require('./db');
const { pathsOf, jobState, holderGone } = require('./job-state');
const { publishedFile, checkDiskRoom } = require('./job');

const DAY_MS = 86400000;
const BUDGET_BYTES = 1e9; // CLAUDE.md: warehouse size budget 1 GB
const STALE_REFRESH_MS = 36 * 3600 * 1000; // nightly, with slack
const STALE_FILING_DAYS = 4; // weekends and holidays have no filings
const TMP_AGE_MS = DAY_MS;
// Temp directories our jobs and tests make (lib/warehouse/*, test/helpers/tmp.js).
const TMP_PREFIX = /^vantage-[\w-]+-[A-Za-z0-9]{6}$/;
const CANDIDATE = /^warehouse\.candidate-\d+\.db/;

const gib = b => `${(b / 1024 ** 3).toFixed(2)} GiB`;
const days = ms => (ms / DAY_MS).toFixed(1);

function dirBytes(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    try {
      n += e.isDirectory() ? dirBytes(p) : fs.lstatSync(p).size;
    } catch {
      // vanished meanwhile
    }
  }
  return n;
}

// Our temp directories older than a day: left by a killed job or test run.
function leftoverTemp({ tmp = os.tmpdir(), now = Date.now() } = {}) {
  const old = fs
    .readdirSync(tmp, { withFileTypes: true })
    .filter(e => e.isDirectory() && TMP_PREFIX.test(e.name))
    .map(e => path.join(tmp, e.name))
    .filter(p => {
      try {
        return now - fs.statSync(p).mtimeMs > TMP_AGE_MS;
      } catch {
        return false;
      }
    });
  return { dirs: old, bytes: old.reduce((n, d) => n + dirBytes(d), 0) };
}

// Processes running this project's job scripts: more than the lock holder means
// a job that lost its lock, or one waiting on a dead source.
function jobProcesses({ root = path.join(__dirname, '..', '..') } = {}) {
  let out;
  try {
    out = execFileSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
  const scripts = path.join(root, 'scripts') + path.sep;
  return out
    .split('\n')
    .map(l => l.trim().match(/^(\d+)\s+(.*)$/))
    .filter(m => m && Number(m[1]) !== process.pid && m[2].includes(scripts) && !m[2].includes('doctor.js'))
    .map(m => ({ pid: Number(m[1]), command: m[2] }));
}

function doctor(dbPath, { now = Date.now(), tmp, freeBytes, processes = jobProcesses } = {}) {
  const checks = [];
  const add = (status, name, detail) => checks.push({ status, name, detail });
  const p = pathsOf(dbPath);

  const file = publishedFile(dbPath);
  if (!file) {
    add('fail', 'warehouse', `${dbPath}: no published warehouse`);
    return { checks, ok: false };
  }
  const size = fs.statSync(file).size;
  let db;
  try {
    db = openWarehouseReadOnly(dbPath);
  } catch (err) {
    add('fail', 'warehouse', err.message);
    return { checks, ok: false };
  }
  try {
    add(
      size > BUDGET_BYTES ? 'warn' : 'ok',
      'warehouse',
      `generation ${generationOf(db)}, ${path.relative(fs.realpathSync(p.dir), file)}, ${(size / 1e6).toFixed(1)} MB of the 1 GB budget`
    );

    // freshness
    const newest = db.prepare('SELECT MAX(filing_date) d FROM filings').get().d;
    const age = newest ? (now - Date.parse(`${newest}T00:00:00Z`)) / DAY_MS : Infinity;
    add(
      age > STALE_FILING_DAYS ? 'warn' : 'ok',
      'newest filing',
      `${newest ?? 'none'} (${Number.isFinite(age) ? `${Math.floor(age)} day(s) ago` : 'no filings'})`
    );
    const refreshed = db
      .prepare(
        "SELECT finished_at, status FROM refresh_runs WHERE kind = 'refresh' AND status IN ('ok', 'partial') ORDER BY id DESC LIMIT 1"
      )
      .get();
    const since = refreshed ? now - Date.parse(refreshed.finished_at) : Infinity;
    add(
      since > STALE_REFRESH_MS ? 'warn' : 'ok',
      'last refresh',
      refreshed ? `${refreshed.finished_at} (${days(since)} days ago, ${refreshed.status})` : 'never'
    );
    const errors = db.prepare('SELECT COUNT(*) n, SUM(attempts >= 5) stuck FROM ingest_errors').get();
    add(
      errors.n ? 'warn' : 'ok',
      'ingest errors',
      errors.n ? `${errors.n} queued, ${errors.stuck || 0} no longer retried (npm run warehouse)` : 'none'
    );

    // row counts
    const n = sql => db.prepare(sql).get().n;
    const companies = db.prepare('SELECT status, COUNT(*) n FROM companies GROUP BY status').all();
    add(
      'ok',
      'rows',
      [
        `${n('SELECT COUNT(*) n FROM filings').toLocaleString()} filings`,
        `${n('SELECT COUNT(*) n FROM holdings').toLocaleString()} holding rows`,
        `companies ${companies.map(c => `${c.n} ${c.status}`).join(', ')}`,
        `${n('SELECT COUNT(*) n FROM managers').toLocaleString()} firms`,
        `${n('SELECT COUNT(*) n FROM fund_names').toLocaleString()} funds`,
        `${n('SELECT COUNT(*) n FROM position_facts').toLocaleString()} position legs`,
      ].join('; ')
    );

    // unresolved value: names no reviewed company claims that look like private
    // companies (categories 'company' and 'linked' of the review queue,
    // lib/entities/report.js), and those over the agreed threshold (report.overdue:
    // >= $50M held by >= 2 funds). Funds, listed names and Level 1/2 rows are not
    // companies to review.
    const un = db
      .prepare(
        `SELECT COUNT(*) n, COALESCE(SUM(current_value_usd), 0) v,
                SUM(current_value_usd >= 50e6 AND current_funds >= 2) over
         FROM unreviewed_entities WHERE active = 1 AND category IN ('company', 'linked') AND current_value_usd > 0`
      )
      .get();
    const priv = db
      .prepare(
        "SELECT COALESCE(SUM(s.current_value_usd), 0) v FROM company_stats s JOIN companies c ON c.id = s.company_id WHERE c.status = 'private'"
      )
      .get().v;
    add(
      un.over ? 'warn' : 'ok',
      'unresolved',
      `${un.n.toLocaleString()} unreviewed company-like names hold $${(un.v / 1e9).toFixed(2)}B now ` +
        `(reviewed private companies: $${(priv / 1e9).toFixed(2)}B); ${un.over || 0} over the review threshold ` +
        '(npm run entities:report)'
    );
  } finally {
    db.close();
  }

  // the last job and the lock
  const job = jobState(dbPath);
  if (!job) add('ok', 'last job', 'none recorded');
  else {
    const line =
      `${job.kind} ${job.status}${job.generation ? ` (generation ${job.generation})` : ''}, ` +
      `${job.startedAt || '?'} → ${job.finishedAt || 'running'}` +
      `${job.error ? `: ${job.error}` : ''}${job.warning ? `; warning: ${job.warning}` : ''}`;
    add(
      job.status === 'failed' || job.status === 'interrupted' ? 'fail' : job.warning ? 'warn' : 'ok',
      'last job',
      line
    );
  }
  if (fs.existsSync(p.lock)) {
    let holder = {};
    try {
      holder = JSON.parse(fs.readFileSync(p.lock, 'utf8'));
    } catch {
      // half-written
    }
    const gone = holderGone(holder);
    add(
      gone === false ? 'ok' : 'warn',
      'job lock',
      gone === false
        ? `held by a running ${holder.kind} job (pid ${holder.pid})`
        : `left by a ${holder.kind || 'warehouse'} job whose process ${gone ? 'ended' : 'cannot be checked from this host'} ` +
            `(pid ${holder.pid}); the next job takes it over${gone ? '' : ' once its heartbeat is 10 minutes old'}`
    );
  } else add('ok', 'job lock', 'free');

  // room for the next job, and what dead jobs and tests left behind
  try {
    const { free, need } = checkDiskRoom(p.generations, file, freeBytes ? { freeBytes } : undefined);
    add('ok', 'disk', `${gib(free)} free, a job needs ${gib(need)}`);
  } catch (err) {
    add('fail', 'disk', err.message);
  }
  const candidates = fs.existsSync(p.generations) ? fs.readdirSync(p.generations).filter(f => CANDIDATE.test(f)) : [];
  const running = job?.status === 'running';
  add(
    candidates.length && !running ? 'warn' : 'ok',
    'candidates',
    candidates.length
      ? `${candidates.join(', ')}${running ? ' (the running job)' : ': left by an interrupted job; the next job removes them'}`
      : 'none'
  );
  const t = leftoverTemp({ tmp, now });
  add(
    t.dirs.length ? 'warn' : 'ok',
    'temp files',
    t.dirs.length
      ? `${t.dirs.length} vantage-* directories older than a day in ${tmp || os.tmpdir()}, ${gib(t.bytes)}`
      : 'none older than a day'
  );
  const procs = processes();
  if (procs)
    add(
      procs.length > (running ? 1 : 0) ? 'warn' : 'ok',
      'job processes',
      procs.length ? procs.map(x => `pid ${x.pid}: ${x.command.slice(0, 120)}`).join('; ') : 'none'
    );

  return { checks, ok: !checks.some(c => c.status === 'fail') };
}

module.exports = { doctor, leftoverTemp };
