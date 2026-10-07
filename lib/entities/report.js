// The identity graph over the whole warehouse, stored after every ingest, and
// the unresolved-value report built from it (ROADMAP §Phase 4.5, LESSONS 23:
// measure misses by dollars, not by hunting name patterns).
//
// identityUpkeep(db) rebuilds identity_edges / identity_nodes. The graph is
// linked with the imported companies as the guard: holdings.company_id of a
// key's direct rows are its "curated companies", companies.status and listing
// evidence give "listed" / "private". Curation drops join nothing and
// curation.separate pairs never join.
//
// unresolvedReport(...) ranks the private-candidate value that resolves to no
// company, by component, at each active fund's latest canonical filing (the
// as-of rules of ADR 0004: inactive after 123 days). Categories:
//   linked     a member resolves to a company: the next seed + import picks it up
//   listed     listing evidence or a public company: not a private candidate
//   vehicle    per-fund holding vehicles whose target names no company (opaque)
//   fund       a fund interest or vehicle by name (PE/VC/hedge fund LP, co-invest,
//              feeder, master portfolio, CLO, continuation vehicle, series LLC)
//   level12    under 10% of the value at fair-value Level 3: looks public (the seed's rule)
//   company    an operating-company candidate
const fs = require('fs');
const path = require('path');
const { toCsv } = require('./csv');
const { buildIdentity, linkComponents, identityRows, fundFamilies } = require('./identity');
const { latestListingEvidence, BORDERLINE_L3 } = require('./seed');
const { FUND_LIKE } = require('./names');
const { INACTIVE_DAYS } = require('../analytics/asof');

// Under 10% of the value at Level 3 looks public (the seed's rule).
const PUBLIC_LOOKING = BORDERLINE_L3;
// Pooled vehicles by name, beyond FUND_LIKE: CLOs, aggregators, continuation
// vehicles, series LLCs, reinsurance segregated accounts.
const POOLED_VEHICLE_WORDS = /\b(CLO|AGGREGATOR|CV|SERIES OF|SEGREGATED ACCOUNT|CO INVEST\w*|CO-INVEST\w*)\b/;
const DAY_MS = 86400000;

