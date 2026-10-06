// Where a warehouse's job files live and the last job's state (written by
// lib/warehouse/job.js, read by /api/freshness). Kept apart from job.js so the
// web server reads the state without loading the ingest code.
const fs = require('fs');
const path = require('path');
const { defaultWarehousePath } = require('./db');

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

// The last job's state; null when no job has run here.
function jobState(dbPath = defaultWarehousePath()) {
  try {
    return JSON.parse(fs.readFileSync(pathsOf(dbPath).state, 'utf8'));
  } catch {
    return null;
  }
}

module.exports = { pathsOf, writeState, jobState };
