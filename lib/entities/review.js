// Imports the human-reviewed entity files (data/review/*.csv). Each import
// replaces what the previous import of that file wrote, in one transaction,
// and fails loudly on any invalid row: nothing half-imports.
//
// aliases.csv   company, status, track, kind, alias, via_spv, note (other columns are context)
//               A row with an empty company is dropped. One company's rows must agree on
//               status and track.
// managers.csv  manager, kind (adviser | registrant), key (SEC file number | CIK)
// disclosed_exposure.csv  fund_key, report_date, company, basis, source_accession (empty company: skipped)
const ACCESSION = /^\d{10}-\d{2}-\d{6}$/;

function fail(file, line, msg) {
  throw new Error(`${file} line ${line}: ${msg}`);
}

function importAliases(db, rows, { file = 'aliases.csv', now = new Date().toISOString() } = {}) {
  const companies = new Map();
  const aliases = [];
  rows.forEach((r, i) => {
    const line = i + 2;
    const name = String(r.company || '').trim();
    if (!name) return;
    const status = String(r.status || '').trim();
    if (!['private', 'public'].includes(status)) fail(file, line, `status must be private or public, got "${status}"`);
    const track = String(r.track || 'N')
      .trim()
      .toUpperCase();
    if (!['Y', 'N'].includes(track)) fail(file, line, `track must be Y or N, got "${r.track}"`);
    const kind = String(r.kind || '').trim();
    if (!['issuer_key', 'exact', 'regex'].includes(kind)) fail(file, line, `unknown kind "${kind}"`);
    const pattern = String(r.alias || '').trim();
    if (!pattern) fail(file, line, 'empty alias');
    if (kind === 'regex') {
      try {
        new RegExp(pattern, 'i');
      } catch (err) {
        fail(file, line, `bad regex: ${err.message}`);
      }
    }
    const viaSpv = String(r.via_spv || '0').trim();
    if (!['0', '1'].includes(viaSpv)) fail(file, line, `via_spv must be 0 or 1, got "${viaSpv}"`);
    const c = companies.get(name);
    if (c && (c.status !== status || c.track !== track))
      fail(file, line, `"${name}" has conflicting status/track across rows`);
    if (!c) companies.set(name, { status, track, note: String(r.note || '').trim() || null });
    else if (!c.note && r.note) c.note = String(r.note).trim();
    aliases.push({ name, kind, pattern, viaSpv: Number(viaSpv), line });
  });
  const seen = new Map();
  for (const a of aliases) {
    const k = `${a.kind}\u0000${a.pattern}`;
    if (seen.has(k) && seen.get(k) !== a.name)
      fail(file, a.line, `alias "${a.pattern}" is claimed by "${seen.get(k)}" too`);
    seen.set(k, a.name);
  }

  const source = `review:${file}`;
  db.transaction(() => {
    db.prepare('DELETE FROM company_aliases WHERE source = ?').run(source);
    const upsert = db.prepare(
      `INSERT INTO companies (name, status, notes) VALUES (?, ?, ?)
       ON CONFLICT (name) DO UPDATE SET status = excluded.status, notes = COALESCE(excluded.notes, notes)`
    );
    const idOf = db.prepare('SELECT id FROM companies WHERE name = ?');
    const ids = new Map();
    for (const [name, c] of companies) {
      upsert.run(name, c.status, c.note);
      ids.set(name, idOf.get(name).id);
    }
    const insert = db.prepare(
      'INSERT OR REPLACE INTO company_aliases (company_id, kind, pattern, via_spv, source) VALUES (?, ?, ?, ?, ?)'
    );
    for (const a of aliases) insert.run(ids.get(a.name), a.kind, a.pattern, a.viaSpv, source);
    // A company renamed or removed in the file keeps nothing that points to it.
    db.prepare(
      `DELETE FROM companies WHERE id NOT IN (SELECT company_id FROM company_aliases)
         AND id NOT IN (SELECT company_id FROM spv_map)`
    ).run();
    db.prepare('DELETE FROM tracked_companies').run();
    const track = db.prepare('INSERT INTO tracked_companies (company_id, added_at, note) VALUES (?, ?, ?)');
    for (const [name, c] of companies) if (c.track === 'Y') track.run(ids.get(name), now, source);
  })();
  return {
    companies: companies.size,
    aliases: aliases.length,
    tracked: [...companies.values()].filter(c => c.track === 'Y').length,
  };
}

function importManagers(db, rows, { file = 'managers.csv' } = {}) {
  const links = [];
  rows.forEach((r, i) => {
    const line = i + 2;
    const manager = String(r.manager || '').trim();
    if (!manager) return;
    const kind = String(r.kind || '').trim();
    if (!['adviser', 'registrant'].includes(kind))
      fail(file, line, `kind must be adviser or registrant, got "${kind}"`);
    const key = String(r.key || '').trim();
    if (!key) fail(file, line, 'empty key');
    if (kind === 'registrant' && !/^\d+$/.test(key)) fail(file, line, `registrant key must be a CIK, got "${key}"`);
    links.push({ manager, kind, key });
  });
  db.transaction(() => {
    db.prepare('DELETE FROM manager_advisers').run();
    db.prepare('DELETE FROM manager_registrants').run();
    const upsert = db.prepare('INSERT INTO managers (name) VALUES (?) ON CONFLICT (name) DO NOTHING');
    const idOf = db.prepare('SELECT id FROM managers WHERE name = ?');
    const adv = db.prepare('INSERT OR REPLACE INTO manager_advisers (manager_id, file_num) VALUES (?, ?)');
    const reg = db.prepare('INSERT OR REPLACE INTO manager_registrants (manager_id, cik) VALUES (?, ?)');
    for (const l of links) {
      upsert.run(l.manager);
      const id = idOf.get(l.manager).id;
      if (l.kind === 'adviser') adv.run(id, l.key);
      else reg.run(id, l.key.replace(/^0+/, ''));
    }
    db.prepare(
      `DELETE FROM managers WHERE id NOT IN (SELECT manager_id FROM manager_advisers)
         AND id NOT IN (SELECT manager_id FROM manager_registrants)`
    ).run();
  })();
  return { links: links.length, managers: new Set(links.map(l => l.manager)).size };
}

function importDisclosedExposure(db, rows, { file = 'disclosed_exposure.csv' } = {}) {
  const idOf = db.prepare('SELECT id FROM companies WHERE name = ?');
  const out = [];
  rows.forEach((r, i) => {
    const line = i + 2;
    if (!String(r.company || '').trim()) return; // no company yet (not in aliases.csv)
    const company = idOf.get(String(r.company || '').trim());
    if (!company) fail(file, line, `unknown company "${r.company}" (import aliases.csv first)`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.report_date || '')) fail(file, line, `bad report_date "${r.report_date}"`);
    if (!ACCESSION.test(r.source_accession || '')) fail(file, line, `bad source_accession "${r.source_accession}"`);
    if (!String(r.basis || '').trim()) fail(file, line, 'empty basis');
    if (!String(r.fund_key || '').trim()) fail(file, line, 'empty fund_key');
    out.push([r.fund_key.trim(), r.report_date, company.id, r.basis.trim(), r.source_accession]);
  });
  db.transaction(() => {
    db.prepare('DELETE FROM disclosed_exposure').run();
    const ins = db.prepare(
      'INSERT INTO disclosed_exposure (fund_key, report_date, company_id, basis, source_accession) VALUES (?, ?, ?, ?, ?)'
    );
    for (const r of out) ins.run(...r);
  })();
  return { rows: out.length };
}

module.exports = { importAliases, importManagers, importDisclosedExposure };
