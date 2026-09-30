// Every issuer is findable and answerable (ADR 0008, ROADMAP §5a tasks 3-4).
//
// rebuildEntities(db, up) runs after every refresh and review import, with the
// identity upkeep (report.identityUpkeep) of that run:
//   1. unreviewed_entities: one per identity component (else issuer key) that
//      holds rows no company claims, with the review queue's category and its
//      evidence (funds, dates, names). Ids are kept by key and never deleted.
//   2. holdings.entity_id on every unresolved row, in every filing (knownAsOf
//      answers read superseded filings too); cleared on resolved rows.
//   3. company_stats: each company's current funds and value (the same rule)
//      and its first and last mark dates, as search evidence.
//   4. search_names: companies (name, issuer_key and exact aliases, brands) and
//      active unreviewed entities, each with its spelling variants.
const { componentCategory, currentRows } = require('./report');
const { nameVariants } = require('./identity');
const { keyOf } = require('./names');

const TOP_NAMES = 4;

// Spelling variants of a name for the search index and the query: the
// identity graph's variants (abbreviations, spacing, legal suffixes), plus the
// plain alphanumeric form so short names still match.
function searchVariants(text) {
  const up = String(text || '')
    .toUpperCase()
    .trim();
  const plain = up.replace(/[^A-Z0-9]+/g, '');
  const out = new Set(plain ? [plain] : []);
  if (up) for (const v of nameVariants(up)) out.add(v);
  return [...out];
}

function unresolvedRows(db) {
  return db
    .prepare(
      `SELECT h.accession, h.row_key, h.issuer_name, h.title, h.value_usd, h.fv_level, h.instrument_type,
         h.entity_id, f.fund_key, f.report_date
       FROM holdings h JOIN filings f ON f.accession = h.accession
       WHERE h.company_id IS NULL
       ORDER BY h.accession, h.row_key`
    )
    .all();
}

