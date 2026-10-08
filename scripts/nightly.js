#!/usr/bin/env node
// The nightly run for a scheduler (lib/warehouse/nightly.js): refresh, backup,
// the watch report, doctor; alerts on a failure; exits 1 on a failure.
//
//   npm run nightly
require('dotenv').config();
const { defaultWarehousePath } = require('../lib/warehouse/db');
const { nightly, runRefresh } = require('../lib/warehouse/nightly');
const { backup } = require('../lib/warehouse/backup');
const { doctor } = require('../lib/warehouse/doctor');
const { runWatch } = require('./watch');

async function main() {
  const dbPath = defaultWarehousePath();
  const log = line => console.log(`[${new Date().toISOString()}] ${line}`);
  const r = await nightly(dbPath, {
    refresh: () => runRefresh(),
    backup: async () => {
      const b = backup(dbPath, { log });
      return {
        status: 'ok',
        detail: `${b.skipped ? 'already backed up' : 'backed up'}: generation ${b.generation}, ${b.file}`,
      };
    },
    // suggestions for review (lib/warehouse/watch.js): new items make the night "warn"
    watch: async () => {
      const w = runWatch(dbPath);
      const c = w.counts;
      const fresh = c.queueNew + c.listingNew + c.identityNew + c.splitNew;
      return {
        status: fresh ? 'warn' : 'ok',
        detail:
          `${fresh} new item(s) to review (queue ${c.queueNew}, listing ${c.listingNew}, identity ${c.identityNew}, split ${c.splitNew}); ` +
          w.file,
      };
    },
    doctor: async () => {
      const d = doctor(dbPath);
      const bad = d.checks.filter(c => c.status !== 'ok');
      return {
        status: d.ok ? (bad.length ? 'warn' : 'ok') : 'fail',
        detail: bad.length ? bad.map(c => `${c.name} ${c.status}: ${c.detail}`).join('; ') : 'all checks ok',
      };
    },
  });
  for (const s of r.steps) log(`${s.name} ${s.status}: ${s.detail}`);
  log(`nightly ${r.status}`);
  if (r.status === 'fail') process.exitCode = 1;
}

main().catch(err => {
  console.error(`nightly failed: ${err.message}`);
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 1000).unref();
});
