// Nightly watch reports (ROADMAP §8): what changed between the published
// generation and the one before it that a reviewer should look at. Suggestions
// only, never applied: a status change moves a company between the warehouse
// and the live path (ADR 0008), and an identity link changes every number of
// the companies it joins.
//
//   1. review queue: unreviewed company-like names now over the agreed
//      threshold (>= $50M held by >= 2 funds, entities report `overdue`), new
//      ones first;
//   2. listing evidence: a private company's alias key now trades as listed
//      stock in a bulk quarter (listing_evidence, written with each bulk
//      quarter): a possible IPO;
//   3. identity evidence: a new instrument-id, share-count or same-mark link
//      between a reviewed company's key and a name no company claims: a
//      possible rename or codename;
//   4. split identities: one filer instrument id under two private companies
//      in one fund (a filer relabel the curation split apart: BlackRock's
//      "DF Residential I LP" became "DF Residential III LP" with the same id and
//      share count, P8 W3), which reads as a false exit plus a false new position.
// Read-only over two generation files.
const THRESHOLD_USD = 50e6;
const THRESHOLD_FUNDS = 2;
const STRONG = ['instrument_id', 'share_count', 'same_mark'];

const overThreshold = db =>
  db
    .prepare(
      `SELECT key, display_name name, current_value_usd value, current_funds funds FROM unreviewed_entities
       WHERE active = 1 AND category IN ('company', 'linked') AND current_value_usd >= ? AND current_funds >= ?
       ORDER BY current_value_usd DESC`
    )
    .all(THRESHOLD_USD, THRESHOLD_FUNDS);

// alias key -> { id, name } of private companies
function privateKeys(db) {
  const out = new Map();
  for (const r of db
    .prepare(
      `SELECT a.pattern key, c.id, c.name FROM company_aliases a JOIN companies c ON c.id = a.company_id
       WHERE a.kind = 'issuer_key' AND c.status = 'private'`
    )
    .all())
    out.set(r.key, { id: r.id, name: r.name });
  return out;
}

const listingRows = db =>
  db
    .prepare('SELECT issuer_key, quarter, filings, value_usd, sample_accession, sample_cusip FROM listing_evidence')
    .all();

// keys of names no reviewed company claims
function unclaimedKeys(db) {
  const keys = new Map();
  for (const r of db.prepare('SELECT key, display_name, keys FROM unreviewed_entities WHERE active = 1').all())
    for (const k of JSON.parse(r.keys || '[]')) keys.set(k, { entity: r.key, name: r.display_name });
  return keys;
}

const edgeId = e => `${e.a}\u0000${e.b}\u0000${e.kind}`;
const strongEdges = db =>
  db
    .prepare(
      `SELECT a, b, kind, accession, confidence, detail FROM identity_edges
       WHERE kind IN (${STRONG.map(() => '?').join(',')}) AND confidence IN ('high', 'medium')`
    )
    .all(...STRONG);

// placeholders filers put in the id field ("OTHER" under Waymo, Stripe, Canva and Kraken in one fund)
const NO_ID = ['', 'N/A', 'NA', 'NONE', 'OTHER', '000000000', '999999999'];
const splitIds = db =>
  db
    .prepare(
      `WITH r AS (SELECT h.other_id, h.company_id, f.fund_key, f.report_date FROM holdings h
                  JOIN filings f USING (accession) JOIN companies c ON c.id = h.company_id AND c.status = 'private'
                  WHERE h.other_id IS NOT NULL AND upper(h.other_id) NOT IN (${NO_ID.map(() => '?').join(',')}))
       SELECT a.other_id id, a.fund_key fundKey, a.company_id a, b.company_id b,
              (SELECT name FROM companies WHERE id = a.company_id) aName,
              (SELECT name FROM companies WHERE id = b.company_id) bName, COUNT(*) pairs, MAX(a.report_date, b.report_date) last
       FROM r a JOIN r b ON a.other_id = b.other_id AND a.fund_key = b.fund_key AND a.company_id < b.company_id
       GROUP BY 1, 2, 3, 4 ORDER BY pairs DESC`
    )
    .all(...NO_ID);

