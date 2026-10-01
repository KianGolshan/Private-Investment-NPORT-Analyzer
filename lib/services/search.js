// Search over every issuer (ROADMAP §5a task 4, ADR 0008): curated companies
// by name, alias and brand, and unreviewed entities, through the FTS5 trigram
// index search_names (rebuilt by lib/entities/entities.js).
//
// Tiers, best first; each result says how it matched:
//   exact       the text as typed equals a name, alias or brand
//   normalized  equal after the identity graph's spelling rules ("Open AI" =
//               "OPENAI", "Hub International" = "HUB INTL", "FHUS" = "FHU US")
//   prefix      a name starts with what was typed ("Databrick")
//   substring   what was typed appears inside a name, starting a word
//               ("Hub" in "Hockey Parent dba HUB INTL", never "Stri" in "INDUSTRIES")
//   similar     one or two letters off ("Databriks"), only when nothing else
//               matched, only for 6+ characters, and never when one spelling
//               extends the other: OPENAIR vs OPENAI, STRIPES vs STRIPE and
//               ANTHROPICS vs ANTHROPIC are different companies (trap 26).
// Look-alikes stay apart: a curated alias joins them only on filer evidence
// (OPENAIR is an OpenAI alias because of BlackRock's filings, F32), and the
// result says so ("alias OPENAIR").
const { searchVariants } = require('../entities/entities');

const TIERS = ['exact', 'normalized', 'prefix', 'substring', 'similar'];
// Ranking groups: an exact and a normalized match are equally strong, so a
// reviewed company spelled differently ("HUB INTL") ranks above an unreviewed
// name typed exactly ("Hub International", a Pantheon co-investment line).
const GROUP = { exact: 0, normalized: 0, prefix: 1, substring: 2, similar: 3 };
const MAX_ROWS = 400;
const MIN_SIMILAR = 6;

// Damerau-Levenshtein (optimal string alignment), stopping above `max`.
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2 = null;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur.push(v);
      best = Math.min(best, v);
    }
    if (best > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length];
}

const ftsPhrase = s => `"${s.replace(/"/g, '""')}"`;

function candidates(db, query) {
  const stmt = db.prepare(
    `SELECT compact, name, kind, ref, detail FROM search_names WHERE search_names MATCH ? LIMIT ${MAX_ROWS}`
  );
  const out = [];
  for (const q of query) if (q.length >= 3) out.push(...stmt.all(`compact : ${ftsPhrase(q)}`));
  return out;
}

// Does q (compact, no spaces) start at a word boundary of the name?
function atWordStart(name, q) {
  const words = String(name)
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
  for (let i = 0; i < words.length; i++) if (words.slice(i).join('').startsWith(q)) return true;
  return false;
}

function tierOf(row, typed, query) {
  if (row.name.toUpperCase().replace(/\s+/g, ' ').trim() === typed) return 'exact';
  const forms = row.compact.split(' ');
  if (forms.some(f => query.includes(f))) return 'normalized';
  if (forms.some(f => query.some(q => f.startsWith(q)))) return 'prefix';
  if (query.some(q => atWordStart(row.name, q))) return 'substring';
  return null;
}

// Rows sharing trigrams with the query, scored by edit distance.
function similar(db, query) {
  const grams = new Set();
  for (const q of query) for (let i = 0; i + 3 <= q.length; i++) grams.add(q.slice(i, i + 3));
  if (!grams.size) return [];
  const rows = db
    .prepare(`SELECT compact, name, kind, ref, detail FROM search_names WHERE search_names MATCH ? LIMIT 5000`)
    .all(`compact : (${[...grams].map(ftsPhrase).join(' OR ')})`);
  const out = [];
  for (const row of rows) {
    let best = Infinity;
    for (const f of row.compact.split(' '))
      for (const q of query) {
        if (q.length < MIN_SIMILAR || f.startsWith(q) || q.startsWith(f)) continue;
        const max = q.length >= 10 ? 2 : 1;
        const d = editDistance(q, f, max);
        if (d <= max) best = Math.min(best, d);
      }
    if (best !== Infinity) out.push({ ...row, distance: best });
  }
  return out;
}

