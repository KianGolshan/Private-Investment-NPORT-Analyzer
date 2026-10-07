#!/usr/bin/env node
// The published warehouse generations (lib/warehouse/job.js, ADR 0009).
//
//   npm run warehouse                        # generations, which one is published, the last job
//   npm run warehouse -- --rollback          # republish the previous contents as a new generation
//   npm run warehouse -- --rollback --to N   # republish kept generation N (also undoes a rollback)
//   npm run warehouse -- --sync-curation     # write the published curation snapshot to data/review
require('dotenv').config();
const path = require('path');
const { defaultWarehousePath } = require('../lib/warehouse/db');
const { generations, jobState, rollback, syncCuration } = require('../lib/warehouse/job');

function main() {
  const dbPath = defaultWarehousePath();
  const args = process.argv.slice(2);
  if (args.includes('--rollback')) {
    const at = args.indexOf('--to');
    const r = rollback(dbPath, { log: console.log, to: at >= 0 ? Number(args[at + 1]) : null });
    console.log(`published generation ${r.to} with the contents of generation ${r.restores} (was ${r.from})`);
    return;
  }
  if (args.includes('--sync-curation')) {
    const names = syncCuration(dbPath);
    console.log(`wrote ${names.join(', ')} from the published generation`);
    return;
  }
  const gens = generations(dbPath);
  if (!gens.length) console.log(`${dbPath}: no generations yet (a warehouse from before P6c R2, or none)`);
  for (const g of gens)
    console.log(
      `${g.published ? '*' : ' '} generation ${String(g.id).padStart(4)}  ${(g.bytes / 1e6).toFixed(1)} MB  ${path.relative(process.cwd(), g.file)}`
    );
  // filings that failed MAX_ATTEMPTS times are no longer retried (lib/warehouse/delta.js, review R12)
  if (gens.length) {
    const Database = require('better-sqlite3');
    const db = new Database(gens.find(g => g.published)?.file || gens[0].file, { readonly: true });
    try {
      const stuck = db
        .prepare('SELECT accession, error FROM ingest_errors WHERE attempts >= 5 ORDER BY accession')
        .all();
      if (stuck.length)
        console.log(
          `${stuck.length} filing(s) failed 5 times and are no longer retried: ` +
            stuck
              .slice(0, 10)
              .map(r => `${r.accession} (${r.error})`)
              .join(', ')
        );
    } finally {
      db.close();
    }
  }
  const j = jobState(dbPath);
  if (j)
    console.log(
      `last job: ${j.kind} ${j.status}${j.generation ? ` (generation ${j.generation})` : ''}, ` +
        `${j.startedAt || ''} → ${j.finishedAt || 'running'}${j.error ? `: ${j.error}` : ''}${j.note ? ` (${j.note})` : ''}` +
        `${j.warning ? `; WARNING: ${j.warning}` : ''}`
    );
}

try {
  main();
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
