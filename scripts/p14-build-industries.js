#!/usr/bin/env node
// P14 one-off: write data/review/industries.csv, the reviewed industry decision
// for every private operating company (category company) in the published
// warehouse, from the labels made in session on 2026-10-20:
//   docs/plans/p14/gold-labels.csv   the 197 companies reviewed before P14, by company id;
//   docs/plans/p14/queue-labels.csv  the names admitted from the unreviewed queue, by
//                                    entity id, mapped to their company through the
//                                    entity's issuer keys in data/review/aliases.csv.
// A company with no usable label fails the run, so every company gets a decision.
// Read-only on the warehouse. Then run `npm run review:aliases` (it imports the file).
//
//   node scripts/p14-build-industries.js [--dry-run]
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { parseCsv, toCsv } = require('../lib/entities/csv');
const { INDUSTRY_COLUMNS } = require('../lib/entities/review');
const { openWarehouseReadOnly } = require('../lib/warehouse/db');

const ROOT = path.join(__dirname, '..');
const read = f => parseCsv(fs.readFileSync(path.join(ROOT, f), 'utf8'));
const RANK = { high: 3, medium: 2, low: 1, unclear: 0 };

// Reviewed companies the in-session labels could not classify, decided here
// with what the filings and a web search showed (2026-10-20).
const DECIDED = {
  MYT: {
    industry: 'cons.retail',
    confidence: 'medium',
    note: 'MYT Holding; tied to Neiman Marcus through the MYT guarantor entities in its filings',
  },
};

function main() {
  const db = openWarehouseReadOnly();
  const companies = db
    .prepare("SELECT id, name FROM companies WHERE status = 'private' AND category = 'company' ORDER BY id")
    .all();
  const gold = new Map(read('docs/plans/p14/gold-labels.csv').map(r => [Number(r.id), r]));
  const ownerOfKey = new Map(
    read('data/review/aliases.csv')
      .filter(r => r.kind === 'issuer_key' && r.company)
      .map(r => [r.alias, r.company])
  );
  const keysOf = db.prepare('SELECT keys FROM unreviewed_entities WHERE id = ?');
  const byCompany = new Map(); // company name -> best queue label
  for (const r of read('docs/plans/p14/queue-labels.csv')) {
    if (r.entity_type !== 'operating_company' || !r.industry) continue;
    const e = keysOf.get(Number(r.entity_id));
    if (!e) continue;
    const owners = new Set(
      JSON.parse(e.keys)
        .map(k => ownerOfKey.get(k))
        .filter(Boolean)
    );
    for (const name of owners) {
      const have = byCompany.get(name);
      if (!have || RANK[r.confidence] > RANK[have.confidence]) byCompany.set(name, r);
    }
  }

  const rows = [];
  const missing = [];
  for (const c of companies) {
    const g = gold.get(c.id);
    const q = byCompany.get(c.name);
    const d = DECIDED[c.name];
    if (d) rows.push({ company_id: c.id, company: c.name, themes: '', source: 'p14-review', ...d });
    else if (g && g.industry)
      rows.push({
        company_id: c.id,
        company: c.name,
        industry: g.industry,
        themes: g.themes,
        confidence: g.confidence,
        source: 'p14-review',
        note: g.note,
      });
    else if (q)
      rows.push({
        company_id: c.id,
        company: c.name,
        industry: q.industry,
        themes: q.themes,
        confidence: q.confidence,
        source: 'p14-queue',
        note: q.note,
      });
    else if (g)
      rows.push({
        company_id: c.id,
        company: c.name,
        industry: '',
        themes: '',
        confidence: 'unclear',
        source: 'p14-review',
        note: g.note || 'not yet classified',
      });
    else missing.push(`${c.id} ${c.name}`);
  }
  if (missing.length) {
    console.error(`${missing.length} private companies have no label:\n${missing.join('\n')}`);
    process.exitCode = 1;
    return;
  }
  const counts = rows.reduce((m, r) => ((m[r.confidence] = (m[r.confidence] || 0) + 1), m), {});
  console.log(`industries.csv: ${rows.length} companies`, counts);
  if (!process.argv.includes('--dry-run'))
    fs.writeFileSync(path.join(ROOT, 'data/review/industries.csv'), toCsv(INDUSTRY_COLUMNS, rows));
}

main();
