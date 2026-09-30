#!/usr/bin/env node
// Imports the reviewed entity files, then re-resolves every holding row and
// rebuilds fund advisers (lib/entities/review.js, resolve.js, managers.js).
//
//   node scripts/review-aliases.js                    # data/review/{company_ids,aliases,managers,disclosed_exposure}.csv
//   node scripts/review-aliases.js --dir path/to/dir  # reviewed copies elsewhere
//
// Missing files are skipped. Any invalid row aborts that file's import. Company ids come from
// company_ids.csv, which is rewritten after the import (new ids, retired ids with redirects).
const fs = require('fs');
const path = require('path');
const { openWarehouse } = require('../lib/warehouse/db');
const { parseCsv, toCsv } = require('../lib/entities/csv');
const {
  importAliases,
  importManagers,
  importDisclosedExposure,
  companyIdRows,
  COMPANY_ID_COLUMNS,
} = require('../lib/entities/review');
const { entityUpkeep } = require('../lib/entities/upkeep');
const { identityUpkeep } = require('../lib/entities/report');
const { rebuildEntities } = require('../lib/entities/entities');

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
    if (aliases) {
      console.log('aliases:', importAliases(db, aliases, { ids: read('company_ids.csv') }));
      fs.writeFileSync(path.join(dir, 'company_ids.csv'), toCsv(COMPANY_ID_COLUMNS, companyIdRows(db)));
    }
    const managers = read('managers.csv');
    if (managers) console.log('managers:', importManagers(db, managers));
    const disclosed = read('disclosed_exposure.csv');
    if (disclosed) console.log('disclosed exposure:', importDisclosedExposure(db, disclosed));
    const e = entityUpkeep(db);
    console.log('fund advisers:', e.advisers);
    console.log('holdings resolved:', e.companies);
    console.log('unreviewed entities and search:', rebuildEntities(db, identityUpkeep(db)));
  } finally {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    console.log(`done in ${((Date.now() - t) / 1000).toFixed(1)} s`);
  }
}

main();
