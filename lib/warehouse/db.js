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
function migrationFiles() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter(f => /^\d{4}_[\w-]+\.sql$/.test(f))
    .sort();
}

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
  for (const file of migrationFiles()) {
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

// For readers (the web server, the MCP server): never creates a file, never
// migrates, never writes. Migrations belong to the jobs (ingest, refresh,
// review import). Fails loudly when the file is missing or its schema is
// behind the code, instead of serving an empty or stale warehouse.
function openWarehouseReadOnly(dbPath = defaultWarehousePath()) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const expected = migrationFiles().map(f => Number(f.slice(0, 4)));
  let applied;
  try {
    applied = new Set(
      db
        .prepare('SELECT version FROM schema_migrations')
        .all()
        .map(r => r.version)
    );
  } catch {
    applied = new Set();
  }
  const missing = expected.filter(v => !applied.has(v));
  if (missing.length) {
    db.close();
    throw new Error(
      `${dbPath}: schema is missing migration(s) ${missing.join(', ')}; run npm run refresh (or any ingest job) first`
    );
  }
  return db;
}

// The data version an open warehouse answers from: its published generation
// (generation_meta, written by lib/warehouse/job.js), or, for a warehouse built
// before generations or a test fixture, the latest finished run.
function generationOf(db) {
  try {
    const g = db.prepare('SELECT MAX(id) id FROM generation_meta').get().id;
    if (g != null) return g;
  } catch {
    // before migration 0020
  }
  return (
    db.prepare("SELECT id FROM refresh_runs WHERE status IN ('ok', 'partial') ORDER BY id DESC LIMIT 1").get()?.id ?? 0
  );
}

module.exports = {
  openWarehouse,
  openWarehouseReadOnly,
  migrate,
  migrationFiles,
  generationOf,
  defaultWarehousePath,
  MIGRATIONS_DIR,
};
