// LIVE check (LIVE_SEC=1): the loaded warehouse's filing list equals EDGAR's
// own submissions list, inside the bulk window, for randomly sampled
// registrants. Needs a real warehouse (npm run ingest:bulk -- --all) at
// WAREHOUSE_DB_PATH (default ./warehouse.db). Baseline on 2026-09-27: 80
// registrants, 7,046 filings, 0 missing.
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const axios = require('axios');
const { openWarehouse, defaultWarehousePath } = require('../lib/warehouse/db');

const LIVE = process.env.LIVE_SEC === '1';
const DB_PATH = defaultWarehousePath();
const SAMPLE = Number(process.env.LIVE_WAREHOUSE_SAMPLE) || 20;
// Bulk data starts with filings made in 2019Q4; earlier public N-PORTs
// (filed ~May–Sep 2019) are not in any bulk file (real: KP Large Cap Equity
// Fund 0001752724-19-047738, filed 2019-05-29).
const WINDOW_START = '2019-10-01';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function edgarNportFilings(cik) {
  const headers = { 'User-Agent': process.env.SEC_USER_AGENT };
  const get = async url => {
    await sleep(150);
    return (await axios.get(url, { headers, timeout: 30000 })).data;
  };
  const first = await get(`https://data.sec.gov/submissions/CIK${String(cik).padStart(10, '0')}.json`);
  const blocks = [first.filings.recent];
  for (const f of first.filings.files || []) blocks.push(await get(`https://data.sec.gov/submissions/${f.name}`));
  const out = [];
  for (const b of blocks) {
    for (let i = 0; i < b.form.length; i++) {
      if (b.form[i] === 'NPORT-P' || b.form[i] === 'NPORT-P/A') {
        out.push({ accession: b.accessionNumber[i], filingDate: b.filingDate[i] });
      }
    }
  }
  return out;
}

test(
  'LIVE: warehouse filing list equals EDGAR submissions for sampled registrants (bulk window)',
  { skip: !LIVE || !fs.existsSync(DB_PATH), timeout: 30 * 60 * 1000 },
  async () => {
    const db = openWarehouse(DB_PATH);
    const windowEnd = db.prepare("SELECT MAX(filing_date) d FROM filings WHERE source LIKE 'bulk:%'").get().d;
    const ciks = db
      .prepare('SELECT cik FROM (SELECT DISTINCT cik FROM filings WHERE cik IS NOT NULL) ORDER BY random() LIMIT ?')
      .all(SAMPLE)
      .map(r => r.cik);
    const has = db.prepare('SELECT 1 FROM filings WHERE accession = ?');
    let checked = 0;
    const missing = [];
    for (const cik of ciks) {
      for (const f of await edgarNportFilings(cik)) {
        if (f.filingDate < WINDOW_START || f.filingDate > windowEnd) continue;
        checked++;
        if (!has.get(f.accession)) missing.push({ cik, ...f });
      }
    }
    db.close();
    console.log(
      `checked ${checked} EDGAR filings across ${ciks.length} registrants (window ${WINDOW_START}..${windowEnd})`
    );
    assert.ok(checked > 0);
    assert.deepEqual(missing, [], 'every EDGAR NPORT-P in the bulk window is in the warehouse');
  }
);
