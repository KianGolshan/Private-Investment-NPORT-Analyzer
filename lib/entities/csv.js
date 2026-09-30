// Minimal RFC 4180 CSV for the human-reviewed entity files in data/review/.
function toCsv(columns, rows) {
  const cell = v => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(','), ...rows.map(r => columns.map(c => cell(r[c])).join(','))].join('\n') + '\n';
}

function parseCsv(text) {
  const records = [];
  let row = [];
  let field = '';
  let quoted = false;
  const s = String(text).replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      records.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (quoted) throw new Error('CSV: unterminated quoted field');
  if (field !== '' || row.length) {
    row.push(field);
    records.push(row);
  }
  const [header, ...body] = records.filter(r => r.some(c => c.trim() !== ''));
  if (!header) return [];
  return body.map((r, n) => {
    if (r.length !== header.length)
      throw new Error(`CSV line ${n + 2}: ${r.length} fields, header has ${header.length}`);
    return Object.fromEntries(header.map((h, i) => [h.trim(), r[i]]));
  });
}

module.exports = { toCsv, parseCsv };
