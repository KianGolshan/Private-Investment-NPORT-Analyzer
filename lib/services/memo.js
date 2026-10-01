// Answers that read the whole warehouse (top companies, firm books) are kept
// per database handle until the next finished refresh or curation run: the
// data cannot change without one (refresh_runs, migration 0018).
const memos = new WeakMap();
const MAX_ENTRIES = 200;

function memo(db, key, compute) {
  const runId = db.prepare("SELECT MAX(id) id FROM refresh_runs WHERE status = 'ok'").get().id ?? 0;
  let m = memos.get(db);
  if (!m || m.runId !== runId) memos.set(db, (m = { runId, entries: new Map() }));
  if (m.entries.has(key)) return m.entries.get(key);
  const value = compute();
  if (m.entries.size >= MAX_ENTRIES) m.entries.delete(m.entries.keys().next().value);
  m.entries.set(key, value);
  return value;
}

module.exports = { memo };
