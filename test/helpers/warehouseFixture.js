// Loads test/fixtures/warehouse/ (real rows exported from warehouse.db by its
// build-fixture.js) into a fresh in-memory warehouse with every migration
// applied, so the offline golden tests run the real views and code.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { openWarehouse } = require('../../lib/warehouse/db');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'warehouse', 'warehouse.json.gz');

function insertTable(db, name, { columns, rows }) {
  const stmt = db.prepare(`INSERT INTO ${name} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`);
  db.transaction(() => rows.forEach(r => stmt.run(r)))();
}

function openFixtureWarehouse() {
  const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(FIXTURE)).toString('utf8'));
  const db = openWarehouse(':memory:');
  insertTable(db, 'filings', data.filings);
  insertTable(db, 'holdings', data.holdings);
  for (const t of ['ncen_filings', 'ncen_advisers', 'advisers']) if (data[t]) insertTable(db, t, data[t]);
  return { db, manifest: data.manifest };
}

module.exports = { openFixtureWarehouse };
