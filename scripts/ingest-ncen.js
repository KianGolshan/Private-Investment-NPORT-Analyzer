#!/usr/bin/env node
// Loads Form N-CEN adviser data (lib/warehouse/ncen.js), then rebuilds each
// fund's advisers (lib/entities/managers.js).
//
//   npm run ingest:ncen                 # data sets not yet loaded, then the EDGAR top-up
//   npm run ingest:ncen -- --all        # reload every data set
//   npm run ingest:ncen -- --no-edgar   # data sets only
//
// Runs in the foreground; each data set is one transaction; resumable.
require('dotenv').config();
const { openWarehouse } = require('../lib/warehouse/db');
const { refreshNcen } = require('../lib/warehouse/ncen');
const { refreshFundAdvisers } = require('../lib/entities/managers');

async function main() {
  const args = process.argv.slice(2);
  const db = openWarehouse();
  const started = Date.now();
  let failed = 0;
  try {
    const r = await refreshNcen(db, {
      all: args.includes('--all'),
      edgar: !args.includes('--no-edgar'),
      log: console.log,
    });
    if (r.topUp) {
      console.log(`EDGAR top-up: ${r.topUp.fetched} filings read, ${r.topUp.failed.length} failed`);
      for (const f of r.topUp.failed) console.error(`  failed ${f.accession}: ${f.error}`);
      failed = r.topUp.failed.length;
    }
    const m = refreshFundAdvisers(db);
    console.log(`fund advisers: ${m.mapped} of ${m.funds} funds mapped`);
  } finally {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    console.log(`done in ${((Date.now() - started) / 60000).toFixed(1)} min`);
  }
  if (failed) process.exitCode = 1;
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
