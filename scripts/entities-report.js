#!/usr/bin/env node
// The unresolved-value report: the entity review queue after every refresh
// (lib/entities/report.js, ROADMAP §Phase 4.5). Rebuilds the identity graph in
// warehouse.db, then writes
//
//   reports/entities/unresolved.csv   private-candidate value resolving to no company, by component
//   reports/entities/conflicts.csv    evidence edges a guard stopped (flagged, not merged)
//
//   node scripts/entities-report.js [--threshold 50]   # $M; components at or above it are flagged
const path = require('path');
const { openWarehouse } = require('../lib/warehouse/db');
const { writeEntityReport, overdue } = require('../lib/entities/report');

const OUT = path.join(__dirname, '..', 'reports', 'entities');

function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf('--threshold');
  const threshold = (at >= 0 ? Number(args[at + 1]) : 50) * 1e6;
  if (!(threshold > 0)) throw new Error('--threshold must be a positive number of $M');
  const db = openWarehouse();
  const t = Date.now();
  try {
    const { up, report } = writeEntityReport(db, OUT, { threshold });
    const applied = up.graph.edges.filter(e => e.applied).length;
    console.log(
      `identity: ${up.graph.nodes.size} issuer keys, ${up.graph.edges.length} evidence edges (${applied} applied, ` +
        `${report.conflicts.length} conflicts), ${up.graph.vehicles.size} per-fund vehicles`
    );
    const sum = list => list.reduce((s, c) => s + c.value_musd, 0);
    console.log(`unresolved at each active fund's latest filing (as of ${report.asOf}):`);
    for (const cat of ['linked', 'company', 'vehicle', 'fund', 'level12', 'listed']) {
      const list = report.components.filter(c => c.category === cat);
      const over = list.filter(c => c.over_threshold);
      console.log(
        `  ${cat.padEnd(8)} ${String(list.length).padStart(6)} components  $${sum(list).toFixed(0).padStart(7)}M` +
          `   ${over.length} at or over $${threshold / 1e6}M ($${sum(over).toFixed(0)}M)`
      );
    }
    console.log('top unresolved companies, vehicles and linked names:');
    for (const c of report.components.filter(x => ['linked', 'company', 'vehicle'].includes(x.category)).slice(0, 25))
      console.log(
        `  $${String(c.value_musd).padStart(7)}M ${String(c.funds).padStart(3)} funds  ${c.category.padEnd(7)} ${c.names.slice(0, 90)}`
      );
    const tr = report.tracked;
    console.log(
      `tracked companies: $${(tr.resolved / 1e6).toFixed(0)}M resolved, $${(tr.unresolved / 1e6).toFixed(1)}M ` +
        `unresolved (${(tr.share * 100).toFixed(2)}%)`
    );
    for (const [name, v] of tr.top.slice(0, 8)) console.log(`  $${(v / 1e6).toFixed(1).padStart(6)}M  ${name}`);
    const due = overdue(report);
    console.log(
      `over the threshold ($${threshold / 1e6}M, 2+ funds) and not a vehicle: ${due.length}` +
        (due.length ? ` (${due.map(c => c.names.split(' | ')[0]).join('; ')})` : '')
    );
    console.log(`wrote ${path.relative(process.cwd(), OUT)}/{unresolved,conflicts}.csv`);
  } finally {
    db.close();
    console.log(`done in ${((Date.now() - t) / 1000).toFixed(1)} s`);
  }
}

main();
