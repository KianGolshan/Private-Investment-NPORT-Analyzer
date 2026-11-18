#!/usr/bin/env node
// P15 non-regression (plan §9): every table two generations share holds the same rows.
// Read-only. Compares a content hash of each table (every column, rows in primary-key
// or rowid order) and prints the tables that differ; exits 1 if any shared table
// differs outside the expected ones (job bookkeeping, and the N-CSR tables, which are new).
//
//   node scripts/diff-generations.js generations/warehouse-69.db generations/warehouse-70.db
const crypto = require('crypto');
const Database = require('better-sqlite3');

// Rows every job adds: the job's own log, run record and generation metadata.
const BOOKKEEPING = new Set([
  'ingest_log',
  'refresh_runs',
  'generation_meta',
  'schema_migrations',
  'curation_snapshot',
]);
const NEW = /^(ncsr_|cost_facts$|round_prices$)/;

function tables(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map(r => r.name)
    .filter(n => !/_(data|idx|content|docsize|config)$/.test(n)); // FTS5 shadow tables: their parent is compared
}

function hashOf(db, table) {
  const cols = db.prepare(`PRAGMA table_info("${table}")`).all();
  const pk = cols
    .filter(c => c.pk)
    .sort((a, b) => a.pk - b.pk)
    .map(c => `"${c.name}"`);
  const order = pk.length ? pk.join(',') : cols.map(c => `"${c.name}"`).join(',');
  const h = crypto.createHash('sha256');
  let n = 0;
  for (const row of db.prepare(`SELECT * FROM "${table}" ORDER BY ${order}`).raw().iterate()) {
    h.update(JSON.stringify(row));
    h.update('\n');
    n++;
  }
  return { rows: n, hash: h.digest('hex').slice(0, 16) };
}

function main() {
  const [a, b] = process.argv.slice(2);
  if (!a || !b) {
    console.error('usage: diff-generations.js <before.db> <after.db>');
    process.exit(2);
  }
  const da = new Database(a, { readonly: true, fileMustExist: true });
  const db = new Database(b, { readonly: true, fileMustExist: true });
  const ta = new Set(tables(da));
  const tb = tables(db);
  let bad = 0;
  for (const t of tb) {
    if (!ta.has(t)) {
      console.log(`new      ${t}${NEW.test(t) ? '' : '  (unexpected)'}`);
      if (!NEW.test(t)) bad++;
      continue;
    }
    const x = hashOf(da, t);
    const y = hashOf(db, t);
    const same = x.hash === y.hash;
    const expected = BOOKKEEPING.has(t) || NEW.test(t);
    if (!same) console.log(`${expected ? 'changed ' : 'DIFFERS '} ${t}: ${x.rows} -> ${y.rows} rows`);
    if (!same && !expected) bad++;
  }
  for (const t of ta) if (!tb.includes(t)) (bad++, console.log(`MISSING  ${t}`));
  console.log(`${tb.length} tables compared; ${bad} unexpected difference(s)`);
  if (bad) process.exit(1);
}

main();
