// Temp directories for tests, removed when the test file's process exits, or
// earlier through removeTmp() (afterEach, or between runs of a sweep). Every
// test makes its temp directories here (test/invariants.test.js): before this
// helper, a full `npm test` left ~1.6 GB of warehouse copies in $TMPDIR, 26 GB
// over a week (P8 pre-flight, 2026-10-07).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Captured at load, so a test that stubs fs.rmSync (fault injection) cannot
// stop the cleanup.
const { rmSync, mkdtempSync } = fs;
const made = [];

function tmpDir(prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `vantage-${prefix}-`));
  made.push(dir);
  return dir;
}

function removeTmp() {
  while (made.length) {
    const dir = made.pop();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort: the exit hook must not throw
    }
  }
}

process.on('exit', removeTmp);

module.exports = { tmpDir, removeTmp };
