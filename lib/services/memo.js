// Answers that read the whole warehouse (top companies, firm books) are kept
// per database handle and generation. A published generation never changes
// (lib/warehouse/job.js writes a new file and readers open it), so the key is
// exact there; on a pre-generation or test warehouse it is the latest run.
//
// Bounded by count and by bytes (review R17): the per-date and per-firm answers
// a crawler can multiply are measured once, as JSON, when computed, and the
// oldest go first past VANTAGE_MEMO_MAX_MB (256). The whole-warehouse tables
// every answer reads (PINNED) are kept and not measured: there is one of each,
// and serializing them would cost more than the bound saves.
const { generationOf } = require('../warehouse/db');

const memos = new WeakMap();
const MAX_ENTRIES = 200;
const PINNED = new Set(['facts:all', 'facts:marksByDate', 'fundFirms', 'filings:empty']);
const maxBytes = () => (Number(process.env.VANTAGE_MEMO_MAX_MB) || 256) * 1024 * 1024;

// JSON length as the size estimate (UTF-16 in memory is about twice that, the
// same for every entry, so the order of eviction is right). Unserializable: 0.
function sizeOf(value) {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function memo(db, key, compute) {
  const runId = generationOf(db);
  let m = memos.get(db);
  if (!m || m.runId !== runId) memos.set(db, (m = { runId, entries: new Map(), sizes: new Map(), bytes: 0 }));
  if (m.entries.has(key)) return m.entries.get(key);
  const value = compute();
  const size = PINNED.has(key) ? 0 : sizeOf(value);
  const limit = maxBytes();
  // an answer larger than the whole budget is returned, not kept (and evicts nothing)
  if (size > limit) return value;
  for (const old of m.entries.keys()) {
    if (m.entries.size < MAX_ENTRIES && m.bytes + size <= limit) break;
    if (PINNED.has(old)) continue;
    m.bytes -= m.sizes.get(old) ?? 0;
    m.entries.delete(old);
    m.sizes.delete(old);
  }
  m.entries.set(key, value);
  m.sizes.set(key, size);
  m.bytes += size;
  return value;
}

// Test and bench hook: { entries, bytes } kept for a handle.
function memoStats(db) {
  const m = memos.get(db);
  return { entries: m?.entries.size ?? 0, bytes: m?.bytes ?? 0 };
}

module.exports = { memo, memoStats, PINNED };
