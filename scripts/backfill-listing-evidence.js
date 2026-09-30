#!/usr/bin/env node
// Fills listing_evidence (migration 0010) for bulk quarters loaded before it
// existed, newest first (lib/warehouse/listing-evidence.js):
//
//   node scripts/backfill-listing-evidence.js --max 4
//
// Foreground, one quarter at a time (download, scan, delete the zip),
// resumable: quarters with evidence are skipped. New ingests fill it directly.
require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openWarehouse } = require('../lib/warehouse/db');
const { downloadQuarter } = require('../lib/warehouse/bulk-source');
const { openZip, readTable } = require('../lib/warehouse/tsv-zip');
const { isValidIsin } = require('../lib/warehouse/identifiers');
const { isPrivateCandidate } = require('../lib/warehouse/keep-rule');
const { listingEvidenceCollector } = require('../lib/warehouse/listing-evidence');

async function scan(zipPath) {
  const archive = await openZip(zipPath);
  try {
    const isin = new Set();
    await readTable(archive, 'IDENTIFIERS.tsv', r => {
      if (isValidIsin(r.IDENTIFIER_ISIN)) isin.add(Number(r.HOLDING_ID));
    });
    const listing = listingEvidenceCollector();
    await readTable(archive, 'FUND_REPORTED_HOLDING.tsv', r => {
      const has = isin.has(Number(r.HOLDING_ID));
      if (!isPrivateCandidate(r, has)) listing.add(r, has);
    });
    return listing;
  } finally {
    archive.zip.close();
  }
}

async function main() {
  const at = process.argv.indexOf('--max');
  const max = at >= 0 ? Number(process.argv[at + 1]) : 4;
  if (!(max > 0)) throw new Error('--max must be a positive number');
  const db = openWarehouse();
  const t = Date.now();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vantage-listing-'));
  try {
    const done = new Set(
      db
        .prepare('SELECT DISTINCT quarter FROM listing_evidence')
        .all()
        .map(r => r.quarter)
    );
    const quarters = db
      .prepare("SELECT DISTINCT substr(source, 6) q FROM filings WHERE source LIKE 'bulk:%' ORDER BY q DESC")
      .all()
      .map(r => r.q)
      .filter(q => !done.has(q))
      .slice(0, max);
    console.log(`listing evidence: doing ${quarters.join(' ') || 'nothing'}`);
    for (const q of quarters) {
      const zip = await downloadQuarter(q, dir);
      try {
        const listing = await scan(zip.path);
        const n = db.transaction(() => listing.store(db, q))();
        console.log(`  ${q}: ${n} issuer keys (${((Date.now() - t) / 1000).toFixed(0)} s)`);
      } finally {
        fs.rmSync(zip.path, { force: true });
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    db.close();
    console.log(`done in ${((Date.now() - t) / 60000).toFixed(1)} min`);
  }
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
