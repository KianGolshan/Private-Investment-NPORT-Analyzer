// The nightly run (ROADMAP §8): refresh, then back up the published
// generation (and copy it off-site, P9), then the doctor's checks, with an
// alert when anything fails.
// `npm run nightly` is what a scheduler (launchd, cron) runs; it exits 1 on a
// failure. The result is kept in `<warehouse>.nightly.json` (the last run) and
// appended to `<warehouse>.nightly.log`; `npm run doctor` reports it.
//
// Alerts:
//   - a macOS notification (osascript) on a failure, unless VANTAGE_NOTIFY=0;
//   - VANTAGE_ALERT_URL, a dead-man's switch such as healthchecks.io: pinged on
//     success, `<url>/fail` with the summary on a failure. A night that never
//     runs sends no ping, and the service alerts on the silence. Off unless set.
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { pathsOf } = require('./job-state');

const ROOT = path.join(__dirname, '..', '..');
const REFRESH_LIMIT_MS = 4 * 3600 * 1000; // past the job's own 3 h limit: the wrapper always ends

// Runs `npm run refresh` as a child process (its own job, lock and exit code).
function runRefresh({ limitMs = REFRESH_LIMIT_MS, env = process.env } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'refresh.js')], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), limitMs);
    child.on('error', err => {
      clearTimeout(timer);
      resolve({ status: 'fail', detail: `could not start the refresh: ${err.message}` });
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve(
        code === 0
          ? { status: 'ok', detail: 'published' }
          : { status: 'fail', detail: signal ? `killed (${signal}) after the time limit` : `exit code ${code}` }
      );
    });
  });
}

// The off-site copy (P9): VANTAGE_OFFSITE_CMD, a shell command that copies the
// backup directory off this host (e.g. `rclone sync "$BACKUP_DIR"
// r2:vantage-backups`), run after the backup with BACKUP_DIR and BACKUP_FILE
// set. Unset: skipped (ok). A failure or the time limit makes the night "warn"
// (the data is published and backed up locally). A success is recorded as
// `<warehouse>.offsite.json`, which the doctor counts as an off-host backup.
const OFFSITE_LIMIT_MS = 30 * 60 * 1000;
function runOffsite(
  dbPath,
  {
    cmd = process.env.VANTAGE_OFFSITE_CMD,
    dir,
    file,
    generation,
    limitMs = OFFSITE_LIMIT_MS,
    now = () => new Date(),
  } = {}
) {
  if (!cmd) return Promise.resolve({ status: 'ok', detail: 'skipped (VANTAGE_OFFSITE_CMD is not set)' });
  return new Promise(resolve => {
    let tail = '';
    const keep = chunk => (tail = (tail + chunk).slice(-400));
    const child = spawn('/bin/sh', ['-c', cmd], {
      cwd: ROOT,
      env: { ...process.env, BACKUP_DIR: dir ?? '', BACKUP_FILE: file ?? '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => child.kill('SIGKILL'), limitMs);
    const done = r => {
      clearTimeout(timer);
      resolve(r);
    };
    child.on('error', err => done({ status: 'warn', detail: `could not start the off-site copy: ${err.message}` }));
    child.on('exit', (code, signal) => {
      if (code !== 0)
        return done({
          status: 'warn',
          detail:
            (signal ? `killed (${signal}) after the time limit` : `exit code ${code}`) +
            (tail.trim() ? `: ${tail.trim().split('\n').pop()}` : ''),
        });
      const record = { at: now().toISOString(), generation: generation ?? null, file: file ?? null };
      const out = `${pathsOf(dbPath).link}.offsite.json`;
      try {
        fs.writeFileSync(`${out}.tmp`, JSON.stringify(record));
        fs.renameSync(`${out}.tmp`, out);
      } catch (err) {
        return done({ status: 'warn', detail: `copied, but could not record it: ${err.message}` });
      }
      return done({ status: 'ok', detail: `copied off-site: generation ${record.generation}` });
    });
  });
}

// The last successful off-site copy recorded beside the warehouse, or null.
function lastOffsite(dbPath) {
  try {
    return JSON.parse(fs.readFileSync(`${pathsOf(dbPath).link}.offsite.json`, 'utf8'));
  } catch {
    return null;
  }
}

function notifyMac(title, message) {
  if (process.platform !== 'darwin' || process.env.VANTAGE_NOTIFY === '0') return Promise.resolve(false);
  const q = s => String(s).replace(/["\\]/g, ' ').slice(0, 200);
  return new Promise(resolve =>
    execFile('osascript', ['-e', `display notification "${q(message)}" with title "${q(title)}"`], err => resolve(!err))
  );
}

async function ping(url, ok, summary) {
  if (!url) return null;
  try {
    const res = await fetch(ok ? url : `${url.replace(/\/$/, '')}/fail`, {
      method: 'POST',
      body: summary,
      signal: AbortSignal.timeout(10000),
    });
    return res.ok;
  } catch {
    return false; // an alert channel that is down never fails the night
  }
}

// A scheduled run of named steps (the nightly run; the monthly reconciliation
// and LIVE regression, scripts/monthly.js). steps: { name: async () =>
// { status: 'ok' | 'warn' | 'fail', detail } }, every one run in order even
// after a failure. Recorded as `<warehouse>.<run>.json` and `.<run>.log`.
async function runSteps(
  dbPath,
  run,
  steps,
  { alertUrl = process.env.VANTAGE_ALERT_URL, notify = notifyMac, now = () => new Date() } = {}
) {
  const startedAt = now().toISOString();
  const results = [];
  for (const [name, step] of Object.entries(steps)) {
    let r;
    try {
      r = await step();
    } catch (err) {
      r = { status: 'fail', detail: err.message };
    }
    results.push({ name, ...r });
  }
  const failed = results.filter(r => r.status === 'fail');
  const status = failed.length ? 'fail' : results.some(r => r.status === 'warn') ? 'warn' : 'ok';
  const summary = results.map(r => `${r.name} ${r.status}: ${r.detail}`).join('\n');
  const state = { run, startedAt, finishedAt: now().toISOString(), status, steps: results };
  const p = pathsOf(dbPath);
  const file = `${p.link}.${run}.json`;
  try {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 1));
    fs.renameSync(`${file}.tmp`, file);
    fs.appendFileSync(`${p.link}.${run}.log`, JSON.stringify(state) + '\n');
  } catch (err) {
    results.push({ name: 'record', status: 'warn', detail: `could not write ${file}: ${err.message}` });
  }
  const alerts = {
    notified: failed.length
      ? await notify(`Vantage ${run} failed`, failed.map(r => `${r.name}: ${r.detail}`).join('; '))
      : false,
    pinged: await ping(alertUrl, !failed.length, summary),
  };
  return { ...state, alerts };
}

// steps: { refresh, backup, doctor } (injected by tests).
const nightly = (dbPath, steps, opts) => runSteps(dbPath, 'nightly', steps, opts);

// The last run of `run` recorded beside the warehouse, or null.
function lastNightly(dbPath, run = 'nightly') {
  try {
    return JSON.parse(fs.readFileSync(`${pathsOf(dbPath).link}.${run}.json`, 'utf8'));
  } catch {
    return null;
  }
}

module.exports = { nightly, runSteps, runRefresh, runOffsite, lastOffsite, lastNightly, notifyMac };
