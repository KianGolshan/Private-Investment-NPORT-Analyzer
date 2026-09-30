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
//   - status: public when funds report post-IPO lock-up or PIPE shares in the
//     last 12 months (newer than any bulk quarter), or when >= 3 filings in one
//     of the latest 4 bulk quarters price the issuer at Level 1 with a valid
//     ISIN/CUSIP (listing_evidence, migration 0010: the warehouse keeps only a
//     listed company's Level-3/restricted rows, so Pfizer's PIPE alone looks
//     private); otherwise private when >= 50% of the last 12 months' value is
//     Level 3 (trap 7: some filers use Level
//     1/2 for private names, so every status is a suggestion for review);
//   - noise flags: fund interests, CONTRA CVRs, very short keys (trap 13).
// Managers: advisers (N-CEN) with private holdings, grouped into firms by
// v1's curated TOP_FUND_GROUPS where they overlap, else by name stem.
const fs = require('fs');
const path = require('path');
const { issuerKeyOf, ISSUER_CUT_TOKENS, ISSUER_SUFFIX_TOKENS } = require('../../parsers');

const WINDOW_DAYS = 365;
const MIN_FUNDS = 3;
const MIN_VALUE = 25e6;
const PRIVATE_L3 = 0.5;
const BORDERLINE_L3 = 0.1;
const TRACK_TOP = 250;
const TITLE_MERGE_SHARE = 0.8;
const LISTED_MIN_FILINGS = 3;
// Reinsurance sidecars / cat-bond vehicles ("PARTNER RE 2026 EQUITY", "LOGAN RE 2027").
// Lock-up shares only exist after an IPO (or on PIPE shares of a listed
// company): "SPACE EXPLORATION TECHNOLOGIES CORP A (180 DAY LOCK UP)",
// "KARDIGAN, INC. LOCKUP SHARES PP". Newer than the latest listing evidence.
const LOCKUP = /\bLOCK[\s-]?UP\b(?!.*\bUPON (AN )?IPO\b)/i; // "LOCKUP UPON IPO" is a pre-IPO term (Celonis)
// A PIPE is a private placement in a *public* company ("KEURIG DR PEPPER SER A
// CVT PFD PIPE PP"). Only the last 12 months count: Endeavor had a PIPE, then
// was taken private.
const PIPE = /\bPIPE\b/i;
const REINSURANCE = /\bRE\b( \d{4}\b| LTD\b| LIMITED\b| UNCOMMITTED\b|$)/;

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
        pipe: null, // first recent row describing PIPE shares (a listed issuer)
        names: new Map(), // as filed (original case), for display names
        lockup: null, // first recent row describing post-IPO lock-up shares
      };
      clusters.set(key, c);
    }
    c.rows++;
    const raw = rawName(r);
    c.raw.set(raw, (c.raw.get(raw) || 0) + 1);
    const filed = (real(r.issuer_name) || real(r.title)).replace(/\s+/g, ' ');
    c.names.set(filed, (c.names.get(filed) || 0) + 1);
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
    if (r.report_date >= since && r.report_date <= asOf) {
      if (PIPE.test(`${r.issuer_name} ${r.title}`) && (!c.pipe || r.report_date < c.pipe.date))
        c.pipe = { date: r.report_date, accession: r.accession, text: real(r.title) || real(r.issuer_name) };
      if (LOCKUP.test(`${r.issuer_name} ${r.title}`) && (!c.lockup || r.report_date < c.lockup.date))
        c.lockup = { date: r.report_date, accession: r.accession, text: real(r.title) || real(r.issuer_name) };
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

// issuer key -> its strongest listing evidence in the latest 4 bulk quarters.
// Four, not one: a listed stock whose trading is suspended drops to Level 3
// (Fu Shou Yuan: 10-12 filings a quarter through 2026q1, 1 in 2026q2).
function latestListingEvidence(db) {
  const quarters = db
    .prepare('SELECT DISTINCT quarter FROM listing_evidence ORDER BY quarter DESC LIMIT 4')
    .all()
    .map(r => r.quarter);
  const out = new Map();
  if (!quarters.length) return out;
  const rows = db
    .prepare(
      `SELECT * FROM listing_evidence WHERE quarter IN (${quarters.map(() => '?').join(',')}) AND filings >= ?
       ORDER BY filings DESC`
    )
    .all(...quarters, LISTED_MIN_FILINGS);
  for (const e of rows) if (!out.has(e.issuer_key)) out.set(e.issuer_key, e);
  return out;
}

// Display name from the filers' own spelling: the most common mixed-case name
// of the anchor rows, cut at the first security word ("SER", "PFD"...) and
// stripped of legal suffixes ("OpenAI Group PBC" -> "OpenAI"). Falls back to
// the key in title case.
function cleanName(filed) {
  const tokens = filed
    .replace(/\([^)]*\)/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const norm = t => t.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const kept = [];
  for (const t of tokens) {
    if (kept.length && ISSUER_CUT_TOKENS.has(norm(t))) break;
    kept.push(t);
  }
  while (kept.length > 1 && (ISSUER_SUFFIX_TOKENS.has(norm(kept.at(-1))) || !norm(kept.at(-1)))) kept.pop();
  return kept
    .join(' ')
    .replace(/[\s,.;:/&-]+$/, '')
    .trim();
}
function displayName(c) {
  const mixed = [...c.names].filter(([n]) => /[a-z]/.test(n)).sort((a, b) => b[1] - a[1]);
  const name = mixed.length ? cleanName(mixed[0][0]) : '';
  const fallback = titleCase(c.key).replace(/\bAi\b/g, 'AI');
  if (!name || name.length < 2) return fallback;
  // An all-caps spelling ("PATREON") reads better in title case.
  return /[a-z]/.test(name) || name.length <= 4
    ? name
    : titleCase(
        name
          .replace(/[^A-Z0-9 ]/g, ' ')
          .trim()
          .replace(/\s+/g, ' ')
      ).replace(/\bAi\b/g, 'AI');
}

// Curation (data/review/curation.json): the reviewed decisions the rules can't
// make, each with a reason and, for merges, the evidence accession. Keys are
// issuer keys (stable across re-seeds). Unknown keys are errors.
function applyMerges(curation, { clusters, groups, groupOfKey, add, issues }) {
  for (const m of curation.merge || []) {
    const target = groupOfKey.get(m.into);
    if (!target) {
      issues.push(`merge.into "${m.into}" is not a company key`);
      continue;
    }
    for (const key of m.keys) {
      const c = clusters.get(key);
      if (!c) {
        issues.push(`merge key "${key}" not found`);
        continue;
      }
      const from = groupOfKey.get(key);
      const reason = `curation: ${m.reason}`;
      if (from === target) continue;
      if (from && from.anchor === c) {
        for (const a of from.aliases)
          add(target, a.cluster, a.cluster === c ? reason : a.reason, a.cluster === c ? m.evidence : a.evidence);
        target.spvs.push(...from.spvs);
        groups.splice(groups.indexOf(from), 1);
      } else {
        if (from) from.aliases = from.aliases.filter(a => a.cluster !== c);
        add(target, c, reason, m.evidence);
      }
    }
  }
  // Vehicles a filing shows hold the company, though its name doesn't say so.
  for (const s of curation.spv || []) {
    const target = groupOfKey.get(s.into);
    if (!target) {
      issues.push(`spv.into "${s.into}" is not a company key`);
      continue;
    }
    for (const raw of s.raw) {
      const c = [...clusters.values()].find(x => x.raw.has(raw));
      if (!c) issues.push(`spv raw name "${raw}" not found`);
      else
        target.spvs.push({
          raw,
          rows: c.raw.get(raw),
          cluster: c,
          reason: `curation: ${s.reason}`,
          evidence: s.evidence,
        });
    }
  }
  for (const d of curation.drop || []) {
    const g = groupOfKey.get(d.key);
    if (!g || g.anchor.key === d.key) {
      issues.push(`drop "${d.key}": ${g ? 'is an anchor' : 'not in any company'}`);
      continue;
    }
    g.aliases = g.aliases.filter(a => a.cluster.key !== d.key);
    groupOfKey.delete(d.key);
  }
}
function applyDecisions(curation, groups, issues) {
  const byKey = new Map(groups.map(g => [g.anchor.key, g]));
  const each = (section, fn) => {
    for (const [key, v] of Object.entries(curation[section] || {})) {
      const g = byKey.get(key);
      if (!g) issues.push(`${section}: "${key}" is not a company key`);
      else fn(g, v);
    }
  };
  each('status', (g, v) => {
    g.status = v.status;
    g.note = v.note;
  });
  each('rename', (g, v) => (g.name = v));
  each('note', (g, v) => (g.note = g.note ? `${g.note} ${v}` : v));
  each('untrack', (g, v) => {
    g.track = false;
    g.flags.push(`not tracked: ${v}`);
  });
  each('track', g => (g.track = g.status === 'private'));
}

const VEHICLE_WORDS = /\b(CO ?INVEST\w*|INVESTORS|INVESTMENTS|FUND|PARTNERS|SPV|SERIES OF|EXPOSURE)\b/;
const DEBT_WORDS = /\b(NOTE|NOTES|LOAN|DEBENTURE)\b|%/;
function isVehicleFor(raw, phrase) {
  for (const m of raw.matchAll(/\(([^)]*)\)/g)) {
    if (words(m[1]).includes(phrase)) return !DEBT_WORDS.test(m[1]);
  }
  const w = words(raw.replace(/\([^)]*\)/g, ' '));
  const at = w.indexOf(phrase);
  if (at < 0) return false;
  if (at === 0) return /\bSPV\b/.test(w); // "KALSHI SPV EXPOSURE", not "ICAPITAL MILLENNIUM FUND"
  return VEHICLE_WORDS.test(w);
}

