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
const { defaultWarehousePath } = require('../lib/warehouse/db');
const { ingestDelta, defaultSince } = require('../lib/warehouse/delta');
const { runJob } = require('../lib/warehouse/job');

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

// A warehouse job (lib/warehouse/job.js): every derived table is rebuilt and
// the result is published as a new generation, or nothing is.
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dbPath = defaultWarehousePath();
  const started = Date.now();
  const r = await runJob(
    'ingest-delta',
    async db => {
      const since = opts.since || defaultSince(db);
      if (!since) throw new Error('no bulk data yet: run npm run ingest:bulk -- --all first, or pass --since');
      const stats = await ingestDelta(db, {
        since,
        until: opts.until,
        concurrency: opts.concurrency,
        log: console.log,
      });
      const errors = db.prepare('SELECT accession, error, attempts FROM ingest_errors ORDER BY accession').all();
      return {
        status: stats.failed ? 'partial' : 'ok',
        note: stats.failed ? `${stats.failed} filing(s) failed` : null,
        stats,
        errors,
      };
    },
    { dbPath, log: console.log }
  );
  const { stats } = r;
  console.log(
    `Done: ${stats.loaded} filings loaded, ${stats.rowsKept.toLocaleString()} holdings kept, ` +
      `${stats.failed} failed, ${((Date.now() - started) / 60000).toFixed(1)} min; published generation ${r.generation}`
  );
  if (stats.failed) {
    for (const e of r.errors) console.log(`  failed ${e.accession}: ${e.error} (attempt ${e.attempts})`);
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error(`ingest-delta failed: ${err.message}`);
  process.exitCode = 1;
});
