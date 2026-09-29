#!/usr/bin/env node
// Writes the entity review files from the warehouse (lib/entities/seed.js):
//
//   node scripts/seed-entities.js            # data/review/aliases.csv and managers.csv
//
// Edit the CSVs (company names, merges, status, track, drop rows), then import
// them with scripts/review-aliases.js. Re-running overwrites both files, so
// keep reviewed copies under another name.
const fs = require('fs');
const path = require('path');
const { openWarehouse } = require('../lib/warehouse/db');
const { toCsv } = require('../lib/entities/csv');
const seed = require('../lib/entities/seed');

const OUT = path.join(__dirname, '..', 'data', 'review');

function main() {
  const db = openWarehouse();
  const t = Date.now();
  try {
    const asOf = db
      .prepare('SELECT MAX(report_date) d FROM canonical_filings WHERE report_date <= ?')
      .get(new Date().toISOString().slice(0, 10)).d;
    const rows = seed.companyRows(db);
    const { clusters, since } = seed.buildClusters(rows, { asOf });
    const { groups, candidates } = seed.suggestCompanies(clusters);
    const aliases = seed.aliasRows(groups);
    const managers = seed.suggestManagers(db);
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'aliases.csv'), toCsv(seed.ALIAS_COLUMNS, aliases));
    fs.writeFileSync(path.join(OUT, 'managers.csv'), toCsv(seed.MANAGER_COLUMNS, managers));
    const count = s => groups.filter(g => g.status === s).length;
    console.log(`window ${since}..${asOf}: ${rows.length} rows, ${clusters.size} issuer keys`);
    console.log(`${candidates} candidates (>= 3 funds, >= $25M); ${groups.length} company groups`);
    console.log(
      `  private ${count('private')}, public ${count('public')}, tracked ${groups.filter(g => g.track).length}`
    );
    console.log(`  ${aliases.length} alias rows (${aliases.filter(a => a.via_spv).length} named-SPV suggestions)`);
    console.log(
      `managers.csv: ${managers.length} rows (${managers.filter(m => m.kind === 'registrant').length} registrants without N-CEN)`
    );
    console.log(`done in ${((Date.now() - t) / 1000).toFixed(1)} s`);
  } finally {
    db.close();
  }
}

main();
