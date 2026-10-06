// Answers that read the whole warehouse (top companies, firm books) are kept
// per database handle and generation. A published generation never changes
// (lib/warehouse/job.js writes a new file and readers open it), so the key is
// exact there; on a pre-generation or test warehouse it is the latest run.
const { generationOf } = require('../warehouse/db');

const memos = new WeakMap();
const MAX_ENTRIES = 200;

function memo(db, key, compute) {
  const runId = generationOf(db);
  let m = memos.get(db);
  if (!m || m.runId !== runId) memos.set(db, (m = { runId, entries: new Map() }));
  if (m.entries.has(key)) return m.entries.get(key);
  const value = compute();
  if (m.entries.size >= MAX_ENTRIES) m.entries.delete(m.entries.keys().next().value);
  m.entries.set(key, value);
  return value;
}

module.exports = { memo };
