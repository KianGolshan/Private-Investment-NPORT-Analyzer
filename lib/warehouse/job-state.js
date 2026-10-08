// Where a warehouse's job files live and the last job's state (written by
// lib/warehouse/job.js, read by /api/freshness). Kept apart from job.js so the
// web server reads the state without loading the ingest code.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { defaultWarehousePath } = require('./db');

// ---- which process is the job's (P8 pre-flight, 2026-10-07) ----
// A pid alone does not name a process: after a crash and a reboot, or simply
// in time, the pid in a leftover lock or state file can belong to another
// program, and a lock judged by the pid alone would block every job. So the
// lock and the state record the process's start time and the host's boot time,
// and a holder counts as alive only while its pid runs with that start time.
const alive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};
const START_TOLERANCE_MS = 3000; // ps reports whole seconds; Node starts ms later
const BOOT_TOLERANCE_MS = 60 * 1000;
const bootMs = () => Date.now() - os.uptime() * 1000;
const selfStartMs = () => Math.round(Date.now() - process.uptime() * 1000);
// The start time of a running pid (ms), or null when ps cannot say.
function processStartMs(pid) {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const t = Date.parse(out);
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}
// What a lock or state file records about the process that wrote it.
const selfIdentity = () => ({
  pid: process.pid,
  host: os.hostname(),
  procStart: selfStartMs(),
  boot: Math.round(bootMs()),
});
// Whether the process a lock or state names has ended: true (ended, or its pid
// now runs another process), false (still running), null (another host: this
// one cannot tell). A record without start or boot times (written before this
// check) is judged by its pid alone.
function holderGone(holder, { startOf = processStartMs } = {}) {
  if (!holder?.pid) return null;
  if (holder.host && holder.host !== os.hostname()) return null;
  if (!alive(holder.pid)) return true;
  if (holder.procStart != null) {
    const start = startOf(holder.pid);
    if (start != null) return Math.abs(start - holder.procStart) > START_TOLERANCE_MS;
  }
  if (holder.boot != null) return Math.abs(bootMs() - holder.boot) > BOOT_TOLERANCE_MS;
  return false;
}

function pathsOf(dbPath) {
  const dir = path.dirname(dbPath);
  return {
    link: dbPath,
    dir,
    generations: path.join(dir, 'generations'),
    lock: `${dbPath}.lock`,
    state: `${dbPath}.job.json`,
    log: `${dbPath}.jobs.log`,
  };
}

// Writes the state atomically; a finished job is also appended to the log.
function writeState(dbPath, state) {
  const { state: file, log } = pathsOf(dbPath);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
  fs.renameSync(tmp, file);
  if (state.status !== 'running') fs.appendFileSync(log, JSON.stringify(state) + '\n');
}

// The last job's state; null when no job has run here. A job recorded as
// running whose process has ended (killed, a crash, a power loss) is reported
// as 'interrupted': it published nothing, and no job is running.
function jobState(dbPath = defaultWarehousePath(), opts) {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(pathsOf(dbPath).state, 'utf8'));
  } catch {
    return null;
  }
  if (state?.status === 'running' && holderGone(state, opts) === true)
    return {
      ...state,
      status: 'interrupted',
      error: `the ${state.kind} job's process (pid ${state.pid}) ended without finishing; nothing was published`,
    };
  return state;
}

module.exports = { pathsOf, writeState, jobState, holderGone, selfIdentity, processStartMs };
