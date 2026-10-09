// The deploy drill's warehouse (deploy/test/drill.sh): the golden fixture
// (test/fixtures/warehouse, real rows) published as a generation at
// $WAREHOUSE, as the e2e server does (web/e2e/server.cjs).
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const dbPath = process.env.WAREHOUSE;
if (!dbPath) throw new Error('set WAREHOUSE');
const { goldenWarehouse } = require(path.join(ROOT, 'test', 'helpers', 'warehouseApp'));
const { runJob } = require(path.join(ROOT, 'lib', 'warehouse', 'job'));

fs.writeFileSync(dbPath, goldenWarehouse().db.serialize());
runJob('curation', () => ({}), { dbPath }).then(r => console.log(`warehouse: generation ${r.generation} at ${dbPath}`));
