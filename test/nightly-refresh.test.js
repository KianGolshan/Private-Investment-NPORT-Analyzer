// The nightly's refresh child (lib/warehouse/nightly.js runRefresh): every way
// it can end is reported in words, and it runs with its own heap ceiling. Real
// child processes. The server's first nightly (2026-10-14) ran out of memory at
// the ~1.5 GB heap Node derived from MemoryMax=3G, and the run was reported as
// "killed (SIGABRT) after the time limit".
//
// Run with: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir } = require('./helpers/tmp');
const { runRefresh, endedBy, refreshArgs } = require('../lib/warehouse/nightly');

const dir = tmpDir('nightly-child');
function script(name, body) {
  const file = path.join(dir, `${name}.js`);
  fs.writeFileSync(file, body);
  return file;
}

test('a refresh that publishes is ok', async () => {
  const r = await runRefresh({ script: script('ok', 'process.exit(0);') });
  assert.deepEqual(r, { status: 'ok', detail: 'published' });
});

test('a refresh that fails reports its exit code', async () => {
  const r = await runRefresh({ script: script('code', 'process.exit(3);') });
  assert.deepEqual(r, { status: 'fail', detail: 'exit code 3' });
});

test('a refresh that crashes (out of memory raises SIGABRT) is reported as a crash, not the time limit', async () => {
  const r = await runRefresh({ script: script('abort', 'process.abort();') });
  assert.equal(r.status, 'fail');
  assert.match(r.detail, /^crashed \(SIGABRT, usually out of memory\)$/);
});

test('a refresh past the time limit is killed and says so', async () => {
  const r = await runRefresh({ script: script('slow', 'setTimeout(() => {}, 60000);'), limitMs: 300 });
  assert.equal(r.status, 'fail');
  assert.match(r.detail, /^killed \(SIGKILL\) after the time limit$/);
});

test('the refresh runs with its own heap ceiling (3 GB, or VANTAGE_REFRESH_HEAP_MB)', async () => {
  const out = path.join(dir, 'heap.txt');
  const probe = script(
    'heap',
    `require('fs').writeFileSync(${JSON.stringify(out)}, String(require('v8').getHeapStatistics().heap_size_limit));`
  );
  await runRefresh({ script: probe, env: { ...process.env, VANTAGE_REFRESH_HEAP_MB: '' } });
  const mb = Number(fs.readFileSync(out, 'utf8')) / 1048576;
  assert.ok(mb >= 3072 && mb < 3400, `heap limit ${mb} MB (old space plus the young generation)`);
  await runRefresh({ script: probe, env: { ...process.env, VANTAGE_REFRESH_HEAP_MB: '1024' } });
  assert.ok(Number(fs.readFileSync(out, 'utf8')) / 1048576 < 1400);
});

test('endedBy and refreshArgs: every case, including unreadable settings', () => {
  assert.equal(endedBy({ code: 1 }), 'exit code 1');
  assert.equal(endedBy({ signal: 'SIGTERM' }), 'ended by SIGTERM');
  assert.equal(endedBy({ signal: 'SIGKILL', timedOut: true }), 'killed (SIGKILL) after the time limit');
  assert.equal(endedBy({ code: null, timedOut: true }), 'killed (SIGKILL) after the time limit');
  for (const v of [undefined, '', 'abc', '-5', '100', '2.5'])
    assert.deepEqual(refreshArgs({ VANTAGE_REFRESH_HEAP_MB: v }), ['--max-old-space-size=3072'], String(v));
  assert.deepEqual(refreshArgs({ VANTAGE_REFRESH_HEAP_MB: '4096' }), ['--max-old-space-size=4096']);
});
