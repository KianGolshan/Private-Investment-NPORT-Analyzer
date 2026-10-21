#!/usr/bin/env node
// P14 one-off: admit the private operating companies found in the unreviewed
// queue (docs/plans/p14/queue-labels.csv, labeled in session on 2026-10-20)
// into data/review/aliases.csv, the same way "make this a company" does
// (lib/entities/make-company.js): one issuer_key row per key of the name's
// identity component, citing the largest stored row's accession. Duplicates
// found during labeling are merged by the explicit decisions below, never by
// name similarity. Read-only on the warehouse; writes aliases.csv only. Run
// `npm run review:aliases` afterwards (a curation job).
//
//   node scripts/p14-admit-companies.js [--dry-run]
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { parseCsv, toCsv } = require('../lib/entities/csv');
const { ALIAS_COLUMNS } = require('../lib/entities/seed');
const { openWarehouseReadOnly } = require('../lib/warehouse/db');

const ROOT = path.join(__dirname, '..');
const LABELS = path.join(ROOT, 'docs/plans/p14/queue-labels.csv');
const ALIASES = path.join(ROOT, 'data/review/aliases.csv');
const DATE = '2026-10-20';

// Same company under several unreviewed names: [group name, entity ids].
const GROUPS = [
  ['Real Alloy', [64159, 64158]],
  ['EdgeCore Digital Infrastructure', [49454, 49455, 49456]],
  ['Endeavor BioMedicines', [49829, 49828]],
  ['ADARx Pharmaceuticals', [41331, 41330]],
  ['Genesys', [52072, 52071]],
  ['Evolve Vacation Rental', [50440, 50441]],
  ['Shield AI', [65972, 65973]],
  ['Homer City Redevelopment', [56699, 54391]],
  ['Brain Corp', [45019, 45020]],
  ['Workrise', [71211, 71210]],
  ['Crescent Midstream', [48026, 48027]],
  ['Obsidian Therapeutics', [61139, 61140]],
  ['Akur8', [41791, 41790]],
  ['Envision Healthcare', [49981, 49986, 60298]],
  ['GenOn', [52084, 52086]],
  ['Cohesity', [47057, 47215]],
  ['GOAT Group', [19281, 19280]],
  ['Arbor Biotechnologies', [42843, 42842]],
  ['LABL (Multi-Color)', [57255, 57256, 57254, 57252]],
  ['Qonto', [63836, 63838]],
  ['Included Health', [52629, 55205]],
  ['Georgia Banking Company', [51971, 51972, 52125]],
  ['CCF Holdings', [46032, 46033]],
  ['Santander Consumer Bank AS', [65232, 65231]],
  ['ProSomnus', [63533, 63532]],
  ['48forty Solutions', [30625, 30624]],
  ['Clarify Health', [46923, 46922]],
  ['Digicel', [48828, 48829]],
  ['United Site Services', [69587, 69588]],
  ['Brightline West', [45122, 45121]],
  ['Aergo Capital', [41503, 41502]],
  ['Hearthside Food Solutions', [53824, 53823]],
  ['Copia Wealth Studios', [47739, 47738]],
  ['Travelport', [69008]],
];
// Unreviewed names that belong to a company already in the app: entity id -> company id.
const INTO_REVIEWED = { 69022: 42, 41701: 66, 55208: 31, 63630: 15, 45581: 104, 41959: 38, 71092: 72 };
// Left out on purpose (listed, mixed grouping, or needs a person): entity ids.
const EXCLUDE = new Set([
  52049,
  52051, // Generate Biomedicines: post-IPO lockup shares
  66808,
  66809,
  68095, // TeamShares: SPAC PIPE
  61872,
  65263, // Sarcos/Palladyne: listed
  51512, // FreedomPay: raw names include an unrelated Freedom Institute
  41962, // "ALLIANT PRIVATE PLACEMENT": issuer not identified
  56587,
  60326, // Keenova: low confidence
]);

