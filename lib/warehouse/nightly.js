// The nightly run (ROADMAP §8): refresh, then back up the published
// generation, then the doctor's checks, with an alert when anything fails.
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

// steps: { refresh, backup, doctor } as async functions returning
// { status: 'ok' | 'warn' | 'fail', detail } (injected by tests).
async function nightly(
  dbPath,
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
  const state = { startedAt, finishedAt: now().toISOString(), status, steps: results };
  const p = pathsOf(dbPath);
  const file = `${p.link}.nightly.json`;
  try {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 1));
    fs.renameSync(`${file}.tmp`, file);
    fs.appendFileSync(`${p.link}.nightly.log`, JSON.stringify(state) + '\n');
  } catch (err) {
    results.push({ name: 'record', status: 'warn', detail: `could not write ${file}: ${err.message}` });
  }
  const alerts = {
    notified: failed.length
      ? await notify('Vantage nightly failed', failed.map(r => `${r.name}: ${r.detail}`).join('; '))
      : false,
    pinged: await ping(alertUrl, !failed.length, summary),
  };
  return { ...state, alerts };
}

// The last nightly run recorded beside the warehouse, or null.
function lastNightly(dbPath) {
  try {
    return JSON.parse(fs.readFileSync(`${pathsOf(dbPath).link}.nightly.json`, 'utf8'));
  } catch {
    return null;
  }
}

module.exports = { nightly, runRefresh, lastNightly, notifyMac };
