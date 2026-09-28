// Vantage v2 warehouse connection + migration runner.
// Kept separate from cache.db (docs/decisions/0002): the warehouse is
// durable, provenance-carrying data and is never pruned.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..', '..');
const MIGRATIONS_DIR = path.join(ROOT, 'db', 'migrations');

function defaultWarehousePath() {
  return process.env.WAREHOUSE_DB_PATH || path.join(ROOT, 'warehouse.db');
}

// Applies every db/migrations/NNNN_name.sql not yet recorded, in order, each
// in its own transaction. Returns the versions applied by this call.
function migrate(db) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)'
  );
  const applied = new Set(
    db
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map(r => r.version)
  );
  const record = db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)');
  const ran = [];
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter(f => /^\d{4}_[\w-]+\.sql$/.test(f))
    .sort();
  for (const file of files) {
    const version = Number(file.slice(0, 4));
    if (applied.has(version)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      record.run(version, file, new Date().toISOString());
    })();
    ran.push(version);
  }
  return ran;
}

function openWarehouse(dbPath = defaultWarehousePath()) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

module.exports = { openWarehouse, migrate, defaultWarehousePath, MIGRATIONS_DIR };
