// Seeds the entity review files from the warehouse (human in the loop:
// scripts/seed-entities.js writes data/review/*.csv, a person edits them,
// scripts/review-aliases.js imports them).
//
// Companies: holding rows cluster by parsers.issuerKeyOf. Candidates are
// clusters held by >= 3 funds for >= $25M over the last 12 months (ROADMAP
// §Phase 4), ranked by funds x dollars x quarters present. Suggestions:
//   - merges: a cluster whose key extends a candidate's key ("DATABRICKS INC
//     SERES" -> "DATABRICKS"), shares its first two words ("SPACE EXPLORATION
//     TECH"), or whose rows' own titles name the candidate (issuer "DOUYIN CO
//     LTD", title "BYTEDANCE LTD SER E-1 PC PP");
//   - named SPVs: a vehicle whose name contains the company's name as whole
//     words ("Magnitude ANC III, LLC (economic exposure to Anthropic…)"),
//     via_spv = 1. "STRIPES VI" and "ANTHROPICS TECHNOLOGY" do not match;
//   - status: public when >= 3 filings in the latest bulk quarter price the
//     issuer at Level 1 with a valid ISIN/CUSIP (listing_evidence, migration
//     0010: the warehouse keeps only a listed company's Level-3/restricted
//     rows, so Pfizer's PIPE alone looks private); otherwise private when >= 50%
//     of the last 12 months' value is Level 3 (trap 7: some filers use Level
//     1/2 for private names, so every status is a suggestion for review);
//   - noise flags: fund interests, CONTRA CVRs, very short keys (trap 13).
// Managers: advisers (N-CEN) with private holdings, grouped into firms by
// v1's curated TOP_FUND_GROUPS where they overlap, else by name stem.
const fs = require('fs');
const path = require('path');
const { issuerKeyOf } = require('../../parsers');

const WINDOW_DAYS = 365;
const MIN_FUNDS = 3;
const MIN_VALUE = 25e6;
const PRIVATE_L3 = 0.5;
const BORDERLINE_L3 = 0.1;
const TRACK_TOP = 250;
const TITLE_MERGE_SHARE = 0.8;
const LISTED_MIN_FILINGS = 3;

// Curated status decisions, each with SEC evidence (CLAUDE.md: SpaceX is public).
const KNOWN_STATUS = {
  'SPACE EXPLORATION TECHNOLOGIES': {
    status: 'public',
    note: 'IPO completed June 2026 (Fundrise Innovation Fund report, 0001867090-26-000109); funds report 180-day lock-up Class A shares from 2026-06-30 (0000035402-26-005373).',
  },
};

const NA = /^(N\/?A|NONE|NULL|NIL|-+)$/i;
const real = v => {
  const t = String(v ?? '').trim();
  return t && !NA.test(t) ? t : '';
};
// The raw name an 'exact' alias matches: issuer name, else title.
const rawName = r => (real(r.issuer_name) || real(r.title)).toUpperCase().replace(/\s+/g, ' ').trim();
const keyOf = r => issuerKeyOf({ issuer: r.issuer_name, title: r.title });
const words = s =>
  ` ${String(s)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()} `;
const quarterOf = d => `${d.slice(0, 4)}q${Math.ceil(Number(d.slice(5, 7)) / 3)}`;
const FUND_LIKE =
  /\b(FUND|FUNDS|PORTFOLIO|TRUST|MASTER|INDEX|LIFEPATH|FEEDER|CO ?INVEST\w*|L ?P|LLLP|PARTNERS|SPV|VEHICLE|SECONDARIES|VINTAGE|SCSP|SCA|SICAV|FCP)\b/;

function companyRows(db) {
  return db
    .prepare(
      `SELECT h.accession, h.issuer_name, h.title, h.value_usd, h.fv_level, h.instrument_type, c.fund_key, c.report_date
       FROM holdings h JOIN canonical_filings c ON c.accession = h.accession
       WHERE h.value_usd > 0 AND h.instrument_type <> 'debt'`
    )
    .all();
}