function watchReport(current, previous) {
  // 1. review queue
  const now = overThreshold(current);
  const before = new Set(previous ? overThreshold(previous).map(r => r.key) : []);
  const queue = now.map(r => ({ ...r, isNew: !before.has(r.key) }));

  // 2. listing evidence for private companies
  const priv = privateKeys(current);
  const seen = new Set(previous ? listingRows(previous).map(r => `${r.issuer_key}\u0000${r.quarter}`) : []);
  const listing = listingRows(current)
    .filter(r => priv.has(r.issuer_key))
    .map(r => ({ ...r, company: priv.get(r.issuer_key), isNew: !seen.has(`${r.issuer_key}\u0000${r.quarter}`) }))
    .sort((a, b) => b.quarter.localeCompare(a.quarter) || b.value_usd - a.value_usd);

  // 3. identity evidence between a company key and an unclaimed name
  const unclaimed = unclaimedKeys(current);
  const had = new Set(previous ? strongEdges(previous).map(edgeId) : []);
  const identity = [];
  for (const e of strongEdges(current)) {
    const [co, other] = priv.has(e.a) ? [e.a, e.b] : priv.has(e.b) ? [e.b, e.a] : [null, null];
    if (!co || !unclaimed.has(other)) continue;
    identity.push({
      company: priv.get(co),
      companyKey: co,
      name: unclaimed.get(other).name,
      entity: unclaimed.get(other).entity,
      kind: e.kind,
      confidence: e.confidence,
      accession: e.accession,
      detail: e.detail,
      isNew: !had.has(edgeId(e)),
    });
  }
  // 4. split identities
  const hadSplit = new Set(previous ? splitIds(previous).map(x => `${x.id}\u0000${x.fundKey}`) : []);
  const split = splitIds(current).map(x => ({ ...x, isNew: !hadSplit.has(`${x.id}\u0000${x.fundKey}`) }));

  const fresh = list => list.filter(x => x.isNew).length;
  return {
    queue,
    listing,
    identity,
    split,
    counts: {
      queue: queue.length,
      queueNew: fresh(queue),
      listing: listing.length,
      listingNew: fresh(listing),
      identity: identity.length,
      identityNew: fresh(identity),
      split: split.length,
      splitNew: fresh(split),
    },
  };
}

const usd = v => `$${(v / 1e6).toFixed(1)}M`;
const mark = x => (x.isNew ? '**new** ' : '');
// The report as Markdown (reports/watch/<date>.md).
function watchMarkdown(r, { generation, previous, date }) {
  const lines = [
    `# Watch report ${date}`,
    '',
    `Generation ${generation}${previous ? ` against ${previous}` : ' (no earlier generation)'}. Suggestions only: ` +
      'nothing here is applied. Review through `data/review` and `npm run review:aliases`.',
    '',
    `## Review queue: ${r.counts.queue} name(s) over $50M in 2+ funds (${r.counts.queueNew} new)`,
    '',
    ...(r.queue.length
      ? r.queue.map(q => `- ${mark(q)}${q.name} (\`${q.key}\`): ${usd(q.value)} in ${q.funds} funds`)
      : ['None.']),
    '',
    `## Listing evidence for private companies: ${r.counts.listing} (${r.counts.listingNew} new)`,
    '',
    "A private company's key held as listed stock in a bulk quarter: check whether it listed (ADR 0008).",
    '',
    ...(r.listing.length
      ? r.listing
          .slice(0, 50)
          .map(
            l =>
              `- ${mark(l)}${l.company.name} (id ${l.company.id}), ${l.quarter}: ${l.filings} filing(s), ${usd(l.value_usd)}, ` +
              `e.g. ${l.sample_accession}${l.sample_cusip ? ` (CUSIP ${l.sample_cusip})` : ''}`
          )
      : ['None.']),
    '',
    `## Identity evidence: ${r.counts.identity} link(s) to unclaimed names (${r.counts.identityNew} new)`,
    '',
    ...(r.identity.length
      ? r.identity
          .slice(0, 50)
          .map(
            i =>
              `- ${mark(i)}${i.company.name} (id ${i.company.id}, \`${i.companyKey}\`) ~ ${i.name} (\`${i.entity}\`): ` +
              `${i.kind} (${i.confidence})${i.accession ? `, ${i.accession}` : ''}${i.detail ? `: ${i.detail}` : ''}`
          )
      : ['None.']),
    '',
    `## Split identities: ${r.counts.split} instrument id(s) under two companies in one fund (${r.counts.splitNew} new)`,
    '',
    "A filer's one instrument id, under two private companies: a relabel that reads as an exit plus a new position.",
    '',
    ...(r.split.length
      ? r.split
          .slice(0, 50)
          .map(
            x =>
              `- ${mark(x)}\`${x.id}\` in fund ${x.fundKey}: ${x.aName} (id ${x.a}) and ${x.bName} (id ${x.b}), ` +
              `${x.pairs} row pair(s), last ${x.last}`
          )
      : ['None.']),
    '',
  ];
  return lines.join('\n');
}

module.exports = { watchReport, watchMarkdown, THRESHOLD_USD };
