// Imports the human-reviewed entity files (data/review/*.csv). Each import
// replaces what the previous import of that file wrote, in one transaction,
// and fails loudly on any invalid row: nothing half-imports.
//
// company_ids.csv  id, company, successor, reason: the stable id ledger (ADR 0008). Ids come from
//               it; the import writes it back (companyIdRows), retiring removed ids with a redirect.
// aliases.csv   company, status, track, category, kind, alias, via_spv, note (other columns are
//               context). A row with an empty company is dropped. One company's rows must agree
//               on status, track and category (company | fund | clo | insurance; blank =
//               company, migration 0022). kind 'brand' rows (a brand the filing names, e.g. "dba
//               Chobani") go to company_brands and must cite an evidence accession.
// managers.csv  manager, kind (adviser | registrant), key (SEC file number | CIK)
// disclosed_exposure.csv  fund_key, report_date, company, basis, source_accession (empty company: skipped)
// taxonomy.json  sectors (each with its industries) and themes, with a version (ADR 0010)
// industries.csv  company_id, company, industry, themes (| separated), confidence, source, note:
//               one reviewed decision per private operating company; a blank industry with
//               confidence "unclear" means "not yet classified". Keyed by company id; the
//               name must match the id (group by identity, display by name).
const ACCESSION = /^\d{10}-\d{2}-\d{6}$/;
const CATEGORIES = ['company', 'fund', 'clo', 'insurance'];

function fail(file, line, msg) {
  throw new Error(`${file} line ${line}: ${msg}`);
}

