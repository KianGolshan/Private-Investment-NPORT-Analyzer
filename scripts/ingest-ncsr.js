#!/usr/bin/env node
// Reads N-CSR / N-CSRS cost tables (lib/warehouse/ncsr.js) for the registrants in
// data/review/ncsr_families.csv, then rebuilds everything derived (cost facts and
// confirmed round prices included), as one warehouse job (P15, ADR 0011).
//
//   npm run ingest:ncsr                     # filings not read yet, at most 150
//   npm run ingest:ncsr -- --backfill       # every filing not read yet, no cap
//   npm run ingest:ncsr -- --cik 707823,44201 --max 10
//
// Runs in the foreground; resumable (read filings are skipped, failed ones retried).
require('dotenv').config();
const { ingestNcsr } = require('../lib/warehouse/ncsr');
const { runJob } = require('../lib/warehouse/job');

function args(argv) {
  const out = { ciks: null, max: 150 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--backfill') out.max = Infinity;
    else if (argv[i] === '--max') out.max = Number(argv[++i]);
    else if (argv[i] === '--cik') out.ciks = argv[++i].split(',').map(s => s.replace(/^0+/, ''));
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!(out.max > 0)) throw new Error('--max must be a positive number');
  return out;
}

async function main() {
  const opt = args(process.argv.slice(2));
  const started = Date.now();
  const r = await runJob(
    'ingest-ncsr',
    async db => {
      const n = await ingestNcsr(db, { ciks: opt.ciks, max: opt.max, log: console.log });
      for (const f of n.failedFilings) console.error(`  failed ${f.accession} (${f.form}, CIK ${f.cik}): ${f.error}`);
      if (n.pending) console.log(`${n.pending} filing(s) left for the next run`);
      return {
        status: n.failedFilings.length ? 'partial' : 'ok',
        note: n.failedFilings.length ? `${n.failedFilings.length} N-CSR filing(s) failed` : null,
      };
    },
    { log: console.log }
  );
  console.log(
    `done in ${((Date.now() - started) / 60000).toFixed(1)} min; published generation ${r.generation} (${r.status})`
  );
  if (r.status !== 'ok') process.exitCode = 1;
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
