#!/usr/bin/env node
// The monthly run for a scheduler (ROADMAP §8): the EDGAR reconciliation, then
// the LIVE regression that re-verifies the goldens (npm run test:live), with
// the nightly run's alerts (lib/warehouse/nightly.js runSteps). Exits 1 on a
// failure. Each step is a child process with a time limit.
//
//   npm run monthly
require('dotenv').config();
const path = require('path');
const { spawn } = require('child_process');
const { defaultWarehousePath } = require('../lib/warehouse/db');
const { runSteps } = require('../lib/warehouse/nightly');

const ROOT = path.join(__dirname, '..');
const child = (args, limitMs, label) =>
  new Promise(resolve => {
    const p = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, LIVE_SEC: '1' }, stdio: 'inherit' });
    const timer = setTimeout(() => p.kill('SIGKILL'), limitMs);
    p.on('error', err => {
      clearTimeout(timer);
      resolve({ status: 'fail', detail: `${label} could not start: ${err.message}` });
    });
    p.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve(
        code === 0
          ? { status: 'ok', detail: `${label} passed` }
          : {
              status: 'fail',
              detail: signal ? `${label} killed after ${limitMs / 60000} min` : `${label} exit code ${code}`,
            }
      );
    });
  });

async function main() {
  const r = await runSteps(defaultWarehousePath(), 'monthly', {
    reconcile: () => child([path.join(ROOT, 'scripts', 'reconcile.js')], 30 * 60000, 'reconcile'),
    live: () =>
      child(
        [
          '--test',
          '--test-concurrency=1',
          ...['live-e2e', 'live-popular', 'live-warehouse'].map(t => path.join(ROOT, 'test', `${t}.test.js`)),
        ],
        60 * 60000,
        'LIVE regression'
      ),
  });
  for (const s of r.steps) console.log(`${s.name} ${s.status}: ${s.detail}`);
  if (r.status === 'fail') process.exitCode = 1;
}

main().catch(err => {
  console.error(`monthly failed: ${err.message}`);
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 1000).unref();
});