function buildClusters(rows, { asOf }) {
  const since = new Date(Date.parse(asOf) - WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
  const clusters = new Map();
  for (const r of rows) {
    const key = keyOf(r);
    if (!key) continue;
    let c = clusters.get(key);
    if (!c) {
      c = {
        key,
        rows: 0,
        raw: new Map(),
        titleKeys: new Map(),
        quarters: new Set(),
        recent: new Map(),
        l3: 0,
        total: 0,
        recentL3: 0,
        recentTotal: 0,
        pipe: false,
      };
      clusters.set(key, c);
    }
    c.rows++;
    const raw = rawName(r);
    c.raw.set(raw, (c.raw.get(raw) || 0) + 1);
    if (real(r.issuer_name) && real(r.title)) {
      const tk = issuerKeyOf({ title: r.title });
      if (tk && tk !== key) {
        const t = c.titleKeys.get(tk) || { n: 0, accession: r.accession };
        t.n++;
        c.titleKeys.set(tk, t);
      }
    }
    c.quarters.add(quarterOf(r.report_date));
    c.total += r.value_usd;
    if (r.fv_level === '3') c.l3 += r.value_usd;
    if (/\bPIPE\b/i.test(`${r.issuer_name} ${r.title}`)) c.pipe = true;
    if (r.report_date >= since && r.report_date <= asOf) {
      c.recentTotal += r.value_usd;
      if (r.fv_level === '3') c.recentL3 += r.value_usd;
      const f = c.recent.get(r.fund_key);
      if (!f || f.date < r.report_date) c.recent.set(r.fund_key, { date: r.report_date, value: r.value_usd });
      else if (f.date === r.report_date) f.value += r.value_usd;
      if (!c.evidence || r.value_usd > c.evidence.value)
        c.evidence = { accession: r.accession, value: r.value_usd, date: r.report_date };
    }
  }
  for (const c of clusters.values()) {
    c.funds = c.recent.size;
    c.value = [...c.recent.values()].reduce((s, f) => s + f.value, 0);
    c.score = c.funds * (c.value / 1e6) * c.quarters.size;
    // Status evidence is the last 12 months (a 2024 IPO is not private now).
    c.l3Share = c.recentTotal ? c.recentL3 / c.recentTotal : c.total ? c.l3 / c.total : 0;
  }
  return { clusters, since };
}

const titleCase = key =>
  key
    .split(' ')
    .map(w => (w.length <= 3 && /\d/.test(w) ? w : w[0] + w.slice(1).toLowerCase()))
    .join(' ');

// issuer key -> the latest bulk quarter's listing evidence.
function latestListingEvidence(db) {
  const q = db.prepare('SELECT MAX(quarter) q FROM listing_evidence').get().q;
  if (!q) return new Map();
  return new Map(
    db
      .prepare('SELECT * FROM listing_evidence WHERE quarter = ? AND filings >= ?')
      .all(q, LISTED_MIN_FILINGS)
      .map(e => [e.issuer_key, e])
  );
}

function suggestCompanies(clusters, { listing = new Map() } = {}) {
  const candidates = [...clusters.values()]
    .filter(c => c.funds >= MIN_FUNDS && c.value >= MIN_VALUE)
    .sort((a, b) => b.score - a.score);
  const groups = [];
  const byAnchor = new Map();
  const byFirstTwo = new Map();
  const byCompact = new Map();
  const groupOfKey = new Map();

  // The group a key belongs to, if any: an anchor key is a whole-word prefix
  // of it (anchor >= 5 characters) or the two share their first two words.
  function match(key) {
    const t = key.split(' ');
    for (let n = t.length; n >= 1; n--) {
      const prefix = t.slice(0, n).join(' ');
      const g = byAnchor.get(prefix);
      if (g && prefix.length >= 5) return { group: g, reason: n === t.length ? 'anchor' : `extends "${prefix}"` };
    }
    if (t.length >= 2) {
      const two = t.slice(0, 2).join(' ');
      const g = byFirstTwo.get(two);
      if (g && two.length >= 8) return { group: g, reason: `shares "${two}"` };
    }
    // Spacing variants: "OPEN AI GLOBAL" -> "OPENAI". The match must end on a
    // word boundary of the key, so "OPENAIR" (OpenAir) never becomes OpenAI.
    for (let n = t.length; n >= 1; n--) {
      const compact = t.slice(0, n).join('');
      const g = compact.length >= 6 && byCompact.get(compact);
      if (g && g.anchor.key !== key) return { group: g, reason: `spelled "${g.anchor.key}"` };
    }
    return null;
  }
  // Rows whose own titles name a group's company (>= 80% of the rows).
  function matchByTitle(c) {
    for (const [tk, t] of c.titleKeys) {
      if (t.n / c.rows < TITLE_MERGE_SHARE) continue;
      const m = match(tk);
      if (m) return { group: m.group, reason: `titles read "${tk}"`, evidence: t.accession };
    }
    return null;
  }
  const add = (g, c, reason, evidence) => {
    g.aliases.push({ cluster: c, reason, evidence: evidence || c.evidence?.accession });
    groupOfKey.set(c.key, g);
  };

  for (const c of candidates) {
    // Public-looking and not listed-with-a-PIPE: not a company group.
    if (c.l3Share < BORDERLINE_L3 && !KNOWN_STATUS[c.key] && !listing.has(c.key)) continue;
    const m = match(c.key) || matchByTitle(c);
    if (m) {
      add(m.group, c, m.reason, m.evidence);
      continue;
    }
    const g = { anchor: c, aliases: [], spvs: [] };
    groups.push(g);
    byAnchor.set(c.key, g);
    if (!byCompact.has(c.key.replace(/ /g, ''))) byCompact.set(c.key.replace(/ /g, ''), g);
    const t = c.key.split(' ');
    if (t.length >= 2 && !byFirstTwo.has(t.slice(0, 2).join(' '))) byFirstTwo.set(t.slice(0, 2).join(' '), g);
    add(g, c, 'anchor');
  }
  for (const c of clusters.values()) {
    if (groupOfKey.has(c.key)) continue;
    const m = match(c.key) || matchByTitle(c);
    if (m) add(m.group, c, m.reason, m.evidence);
  }

  // Named SPVs: raw names (outside every group) containing a private group's
  // anchor as whole words.
  const phrases = groups
    .filter(g => g.anchor.key.length >= 5 && g.anchor.l3Share >= PRIVATE_L3 && !KNOWN_STATUS[g.anchor.key])
    .map(g => ({ g, phrase: words(g.anchor.key) }))
    .sort((a, b) => b.phrase.length - a.phrase.length);
  for (const c of clusters.values()) {
    if (groupOfKey.has(c.key)) continue;
    for (const [raw, n] of c.raw) {
      const w = words(raw);
      const hit = phrases.find(p => w.includes(p.phrase));
      if (hit) hit.g.spvs.push({ raw, rows: n, cluster: c });
    }
  }

  for (const g of groups) {
    const members = g.aliases.map(a => a.cluster);
    const recentTotal = members.reduce((s, c) => s + c.recentTotal, 0);
    g.l3Share = recentTotal
      ? members.reduce((s, c) => s + c.recentL3, 0) / recentTotal
      : members.reduce((s, c) => s + c.l3, 0) / (members.reduce((s, c) => s + c.total, 0) || 1);
    g.score = members.reduce((s, c) => s + c.score, 0);
    const known = KNOWN_STATUS[g.anchor.key];
    const listed = members.map(c => listing.get(c.key)).find(Boolean);
    g.status = known ? known.status : listed ? 'public' : g.l3Share >= PRIVATE_L3 ? 'private' : 'public';
    g.note = known
      ? known.note
      : listed
        ? `Listed: ${listed.filings} filings price it at Level 1 with a valid ISIN/CUSIP in ${listed.quarter} (e.g. ${listed.sample_accession}${listed.sample_cusip ? `, CUSIP ${listed.sample_cusip}` : ''}).`
        : '';
    g.flags = [
      FUND_LIKE.test(g.anchor.key) && 'fund interest?',
      /^CONTRA\b/.test(g.anchor.key) && 'CVR',
      g.anchor.key.length < 4 && 'short key',
      members.some(c => c.pipe) && 'PIPE: public issuer?',
      g.status === 'public' && !known && !listed && `level 3 share ${g.l3Share.toFixed(2)}`,
    ].filter(Boolean);
    g.name = titleCase(g.anchor.key);
  }
  groups.sort((a, b) => b.score - a.score);
  let tracked = 0;
  for (const g of groups) g.track = g.status === 'private' && !g.flags.length && tracked++ < TRACK_TOP;
  return { groups, candidates: candidates.length };
}

const ALIAS_COLUMNS = [
  'company',
  'status',
  'track',
  'kind',
  'alias',
  'via_spv',
  'funds_12m',
  'value_12m_musd',
  'quarters',
  'level3_share',
  'rows',
  'examples',
  'reason',
  'evidence',
  'flags',
  'note',
];

// Review order: tracked companies, other private ones, then public ones;
// by score within each.
function aliasRows(groups) {
  const rank = g => (g.track ? 0 : g.status === 'private' ? 1 : 2);
  const out = [];
  for (const g of [...groups].sort((a, b) => rank(a) - rank(b) || b.score - a.score)) {
    const base = { company: g.name, status: g.status, track: g.track ? 'Y' : 'N' };
    for (const a of g.aliases) {
      const c = a.cluster;
      out.push({
        ...base,
        kind: 'issuer_key',
        alias: c.key,
        via_spv: 0,
        funds_12m: c.funds,
        value_12m_musd: (c.value / 1e6).toFixed(1),
        quarters: c.quarters.size,
        level3_share: c.l3Share.toFixed(2),
        rows: c.rows,
        examples: [...c.raw.keys()].slice(0, 3).join(' | '),
        reason: a.reason,
        evidence: a.evidence || '',
        flags: a.reason === 'anchor' ? g.flags.join('; ') : '',
        note: a.reason === 'anchor' ? g.note : '',
      });
    }
    for (const s of g.spvs) {
      out.push({
        ...base,
        kind: 'exact',
        alias: s.raw,
        via_spv: 1,
        funds_12m: s.cluster.funds,
        value_12m_musd: (s.cluster.value / 1e6).toFixed(1),
        quarters: s.cluster.quarters.size,
        level3_share: s.cluster.l3Share.toFixed(2),
        rows: s.rows,
        examples: '',
        reason: 'vehicle name contains the company name',
        evidence: s.cluster.evidence?.accession || '',
        flags: 'confirm SPV',
        note: '',
      });
    }
  }
  return out;
}

// v1's curated firm -> registrant names (public/app.js TOP_FUND_GROUPS).
function v1FundGroups(appJsPath = path.join(__dirname, '..', '..', 'public', 'app.js')) {
  const src = fs.readFileSync(appJsPath, 'utf8');
  const start = src.indexOf('const TOP_FUND_GROUPS = {');
  if (start < 0) throw new Error('TOP_FUND_GROUPS not found in public/app.js');
  const end = src.indexOf('\n};', start);
  const body = src.slice(start + 'const TOP_FUND_GROUPS = '.length, end + 2);
  return Function(`"use strict"; return (${body});`)();
}

const GENERIC =
  /^(ADVISORS?|ADVISERS?|ADVISORY|MANAGEMENT|INVESTMENTS?|ASSET|ASSETS|FUNDS?|PARTNERS|GROUP|LLC|INC|LP|L|P|CO|COMPANY|CORP|CORPORATION|LTD|LIMITED|GLOBAL|INTERNATIONAL|AND|THE|OF|US|USA|NORTH|AMERICA|AMERICAS|CAPITAL)$/;
function managerStem(name) {
  const t = words(name)
    .trim()
    .split(' ')
    .filter(w => w !== 'THE');
  if (t.length >= 2 && !GENERIC.test(t[1])) return titleCase(`${t[0]} ${t[1]}`);
  return titleCase(t[0] || name);
}

function suggestManagers(db, { v1Groups = v1FundGroups() } = {}) {
  const v1ByRegistrant = new Map();
  for (const [firm, names] of Object.entries(v1Groups))
    for (const n of names) v1ByRegistrant.set(n.toUpperCase(), firm);
  const funds = db
    .prepare(
      `SELECT c.fund_key, c.cik, c.registrant,
         (SELECT SUM(h.value_usd) FROM holdings h WHERE h.accession = c.accession AND h.value_usd > 0
            AND h.instrument_type <> 'debt') AS value
       FROM canonical_filings c
       WHERE c.report_date = (SELECT MAX(report_date) FROM canonical_filings c2 WHERE c2.fund_key = c.fund_key)`
    )
    .all()
    .filter(f => f.value > 0);
  const advOf = db.prepare(
    "SELECT a.file_num, v.name FROM fund_advisers a JOIN advisers v USING (file_num) WHERE a.fund_key = ? AND a.role = 'adviser'"
  );
  const byAdviser = new Map();
  const unmapped = new Map();
  for (const f of funds) {
    const advisers = advOf.all(f.fund_key);
    const v1 = v1ByRegistrant.get(String(f.registrant || '').toUpperCase());
    if (!advisers.length) {
      const u = unmapped.get(f.cik) || { cik: f.cik, name: f.registrant, funds: 0, value: 0, v1 };
      u.funds++;
      u.value += f.value;
      unmapped.set(f.cik, u);
      continue;
    }
    for (const a of advisers) {
      const e = byAdviser.get(a.file_num) || { file_num: a.file_num, name: a.name, funds: 0, value: 0, v1: new Set() };
      e.funds++;
      e.value += f.value / advisers.length;
      if (v1) e.v1.add(v1);
      byAdviser.set(a.file_num, e);
    }
  }
  const rows = [];
  for (const e of [...byAdviser.values()].sort((a, b) => b.value - a.value)) {
    const v1 = [...e.v1];
    rows.push({
      manager: v1.length === 1 ? v1[0] : managerStem(e.name),
      kind: 'adviser',
      key: e.file_num,
      name: e.name,
      funds: e.funds,
      private_value_musd: (e.value / 1e6).toFixed(1),
      v1_group: v1.join(' | '),
      flags: v1.length > 1 ? 'several v1 groups' : v1.length ? '' : 'name stem',
    });
  }
  for (const u of [...unmapped.values()].sort((a, b) => b.value - a.value)) {
    rows.push({
      manager: u.v1 || managerStem(u.name || ''),
      kind: 'registrant',
      key: u.cik,
      name: u.name,
      funds: u.funds,
      private_value_musd: (u.value / 1e6).toFixed(1),
      v1_group: u.v1 || '',
      flags: 'no N-CEN adviser',
    });
  }
  return rows;
}
const MANAGER_COLUMNS = ['manager', 'kind', 'key', 'name', 'funds', 'private_value_musd', 'v1_group', 'flags'];

module.exports = {
  latestListingEvidence,
  companyRows,
  buildClusters,
  suggestCompanies,
  aliasRows,
  suggestManagers,
  v1FundGroups,
  managerStem,
  rawName,
  ALIAS_COLUMNS,
  MANAGER_COLUMNS,
  KNOWN_STATUS,
};
