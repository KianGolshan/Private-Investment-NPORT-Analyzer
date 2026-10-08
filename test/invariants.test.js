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

// V07 (LESSONS 39): an export's labels come from the answer its rows came from.
// The table and export code never fetch metadata of their own.
test('the table and export code never fetch their own metadata', () => {
  const found = hits(
    ['web/src/ui/DataTable.tsx', 'web/src/lib/export.ts'],
    /useApi|fetch\(|useProvenance|['"`]\/api\//
  );
  assert.deepEqual(found, [], 'pass the answer to DataTable as `source`');
});

// V07, all tables (LESSONS 39): every exported table names the answer its rows
// came from, so its file carries that generation (and curation, where the answer
// has a basis). A new <DataTable exportName=…> or <ChangesTable> without
// `source` fails here.
test('every exported table passes the answer its rows came from as `source`', () => {
  const missing = [];
  for (const f of tracked(['web/src'])) {
    const text = read(f);
    for (const m of text.matchAll(/<(DataTable|ChangesTable)\b[\s\S]*?\/>/g)) {
      const tag = m[0];
      const exports = m[1] === 'ChangesTable' || /\bexportName=/.test(tag);
      if (exports && !/\bsource=\{/.test(tag)) missing.push(`${f}:${text.slice(0, m.index).split('\n').length}`);
    }
  }
  assert.deepEqual(missing, [], 'add source={answer} to these tables');
});

// P8 pre-flight (2026-10-07): tests that made temp directories without removing
// them left 26 GB in $TMPDIR. Tests make them through test/helpers/tmp.js, which
// removes them.
test('tests make temp directories only through test/helpers/tmp.js', () => {
  const found = hits(
    tracked(['test']).filter(f => !['test/helpers/tmp.js', 'test/invariants.test.js'].includes(f)),
    /mkdtemp|os\.tmpdir\(\)/
  );
  assert.deepEqual(found, [], 'use tmpDir() from test/helpers/tmp.js');
});

// P8 pre-flight (2026-10-07): the counting rule (a row counts when its value is
// positive and it has shares or no share count) is defined once, in
// lib/analytics/asof.js countsRule; position_facts once carried its own copy.
test('the counting rule is defined only in lib/analytics/asof.js', () => {
  const found = hits(tracked(['lib', 'scripts', 'server.js']), /value_usd > 0 && \(\w+\.balance > 0/).filter(
    h => h.split(':')[0] !== 'lib/analytics/asof.js'
  );
  assert.deepEqual(found, [], 'use countsRule from lib/analytics/asof.js');
});
