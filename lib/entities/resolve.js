// Sets holdings.company_id / via_spv from the alias tables. Runs over every
// row after each ingest and each alias import (idempotent). Precedence:
//   1. spv_map      (fund_key + the vehicle row's name) -> via_spv = 1
//   2. exact alias  (upper-cased issuer name, else title)
//   3. regex alias  (over issuer name and title)
//   4. issuer_key   (parsers.issuerKeyOf, the seed clusters)
const { issuerKeyOf } = require('../../parsers');
const { rawName } = require('./seed');

function loadAliases(db) {
  const byKey = new Map();
  const byExact = new Map();
  const regexes = [];
  for (const a of db.prepare('SELECT company_id, kind, pattern, via_spv FROM company_aliases').all()) {
    const v = { companyId: a.company_id, viaSpv: a.via_spv ? 1 : 0 };
    if (a.kind === 'issuer_key') byKey.set(a.pattern, v);
    else if (a.kind === 'exact') byExact.set(a.pattern.toUpperCase().replace(/\s+/g, ' ').trim(), v);
    else regexes.push({ re: new RegExp(a.pattern, 'i'), ...v });
  }
  const spv = new Map();
  for (const s of db.prepare('SELECT fund_key, holding_match, company_id FROM spv_map').all()) {
    spv.set(`${s.fund_key}\u0000${s.holding_match.toUpperCase().replace(/\s+/g, ' ').trim()}`, {
      companyId: s.company_id,
      viaSpv: 1,
    });
  }
  return { byKey, byExact, regexes, spv };
}

function resolveRow(row, a) {
  const raw = rawName(row);
  return (
    a.spv.get(`${row.fund_key}\u0000${raw}`) ||
    a.byExact.get(raw) ||
    a.regexes.find(r => (row.issuer_name && r.re.test(row.issuer_name)) || (row.title && r.re.test(row.title))) ||
    a.byKey.get(issuerKeyOf({ issuer: row.issuer_name, title: row.title })) ||
    null
  );
}

function resolveCompanies(db) {
  const aliases = loadAliases(db);
  const rows = db
    .prepare(
      `SELECT h.accession, h.row_key, h.issuer_name, h.title, h.company_id, h.via_spv, f.fund_key
       FROM holdings h JOIN filings f ON f.accession = h.accession`
    )
    .all();
  const set = db.prepare('UPDATE holdings SET company_id = ?, via_spv = ? WHERE accession = ? AND row_key = ?');
  let resolved = 0;
  let changed = 0;
  db.transaction(() => {
    for (const r of rows) {
      const m = resolveRow(r, aliases);
      const companyId = m ? m.companyId : null;
      const viaSpv = m ? m.viaSpv : 0;
      if (m) resolved++;
      if (r.company_id !== companyId || r.via_spv !== viaSpv) {
        set.run(companyId, viaSpv, r.accession, r.row_key);
        changed++;
      }
    }
  })();
  return { rows: rows.length, resolved, changed };
}

module.exports = { resolveCompanies, resolveRow, loadAliases };
