// Streams tab-separated tables out of an SEC DERA dataset zip without
// unzipping to disk. The DERA TSVs are unquoted (fields never contain tabs or
// newlines), with a header row. Entries are opened by name in any order, so
// a caller can read a small table twice rather than hold a large one in memory.
const readline = require('readline');
const yauzl = require('yauzl');

function openZip(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: false }, (err, zip) => {
      if (err) return reject(err);
      const entries = new Map();
      zip.on('entry', entry => {
        entries.set(entry.fileName, entry);
        zip.readEntry();
      });
      zip.on('end', () => resolve({ zip, entries }));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

// Calls onRow(object) for every data row of `name`; resolves to the row count.
// required: columns the caller reads; a header without one of them fails the
// read before any row is used (staff review F12: a schema change must fail
// loudly, never load blanks). minRows: fewer data rows fail the read too.
async function readTable({ zip, entries }, name, onRow, { required = [], minRows = 0 } = {}) {
  const entry = entries.get(name);
  if (!entry) throw new Error(`${name} not found in zip`);
  const stream = await new Promise((resolve, reject) =>
    zip.openReadStream(entry, (err, s) => (err ? reject(err) : resolve(s)))
  );
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let header = null;
  let count = 0;
  for await (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!header) {
      header = line.split('\t');
      const missing = required.filter(c => !header.includes(c));
      if (missing.length) {
        stream.destroy();
        throw new Error(`${name}: missing column(s) ${missing.join(', ')}`);
      }
      continue;
    }
    if (!line) continue;
    const cells = line.split('\t');
    const row = {};
    for (let i = 0; i < header.length; i++) row[header[i]] = cells[i] ?? '';
    onRow(row);
    count++;
  }
  if (!header && required.length) throw new Error(`${name}: empty (no header row)`);
  if (count < minRows) throw new Error(`${name}: ${count} row(s), expected at least ${minRows}`);
  return count;
}

module.exports = { openZip, readTable };