// curation: the reviewed decisions (lib/warehouse/curation.js curationFor), always
// passed in: the generation must record exactly what it used (V02).
function identityUpkeep(db, { curation, rows = identityRows(db) } = {}) {
  if (!curation) throw new Error('identityUpkeep needs the curation (lib/warehouse/curation.js curationFor)');
  const graph = buildIdentity(rows, { families: fundFamilies(db) });
  const knownStatus = curation.status || {};
  const listing = latestListingEvidence(db);
  const status = new Map(
    db
      .prepare('SELECT id, status FROM companies')
      .all()
      .map(c => [c.id, c.status])
  );
  const companiesOfKey = new Map();
  for (const r of rows) {
    if (!r.key || !r.company_id || r.via_spv) continue;
    if (!companiesOfKey.has(r.key)) companiesOfKey.set(r.key, new Set());
    companiesOfKey.get(r.key).add(r.company_id);
  }
  const keysOfCompany = new Map();
  for (const [key, ids] of companiesOfKey)
    for (const id of ids) {
      if (!keysOfCompany.has(id)) keysOfCompany.set(id, []);
      keysOfCompany.get(id).push(key);
    }
  const link = linkComponents(graph, {
    statusOf: key => {
      if (listing.has(key) || knownStatus[key]?.status === 'public') return 'public';
      const ids = [...(companiesOfKey.get(key) || [])];
      return ids.some(id => status.get(id) === 'public') ? 'public' : ids.length ? 'private' : '';
    },
    companiesOf: key => [...(companiesOfKey.get(key) || [])],
    separate: curation.separate || [],
    exclude: new Set((curation.drop || []).map(d => d.key)),
    preset: [...keysOfCompany.values()],
  });
  db.transaction(() => {
    db.prepare('DELETE FROM identity_edges').run();
    db.prepare('DELETE FROM identity_nodes').run();
    const edge = db.prepare(
      `INSERT OR REPLACE INTO identity_edges (a, b, kind, accession, confidence, detail, applied, conflict)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const e of graph.edges)
      edge.run(e.a, e.b, e.kind, e.accession, e.confidence, e.detail || null, e.applied ? 1 : 0, e.conflict || null);
    const node = db.prepare('INSERT INTO identity_nodes (key, component, vehicle_target) VALUES (?, ?, ?)');
    for (const c of link.components.values()) {
      if (c.keys.length < 2) continue;
      for (const k of c.keys) node.run(k, c.root, graph.vehicles.get(k)?.target || null);
    }
  })();
  const companies = new Map(
    db
      .prepare(
        `SELECT c.id, c.name, c.status, (t.company_id IS NOT NULL) tracked,
           (SELECT GROUP_CONCAT(pattern, '\u0001') FROM company_aliases a
            WHERE a.company_id = c.id AND a.kind = 'issuer_key') keys
         FROM companies c LEFT JOIN tracked_companies t ON t.company_id = c.id`
      )
      .all()
      .map(c => [c.id, { ...c, keys: c.keys ? c.keys.split('\u0001') : [] }])
  );
  return { rows, graph, link, listing, companiesOfKey, companies, knownStatus, latest: latestFilings(db) };
}

// Each fund's latest canonical report date, from its filings (whatever they
// hold), and the newest report date in the warehouse.
function latestFilings(db) {
  const byFund = new Map(
    db
      .prepare('SELECT fund_key, MAX(report_date) d FROM canonical_filings GROUP BY fund_key')
      .all()
      .map(r => [r.fund_key, r.d])
  );
  let asOf = '';
  for (const d of byFund.values()) if (d > asOf) asOf = d;
  return { byFund, asOf };
}

// What an unresolved component most likely is (the review queue's categories,
// top of this file). ctx: the identity upkeep (graph, listing, companiesOfKey,
// companies by id, knownStatus). companies: the curated companies its keys touch.
function componentCategory(ctx, { keys, rawNames, l3Share }) {
  const { graph, listing, companiesOfKey, companies: byId = new Map(), knownStatus = {} } = ctx;
  const companies = new Set(keys.flatMap(k => [...(companiesOfKey.get(k) || [])]));
  const linkedPublic = [...companies].some(id => byId.get(id)?.status === 'public');
  const category = linkedPublic
    ? 'listed'
    : companies.size
      ? 'linked'
      : keys.some(k => listing.has(k) || knownStatus[k]?.status === 'public')
        ? 'listed'
        : keys.every(k => graph.vehicles.has(k))
          ? 'vehicle'
          : keys.some(k => FUND_LIKE.test(k) || POOLED_VEHICLE_WORDS.test(k)) ||
              [...rawNames].some(n => POOLED_VEHICLE_WORDS.test(n.toUpperCase()))
            ? 'fund'
            : l3Share < PUBLIC_LOOKING
              ? 'level12'
              : 'company';
  return { category, companies };
}

// The rows each active fund reports now: its latest canonical filing, as in
// exposureAsOf at the newest report date (a fund whose latest filing lacks a
// row has exited; no filing within 123 days means inactive). The latest filing
// comes from the fund's filings, not its rows: a fund whose newest filing holds
// no private-candidate row still has that newest filing (it exited).
function currentRows(rows, { byFund, asOf }) {
  const cutoff = new Date(Date.parse(asOf) - INACTIVE_DAYS * DAY_MS).toISOString().slice(0, 10);
  return { asOf, rows: rows.filter(r => r.key && byFund.get(r.fund_key) === r.report_date && r.report_date >= cutoff) };
}

function unresolvedReport(
  { rows, graph, link, listing, companiesOfKey, companies = new Map(), knownStatus = {}, latest },
  { threshold = 50e6 } = {}
) {
  const { asOf, rows: current } = currentRows(rows, latest);
  const companiesById = companies;
  const comps = new Map();
  for (const r of current) {
    if (r.company_id) continue;
    const root = link.componentOf.get(r.key) || r.key;
    let c = comps.get(root);
    if (!c) {
      c = { root, value: 0, l3: 0, funds: new Set(), raw: new Map(), top: null };
      comps.set(root, c);
    }
    c.value += r.value_usd;
    if (r.fv_level === '3') c.l3 += r.value_usd;
    c.funds.add(r.fund_key);
    const raw = (r.issuer_name || r.title || '').trim();
    c.raw.set(raw, (c.raw.get(raw) || 0) + r.value_usd);
    if (!c.top || r.value_usd > c.top.value_usd) c.top = r;
  }
  const out = [];
  const ctx = { graph, listing, companiesOfKey, companies: companiesById, knownStatus };
  for (const c of comps.values()) {
    const keys = link.components.get(c.root)?.keys || [c.root];
    const { category, companies } = componentCategory(ctx, { keys, rawNames: c.raw.keys(), l3Share: c.l3 / c.value });
    out.push({
      component: c.root,
      category,
      value_musd: +(c.value / 1e6).toFixed(1),
      funds: c.funds.size,
      level3_share: +(c.value ? c.l3 / c.value : 0).toFixed(2),
      keys: keys.length,
      names: [...c.raw]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([n]) => n)
        .join(' | '),
      vehicle_target: keys.map(k => graph.vehicles.get(k)?.target).find(Boolean) || '',
      largest_accession: c.top.accession,
      largest_mark_date: c.top.report_date,
      largest_value_musd: +(c.top.value_usd / 1e6).toFixed(1),
      linked_company_ids: [...companies].join(' '),
      over_threshold: c.value >= threshold ? 'Y' : '',
    });
  }
  out.sort((a, b) => b.value_musd - a.value_musd);
  // Conflicts with the value they touch now, largest first.
  const valueOfKey = new Map();
  for (const r of current) valueOfKey.set(r.key, (valueOfKey.get(r.key) || 0) + r.value_usd);
  const conflicts = link.conflicts
    .map(e => ({
      a: e.a,
      b: e.b,
      kind: e.kind,
      accession: e.accession,
      detail: e.detail || '',
      reason: e.conflict,
      value_musd: +(((valueOfKey.get(e.a) || 0) + (valueOfKey.get(e.b) || 0)) / 1e6).toFixed(1),
    }))
    .sort((x, y) => y.value_musd - x.value_musd);
  return { asOf, components: out, conflicts, threshold, tracked: trackedUnresolved(current, link, companiesById) };
}

// Unresolved tracked exposure (ROADMAP §Phase 4/4.5 success criterion): at
// each active fund's latest filing, the value that resolves to no company but
// sits in a tracked company's evidence component or names a tracked company's
// key as whole words ("... (INVESTED IN DATABRICKS)"), over that plus the value
// resolved to tracked companies (direct and indirect).
function trackedUnresolved(current, link, companies) {
  const tracked = [...companies.values()].filter(c => c.tracked);
  const trackedIds = new Set(tracked.map(c => c.id));
  const words = s =>
    ` ${String(s || '')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, ' ')
      .trim()} `;
  const phrases = tracked.flatMap(c => c.keys.filter(k => k.length >= 5).map(k => ({ id: c.id, phrase: words(k) })));
  const trackedRoots = new Set();
  for (const c of tracked)
    for (const k of c.keys) if (link.componentOf.has(k)) trackedRoots.add(link.componentOf.get(k));
  let resolved = 0;
  let unresolved = 0;
  const misses = new Map();
  for (const r of current) {
    if (r.company_id) {
      if (trackedIds.has(r.company_id)) resolved += r.value_usd;
      continue;
    }
    const text = words(`${r.issuer_name} ${r.title}`);
    const hit = trackedRoots.has(link.componentOf.get(r.key)) || phrases.find(p => text.includes(p.phrase));
    if (!hit) continue;
    unresolved += r.value_usd;
    const name = (r.issuer_name || r.title || '').trim();
    misses.set(name, (misses.get(name) || 0) + r.value_usd);
  }
  return {
    resolved,
    unresolved,
    share: resolved + unresolved ? unresolved / (resolved + unresolved) : 0,
    top: [...misses].sort((x, y) => y[1] - x[1]).slice(0, 15),
  };
}

const REPORT_COLUMNS = [
  'component',
  'category',
  'value_musd',
  'funds',
  'level3_share',
  'keys',
  'names',
  'vehicle_target',
  'largest_accession',
  'largest_mark_date',
  'largest_value_musd',
  'linked_company_ids',
  'over_threshold',
];
const CONFLICT_COLUMNS = ['a', 'b', 'kind', 'accession', 'detail', 'reason', 'value_musd'];

// The review queue: rebuild the graph, rank what is unresolved, write
// <dir>/unresolved.csv and <dir>/conflicts.csv (npm run entities:report, and
// every npm run refresh).
function writeEntityReport(db, dir, { threshold = 50e6, curation } = {}) {
  const up = identityUpkeep(db, { curation });
  const report = unresolvedReport(up, { threshold });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'unresolved.csv'), toCsv(REPORT_COLUMNS, report.components));
  fs.writeFileSync(path.join(dir, 'conflicts.csv'), toCsv(CONFLICT_COLUMNS, report.conflicts));
  return { up, report };
}

// Components the agreed threshold says must be resolved (user, 2026-09-30:
// >= $50M held by >= 2 funds) that are not opaque vehicles on the list.
const overdue = report =>
  report.components.filter(
    c => ['company', 'linked'].includes(c.category) && c.value_musd * 1e6 >= report.threshold && c.funds >= 2
  );

module.exports = {
  identityUpkeep,
  unresolvedReport,
  componentCategory,
  writeEntityReport,
  overdue,
  currentRows,
  latestFilings,
  REPORT_COLUMNS,
  CONFLICT_COLUMNS,
};
