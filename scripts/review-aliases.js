#!/usr/bin/env node
// Imports the reviewed entity files, then re-resolves every holding row and
// rebuilds fund advisers (lib/entities/review-import.js).
//
//   node scripts/review-aliases.js                    # data/review/{company_ids,aliases,managers,disclosed_exposure}.csv
//   node scripts/review-aliases.js --dir path/to/dir  # reviewed copies elsewhere
//
// Missing files are skipped. Any invalid row aborts that file's import. Company ids come from
// company_ids.csv, which is rewritten after the import (new ids, retired ids with redirects).
const path = require('path');
const { openWarehouse } = require('../lib/warehouse/db');
const { runReviewImport } = require('../lib/entities/review-import');

function main() {
  const args = process.argv.slice(2);
  const dirAt = args.indexOf('--dir');
  const dir = dirAt >= 0 ? path.resolve(args[dirAt + 1]) : path.join(__dirname, '..', 'data', 'review');
  const db = openWarehouse();
  const t = Date.now();
  try {
    runReviewImport(db, dir, { log: console.log });
  } finally {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    console.log(`done in ${((Date.now() - t) / 1000).toFixed(1)} s`);
  }
}

main();
