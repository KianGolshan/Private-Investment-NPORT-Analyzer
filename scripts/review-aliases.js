#!/usr/bin/env node
// Imports the reviewed entity files, then re-resolves every holding row and
// rebuilds fund advisers (lib/entities/review-import.js).
//
//   node scripts/review-aliases.js                    # data/review/{company_ids,aliases,managers,disclosed_exposure}.csv
//   node scripts/review-aliases.js --dir path/to/dir  # reviewed copies elsewhere
//
// Missing files are skipped. Any invalid row aborts that file's import. Company ids come from
// company_ids.csv, which is rewritten after the import (new ids, retired ids with redirects).
// The job reads a staged copy of the directory; the rewritten ledgers reach it only once the
// new generation is published (lib/warehouse/job.js curationDir).
const path = require('path');
const { runReviewImport } = require('../lib/entities/review-import');
const { runJob } = require('../lib/warehouse/job');

// A warehouse job of kind 'curation' (lib/warehouse/job.js), like the admin
// job: never beside a refresh or another import, published whole or not at all.
async function main() {
  const args = process.argv.slice(2);
  const dirAt = args.indexOf('--dir');
  const dir = dirAt >= 0 ? path.resolve(args[dirAt + 1]) : path.join(__dirname, '..', 'data', 'review');
  const t = Date.now();
  const r = await runJob(
    'curation',
    (db, { curationDir }) => runReviewImport(db, curationDir, { log: console.log }) && {},
    { log: console.log, curationDir: dir }
  );
  console.log(`published generation ${r.generation} in ${((Date.now() - t) / 1000).toFixed(1)} s`);
}

main().catch(err => {
  console.error(`review import failed: ${err.message}`);
  process.exitCode = 1;
});
