// The one place a warehouse job learns the reviewed curation decisions
// (data/review/curation.json: status, merge, spv, drop, separate, ...) that the
// identity rebuild reads (staff review R18; Codex verification V02). The other
// reviewed files are imported into tables, so the data carries them; this one
// is read at rebuild time, so it must come from the same bundle the generation
// records:
//   - a curation job: its staged copy (what curation_snapshot will store);
//   - any other job: the generation's own curation_snapshot, so a refresh never
//     picks up uncommitted edits to data/review (only a curation job imports them);
//   - a warehouse with no snapshot yet (before migration 0021): the files on
//     disk, said so in the log.
// test/invariants.test.js keeps every other module from reading curation.json.
const path = require('path');
const { loadCuration } = require('../entities/seed');

function snapshotCuration(db) {
  let rows;
  try {
    rows = db.prepare('SELECT name, content FROM curation_snapshot').all();
  } catch {
    return null; // before migration 0021
  }
  if (!rows.length) return null;
  const file = rows.find(r => r.name === 'curation.json');
  return file ? JSON.parse(Buffer.from(file.content).toString('utf8')) : {};
}

// { curation, source: 'staged' | 'snapshot' | 'disk' }
function curationFor(db, { stage = null, log = () => {} } = {}) {
  if (stage) return { curation: loadCuration(path.join(stage, 'curation.json')), source: 'staged' };
  const snap = snapshotCuration(db);
  if (snap) return { curation: snap, source: 'snapshot' };
  log('curation: no snapshot in this generation yet; reading data/review/curation.json from disk');
  return { curation: loadCuration(), source: 'disk' };
}

module.exports = { curationFor };
