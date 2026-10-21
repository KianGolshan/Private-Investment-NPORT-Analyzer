// Sector, industry and theme labels of private operating companies (P14, ADR
// 0010), read once per generation. Labels group numbers; they change none. A
// company with no industry (a "not yet classified" decision, or none at all) is
// in the 'unclassified' group, so every grouping adds up to the whole.
// Group by identity (codes), display by name.
const { memo } = require('./memo');
const { ServiceError } = require('./errors');

const UNCLASSIFIED = 'unclassified';
const UNCLASSIFIED_LABEL = 'Not yet classified';
const LEVELS = ['sector', 'industry', 'theme'];

const hasTaxonomy = db =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'taxonomy_meta'").get() &&
  !!db.prepare('SELECT 1 FROM taxonomy_meta').get();

// { version, sectors: [{ code, name, industries: [{ code, name, definition }] }], themes, names }
function taxonomy(db) {
  return memo(db, 'sectors:taxonomy', () => {
    if (!hasTaxonomy(db)) return { version: null, sectors: [], themes: [], names: new Map() };
    const industries = db.prepare('SELECT * FROM taxonomy_industries ORDER BY position').all();
    const sectors = db
      .prepare('SELECT * FROM taxonomy_sectors ORDER BY position')
      .all()
      .map(s => ({
        code: s.code,
        name: s.name,
        industries: industries
          .filter(i => i.sector === s.code)
          .map(i => ({ code: i.code, name: i.name, definition: i.definition })),
      }));
    const themes = db.prepare('SELECT code, name, definition FROM taxonomy_themes ORDER BY position').all();
    const names = new Map([
      [UNCLASSIFIED, UNCLASSIFIED_LABEL],
      ...sectors.map(s => [s.code, s.name]),
      ...industries.map(i => [i.code, i.name]),
      ...themes.map(t => [t.code, t.name]),
    ]);
    return { version: db.prepare('SELECT version FROM taxonomy_meta').get().version, sectors, themes, names };
  });
}

// company id -> { sector, industry, themes, confidence, source, note }
function labels(db) {
  return memo(db, 'sectors:labels', () => {
    const out = new Map();
    if (!hasTaxonomy(db)) return out;
    const rows = db
      .prepare(
        `SELECT ci.company_id id, ci.industry, ci.confidence, ci.source, ci.note, i.sector
         FROM company_industry ci LEFT JOIN taxonomy_industries i ON i.code = ci.industry`
      )
      .all();
    for (const r of rows)
      out.set(r.id, {
        sector: r.sector || null,
        industry: r.industry || null,
        themes: [],
        confidence: r.confidence,
        source: r.source,
        note: r.note,
      });
    for (const t of db.prepare('SELECT company_id, theme FROM company_themes ORDER BY theme').all())
      out.get(t.company_id)?.themes.push(t.theme);
    return out;
  });
}

// A company's group keys at a level: one sector or industry (or 'unclassified');
// any number of themes (none: no theme key; themes never add up to a total).
function groupKeys(db, level) {
  if (!LEVELS.includes(level)) throw new Error(`level must be one of ${LEVELS.join(', ')}`);
  const map = labels(db);
  if (level === 'theme') return id => map.get(id)?.themes || [];
  return id => [map.get(id)?.[level] || UNCLASSIFIED];
}

// A list filter (?sector=, ?industry=, ?theme=): { level, key } -> the ids of
// the companies in that group, or null without a filter. An unknown code is 404.
function groupIds(db, group) {
  if (!group) return null;
  if (!LEVELS.includes(group.level)) throw new ServiceError(400, `level must be one of ${LEVELS.join(', ')}`);
  if (!taxonomy(db).names.has(group.key)) throw new ServiceError(404, `no ${group.level} "${group.key}"`);
  return memo(db, `sectors:ids:${group.level}:${group.key}`, () => {
    const keysOf = groupKeys(db, group.level);
    const out = new Set();
    for (const id of db
      .prepare("SELECT id FROM companies WHERE status = 'private'")
      .all()
      .map(r => r.id))
      if (keysOf(id).includes(group.key)) out.add(id);
    return out;
  });
}

// A list row's labels (Market, movers, newly reported): codes and names.
function rowLabels(db, companyId) {
  const l = labels(db).get(companyId);
  if (!l) return {};
  const names = taxonomy(db).names;
  return {
    sector: l.sector,
    industry: l.industry,
    industryLabel: l.industry ? names.get(l.industry) : null,
    themes: l.themes,
  };
}

// The label a company page shows (null when the warehouse has no taxonomy).
function companyLabel(db, companyId) {
  const t = taxonomy(db);
  if (!t.version) return null;
  const l = labels(db).get(companyId);
  if (!l) return null;
  return {
    sector: l.sector ? { code: l.sector, name: t.names.get(l.sector) } : null,
    industry: l.industry ? { code: l.industry, name: t.names.get(l.industry) } : null,
    themes: l.themes.map(code => ({ code, name: t.names.get(code) })),
    confidence: l.confidence,
    taxonomyVersion: t.version,
  };
}

module.exports = {
  taxonomy,
  labels,
  groupKeys,
  groupIds,
  rowLabels,
  companyLabel,
  LEVELS,
  UNCLASSIFIED,
  UNCLASSIFIED_LABEL,
};
