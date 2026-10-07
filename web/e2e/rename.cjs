// Renames a company through a real warehouse job (lib/warehouse/job.js): a
// new generation the running server must switch to.
//   node e2e/rename.cjs <company id> <new name>
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const dbPath = path.join(process.env.E2E_DIR || path.join(os.tmpdir(), 'vantage-e2e'), 'warehouse.db');
const { runJob } = require(path.join(ROOT, 'lib', 'warehouse', 'job'));
const [id, name] = process.argv.slice(2);
runJob(
  'curation',
  db => {
    db.prepare('UPDATE companies SET name = ? WHERE id = ?').run(name, Number(id));
    return {};
  },
  { dbPath }
).then(
  r => console.log(`generation ${r.generation}`),
  err => {
    console.error(err.message);
    process.exit(1);
  }
);
