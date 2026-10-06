#!/usr/bin/env node
// The published warehouse generations (lib/warehouse/job.js, ADR 0009).
//
//   npm run warehouse                 # generations, which one is published, the last job
//   npm run warehouse -- --rollback   # publish the generation before the current one
require('dotenv').config();
const path = require('path');
const { defaultWarehousePath } = require('../lib/warehouse/db');
const { generations, jobState, rollback } = require('../lib/warehouse/job');

function main() {
  const dbPath = defaultWarehousePath();
  if (process.argv.includes('--rollback')) {
    const r = rollback(dbPath, { log: console.log });
    console.log(`published generation ${r.to} (was ${r.from})`);
    return;
  }
  const gens = generations(dbPath);
  if (!gens.length) console.log(`${dbPath}: no generations yet (a warehouse from before P6c R2, or none)`);
  for (const g of gens)
    console.log(
      `${g.published ? '*' : ' '} generation ${String(g.id).padStart(4)}  ${(g.bytes / 1e6).toFixed(1)} MB  ${path.relative(process.cwd(), g.file)}`
    );
  const j = jobState(dbPath);
  if (j)
    console.log(
      `last job: ${j.kind} ${j.status}${j.generation ? ` (generation ${j.generation})` : ''}, ` +
        `${j.startedAt || ''} → ${j.finishedAt || 'running'}${j.error ? `: ${j.error}` : ''}${j.note ? ` (${j.note})` : ''}`
    );
}

try {
  main();
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