function main() {
  const dry = process.argv.includes('--dry-run');
  const labels = parseCsv(fs.readFileSync(LABELS, 'utf8'));
  const byId = new Map(labels.map(r => [Number(r.entity_id), r]));
  const db = openWarehouseReadOnly();
  const entity = db.prepare('SELECT * FROM unreviewed_entities WHERE id = ?');
  const evidenceOf = db.prepare(
    'SELECT accession FROM holdings WHERE entity_id = ? ORDER BY value_usd DESC, accession LIMIT 1'
  );
  const companyName = db.prepare('SELECT name FROM companies WHERE id = ?');
  const clash = db.prepare('SELECT id FROM companies WHERE name = ? COLLATE NOCASE');

  const admit = label => label && label.entity_type === 'operating_company' && label.confidence !== 'low';
  const plan = new Map(); // company name -> { ids, label, into }
  const used = new Set();
  for (const [name, ids] of GROUPS) {
    const live = ids.filter(id => !EXCLUDE.has(id));
    if (!live.some(id => admit(byId.get(id)))) continue;
    plan.set(name, { ids: live, label: byId.get(live.find(id => admit(byId.get(id)))) });
    live.forEach(id => used.add(id));
  }
  for (const [eid, cid] of Object.entries(INTO_REVIEWED)) {
    const name = companyName.get(cid)?.name;
    if (!name) throw new Error(`reviewed company ${cid} not found`);
    const p = plan.get(name) || { ids: [], label: byId.get(Number(eid)), into: cid };
    p.ids.push(Number(eid));
    plan.set(name, p);
    used.add(Number(eid));
  }
  for (const r of labels) {
    const id = Number(r.entity_id);
    if (used.has(id) || EXCLUDE.has(id) || !admit(r) || /merge candidate/.test(r.note)) continue;
    plan.set(r.clean_name, { ids: [id], label: r });
  }

  const rows = parseCsv(fs.readFileSync(ALIASES, 'utf8'));
  // rows added to a reviewed company keep its status, track and category
  const existing = new Map();
  for (const r of rows) if (r.company && !existing.has(r.company)) existing.set(r.company, r);
  const owner = new Map(rows.filter(r => r.kind === 'issuer_key' && r.company).map(r => [r.alias, r.company]));
  const out = [];
  const problems = [];
  let keys = 0;
  for (const [name, p] of plan) {
    if (!p.into && clash.get(name)) problems.push(`"${name}" is already a company name`);
    for (const id of p.ids) {
      const e = entity.get(id);
      if (!e) {
        problems.push(`entity ${id} (${name}) not found`);
        continue;
      }
      const evidence = evidenceOf.get(id)?.accession;
      if (!evidence) problems.push(`entity ${id} (${name}) has no rows to cite`);
      const examples = JSON.parse(e.names).slice(0, 3).join(' | ');
      const l = byId.get(id) || p.label;
      for (const k of JSON.parse(e.keys)) {
        if (owner.has(k) && owner.get(k) !== name) {
          problems.push(`issuer key "${k}" already belongs to "${owner.get(k)}" (wanted by "${name}")`);
          continue;
        }
        owner.set(k, name);
        keys++;
        const base = p.into ? existing.get(name) : null;
        out.push({
          company: name,
          status: base ? base.status : 'private',
          track: base ? base.track : 'N',
          category: base ? base.category : '',
          kind: 'issuer_key',
          alias: k,
          via_spv: '0',
          examples,
          reason: `P14 review ${DATE}: ${p.into ? 'merged into the reviewed company' : 'operating private company found in the unreviewed queue'} (was unreviewed ${e.category}; label ${l.confidence})`,
          evidence,
          note: l.note || '',
        });
      }
    }
  }
  const newCos = [...plan.values()].filter(p => !p.into).length;
  console.log(`companies: ${newCos} new, ${plan.size - newCos} existing with added names; issuer keys: ${keys}`);
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exitCode = 1;
    return;
  }
  if (dry) return;
  fs.writeFileSync(ALIASES, toCsv(ALIAS_COLUMNS, [...rows, ...out]));
  console.log(`aliases.csv: +${out.length} rows`);
}

main();
