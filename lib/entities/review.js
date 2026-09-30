// Imports the human-reviewed entity files (data/review/*.csv). Each import
// replaces what the previous import of that file wrote, in one transaction,
// and fails loudly on any invalid row: nothing half-imports.
//
// company_ids.csv  id, company, successor, reason: the stable id ledger (ADR 0008). Ids come from
//               it; the import writes it back (companyIdRows), retiring removed ids with a redirect.
// aliases.csv   company, status, track, kind, alias, via_spv, note (other columns are context)
//               A row with an empty company is dropped. One company's rows must agree on
//               status and track. kind 'brand' rows (a brand the filing names, e.g. "dba
//               Chobani") go to company_brands and must cite an evidence accession.
// managers.csv  manager, kind (adviser | registrant), key (SEC file number | CIK)
// disclosed_exposure.csv  fund_key, report_date, company, basis, source_accession (empty company: skipped)
const ACCESSION = /^\d{10}-\d{2}-\d{6}$/;

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
    if (c && (c.status !== status || c.track !== track))
      fail(file, line, `"${name}" has conflicting status/track across rows`);
    if (!c) companies.set(name, { status, track, note: String(r.note || '').trim() || null });
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
function parseIdLedger(rows, file = 'company_ids.csv') {
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
    const name = String(r.company || '').trim();
    if (!name) fail(file, line, 'empty company');
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
  const insert = db.prepare('INSERT INTO companies (id, name, status, notes) VALUES (?, ?, ?, ?)');
  const update = db.prepare('UPDATE companies SET status = ?, notes = COALESCE(?, notes) WHERE id = ?');
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
      update.run(c.status, c.note, have);
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
    insert.run(id, name, c.status, c.note);
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

module.exports = { importAliases, importManagers, importDisclosedExposure, companyIdRows, COMPANY_ID_COLUMNS };
