// Guards against patterns that reviews found more than once (P6e; the Codex
// verification review of 2026-10-06, V02 and V10). Each scans the tracked
// source, so a new file that breaks the rule fails here, not in a later review.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const tracked = dirs =>
  execFileSync('git', ['ls-files', '--', ...dirs], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(f => /\.(c?js|tsx?)$/.test(f));
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const hits = (files, re) =>
  files.flatMap(f =>
    read(f)
      .split('\n')
      .map((line, i) => [line, i + 1])
      .filter(([line]) => re.test(line) && !/^\s*\/\//.test(line))
      .map(([, n]) => `${f}:${n}`)
  );

// V02: the curation a generation records must be the curation it used. Only the
// resolver (lib/warehouse/curation.js) and the seed tooling read curation.json;
// every derived step gets it passed in (job ctx.curation / curationFor).
test('only the curation resolver and the seed tooling read data/review/curation.json', () => {
  const allowed = new Set(['lib/entities/seed.js', 'lib/warehouse/curation.js', 'scripts/seed-entities.js']);
  const found = hits(tracked(['lib', 'scripts', 'server.js']), /\bloadCuration\(/).filter(
    h => !allowed.has(h.split(':')[0])
  );
  assert.deepEqual(found, [], 'read the curation through lib/warehouse/curation.js curationFor');
});

// V10: diagnostics and scripts never open the published warehouse write-capable
// (openWarehouse migrates and switches to WAL; published generations are 0444).
// Only jobs open a candidate for writing.
test('nothing opens the published warehouse write-capable outside a job', () => {
  const found = hits(
    tracked(['lib', 'scripts', 'test', 'server.js']),
    /\bopenWarehouse\(\s*(\)|DB_PATH|defaultWarehousePath\(\)|['"`][^'"`]*warehouse\.db['"`])/
  );
  assert.deepEqual(found, [], 'use openWarehouseReadOnly for the published warehouse');
});
