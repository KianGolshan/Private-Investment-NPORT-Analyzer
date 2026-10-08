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
const { openWarehouseReadOnly, defaultWarehousePath } = require('../lib/warehouse/db');
const { runJob } = require('../lib/warehouse/job');
const { downloadQuarter } = require('../lib/warehouse/bulk-source');
const { fetchFilingRows } = require('../lib/warehouse/delta');
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

// --status only reads. --bulk / --edgar run as a warehouse job
// (lib/warehouse/job.js): the job lock, a validated candidate, a new generation.
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dbPath = defaultWarehousePath();
  const started = Date.now();
  if (!opts.bulk && !opts.edgar) {
    const db = openWarehouseReadOnly(dbPath);
    try {
      status(db);
    } finally {
      db.close();
    }
    return;
  }
  const deadline = started + opts.maxMinutes * 60000;
  const r = await runJob(
    'backfill-totals',
    async db => {
      let failed = 0;
      if (opts.bulk) {
        const b = await backfillBulkTotals(db, {
          download: downloadQuarter,
          quarters: opts.quarters.length ? opts.quarters : null,
          deadline,
          log: console.log,
        });
        console.log(`bulk: ${b.done.length} quarter(s) done, ${b.left} left`);
      }
      if (opts.edgar) {
        const e = await backfillEdgarTotals(db, {
          fetchRows: fetchFilingRows,
          concurrency: opts.concurrency,
          deadline,
          log: console.log,
        });
        console.log(`catch-up: ${e.loaded} of ${e.todo} filings done, ${e.failed.length} failed, ${e.left} left`);
        for (const m of e.keptMismatch)
          console.log(`  kept-row mismatch ${m.accession}: stored ${m.stored}, re-read ${m.reread}`);
        for (const f of e.failed) console.log(`  failed ${f.accession}: ${f.error}`);
        failed = e.failed.length + e.keptMismatch.length;
      }
      status(db);
      return { status: failed ? 'partial' : 'ok', note: failed ? `${failed} filing(s) failed or mismatched` : null };
    },
    { dbPath, log: console.log }
  );
  if (r.status !== 'ok') process.exitCode = 1;
  console.log(`${((Date.now() - started) / 60000).toFixed(1)} min; published generation ${r.generation}`);
}

main().catch(err => {
  console.error(`backfill-filing-totals failed: ${err.message}`);
  process.exitCode = 1;
  // A job past its time limit may leave work running (runJob); exit anyway.
  setTimeout(() => process.exit(1), 1000).unref();
});
