#!/usr/bin/env node
// Loads Form N-CEN adviser data (lib/warehouse/ncen.js), then rebuilds each
// fund's advisers and everything derived from them, as one warehouse job.
//
//   npm run ingest:ncen                 # data sets not yet loaded, then the EDGAR top-up
//   npm run ingest:ncen -- --all        # reload every data set
//   npm run ingest:ncen -- --no-edgar   # data sets only
//
// Runs in the foreground; resumable (data sets already loaded are skipped).
require('dotenv').config();
const { refreshNcen } = require('../lib/warehouse/ncen');
const { runJob } = require('../lib/warehouse/job');

// A warehouse job (lib/warehouse/job.js): fund advisers and everything derived
// from them are rebuilt, then published as a new generation, or nothing is.
async function main() {
  const args = process.argv.slice(2);
  const started = Date.now();
  const r = await runJob(
    'ingest-ncen',
    async db => {
      const n = await refreshNcen(db, {
        all: args.includes('--all'),
        edgar: !args.includes('--no-edgar'),
        log: console.log,
      });
      const failed = n.topUp ? n.topUp.failed : [];
      if (n.topUp) console.log(`EDGAR top-up: ${n.topUp.fetched} filings read, ${failed.length} failed`);
      for (const f of failed) console.error(`  failed ${f.accession}: ${f.error}`);
      return {
        status: failed.length ? 'partial' : 'ok',
        note: failed.length ? `${failed.length} N-CEN filing(s) failed` : null,
      };
    },
    { log: console.log }
  );
  console.log(
    `done in ${((Date.now() - started) / 60000).toFixed(1)} min; published generation ${r.generation} (${r.status})`
  );
  if (r.status !== 'ok') process.exitCode = 1;
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
