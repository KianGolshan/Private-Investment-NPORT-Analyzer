#!/usr/bin/env node
// Rebuilds test/fixtures/identity/ from the REAL warehouse.db (no network):
//
//   node test/fixtures/identity/build-fixture.js [path/to/warehouse.db]
//
// Phase 4.5 identity cases (ROADMAP §Phase 4.5): FHU US Holdings / Chobani
// with Fidelity's per-fund holding LLCs, Project Debussy = Databricks, Oura,
// Anduril, BlackRock's "Anthropics Technology" / "OpenAir.com" labels,
// Windstream / Uniti, and BlackRock's one "Xiaoju Kuaizhi" row that is Ant.
// Exports the matching holding rows, every holding row carrying their ids or
// LEIs, every filing of the funds involved (so as-of exits and inactivity work
// offline), those funds' adviser -> firm links (filer families), and the
// listing evidence of the keys involved. Nothing in the output is hand-written.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const Database = require('better-sqlite3');
const { defaultWarehousePath } = require('../../../lib/warehouse/db');
const { issuerKeyOf } = require('../../../parsers');

const OUT = __dirname;
const NAMES = [
  '\\bFHU ?U?S\\b|\\bCHOBANI\\b',
  // Fidelity per-fund holding LLCs (fund codes need >= 2 targets each).
  '\\b(VETERINARY|TC|AB|TRB|THRIVE) HOLDINGS LLC\\b|\\bTB2 HLDG LLC\\b',
  '\\bproject debussy\\b',
  '\\boura\\b',
  '\\banduril\\b',
  '\\banthropics\\b|\\bopenair\\b',
  '\\bwindstream\\b|\\buniti\\b|\\bnew unity\\b',
  '\\bxiaoju\\b|\\bant (financial|group|intl|international)\\b',
];
const IDS = ['BYDXGRZL8', 'BYJ0U3DG6', 'BRTGP5LH5', '956KCS006'];
const LEIS = ['549300ISVDMZ91KNTR38', '984500B6DEB8CEBC4Z70', '984500FEDAC7FBD96273'];

// Also used by test/fixtures/search/build-fixture.js with its own names.
function buildFixture({ src = defaultWarehousePath(), out = OUT, names = NAMES, ids = IDS, leis = LEIS } = {}) {
  const db = new Database(src, { readonly: true, fileMustExist: true });
  const any = new RegExp(names.join('|'), 'i');
  db.function('fixture_match', { deterministic: true }, t => (t != null && any.test(t) ? 1 : 0));
  const inList = xs => `(${xs.map(() => '?').join(',')})`;

  const named = db
    .prepare('SELECT accession FROM holdings WHERE fixture_match(issuer_name) OR fixture_match(title)')
    .all()
    .map(r => r.accession);
  // Filings where Project Debussy appears: all Databricks rows there too (same-mark evidence).
  const debussy = db
    .prepare("SELECT DISTINCT accession FROM holdings WHERE UPPER(issuer_name) LIKE 'PROJECT DEBUSSY%'")
    .all()
    .map(r => r.accession);
  const holdings = db
    .prepare(
      `SELECT * FROM holdings WHERE fixture_match(issuer_name) OR fixture_match(title)
         OR other_id IN ${inList(ids)} OR lei IN ${inList(leis)}
         OR (accession IN ${inList(debussy)} AND (UPPER(issuer_name) LIKE '%DATABRICKS%' OR UPPER(title) LIKE '%DATABRICKS%'))
       ORDER BY accession, row_key`
    )
    .all(...ids, ...leis, ...debussy);
  const accessions = [...new Set([...holdings.map(h => h.accession), ...named])];
  const fundOf = db.prepare('SELECT fund_key FROM filings WHERE accession = ?');
  const fundKeys = [...new Set(accessions.map(a => fundOf.get(a).fund_key))].sort();
  const filingsOf = db.prepare('SELECT * FROM filings WHERE fund_key = ? ORDER BY report_date, filing_date, accession');
  const filings = fundKeys.flatMap(k => filingsOf.all(k));

  const fundAdvisers = db
    .prepare(`SELECT * FROM fund_advisers WHERE fund_key IN ${inList(fundKeys)} ORDER BY fund_key, file_num`)
    .all(...fundKeys);
  const fileNums = [...new Set(fundAdvisers.map(a => a.file_num))];
  const managerAdvisers = db
    .prepare(`SELECT * FROM manager_advisers WHERE file_num IN ${inList(fileNums)} ORDER BY file_num`)
    .all(...fileNums);
  const managerIds = [...new Set(managerAdvisers.map(m => m.manager_id))];
  const managers = db.prepare(`SELECT * FROM managers WHERE id IN ${inList(managerIds)} ORDER BY id`).all(...managerIds);
  const keys = [...new Set(holdings.map(h => issuerKeyOf({ issuer: h.issuer_name, title: h.title })))];
  const listing = db
    .prepare(`SELECT * FROM listing_evidence WHERE issuer_key IN ${inList(keys)} ORDER BY issuer_key, quarter`)
    .all(...keys);

  const table = rows => ({ columns: Object.keys(rows[0]), rows: rows.map(r => Object.values(r)) });
  const lastRefresh = db.prepare("SELECT id, finished_at FROM refresh_runs WHERE status = 'ok' ORDER BY id DESC LIMIT 1");
  const manifest = {
    builtAt: new Date().toISOString(),
    source: path.basename(src),
    sourceNewestFilingDate: db.prepare('SELECT MAX(filing_date) d FROM filings').get().d,
    sourceRefreshRun: lastRefresh.get() || null,
    names,
    ids,
    leis,
    funds: fundKeys.length,
    filings: filings.length,
    holdings: holdings.length,
    listingEvidence: listing.length,
  };
  db.close();
  const payload = JSON.stringify({
    manifest,
    filings: table(filings),
    holdings: table(holdings),
    managers: table(managers),
    manager_advisers: table(managerAdvisers),
    fund_advisers: table(fundAdvisers),
    listing_evidence: table(listing),
  });
  fs.writeFileSync(path.join(out, 'warehouse.json.gz'), zlib.gzipSync(payload, { level: 9 }));
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`fixture: ${manifest.funds} funds, ${manifest.filings} filings, ${manifest.holdings} rows`);
}

if (require.main === module) buildFixture({ src: process.argv[2] || defaultWarehousePath() });

module.exports = { buildFixture };
