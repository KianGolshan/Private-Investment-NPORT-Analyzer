#!/usr/bin/env node
// The nightly run for a scheduler (lib/warehouse/nightly.js): refresh, backup,
// the off-site copy, the watch report, doctor, the public smoke check; alerts
// on a failure; exits 1 on a failure.
//
//   npm run nightly
require('dotenv').config();
const { defaultWarehousePath } = require('../lib/warehouse/db');
const { nightly, runRefresh, runOffsite } = require('../lib/warehouse/nightly');
const { backup, backupDir } = require('../lib/warehouse/backup');
const { runSmoke } = require('./smoke');
const { doctor } = require('../lib/warehouse/doctor');
const { runWatch } = require('./watch');

async function main() {
  const dbPath = defaultWarehousePath();
  const log = line => console.log(`[${new Date().toISOString()}] ${line}`);
  let last = null; // the backup the off-site step copies
  const r = await nightly(dbPath, {
    refresh: () => runRefresh(),
    backup: async () => {
      const b = backup(dbPath, { log });
      last = b;
      return {
        status: 'ok',
        detail: `${b.skipped ? 'already backed up' : 'backed up'}: generation ${b.generation}, ${b.file}`,
      };
    },
    // VANTAGE_OFFSITE_CMD (P9); skipped when unset, "warn" on a failure
    offsite: () =>
      last
        ? runOffsite(dbPath, { dir: backupDir(), file: last.file, generation: last.generation })
        : Promise.resolve({ status: 'warn', detail: 'no backup to copy (the backup step failed)' }),
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
    // the public site against GOLDEN-NUMBERS (P9), when VANTAGE_PUBLIC_URL is set
    smoke: async () => {
      const url = process.env.VANTAGE_PUBLIC_URL;
      if (!url) return { status: 'ok', detail: 'skipped (VANTAGE_PUBLIC_URL is not set)' };
      const s = await runSmoke(url);
      const bad = s.checks.filter(c => !c.ok);
      return {
        status: bad.length ? 'fail' : 'ok',
        detail: bad.length ? bad.map(c => `${c.name}: ${c.detail}`).join('; ') : `${s.checks.length} checks passed`,
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
