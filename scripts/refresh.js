#!/usr/bin/env node
// Nightly refresh: new or re-posted SEC bulk quarter(s), the EDGAR catch-up,
// N-CEN and entity upkeep. Exits non-zero if anything failed (for
// cron/launchd alerting); refuses to start while another refresh runs.
//
//   npm run refresh
require('dotenv').config();
const path = require('path');
const { openWarehouse, defaultWarehousePath } = require('../lib/warehouse/db');
const { refresh } = require('../lib/warehouse/refresh');

async function main() {
  const db = openWarehouse(defaultWarehousePath());
  const started = Date.now();
  try {
    const r = await refresh(db, {
      log: line => console.log(`[${new Date().toISOString()}] ${line}`),
      entityReport: path.join(__dirname, '..', 'reports', 'entities'),
    });
    console.log(
      `refresh #${r.runId} ${r.status}: bulk added [${r.bulkQuartersAdded.join(' ') || 'none'}], ` +
        `catch-up since ${r.since}: ${r.loaded} loaded, ${r.failed} failed, ` +
        `${((Date.now() - started) / 60000).toFixed(1)} min`
    );
    if (r.status !== 'ok') process.exitCode = 1;
  } finally {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
  }
}

main().catch(err => {
  console.error(`refresh failed: ${err.message}`);
  process.exitCode = 1;
});
