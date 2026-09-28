#!/usr/bin/env node
// Loads SEC DERA N-PORT quarterly datasets into the warehouse.
//
//   npm run ingest:bulk -- --quarter 2026q2 [--quarter 2026q1 …]
//   npm run ingest:bulk -- --all              # every quarter listed by the SEC
//   npm run ingest:bulk -- --missing          # only quarters not yet loaded
//   npm run ingest:bulk -- --file ./2026q2_nport.zip --quarter 2026q2
//
// Quarters load one at a time, in the foreground, each in its own
// transaction. The downloaded zip is deleted after each quarter (pass
// --keep-zip to keep it). Exits non-zero on the first failure; every run is
// recorded in ingest_log.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { openWarehouse, defaultWarehousePath } = require('../lib/warehouse/db');
const { ingestBulkZip } = require('../lib/warehouse/bulk-ingest');
const { listAvailableQuarters } = require('../lib/warehouse/bulk-source');
const { loadBulkQuarters, loadedBulkQuarters } = require('../lib/warehouse/refresh');

function parseArgs(argv) {
  const opts = { quarters: [], all: false, missing: false, file: null, keepZip: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--quarter') opts.quarters.push(String(argv[++i] || '').toLowerCase());
    else if (a === '--all') opts.all = true;
    else if (a === '--missing') opts.missing = true;
    else if (a === '--file') opts.file = argv[++i];
    else if (a === '--keep-zip') opts.keepZip = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  for (const q of opts.quarters) if (!/^\d{4}q[1-4]$/.test(q)) throw new Error(`bad quarter "${q}" (use e.g. 2026q2)`);
  if (opts.file && opts.quarters.length !== 1) throw new Error('--file needs exactly one --quarter');
  if (!opts.file && !opts.all && !opts.missing && !opts.quarters.length) {
    throw new Error('nothing to do: pass --quarter, --all, --missing or --file');
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dbPath = defaultWarehousePath();
  const db = openWarehouse(dbPath);
  const started = Date.now();
  let results;
  try {
    if (opts.file) {
      const stats = await ingestBulkZip(db, opts.file, {
        quarter: opts.quarters[0],
        sourceUrl: path.resolve(opts.file),
        bytes: fs.statSync(opts.file).size,
      });
      console.log(`${stats.quarter}: ${stats.filings} filings, ${stats.rowsKept.toLocaleString()} holding rows kept`);
      results = [stats];
    } else {
      let quarters = opts.quarters;
      if (opts.all || opts.missing) {
        const available = await listAvailableQuarters();
        const loaded = loadedBulkQuarters(db);
        quarters = opts.missing ? available.filter(q => !loaded.has(q)) : available;
      }
      console.log(`Warehouse: ${dbPath}`);
      console.log(`Quarters to load (${quarters.length}): ${quarters.join(' ') || 'none'}`);
      results = await loadBulkQuarters(db, quarters, { log: console.log, keepZip: opts.keepZip });
    }
  } finally {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
  }
  const kept = results.reduce((n, s) => n + s.rowsKept, 0);
  const filings = results.reduce((n, s) => n + s.filings, 0);
  console.log(
    `Done: ${results.length} quarter(s), ${filings.toLocaleString()} filings, ${kept.toLocaleString()} holdings kept, ` +
      `${((Date.now() - started) / 60000).toFixed(1)} min, warehouse ${(fs.statSync(dbPath).size / 1e6).toFixed(0)} MB`
  );
}

main().catch(err => {
  console.error(`ingest-bulk failed: ${err.message}`);
  process.exitCode = 1;
});
