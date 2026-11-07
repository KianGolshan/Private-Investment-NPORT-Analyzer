#!/usr/bin/env node
// Reads N-CSR / N-CSRS cost tables (lib/warehouse/ncsr.js) for the registrants in
// data/review/ncsr_families.csv, then rebuilds everything derived (cost facts and
// confirmed round prices included), as one warehouse job (P15, ADR 0011).
//
//   npm run ingest:ncsr                     # filings not read yet, at most 150
//   npm run ingest:ncsr -- --backfill       # every filing not read yet, no cap
//   npm run ingest:ncsr -- --cik 707823,44201 --max 10
//   npm run ingest:ncsr -- --reread-unmapped  # again, filings with a fund no series matched
//   npm run ingest:ncsr -- --reread checks,unmapped --reread-family troweprice
//                                           # again, after a parser change: filings with a fund
//                                           # report in these statuses, every read filing of a family
//   npm run ingest:ncsr -- --retry-failed   # every failed filing now (failures otherwise wait 30 days
//                                           # after their third attempt)
//
// Runs in the foreground; resumable (read filings are skipped, failed ones retried).
require('dotenv').config();
const { ingestNcsr } = require('../lib/warehouse/ncsr');
const { runJob } = require('../lib/warehouse/job');

function args(argv) {
  const out = { ciks: null, max: 150, rereadUnmapped: false, reread: { statuses: [], families: [] } };
  const STATUSES = ['unmapped', 'no_nport', 'checks', 'ok'];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--backfill') out.max = Infinity;
    else if (argv[i] === '--reread-unmapped') out.rereadUnmapped = true;
    else if (argv[i] === '--retry-failed') out.retryFailed = true;
    else if (argv[i] === '--reread') {
      out.reread.statuses = argv[++i].split(',');
      const bad = out.reread.statuses.filter(x => !STATUSES.includes(x));
      if (bad.length) throw new Error(`--reread: unknown status ${bad.join(', ')} (${STATUSES.join(', ')})`);
    } else if (argv[i] === '--reread-family') {
      out.reread.families = argv[++i].split(',');
      const known = ['fidelity', 'capital', 'troweprice', 'morganstanley'];
      const bad = out.reread.families.filter(x => !known.includes(x));
      if (bad.length) throw new Error(`--reread-family: unknown family ${bad.join(', ')}`);
    } else if (argv[i] === '--max') out.max = Number(argv[++i]);
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
      const n = await ingestNcsr(db, {
        ciks: opt.ciks,
        max: opt.max,
        rereadUnmapped: opt.rereadUnmapped,
        reread: opt.reread,
        retryFailed: opt.retryFailed,
        log: console.log,
      });
      for (const f of n.failedFilings) console.error(`  failed ${f.accession} (${f.form}, CIK ${f.cik}): ${f.error}`);
      if (n.pending) console.log(`${n.pending} filing(s) left for the next run`);
      if (n.stopped) console.error(`stopped: the SEC answered ${n.stopped.status} at ${n.stopped.accession}`);
      const notes = [
        n.failedFilings.length && `${n.failedFilings.length} N-CSR filing(s) failed`,
        n.stopped && `stopped at ${n.stopped.accession} (SEC ${n.stopped.status}); ${n.pending} left for the next run`,
      ].filter(Boolean);
      return { status: notes.length ? 'partial' : 'ok', note: notes.join('; ') || null };
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