function importAliases(db, rows, opts = {}) {
  const { file = 'aliases.csv', now = new Date().toISOString() } = opts;
  const companies = new Map();
  const aliases = [];
  const brands = [];
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
    const category = String(r.category || '').trim() || 'company';
    if (!CATEGORIES.includes(category))
      fail(file, line, `category must be one of ${CATEGORIES.join(', ')} (or blank), got "${r.category}"`);
    const kind = String(r.kind || '').trim();
    if (!['issuer_key', 'exact', 'regex', 'brand'].includes(kind)) fail(file, line, `unknown kind "${kind}"`);
    const pattern = String(r.alias || '').trim();
    if (!pattern) fail(file, line, 'empty alias');
    if (kind === 'brand' && !ACCESSION.test(String(r.evidence || '').trim()))
      fail(file, line, `brand "${pattern}" needs an evidence accession`);
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
    if (c && (c.status !== status || c.track !== track || c.category !== category))
      fail(file, line, `"${name}" has conflicting status/track/category across rows`);
    if (!c) companies.set(name, { status, track, category, note: String(r.note || '').trim() || null });
    else if (!c.note && r.note) c.note = String(r.note).trim();
    if (kind === 'brand') brands.push({ name, brand: pattern, accession: String(r.evidence).trim() });
    else aliases.push({ name, kind, pattern, viaSpv: Number(viaSpv), line });
  });
  const seen = new Map();
  for (const a of aliases) {
    const k = `${a.kind}\u0000${a.pattern}`;
    if (seen.has(k) && seen.get(k) !== a.name)
      fail(file, a.line, `alias "${a.pattern}" is claimed by "${seen.get(k)}" too`);
    seen.set(k, a.name);
  }

  const ledger = parseIdLedger(opts.ids);
  const source = `review:${file}`;
  db.transaction(() => {
    for (const r of ledger.retired) {
      db.prepare(
        `INSERT OR IGNORE INTO company_redirects (old_id, old_name, new_id, reason, retired_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(r.id, r.name, r.successor, r.reason, now);
    }
    renameInPlace(db, companies, aliases);
    const ownedBefore = db.prepare('SELECT company_id, kind, pattern FROM company_aliases').all();
    db.prepare('DELETE FROM company_aliases WHERE source = ?').run(source);
    const ids = assignIds(db, companies, ledger);
    const insert = db.prepare(
      'INSERT OR REPLACE INTO company_aliases (company_id, kind, pattern, via_spv, source) VALUES (?, ?, ?, ?, ?)'
    );
    for (const a of aliases) insert.run(ids.get(a.name), a.kind, a.pattern, a.viaSpv, source);
    db.prepare('DELETE FROM company_brands').run();
    const brand = db.prepare(
      'INSERT OR IGNORE INTO company_brands (company_id, brand, source_accession) VALUES (?, ?, ?)'
    );
    for (const b of brands) brand.run(ids.get(b.name), b.brand, b.accession);
    // A company renamed or removed in the file keeps nothing that points to it;
    // its id is retired with a redirect, never reused.
    retireRemoved(db, ownedBefore, now);
    db.prepare(
      `DELETE FROM companies WHERE id NOT IN (SELECT company_id FROM company_aliases)
         AND id NOT IN (SELECT company_id FROM spv_map)`
    ).run();
    const clash = db
      .prepare('SELECT r.old_id, c.name FROM company_redirects r JOIN companies c ON c.id = r.old_id')
      .get();
    if (clash) throw new Error(`company_ids.csv retires id ${clash.old_id}, but "${clash.name}" still uses it`);
    // Tracked companies keep the date they were first tracked.
    const trackedIds = [...companies].filter(([, c]) => c.track === 'Y').map(([name]) => ids.get(name));
    db.prepare(`DELETE FROM tracked_companies WHERE company_id NOT IN (${trackedIds.map(() => '?').join(',')})`).run(
      ...trackedIds
    );
    const track = db.prepare('INSERT OR IGNORE INTO tracked_companies (company_id, added_at, note) VALUES (?, ?, ?)');
    for (const id of trackedIds) track.run(id, now, source);
  })();
  return {
    companies: companies.size,
    aliases: aliases.length,
    brands: brands.length,
    tracked: [...companies.values()].filter(c => c.track === 'Y').length,
  };
}

// Company ids stay stable across renames, so links to a company (URLs,
// watchlists, MCP calls) survive curation: a name new to the file whose
// aliases all belonged to one company that is no longer in the file is that
// company renamed, and keeps its id.
function renameInPlace(db, companies, aliases) {
  const ownerOf = db.prepare('SELECT company_id FROM company_aliases WHERE kind = ? AND pattern = ?');
  const nameOf = db.prepare('SELECT name FROM companies WHERE id = ?');
  const exists = db.prepare('SELECT 1 FROM companies WHERE name = ?');
  const rename = db.prepare('UPDATE companies SET name = ? WHERE id = ?');
  const claimed = new Set();
  for (const name of companies.keys()) {
    if (exists.get(name)) continue;
    const owners = new Set(
      aliases
        .filter(a => a.name === name)
        .map(a => ownerOf.get(a.kind, a.pattern)?.company_id)
        .filter(id => id != null)
    );
    if (owners.size !== 1) continue;
    const [id] = owners;
    if (claimed.has(id) || companies.has(nameOf.get(id).name)) continue;
    rename.run(name, id);
    claimed.add(id);
  }
}

// company_ids.csv: id, company, successor, reason. A row with no reason is a
// live company; 'merged' (successor = the id that now owns its aliases) and
// 'dropped' rows are retired ids, kept so links still resolve and the id is
// never handed out again.
function parseIdLedger(rows, file = 'company_ids.csv', nameCol = 'company') {
  const byName = new Map();
  const retired = [];
  const seen = new Set();
  let maxId = 0;
  (rows || []).forEach((r, i) => {
    const line = i + 2;
    const id = Number(String(r.id ?? '').trim());
    if (!Number.isInteger(id) || id < 1) fail(file, line, `id must be a positive integer, got "${r.id}"`);
    if (seen.has(id)) fail(file, line, `id ${id} appears twice`);
    seen.add(id);
    maxId = Math.max(maxId, id);
    const name = String(r[nameCol] || '').trim();
    if (!name) fail(file, line, `empty ${nameCol}`);
    const reason = String(r.reason || '').trim();
    if (!reason) {
      if (byName.has(name)) fail(file, line, `"${name}" has two ids`);
      byName.set(name, id);
      return;
    }
    if (!['merged', 'dropped'].includes(reason)) fail(file, line, `reason must be merged or dropped, got "${reason}"`);
    const s = String(r.successor || '').trim();
    const successor = s ? Number(s) : null;
    if (reason === 'merged' && !Number.isInteger(successor)) fail(file, line, 'a merged id needs a successor id');
    retired.push({ id, name, successor: reason === 'merged' ? successor : null, reason });
  });
  return { byName, retired, maxId };
}

// Ids come from the ledger, else the warehouse (a rename kept it), else the
// next id never used before. A ledger that disagrees with the warehouse fails.
function assignIds(db, companies, ledger) {
  const idOf = db.prepare('SELECT id FROM companies WHERE name = ?');
  const nameOf = db.prepare('SELECT name FROM companies WHERE id = ?');
  const isRetired = db.prepare('SELECT 1 FROM company_redirects WHERE old_id = ?');
  const insert = db.prepare('INSERT INTO companies (id, name, status, category, notes) VALUES (?, ?, ?, ?, ?)');
  const update = db.prepare('UPDATE companies SET status = ?, category = ?, notes = COALESCE(?, notes) WHERE id = ?');
  let next = Math.max(
    ledger.maxId,
    db.prepare('SELECT COALESCE(MAX(id), 0) m FROM companies').get().m,
    db.prepare('SELECT COALESCE(MAX(old_id), 0) m FROM company_redirects').get().m
  );
  const ids = new Map();
  for (const [name, c] of companies) {
    const have = idOf.get(name)?.id;
    const want = ledger.byName.get(name);
    if (have != null) {
      if (want != null && want !== have)
        throw new Error(`company_ids.csv gives "${name}" id ${want}, but the warehouse has ${have}`);
      update.run(c.status, c.category, c.note, have);
      ids.set(name, have);
      continue;
    }
    let id = want;
    if (id != null) {
      const holder = nameOf.get(id)?.name;
      if (holder)
        throw new Error(`company_ids.csv gives id ${id} to "${name}", but the warehouse has it as "${holder}"`);
      if (isRetired.get(id)) throw new Error(`company_ids.csv gives "${name}" id ${id}, which is retired`);
    } else id = ++next;
    insert.run(id, name, c.status, c.category, c.note);
    ids.set(name, id);
  }
  return ids;
}

// Companies about to leave (no aliases, no SPV map) get a redirect: to the
// company that now owns most of their former aliases (lowest id on a tie), or
// none. Chains (A merged into B, B later into C) collapse to the live end.
function retireRemoved(db, ownedBefore, now) {
  const gone = db
    .prepare(
      `SELECT id, name FROM companies WHERE id NOT IN (SELECT company_id FROM company_aliases)
         AND id NOT IN (SELECT company_id FROM spv_map) ORDER BY id`
    )
    .all();
  const owner = db.prepare('SELECT company_id FROM company_aliases WHERE kind = ? AND pattern = ?');
  const put = db.prepare(
    `INSERT OR REPLACE INTO company_redirects (old_id, old_name, new_id, reason, retired_at) VALUES (?, ?, ?, ?, ?)`
  );
  for (const g of gone) {
    const votes = new Map();
    for (const a of ownedBefore) {
      if (a.company_id !== g.id) continue;
      const o = owner.get(a.kind, a.pattern)?.company_id;
      if (o != null && o !== g.id) votes.set(o, (votes.get(o) || 0) + 1);
    }
    const [successor] = [...votes].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0] || [null];
    put.run(g.id, g.name, successor, successor == null ? 'dropped' : 'merged', now);
  }
  const redirects = new Map(
    db
      .prepare('SELECT old_id, new_id FROM company_redirects')
      .all()
      .map(r => [r.old_id, r.new_id])
  );
  const follow = db.prepare('UPDATE company_redirects SET new_id = ?, reason = ? WHERE old_id = ?');
  for (const [oldId, newId] of redirects) {
    let end = newId;
    for (let hops = 0; end != null && redirects.has(end) && hops < redirects.size; hops++) end = redirects.get(end);
    if (end !== newId) follow.run(end, end == null ? 'dropped' : 'merged', oldId);
  }
}

// The id ledger to write back to data/review/company_ids.csv after an import.
const COMPANY_ID_COLUMNS = ['id', 'company', 'successor', 'reason'];
function companyIdRows(db) {
  const live = db
    .prepare('SELECT id, name FROM companies')
    .all()
    .map(r => ({ id: r.id, company: r.name, successor: '', reason: '' }));
  const retired = db
    .prepare('SELECT old_id, old_name, new_id, reason FROM company_redirects')
    .all()
    .map(r => ({ id: r.old_id, company: r.old_name, successor: r.new_id ?? '', reason: r.reason }));
  return [...live, ...retired].sort((a, b) => a.id - b.id);
}

// Firms (managers.csv: manager, kind, key). Firm ids are permanent like
// company ids (staff review F08): data/review/manager_ids.csv (id, manager,
// successor, reason) is the ledger; the import writes it back (managerIdRows).
// A firm keeps its id while its name is in managers.csv; a renamed firm keeps
// it too when the new name has exactly the old name's adviser and registrant
// keys. A firm that leaves is retired (manager_redirects): 'merged' into the
// firm that now holds most of its keys, else 'dropped'. An id is never reused.
function importManagers(db, rows, { file = 'managers.csv', ids = null } = {}) {
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
    links.push({ manager, kind, key: kind === 'registrant' ? key.replace(/^0+/, '') : key });
  });
  const ledger = parseIdLedger(ids, 'manager_ids.csv', 'manager');
  const keyOf = l => `${l.kind}:${l.key}`;
  const keysByName = new Map();
  for (const l of links)
    (keysByName.get(l.manager) || keysByName.set(l.manager, new Set()).get(l.manager)).add(keyOf(l));
  const sameKeys = (a, b) => a.size === b.size && [...a].every(k => b.has(k));
  db.transaction(() => {
    const putRedirect = db.prepare(
      'INSERT OR REPLACE INTO manager_redirects (old_id, old_name, new_id, reason) VALUES (?, ?, ?, ?)'
    );
    const isRetired = db.prepare('SELECT 1 FROM manager_redirects WHERE old_id = ?');
    for (const r of ledger.retired) if (!isRetired.get(r.id)) putRedirect.run(r.id, r.name, r.successor, r.reason);
    // what each current firm owned before this import
    const before = db.prepare('SELECT id, name FROM managers').all();
    const ownedBefore = new Map(before.map(m => [m.id, new Set()]));
    for (const a of db.prepare('SELECT manager_id, file_num FROM manager_advisers').all())
      ownedBefore.get(a.manager_id)?.add(`adviser:${a.file_num}`);
    for (const a of db.prepare('SELECT manager_id, cik FROM manager_registrants').all())
      ownedBefore.get(a.manager_id)?.add(`registrant:${a.cik}`);
    db.prepare('DELETE FROM manager_advisers').run();
    db.prepare('DELETE FROM manager_registrants').run();

    const idOf = db.prepare('SELECT id FROM managers WHERE name = ?');
    const nameOf = db.prepare('SELECT name FROM managers WHERE id = ?');
    let next = Math.max(
      ledger.maxId,
      db.prepare('SELECT COALESCE(MAX(id), 0) m FROM managers').get().m,
      db.prepare('SELECT COALESCE(MAX(old_id), 0) m FROM manager_redirects').get().m
    );
    const names = new Set(links.map(l => l.manager));
    const idByName = new Map();
    for (const name of names) {
      const have = idOf.get(name)?.id;
      const want = ledger.byName.get(name);
      if (have != null) {
        if (want != null && want !== have)
          throw new Error(`manager_ids.csv gives "${name}" id ${want}, but the warehouse has ${have}`);
        idByName.set(name, have);
        continue;
      }
      if (want != null) {
        const holder = nameOf.get(want)?.name;
        if (holder && names.has(holder))
          throw new Error(`manager_ids.csv gives id ${want} to "${name}", but the warehouse has it as "${holder}"`);
        if (isRetired.get(want)) throw new Error(`manager_ids.csv gives "${name}" id ${want}, which is retired`);
        if (holder) db.prepare('UPDATE managers SET name = ? WHERE id = ?').run(name, want);
        else db.prepare('INSERT INTO managers (id, name) VALUES (?, ?)').run(want, name);
        idByName.set(name, want);
        continue;
      }
      // a rename: a firm leaving under its old name with exactly these keys
      const renamed = before.filter(m => !names.has(m.name) && sameKeys(ownedBefore.get(m.id), keysByName.get(name)));
      if (renamed.length === 1) {
        db.prepare('UPDATE managers SET name = ? WHERE id = ?').run(name, renamed[0].id);
        idByName.set(name, renamed[0].id);
        continue;
      }
      const id = ++next;
      db.prepare('INSERT INTO managers (id, name) VALUES (?, ?)').run(id, name);
      idByName.set(name, id);
    }
    const adv = db.prepare('INSERT OR REPLACE INTO manager_advisers (manager_id, file_num) VALUES (?, ?)');
    const reg = db.prepare('INSERT OR REPLACE INTO manager_registrants (manager_id, cik) VALUES (?, ?)');
    for (const l of links) (l.kind === 'adviser' ? adv : reg).run(idByName.get(l.manager), l.key);

    // firms that left: retired with a successor (most of their keys) or dropped
    const ownerOf = new Map(links.map(l => [keyOf(l), idByName.get(l.manager)]));
    const live = new Set(idByName.values());
    for (const m of db.prepare('SELECT id, name FROM managers').all()) {
      if (live.has(m.id)) continue;
      const votes = new Map();
      for (const k of ownedBefore.get(m.id) || []) {
        const o = ownerOf.get(k);
        if (o != null) votes.set(o, (votes.get(o) || 0) + 1);
      }
      const [successor] = [...votes].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0] || [null];
      putRedirect.run(m.id, m.name, successor, successor == null ? 'dropped' : 'merged');
      db.prepare('DELETE FROM managers WHERE id = ?').run(m.id);
    }
    // a ledger firm the warehouse never had and managers.csv no longer names
    for (const [name, id] of ledger.byName)
      if (!names.has(name) && !nameOf.get(id) && !isRetired.get(id)) putRedirect.run(id, name, null, 'dropped');
    // chains (A merged into B, B later into C) end at the live firm
    const redirects = new Map(
      db
        .prepare('SELECT old_id, new_id FROM manager_redirects')
        .all()
        .map(r => [r.old_id, r.new_id])
    );
    const follow = db.prepare('UPDATE manager_redirects SET new_id = ?, reason = ? WHERE old_id = ?');
    for (const [oldId, newId] of redirects) {
      let end = newId;
      for (let hops = 0; end != null && redirects.has(end) && hops < redirects.size; hops++) end = redirects.get(end);
      if (end !== newId) follow.run(end, end == null ? 'dropped' : 'merged', oldId);
    }
    const clash = db
      .prepare('SELECT r.old_id, m.name FROM manager_redirects r JOIN managers m ON m.id = r.old_id')
      .get();
    if (clash) throw new Error(`manager_ids.csv retires id ${clash.old_id}, but "${clash.name}" still uses it`);
  })();
  return { links: links.length, managers: keysByName.size };
}

// The firm id ledger to write back to data/review/manager_ids.csv after an import.
const MANAGER_ID_COLUMNS = ['id', 'manager', 'successor', 'reason'];
function managerIdRows(db) {
  const live = db
    .prepare('SELECT id, name FROM managers')
    .all()
    .map(r => ({ id: r.id, manager: r.name, successor: '', reason: '' }));
  const retired = db
    .prepare('SELECT old_id, old_name, new_id, reason FROM manager_redirects')
    .all()
    .map(r => ({ id: r.old_id, manager: r.old_name, successor: r.new_id ?? '', reason: r.reason }));
  return [...live, ...retired].sort((a, b) => a.id - b.id);
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

// The taxonomy (data/review/taxonomy.json): codes are stable, names are labels.
function importTaxonomy(db, taxonomy, { file = 'taxonomy.json' } = {}) {
  const bad = msg => {
    throw new Error(`${file}: ${msg}`);
  };
  if (!taxonomy || typeof taxonomy.version !== 'string' || !taxonomy.version) bad('needs a version');
  if (!Array.isArray(taxonomy.sectors) || !taxonomy.sectors.length) bad('needs sectors');
  if (!Array.isArray(taxonomy.themes)) bad('needs themes');
  const seen = new Set();
  const code = (c, where) => {
    if (typeof c !== 'string' || !/^[a-z][a-z0-9_.]*$/.test(c)) bad(`bad code "${c}" in ${where}`);
    if (seen.has(c)) bad(`code "${c}" appears twice`);
    seen.add(c);
    return c;
  };
  db.transaction(() => {
    for (const t of [
      'company_themes',
      'company_industry',
      'taxonomy_themes',
      'taxonomy_industries',
      'taxonomy_sectors',
      'taxonomy_meta',
    ])
      db.prepare(`DELETE FROM ${t}`).run();
    const sector = db.prepare('INSERT INTO taxonomy_sectors (code, name, position) VALUES (?, ?, ?)');
    const industry = db.prepare(
      'INSERT INTO taxonomy_industries (code, sector, name, definition, position) VALUES (?, ?, ?, ?, ?)'
    );
    const theme = db.prepare('INSERT INTO taxonomy_themes (code, name, definition, position) VALUES (?, ?, ?, ?)');
    let n = 0;
    taxonomy.sectors.forEach((s, i) => {
      sector.run(code(s.code, 'sectors'), String(s.name || bad(`sector ${s.code} has no name`)), i);
      if (!Array.isArray(s.industries) || !s.industries.length) bad(`sector ${s.code} has no industries`);
      s.industries.forEach((ind, j) => {
        if (!String(ind.code).startsWith(`${s.code}.`)) bad(`industry ${ind.code} is not under sector ${s.code}`);
        industry.run(code(ind.code, s.code), s.code, String(ind.name || ''), String(ind.def || ''), j);
        n++;
      });
    });
    taxonomy.themes.forEach((t, i) => theme.run(code(t.code, 'themes'), String(t.name || ''), String(t.def || ''), i));
    db.prepare('INSERT INTO taxonomy_meta (version) VALUES (?)').run(taxonomy.version);
    if (!n) bad('no industries');
  })();
  return { version: taxonomy.version, sectors: taxonomy.sectors.length, themes: taxonomy.themes.length };
}

const INDUSTRY_COLUMNS = ['company_id', 'company', 'industry', 'themes', 'confidence', 'source', 'note'];
const CONFIDENCE = ['high', 'medium', 'low', 'unclear'];

// One reviewed industry decision per company (data/review/industries.csv). Runs
// after importAliases and importTaxonomy, so ids and codes are the ones just written.
function importIndustries(db, rows, { file = 'industries.csv' } = {}) {
  const industries = new Set(
    db
      .prepare('SELECT code FROM taxonomy_industries')
      .all()
      .map(r => r.code)
  );
  const themes = new Set(
    db
      .prepare('SELECT code FROM taxonomy_themes')
      .all()
      .map(r => r.code)
  );
  if (!industries.size) throw new Error(`${file}: import taxonomy.json first`);
  const company = db.prepare('SELECT id, name, status, category FROM companies WHERE id = ?');
  const out = [];
  const seen = new Set();
  rows.forEach((r, i) => {
    const line = i + 2;
    const id = Number(r.company_id);
    if (!Number.isInteger(id) || id <= 0) fail(file, line, `bad company_id "${r.company_id}"`);
    if (seen.has(id)) fail(file, line, `company ${id} appears twice`);
    seen.add(id);
    const c = company.get(id);
    if (!c) fail(file, line, `company ${id} ("${r.company}") is not in the reviewed list`);
    if (c.name !== String(r.company || '').trim())
      fail(file, line, `company ${id} is "${c.name}", the file says "${r.company}"`);
    if (c.category !== 'company')
      fail(file, line, `"${c.name}" is category ${c.category}: industries are for operating companies`);
    const confidence = String(r.confidence || '').trim();
    if (!CONFIDENCE.includes(confidence))
      fail(file, line, `confidence must be one of ${CONFIDENCE.join(', ')}, got "${r.confidence}"`);
    const industry = String(r.industry || '').trim() || null;
    if (industry && !industries.has(industry)) fail(file, line, `unknown industry "${industry}"`);
    if (!industry !== (confidence === 'unclear'))
      fail(file, line, 'a blank industry goes with confidence "unclear", and only then');
    const ts = String(r.themes || '')
      .split('|')
      .map(t => t.trim())
      .filter(Boolean);
    for (const t of ts) if (!themes.has(t)) fail(file, line, `unknown theme "${t}"`);
    if (new Set(ts).size !== ts.length) fail(file, line, 'a theme appears twice');
    const source = String(r.source || '').trim();
    if (!source) fail(file, line, 'empty source');
    out.push({ id, industry, confidence, source, note: String(r.note || '').trim() || null, themes: ts });
  });
  db.transaction(() => {
    db.prepare('DELETE FROM company_themes').run();
    db.prepare('DELETE FROM company_industry').run();
    const ins = db.prepare(
      'INSERT INTO company_industry (company_id, industry, confidence, source, note) VALUES (?, ?, ?, ?, ?)'
    );
    const th = db.prepare('INSERT INTO company_themes (company_id, theme) VALUES (?, ?)');
    for (const r of out) {
      ins.run(r.id, r.industry, r.confidence, r.source, r.note);
      for (const t of r.themes) th.run(r.id, t);
    }
  })();
  return {
    companies: out.length,
    classified: out.filter(r => r.industry).length,
    themes: out.reduce((n, r) => n + r.themes.length, 0),
  };
}

module.exports = {
  importTaxonomy,
  importIndustries,
  INDUSTRY_COLUMNS,
  importAliases,
  importManagers,
  importDisclosedExposure,
  companyIdRows,
  COMPANY_ID_COLUMNS,
  managerIdRows,
  MANAGER_ID_COLUMNS,
};
