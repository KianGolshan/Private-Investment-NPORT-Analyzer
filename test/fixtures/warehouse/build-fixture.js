#!/usr/bin/env node
// Rebuilds test/fixtures/warehouse/ from the REAL warehouse.db (no network):
//
//   node test/fixtures/warehouse/build-fixture.js [path/to/warehouse.db]
//
// Exports every filing (whatever it contains) of every fund that ever
// reported a row naming a golden company, plus those companies' holding rows,
// so exits, dead funds and amendments behave offline exactly as in the real
// warehouse. Nothing in the output is hand-written. Run `npm run refresh`
// first; the manifest records the source's newest filing and refresh run.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const Database = require('better-sqlite3');
const { defaultWarehousePath } = require('../../../lib/warehouse/db');

const OUT = __dirname;
// The research patterns behind GOLDEN-NUMBERS A1-A6 (ROADMAP Phase 3), plus
// the Phase 4 entity cases: ByteDance/Douyin and SpaceX (public).
const COMPANIES = {
  anthropic: '\\banthropic\\b',
  databricks: '\\bdatabricks\\b',
  stripe: '\\bstripe,? (inc|llc)\\b|^stripe\\b',
  bytedance: '\\bbytedance\\b|\\bdouyin\\b',
  spacex: '\\bspace exploration\\b|\\bspacex\\b',
};

function main() {
  const src = process.argv[2] || defaultWarehousePath();
  const db = new Database(src, { readonly: true, fileMustExist: true });
  const any = new RegExp(Object.values(COMPANIES).join('|'), 'i');
  db.function('fixture_match', { deterministic: true }, t => (t != null && any.test(t) ? 1 : 0));

  const holdings = db
    .prepare('SELECT * FROM holdings WHERE fixture_match(issuer_name) OR fixture_match(title) ORDER BY accession, row_key')
    .all();
  const accessions = [...new Set(holdings.map(h => h.accession))];
  const fundKeys = new Set();
  const fundOf = db.prepare('SELECT fund_key FROM filings WHERE accession = ?');
  for (const a of accessions) fundKeys.add(fundOf.get(a).fund_key);
  const filingsOf = db.prepare('SELECT * FROM filings WHERE fund_key = ? ORDER BY report_date, filing_date, accession');
  const filings = [...fundKeys].sort().flatMap(k => filingsOf.all(k));

  // N-CEN adviser rows for these funds' registrants (Phase 4 manager tests).
  const ciks = [...new Set(filings.map(f => f.cik).filter(Boolean))];
  const inList = `(${ciks.map(() => '?').join(',')})`;
  const ncenAdvisers = db.prepare(`SELECT * FROM ncen_advisers WHERE cik IN ${inList} ORDER BY accession`).all(...ciks);
  const ncenFilings = db.prepare(`SELECT * FROM ncen_filings WHERE cik IN ${inList} ORDER BY accession`).all(...ciks);
  const fileNums = [...new Set(ncenAdvisers.map(a => a.file_num))];
  const advisers = db
    .prepare(`SELECT * FROM advisers WHERE file_num IN (${fileNums.map(() => '?').join(',')}) ORDER BY file_num`)
    .all(...fileNums);

  const table = rows => ({ columns: Object.keys(rows[0]), rows: rows.map(r => Object.values(r)) });
  const lastRefresh = db.prepare("SELECT id, finished_at FROM refresh_runs WHERE status = 'ok' ORDER BY id DESC LIMIT 1");
  const manifest = {
    builtAt: new Date().toISOString(),
    source: path.basename(src),
    sourceNewestFilingDate: db.prepare('SELECT MAX(filing_date) d FROM filings').get().d,
    sourceRefreshRun: lastRefresh.get() || null,
    companies: COMPANIES,
    funds: fundKeys.size,
    filings: filings.length,
    holdings: holdings.length,
    ncenFilings: ncenFilings.length,
    ncenAdviserRows: ncenAdvisers.length,
  };
  db.close();

  const payload = JSON.stringify({
    manifest,
    filings: table(filings),
    holdings: table(holdings),
    ncen_filings: table(ncenFilings),
    ncen_advisers: table(ncenAdvisers),
    advisers: table(advisers),
  });
  fs.writeFileSync(path.join(OUT, 'warehouse.json.gz'), zlib.gzipSync(payload, { level: 9 }));
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`fixture: ${manifest.funds} funds, ${manifest.filings} filings, ${manifest.holdings} rows`);
}

main();
