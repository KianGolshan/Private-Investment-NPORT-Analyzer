#!/usr/bin/env node
// Reconciles the warehouse with EDGAR (lib/warehouse/reconcile.js): every listed
// N-PORT stored, every stored filing still listed, a rotating re-fetch sample
// unchanged. Read-only. Writes reports/reconcile/<date>.json; exits 1 on a finding.
//
//   npm run reconcile                 # sample 100 re-fetches
//   npm run reconcile -- --sample 0   # indexes only
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { openWarehouseReadOnly } = require('../lib/warehouse/db');
const { reconcile } = require('../lib/warehouse/reconcile');

async function main() {
  const at = process.argv.indexOf('--sample');
  const sample = at > 0 ? Number(process.argv[at + 1]) : 100;
  const db = openWarehouseReadOnly();
  let r;
  try {
    r = await reconcile(db, { sample, log: line => console.log(line) });
  } finally {
    db.close();
  }
  const dir = path.join(__dirname, '..', 'reports', 'reconcile');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${r.until}.json`);
  fs.writeFileSync(file, JSON.stringify(r, null, 1));
  console.log(
    `listed ${r.listed}, stored ${r.stored}: ${r.missing.length} missing, ${r.notListed.length} no longer listed, ` +
      `${r.changed.length} of ${r.sampled} re-fetched changed (${r.failed.length} failed), ${r.pending.length} pending; ${file}`
  );
  if (!r.ok) process.exitCode = 1;
}

main().catch(err => {
  console.error(`reconcile failed: ${err.message}`);
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 1000).unref();
});