function evidence(db) {
  const company = db.prepare(
    `SELECT c.id, c.name, c.status, (t.company_id IS NOT NULL) tracked, s.current_funds, s.current_value_usd, s.as_of,
       s.funds_ever, s.first_mark_date, s.last_mark_date
     FROM companies c LEFT JOIN tracked_companies t ON t.company_id = c.id
       LEFT JOIN company_stats s ON s.company_id = c.id WHERE c.id = ?`
  );
  const entity = db.prepare(
    `SELECT id, key, display_name, category, names, linked_company_ids, funds_ever, first_mark_date, last_mark_date,
       current_funds, current_value_usd FROM unreviewed_entities WHERE id = ?`
  );
  const asOf = db.prepare('SELECT MAX(as_of) d FROM company_stats');
  return {
    company: id => {
      const c = company.get(id);
      return (
        c && {
          type: 'company',
          id: c.id,
          name: c.name,
          status: c.status,
          tracked: !!c.tracked,
          reviewed: true,
          evidence: {
            currentFunds: c.current_funds ?? 0,
            currentValueUsd: c.current_value_usd ?? 0,
            asOf: c.as_of,
            fundsEver: c.funds_ever ?? 0,
            firstMarkDate: c.first_mark_date,
            lastMarkDate: c.last_mark_date,
          },
        }
      );
    },
    unreviewed: id => {
      const e = entity.get(id);
      return (
        e && {
          type: 'unreviewed',
          id: e.id,
          key: e.key,
          name: e.display_name,
          category: e.category,
          reviewed: false,
          linkedCompanyIds: JSON.parse(e.linked_company_ids),
          evidence: {
            currentFunds: e.current_funds,
            currentValueUsd: e.current_value_usd,
            asOf: asOf.get().d,
            fundsEver: e.funds_ever,
            firstMarkDate: e.first_mark_date,
            lastMarkDate: e.last_mark_date,
            names: JSON.parse(e.names),
          },
        }
      );
    },
  };
}

const VIA = { name: 'name', alias: 'alias', brand: 'brand', unreviewed: 'name' };

function search(db, text, { limit = 10 } = {}) {
  const typed = String(text || '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
  const query = searchVariants(typed);
  if (!query.length || query.every(q => q.length < 3)) return [];

  const best = new Map();
  const consider = (row, tier) => {
    const target = `${row.kind === 'unreviewed' ? 'u' : 'c'}:${row.ref}`;
    const rank = TIERS.indexOf(tier);
    const prev = best.get(target);
    if (prev && prev.rank <= rank) return;
    best.set(target, {
      rank,
      row,
      match: { how: tier, via: VIA[row.kind], text: row.name, ...(row.detail ? { detail: row.detail } : {}) },
    });
  };
  for (const row of candidates(db, query)) {
    const tier = tierOf(row, typed, query);
    if (tier) consider(row, tier);
  }
  if (!best.size) for (const row of similar(db, query)) consider(row, 'similar');

  const ev = evidence(db);
  const ranked = [...best.values()]
    .map(b => {
      const r = b.row.kind === 'unreviewed' ? ev.unreviewed(b.row.ref) : ev.company(b.row.ref);
      return r && { ...r, match: b.match, rank: GROUP[b.match.how] };
    })
    .filter(Boolean)
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        b.reviewed - a.reviewed ||
        b.evidence.currentValueUsd - a.evidence.currentValueUsd ||
        a.name.localeCompare(b.name)
    )
    .map(({ rank: _rank, ...r }) => ({ ...r, strong: false }));
  if (ranked.length && isStrong(ranked[0], typed, ranked.slice(1))) ranked[0].strong = true;
  return ranked.slice(0, limit);
}

// May the top result open without asking? An exact or normalized match, or a
// name that starts with the typed whole words ("Cerebras" -> "Cerebras
// Systems") when no other result does too. A substring ("Mistral" inside "SLP
// Mistral Co-Invest") or a similar spelling never opens by itself.
const words = t =>
  String(t)
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
function leadsWith(r, typed) {
  const t = words(typed);
  const w = words(r.match.text);
  return t.length > 0 && t.every((x, i) => w[i] === x);
}
function isStrong(top, typed, rest) {
  if (top.match.how === 'exact' || top.match.how === 'normalized') return true;
  if (top.match.how !== 'prefix' || !leadsWith(top, typed)) return false;
  return !rest.some(r => ['exact', 'normalized', 'prefix'].includes(r.match.how) && leadsWith(r, typed));
}

module.exports = { search, editDistance };
