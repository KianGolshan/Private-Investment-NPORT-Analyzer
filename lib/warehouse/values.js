// Field cleaning shared by both ingest paths (bulk TSV and EDGAR XML), so a
// value is stored the same way whichever path loaded it.

// Placeholder text ("N/A", "", "NONE") -> null.
function text(value) {
  if (value === null || value === undefined || typeof value === 'object') return null;
  const t = String(value).trim();
  return !t || /^(N\/?A|NONE|NULL|NIL|-+)$/i.test(t) ? null : t;
}

// A finite number, else null ("", "N/A", missing).
function num(value) {
  if (value === null || value === undefined || typeof value === 'object') return null;
  const t = String(value).trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

module.exports = { text, num };
