#!/usr/bin/env node
// Rebuilds test/fixtures/fund/ from the REAL warehouse.db (no network):
//
//   node test/fixtures/fund/build-fixture.js [path/to/warehouse.db]
//
// Exports whole funds for the fund page (ROADMAP §5b task 3): every filing of
// each fund below, every stored row of those filings, their filing_totals and
// capital-structure rows, and the companies, tracked entries and unreviewed
// entities those rows point at. Nothing in the output is hand-written.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const Database = require('better-sqlite3');
const { defaultWarehousePath } = require('../../../lib/warehouse/db');

const OUT = __dirname;
const FUNDS = {
  S000009228: 'Growth Fund of America: Anthropic F1/F2, Stripe, Databricks, OpenAI',
  CIK2044519: 'Coatue Innovative Strategies: an NPORT-P/A replaces its NPORT-P (F16)',
  S000007191: 'Fidelity OTC Portfolio: holds Stripe 2025-10-31, no Stripe row 2026-01-31 (F8/F9)',
  S000008787: 'American High Income (AFIS High-Income Bond Fund): Mesquite reported at $0 (F34)',
  S000011440: 'Northeast Investors Trust: Westmoreland Mining equity and term loan (capital structure)',
};

function main() {
  const src = process.argv[2] || defaultWarehousePath();
  const db = new Database(src, { readonly: true, fileMustExist: true });
  const keys = Object.keys(FUNDS);
  const inKeys = `(${keys.map(() => '?').join(',')})`;
  const filings = db
    .prepare(`SELECT * FROM filings WHERE fund_key IN ${inKeys} ORDER BY fund_key, report_date, accession`)
    .all(...keys);
  const accs = `SELECT accession FROM filings WHERE fund_key IN ${inKeys}`;
  const holdings = db
    .prepare(`SELECT * FROM holdings WHERE accession IN (${accs}) ORDER BY accession, row_key`)
    .all(...keys);
  const totals = db
    .prepare(`SELECT * FROM filing_totals WHERE accession IN (${accs}) ORDER BY accession`)
    .all(...keys);
  const capital = db
    .prepare(`SELECT * FROM capital_structure_rows WHERE accession IN (${accs}) ORDER BY accession, row_key`)
    .all(...keys);
  const companyIds = [...new Set(holdings.map(h => h.company_id).filter(id => id != null))];
  const entityIds = [...new Set(holdings.map(h => h.entity_id).filter(id => id != null))];
  const list = ids => `(${ids.map(() => '?').join(',') || 'NULL'})`;
  const companies = db.prepare(`SELECT * FROM companies WHERE id IN ${list(companyIds)} ORDER BY id`).all(...companyIds);
  const tracked = db
    .prepare(`SELECT * FROM tracked_companies WHERE company_id IN ${list(companyIds)} ORDER BY company_id`)
    .all(...companyIds);
  const entities = db
    .prepare(`SELECT * FROM unreviewed_entities WHERE id IN ${list(entityIds)} ORDER BY id`)
    .all(...entityIds);

  const table = rows => ({ columns: Object.keys(rows[0]), rows: rows.map(r => Object.values(r)) });
  const lastRefresh = db.prepare("SELECT id, finished_at FROM refresh_runs WHERE status = 'ok' ORDER BY id DESC LIMIT 1");
  const manifest = {
    builtAt: new Date().toISOString(),
    source: path.basename(src),
    sourceRefreshRun: lastRefresh.get() || null,
    funds: FUNDS,
    filings: filings.length,
    holdings: holdings.length,
    capitalRows: capital.length,
    companies: companies.length,
    unreviewedEntities: entities.length,
  };
  db.close();
  const payload = JSON.stringify({
    manifest,
    filings: table(filings),
    holdings: table(holdings),
    filing_totals: table(totals),
    capital_structure_rows: table(capital),
    companies: table(companies),
    tracked_companies: table(tracked),
    unreviewed_entities: table(entities),
  });
  fs.writeFileSync(path.join(OUT, 'warehouse.json.gz'), zlib.gzipSync(payload, { level: 9 }));
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`fixture: ${keys.length} funds, ${filings.length} filings, ${holdings.length} rows, ${capital.length} capital rows`);
}

main();
