#!/usr/bin/env node
// Rebuilds test/fixtures/asof-zero/ from the REAL warehouse.db (no network):
//
//   node test/fixtures/asof-zero/build-fixture.js [path/to/warehouse.db]
//
// One fund that still reports a position valued at $0 (GOLDEN F34): every
// filing of American High Income Trust (S000008787) and its Mesquite Energy
// rows. Same format as test/fixtures/warehouse/ (openFixtureWarehouse).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const Database = require('better-sqlite3');
const { defaultWarehousePath } = require('../../../lib/warehouse/db');

const FUND_KEY = 'S000008787';
const PATTERN = '\\bmesquite energy\\b';

function main() {
  const src = process.argv[2] || defaultWarehousePath();
  const db = new Database(src, { readonly: true, fileMustExist: true });
  const re = new RegExp(PATTERN, 'i');
  db.function('fixture_match', { deterministic: true }, t => (t != null && re.test(t) ? 1 : 0));
  const filings = db
    .prepare('SELECT * FROM filings WHERE fund_key = ? ORDER BY report_date, filing_date, accession')
    .all(FUND_KEY);
  const holdings = db
    .prepare(
      `SELECT h.* FROM holdings h JOIN filings f ON f.accession = h.accession
       WHERE f.fund_key = ? AND (fixture_match(h.issuer_name) OR fixture_match(h.title))
       ORDER BY h.accession, h.row_key`
    )
    .all(FUND_KEY);
  const table = rows => ({ columns: Object.keys(rows[0]), rows: rows.map(r => Object.values(r)) });
  const manifest = {
    builtAt: new Date().toISOString(),
    source: path.basename(src),
    sourceNewestFilingDate: db.prepare('SELECT MAX(filing_date) d FROM filings').get().d,
    fundKey: FUND_KEY,
    pattern: PATTERN,
    filings: filings.length,
    holdings: holdings.length,
  };
  db.close();
  const payload = JSON.stringify({ manifest, filings: table(filings), holdings: table(holdings) });
  fs.writeFileSync(path.join(__dirname, 'warehouse.json.gz'), zlib.gzipSync(payload, { level: 9 }));
  fs.writeFileSync(path.join(__dirname, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`fixture: ${manifest.filings} filings, ${manifest.holdings} rows`);
}

main();
