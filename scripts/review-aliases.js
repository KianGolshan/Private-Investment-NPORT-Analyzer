#!/usr/bin/env node
// Imports the reviewed entity files, then re-resolves every holding row and
// rebuilds fund advisers (lib/entities/review.js, resolve.js, managers.js).
//
//   node scripts/review-aliases.js                    # data/review/{aliases,managers,disclosed_exposure}.csv
//   node scripts/review-aliases.js --dir path/to/dir  # reviewed copies elsewhere
//
// Missing files are skipped. Any invalid row aborts that file's import.
const fs = require('fs');
const path = require('path');
const { openWarehouse } = require('../lib/warehouse/db');
const { parseCsv } = require('../lib/entities/csv');
const { importAliases, importManagers, importDisclosedExposure } = require('../lib/entities/review');
const { entityUpkeep } = require('../lib/entities/upkeep');

function main() {
  const args = process.argv.slice(2);
  const dirAt = args.indexOf('--dir');
  const dir = dirAt >= 0 ? path.resolve(args[dirAt + 1]) : path.join(__dirname, '..', 'data', 'review');
  const read = f => {
    const p = path.join(dir, f);
    return fs.existsSync(p) ? parseCsv(fs.readFileSync(p, 'utf8')) : null;
  };
  const db = openWarehouse();
  const t = Date.now();
  try {
    const aliases = read('aliases.csv');
    if (aliases) console.log('aliases:', importAliases(db, aliases));
    const managers = read('managers.csv');
    if (managers) console.log('managers:', importManagers(db, managers));
    const disclosed = read('disclosed_exposure.csv');
    if (disclosed) console.log('disclosed exposure:', importDisclosedExposure(db, disclosed));
    const e = entityUpkeep(db);
    console.log('fund advisers:', e.advisers);
    console.log('holdings resolved:', e.companies);
  } finally {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    console.log(`done in ${((Date.now() - t) / 1000).toFixed(1)} s`);
  }
}

main();
