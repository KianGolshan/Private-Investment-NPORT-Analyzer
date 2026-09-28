#!/usr/bin/env node
// Catch-up: loads every NPORT-P / NPORT-P/A filed since the newest bulk
// filing date (or --since) from EDGAR, as primary_doc.xml, into the warehouse.
//
//   npm run ingest:delta                        # since the newest bulk filing date
//   npm run ingest:delta -- --since 2026-09-01 [--until 2026-09-28] [--concurrency 3]
//
// Resumable (already-loaded filings are skipped); failures are listed in
// ingest_errors, retried next run, and make this exit non-zero.
require('dotenv').config();
const fs = require('fs');
const { openWarehouse, defaultWarehousePath } = require('../lib/warehouse/db');
const { ingestDelta, defaultSince } = require('../lib/warehouse/delta');

function parseArgs(argv) {
  const opts = { since: null, until: null, concurrency: 3 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--since') opts.since = argv[++i];
    else if (a === '--until') opts.until = argv[++i];
    else if (a === '--concurrency') opts.concurrency = Number(argv[++i]);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!(opts.concurrency >= 1 && opts.concurrency <= 8)) throw new Error('--concurrency must be 1–8');
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dbPath = defaultWarehousePath();
  const db = openWarehouse(dbPath);
  const started = Date.now();
  try {
    const since = opts.since || defaultSince(db);
    if (!since) throw new Error('no bulk data yet: run npm run ingest:bulk -- --all first, or pass --since');
    const stats = await ingestDelta(db, { since, until: opts.until, concurrency: opts.concurrency, log: console.log });
    console.log(
      `Done: ${stats.loaded} filings loaded, ${stats.rowsKept.toLocaleString()} holdings kept, ` +
        `${stats.failed} failed, ${((Date.now() - started) / 60000).toFixed(1)} min`
    );
    if (stats.failed) {
      for (const e of db.prepare('SELECT accession, error, attempts FROM ingest_errors ORDER BY accession').all()) {
        console.log(`  failed ${e.accession}: ${e.error} (attempt ${e.attempts})`);
      }
      process.exitCode = 1;
    }
  } finally {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
  }
  console.log(`Warehouse: ${dbPath} (${(fs.statSync(dbPath).size / 1e6).toFixed(0)} MB)`);
}

main().catch(err => {
  console.error(`ingest-delta failed: ${err.message}`);
  process.exitCode = 1;
});