function suggestCompanies(clusters, { listing = new Map(), curation = {} } = {}) {
  const issues = [];
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
    // A key that is a whole-word prefix of exactly one anchor: "ANDURIL" ->
    // "ANDURIL INDUSTRIES", "NSCALE" -> "NSCALE GLOBAL".
    if (key.length >= 5) {
      const hits = [...byAnchor.keys()].filter(a => a.startsWith(`${key} `));
      if (hits.length === 1) return { group: byAnchor.get(hits[0]), reason: `prefix of "${hits[0]}"` };
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
  applyMerges(curation, { clusters, groups, groupOfKey, add, issues });

  // Named SPVs: a vehicle row (outside every group) that names a private
  // company as whole words, either in parentheses ("TIGER GLOBAL PIP 12-1, LLC
  // (INVESTED IN DATABRICKS…)") or after vehicle words ("CARLYLE SYNIVERSE CO
  // INVEST LP", "HEDOSOPHIA VINTED INVESTMENTS"). Not: a company whose name
  // merely contains another's ("FORUM ENERGY TECHNOLOGIES"), a company's own
  // fund ("ICAPITAL MILLENNIUM FUND": the name comes first), or a vehicle whose
  // parenthetical describes a note or loan (debt, not equity exposure).
  const phrases = groups
    .filter(g => g.anchor.key.length >= 5 && g.anchor.l3Share >= PRIVATE_L3 && !KNOWN_STATUS[g.anchor.key])
    .map(g => ({ g, phrase: words(g.anchor.key) }))
    .sort((a, b) => b.phrase.length - a.phrase.length);
  for (const c of clusters.values()) {
    if (groupOfKey.has(c.key)) continue;
    for (const [raw, n] of c.raw) {
      const hit = phrases.find(p => isVehicleFor(raw, p.phrase));
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
    const first = field =>
      members
        .map(c => c[field])
        .filter(Boolean)
        .sort((a, b) => a.date.localeCompare(b.date))[0];
    const lockup = first('lockup');
    const pipe = first('pipe');
    const evidencePublic = listed || lockup || pipe;
    g.status = known ? known.status : evidencePublic ? 'public' : g.l3Share >= PRIVATE_L3 ? 'private' : 'public';
    g.note = known
      ? known.note
      : listed
        ? `Listed: ${listed.filings} filings price it at Level 1 with a valid ISIN/CUSIP in ${listed.quarter} (e.g. ${listed.sample_accession}${listed.sample_cusip ? `, CUSIP ${listed.sample_cusip}` : ''}).`
        : lockup
          ? `Public: funds report post-IPO lock-up shares from ${lockup.date} ("${lockup.text}", ${lockup.accession}).`
          : pipe
            ? `Public: funds report PIPE shares (a private placement in a listed company) from ${pipe.date} ("${pipe.text}", ${pipe.accession}).`
            : '';
    g.flags = [
      FUND_LIKE.test(g.anchor.key) && 'fund interest?',
      REINSURANCE.test(g.anchor.key) && 'reinsurance vehicle?',
      /^CONTRA\b/.test(g.anchor.key) && 'CVR',
      g.anchor.key.length < 4 && 'short key',
      g.status === 'public' && !known && !evidencePublic && `level 3 share ${g.l3Share.toFixed(2)}`,
    ].filter(Boolean);
    g.name = displayName(g.anchor);
  }
  groups.sort((a, b) => b.score - a.score);
  let tracked = 0;
  for (const g of groups) g.track = g.status === 'private' && !g.flags.length && tracked++ < TRACK_TOP;
  applyDecisions(curation, groups, issues);
  // Names must be unique: disambiguate with the key.
  const seen = new Map();
  for (const g of groups) seen.set(g.name, (seen.get(g.name) || 0) + 1);
  for (const g of groups) if (seen.get(g.name) > 1) g.name = `${g.name} (${g.anchor.key})`;
  return { groups, candidates: candidates.length, issues };
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
        reason: s.reason || 'vehicle name contains the company name',
        evidence: s.evidence || s.cluster.evidence?.accession || '',
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

// Firm name from an adviser's own name: its first word, plus the second when
// that is not an entity word ("BlackRock Fund Advisors" -> "BlackRock",
// "J.P. Morgan Investment Management" -> "J.P. Morgan", "Pantheon Infra
// Advisors" -> "Pantheon", "Hamilton Lane Advisors" -> "Hamilton Lane"). Keeps
// the filer's casing and short acronyms ("PGIM", "DWS"). Name evidence only: no
// ownership is assumed (Eaton Vance stays Eaton Vance).
const ENTITY_WORD =
  /^(ADVISORS?|ADVISERS?|ADVISORY|MANAGEMENT|INVESTMENTS?|ASSET|ASSETS|FUNDS?|PARTNERS|GROUP|LLC|INC|LP|L|P|CO|COMPANY|CORP|CORPORATION|LTD|LIMITED|GLOBAL|INTERNATIONAL|AND|OF|US|USA|NORTH|AMERICA|AMERICAS|CAPITAL|PRIVATE|REGISTERED|ALTERNATIVE|ALTERNATIVES|INFRA|WEALTH|FINANCIAL|VENTURES|CREDIT|SOLUTIONS|STRATEGIES|RIC|S3|II|III|IV|GP|AIP|SERVICES|RESEARCH|DIVERSIFYING|EXCHANGETRADED|WORLD|REAL|LIQUID|VARIABLE|HEDGE|TARGET|ETF|GA|SYSTEMATIC|EQUITY|MUTUAL|HERMES)$/;
function managerStem(name) {
  const norm = t => t.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const tokens = String(name || '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\bd\/b\/a\b.*$/i, ' ')
    .split(/[\s,]+/)
    .map(t => t.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9.]+$/g, ''))
    .filter(t => norm(t) && norm(t) !== 'THE');
  if (!tokens.length) return String(name || '').trim();
  // Initials stay with the name they start: "F. L. Putnam" -> "F. L. Putnam".
  let lead = 0;
  while (lead < tokens.length - 1 && norm(tokens[lead]).length === 1) lead++;
  if (lead) return tokens.slice(0, lead + 1).join(' ');
  const pick = tokens.length >= 2 && !ENTITY_WORD.test(norm(tokens[1])) ? tokens.slice(0, 2) : tokens.slice(0, 1);
  const cased = t => (/[a-z]/.test(t) || norm(t).length <= 4 ? t : t[0] + t.slice(1).toLowerCase());
  return pick.map(cased).join(' ');
}
// Registrant names differ in punctuation from v1's list ("…Fund, Inc.").
const registrantKey = n =>
  String(n || '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\b(INC|LLC|THE|CORP|CORPORATION|LTD|LP)\b/g, ' ')
    .replace(/\s+/g, '');

// managerNames: curated adviser file number (or registrant CIK) -> firm name,
// for firms whose adviser name doesn't carry the brand (curation.json).
function suggestManagers(db, { v1Groups = v1FundGroups(), managerNames = {} } = {}) {
  const v1ByRegistrant = new Map();
  for (const [firm, names] of Object.entries(v1Groups))
    for (const n of names) v1ByRegistrant.set(registrantKey(n), firm);
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
    const v1 = v1ByRegistrant.get(registrantKey(f.registrant));
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
      manager: managerNames[e.file_num] || (v1.length === 1 ? v1[0] : managerStem(e.name)),
      kind: 'adviser',
      key: e.file_num,
      name: e.name,
      funds: e.funds,
      private_value_musd: (e.value / 1e6).toFixed(1),
      v1_group: v1.join(' | '),
      flags: managerNames[e.file_num] ? 'curated' : v1.length > 1 ? 'several v1 groups' : v1.length ? '' : 'name stem',
    });
  }
  for (const u of [...unmapped.values()].sort((a, b) => b.value - a.value)) {
    rows.push({
      manager: managerNames[u.cik] || u.v1 || managerStem(u.name || ''),
      kind: 'registrant',
      key: u.cik,
      name: u.name,
      funds: u.funds,
      private_value_musd: (u.value / 1e6).toFixed(1),
      v1_group: u.v1 || '',
      flags: 'no N-CEN adviser',
    });
  }
  // One firm per brand: spellings that differ only in punctuation merge
  // ("JPMorgan" = "J.P. Morgan"), and a one-word brand that starts a v1 firm
  // name joins it ("Franklin" -> "Franklin Templeton").
  const compact = n => n.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const v1Firms = Object.keys(v1Groups);
  const display = new Map();
  for (const r of rows) {
    const k = compact(r.manager);
    if (!display.has(k)) display.set(k, r.manager); // rows are value-ordered
  }
  for (const r of rows) {
    r.manager = display.get(compact(r.manager));
    const v1 = !r.manager.includes(' ') && v1Firms.find(f => f.toUpperCase().startsWith(`${r.manager.toUpperCase()} `));
    if (v1) r.manager = v1;
  }
  return rows;
}
const MANAGER_COLUMNS = ['manager', 'kind', 'key', 'name', 'funds', 'private_value_musd', 'v1_group', 'flags'];

function loadCuration(file = path.join(__dirname, '..', '..', 'data', 'review', 'curation.json')) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
}

module.exports = {
  loadCuration,
  cleanName,
  isVehicleFor,
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
