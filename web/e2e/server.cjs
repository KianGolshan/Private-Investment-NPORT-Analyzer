// The browser suite's server (playwright.config.ts): the golden warehouse
// (test/fixtures/warehouse, real rows, committed curation) published as a
// generation in a temp folder, and the real Express app serving web/dist.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DIR = process.env.E2E_DIR || path.join(os.tmpdir(), 'vantage-e2e');

async function main() {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  const dbPath = path.join(DIR, 'warehouse.db');
  const { goldenWarehouse } = require(path.join(ROOT, 'test', 'helpers', 'warehouseApp'));
  fs.writeFileSync(dbPath, goldenWarehouse().db.serialize());
  process.env.WAREHOUSE_DB_PATH = dbPath;
  const { runJob } = require(path.join(ROOT, 'lib', 'warehouse', 'job'));
  await runJob('curation', () => ({}), { dbPath });
  process.env.SEC_USER_AGENT ||= 'Vantage e2e test@example.com';
  const app = require(path.join(ROOT, 'server'));
  const port = Number(process.env.E2E_PORT || 4173);
  app.listen(port, '127.0.0.1', () => console.log(`e2e server on ${port}, warehouse ${dbPath}`));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