function rebuildEntities(db, up, { now = new Date().toISOString() } = {}) {
  const componentOf = key => up.link.componentOf.get(key) || key;
  const keysOf = root => up.link.components.get(root)?.keys || [root];

  // All-history evidence per component, over the unresolved rows.
  const rows = unresolvedRows(db);
  const comps = new Map();
  for (const r of rows) {
    r.key = keyOf(r);
    if (!r.key) continue;
    r.root = componentOf(r.key);
    let c = comps.get(r.root);
    if (!c) {
      c = { funds: new Set(), first: null, last: null, value: 0, l3: 0, raw: new Map() };
      comps.set(r.root, c);
    }
    c.funds.add(r.fund_key);
    if (!c.first || r.report_date < c.first) c.first = r.report_date;
    if (!c.last || r.report_date > c.last) c.last = r.report_date;
    if (r.value_usd > 0 && r.instrument_type !== 'debt') {
      c.value += r.value_usd;
      if (r.fv_level === '3') c.l3 += r.value_usd;
      const raw = (r.issuer_name || r.title || '').trim();
      if (raw) c.raw.set(raw, (c.raw.get(raw) || 0) + r.value_usd);
    }
  }
  // Current exposure: each active fund's latest canonical filing (the report's rule).
  const { asOf, rows: nowRows } = currentRows(up.rows, up.latest);
  const current = new Map();
  const companyNow = new Map();
  for (const r of nowRows) {
    if (r.company_id) {
      const c = companyNow.get(r.company_id) || { value: 0, funds: new Set() };
      c.value += r.value_usd;
      c.funds.add(r.fund_key);
      companyNow.set(r.company_id, c);
      continue;
    }
    const root = componentOf(r.key);
    const c = current.get(root) || { value: 0, l3: 0, funds: new Set(), raw: new Map() };
    c.value += r.value_usd;
    if (r.fv_level === '3') c.l3 += r.value_usd;
    const raw = (r.issuer_name || r.title || '').trim();
    c.raw.set(raw, (c.raw.get(raw) || 0) + r.value_usd);
    c.funds.add(r.fund_key);
    current.set(root, c);
  }

  const ctx = {
    graph: up.graph,
    listing: up.listing,
    companiesOfKey: up.companiesOfKey,
    companies: up.companies,
    knownStatus: up.knownStatus,
  };
  const ids = new Map();
  db.transaction(() => {
    db.prepare('UPDATE unreviewed_entities SET active = 0').run();
    const upsert = db.prepare(
      `INSERT INTO unreviewed_entities (key, display_name, category, keys, names, linked_company_ids, funds_ever,
         first_mark_date, last_mark_date, current_funds, current_value_usd, level3_share, active)
       VALUES (@key, @display_name, @category, @keys, @names, @linked, @funds_ever, @first, @last, @current_funds,
         @current_value, @l3, 1)
       ON CONFLICT (key) DO UPDATE SET display_name = excluded.display_name, category = excluded.category,
         keys = excluded.keys, names = excluded.names, linked_company_ids = excluded.linked_company_ids,
         funds_ever = excluded.funds_ever, first_mark_date = excluded.first_mark_date,
         last_mark_date = excluded.last_mark_date, current_funds = excluded.current_funds,
         current_value_usd = excluded.current_value_usd, level3_share = excluded.level3_share, active = 1`
    );
    const idOf = db.prepare('SELECT id FROM unreviewed_entities WHERE key = ?');
    for (const [root, c] of [...comps].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const keys = keysOf(root);
      const names = [...c.raw].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([n]) => n);
      const l3Share = c.value ? c.l3 / c.value : null;
      // The review queue's category when the component is held now (same rows,
      // same rule: each active fund's latest filing); otherwise all history.
      const cur = current.get(root);
      const { category, companies } = cur
        ? componentCategory(ctx, { keys, rawNames: cur.raw.keys(), l3Share: cur.l3 / cur.value })
        : componentCategory(ctx, { keys, rawNames: names, l3Share: l3Share ?? 0 });
      upsert.run({
        key: root,
        display_name: names[0] || root,
        category,
        keys: JSON.stringify(keys),
        names: JSON.stringify(names.slice(0, TOP_NAMES)),
        linked: JSON.stringify([...companies].sort((a, b) => a - b)),
        funds_ever: c.funds.size,
        first: c.first,
        last: c.last,
        current_funds: cur ? cur.funds.size : 0,
        current_value: cur ? cur.value : 0,
        l3: l3Share,
      });
      ids.set(root, idOf.get(root).id);
    }

    const tag = db.prepare('UPDATE holdings SET entity_id = ? WHERE accession = ? AND row_key = ?');
    let tagged = 0;
    for (const r of rows) {
      const id = r.root ? ids.get(r.root) : null;
      if (r.entity_id !== id) {
        tag.run(id, r.accession, r.row_key);
        tagged++;
      }
    }
    const cleared = db
      .prepare('UPDATE holdings SET entity_id = NULL WHERE company_id IS NOT NULL AND entity_id IS NOT NULL')
      .run().changes;

    db.prepare('DELETE FROM company_stats').run();
    db.prepare(
      `INSERT INTO company_stats (company_id, current_funds, current_value_usd, as_of, funds_ever, first_mark_date,
         last_mark_date)
       SELECT c.id, 0, 0, @asOf, COUNT(DISTINCT f.fund_key), MIN(f.report_date), MAX(f.report_date)
       FROM companies c LEFT JOIN holdings h ON h.company_id = c.id
         AND h.value_usd > 0 AND h.instrument_type <> 'debt'
       LEFT JOIN canonical_filings f ON f.accession = h.accession
       GROUP BY c.id`
    ).run({ asOf });
    const setNow = db.prepare('UPDATE company_stats SET current_funds = ?, current_value_usd = ? WHERE company_id = ?');
    for (const [id, c] of companyNow) setNow.run(c.funds.size, c.value, id);

    rebuildSearchIndex(db);
    ids.stats = { entities: ids.size, rows: rows.length, tagged, cleared, at: now };
  })();
  return ids.stats;
}

function rebuildSearchIndex(db) {
  db.prepare('DELETE FROM search_names').run();
  const put = db.prepare('INSERT INTO search_names (compact, name, kind, ref, detail) VALUES (?, ?, ?, ?, ?)');
  const add = (text, kind, ref, detail) => {
    const v = searchVariants(text);
    if (v.length) put.run(v.join(' '), text, kind, ref, detail);
  };
  for (const c of db.prepare('SELECT id, name FROM companies').all()) add(c.name, 'name', c.id, '');
  for (const a of db
    .prepare("SELECT company_id, kind, pattern, source FROM company_aliases WHERE kind IN ('issuer_key', 'exact')")
    .all())
    add(a.pattern, 'alias', a.company_id, `${a.kind}:${a.source}`);
  for (const b of db.prepare('SELECT company_id, brand, source_accession FROM company_brands').all())
    add(b.brand, 'brand', b.company_id, b.source_accession);
  for (const e of db
    .prepare('SELECT id, key, display_name, keys, category FROM unreviewed_entities WHERE active = 1')
    .all()) {
    const texts = new Set([e.display_name, ...JSON.parse(e.keys)]);
    for (const t of texts) add(t, 'unreviewed', e.id, e.category);
  }
}

module.exports = { rebuildEntities, rebuildSearchIndex, searchVariants };
