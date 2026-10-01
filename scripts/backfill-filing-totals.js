#!/usr/bin/env node
// One-off: fills filing_totals (migration 0015) for filings loaded before it.
//
//   node scripts/backfill-filing-totals.js --bulk [--quarter 2026q2 …] [--max-minutes 9]
//   node scripts/backfill-filing-totals.js --edgar [--concurrency 3] [--max-minutes 9]
//   node scripts/backfill-filing-totals.js --status
//
// Foreground and resumable: run it again to continue. --max-minutes stops
// starting new work after that long, so each run is a timed batch. Refuses to
// run while a refresh is running. Exits non-zero if any filing failed.
require('dotenv').config();
const fs = require('fs');
const { openWarehouse, defaultWarehousePath } = require('../lib/warehouse/db');
const { downloadQuarter } = require('../lib/warehouse/bulk-source');
const { fetchFilingRows } = require('../lib/warehouse/delta');
const { STALE_RUN_MS } = require('../lib/warehouse/refresh');
const {
  backfillBulkTotals,
  backfillEdgarTotals,
  bulkQuartersMissingTotals,
  edgarFilingsMissingTotals,
} = require('../lib/warehouse/totals-backfill');

function parseArgs(argv) {
  const opts = { bulk: false, edgar: false, status: false, quarters: [], maxMinutes: Infinity, concurrency: 3 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--bulk') opts.bulk = true;
    else if (a === '--edgar') opts.edgar = true;
    else if (a === '--status') opts.status = true;
    else if (a === '--quarter') opts.quarters.push(String(argv[++i] || '').toLowerCase());
    else if (a === '--max-minutes') opts.maxMinutes = Number(argv[++i]);
    else if (a === '--concurrency') opts.concurrency = Number(argv[++i]);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!opts.bulk && !opts.edgar && !opts.status) throw new Error('pass --bulk, --edgar or --status');
  if (!(opts.maxMinutes > 0)) throw new Error('--max-minutes must be positive');
  if (!(opts.concurrency >= 1 && opts.concurrency <= 8)) throw new Error('--concurrency must be 1–8');
  return opts;
}

function status(db) {
  const q = bulkQuartersMissingTotals(db);
  const e = edgarFilingsMissingTotals(db).length;
  const have = db.prepare('SELECT COUNT(*) n FROM filing_totals').get().n;
  console.log(
    `filing_totals: ${have.toLocaleString()} filings; missing: ${q.reduce((n, r) => n + r.missing, 0).toLocaleString()} ` +
      `bulk in ${q.length} quarter(s)${q.length ? ` (${q.map(r => r.quarter).join(' ')})` : ''}, ${e.toLocaleString()} catch-up`
  );
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dbPath = defaultWarehousePath();
  const db = openWarehouse(dbPath);
  const started = Date.now();
  const deadline = started + opts.maxMinutes * 60000;
  try {
    const running = db
      .prepare("SELECT id, started_at FROM refresh_runs WHERE status = 'running'")
      .all()
      .filter(r => Date.now() - Date.parse(r.started_at) < STALE_RUN_MS);
    if (running.length) throw new Error(`refresh #${running[0].id} is running; try again when it finishes`);
    if (opts.bulk) {
      const r = await backfillBulkTotals(db, {
        download: downloadQuarter,
        quarters: opts.quarters.length ? opts.quarters : null,
        deadline,
        log: console.log,
      });
      console.log(`bulk: ${r.done.length} quarter(s) done, ${r.left} left`);
    }
    if (opts.edgar) {
      const r = await backfillEdgarTotals(db, {
        fetchRows: fetchFilingRows,
        concurrency: opts.concurrency,
        deadline,
        log: console.log,
      });
      console.log(`catch-up: ${r.loaded} of ${r.todo} filings done, ${r.failed.length} failed, ${r.left} left`);
      for (const m of r.keptMismatch) {
        console.log(`  kept-row mismatch ${m.accession}: stored ${m.stored}, re-read ${m.reread}`);
      }
      for (const f of r.failed) console.log(`  failed ${f.accession}: ${f.error}`);
      if (r.failed.length || r.keptMismatch.length) process.exitCode = 1;
    }
    status(db);
  } finally {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
  }
  console.log(
    `${((Date.now() - started) / 60000).toFixed(1)} min; warehouse ${(fs.statSync(dbPath).size / 1e6).toFixed(1)} MB`
  );
}

main().catch(err => {
  console.error(`backfill-filing-totals failed: ${err.message}`);
  process.exitCode = 1;
});
