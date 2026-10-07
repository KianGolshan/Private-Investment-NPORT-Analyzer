#!/usr/bin/env node
// Fills filings.series_lei / registrant_lei for filings loaded before
// migration 0005 (lib/warehouse/lei-backfill.js).
//
//   node scripts/backfill-leis.js --max 9      # next 9 bulk quarters not yet done
//   node scripts/backfill-leis.js --edgar      # EDGAR filings without a series ID
//
// Runs in the foreground, one quarter at a time (download, update, delete the
// zip). Resumable: finished quarters are skipped. Exits non-zero on failure.
require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runJob } = require('../lib/warehouse/job');
const { downloadQuarter } = require('../lib/warehouse/bulk-source');
const { backfillLeisFromZip, backfillEdgarLeis, doneQuarters } = require('../lib/warehouse/lei-backfill');

async function main() {
  const args = process.argv.slice(2);
  const edgar = args.includes('--edgar');
  const maxAt = args.indexOf('--max');
  const max = maxAt >= 0 ? Number(args[maxAt + 1]) : Infinity;
  if (!(max > 0)) throw new Error('--max must be a positive number');
  const started = Date.now();
  await runJob('backfill-leis', db => backfill(db, { edgar, max }), { log: console.log });
  console.log(`done in ${((Date.now() - started) / 60000).toFixed(1)} min`);
}

// One batch on the job's candidate warehouse.
async function backfill(db, { edgar, max }) {
  {
    if (edgar) {
      const r = await backfillEdgarLeis(db, { log: console.log });
      console.log(`EDGAR: ${r.listed - r.failed.length}/${r.listed} filings updated`);
      if (r.failed.length) {
        for (const f of r.failed) console.error(`  failed ${f.accession}: ${f.error}`);
        process.exitCode = 1;
      }
      return { status: r.failed.length ? 'partial' : 'ok' };
    }
    const done = doneQuarters(db);
    const quarters = db
      .prepare("SELECT DISTINCT substr(source, 6) q FROM filings WHERE source LIKE 'bulk:%' ORDER BY q")
      .all()
      .map(r => r.q)
      .filter(q => !done.has(q));
    const batch = quarters.slice(0, max);
    console.log(`LEI backfill: ${quarters.length} quarters left, doing ${batch.join(' ') || 'none'}`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vantage-lei-'));
    try {
      for (const q of batch) {
        const t = Date.now();
        const zip = await downloadQuarter(q, dir);
        try {
          const r = await backfillLeisFromZip(db, zip.path, { quarter: q });
          console.log(`  ${q}: ${r.updated} filings (${((Date.now() - t) / 1000).toFixed(0)} s)`);
        } finally {
          fs.rmSync(zip.path, { force: true });
        }
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  return {};
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
