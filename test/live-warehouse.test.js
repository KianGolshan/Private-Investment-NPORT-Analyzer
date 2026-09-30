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
// Bulk data starts with filings made in 2019Q4, which is also when public
// NPORT-P filing began: EDGAR's full index lists none in 2019 QTR2/QTR3 and
// the first on 2019-10-22 (earlier N-PORT-related filings are NPORT-EX
// exhibits, e.g. KP Large Cap 0001752724-19-047738).
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

// Phase 3 goldens on the full warehouse (the offline suite runs them on the
// fixture exported from it). A newer amendment can legitimately move these;
// re-verify on EDGAR and update GOLDEN-NUMBERS.md, never the code.
test('LIVE: as-of golden aggregates A1-A6 on the full warehouse', { skip: !LIVE || !fs.existsSync(DB_PATH) }, () => {
  const { exposureAsOf } = require('../lib/analytics/asof');
  const db = openWarehouse(DB_PATH);
  const P = {
    anthropic: '\\banthropic\\b',
    databricks: '\\bdatabricks\\b',
    stripe: '\\bstripe,? (inc|llc)\\b|^stripe\\b',
  };
  const got = (company, date, extra) => {
    const r = exposureAsOf(db, { pattern: P[company], date, ...extra });
    return [r.funds, Math.round(r.total / 1e7) / 100];
  };
  try {
    assert.deepEqual(got('anthropic', '2026-03-31'), [72, 5.93]);
    assert.deepEqual(got('anthropic', '2026-06-30'), [117, 17.26]);
    assert.deepEqual(got('anthropic', '2026-06-30', { knownAsOf: true }), [82, 6.23]);
    assert.deepEqual(got('stripe', '2025-06-30'), [49, 1.02]);
    assert.deepEqual(got('stripe', '2025-12-31'), [35, 1.31]);
    assert.deepEqual(got('stripe', '2026-03-31'), [34, 1.91]);
    assert.deepEqual(got('stripe', '2026-06-30'), [37, 2.44]);
    assert.deepEqual(got('databricks', '2026-06-30'), [120, 6.22]);
  } finally {
    db.close();
  }
});

// Phase 4 entities on the full warehouse after `npm run review:aliases`
// (the reviewed data/review/*.csv). Skips when no entities are imported.
test(
  'LIVE: reviewed entities resolve the roadmap cases and reproduce the goldens by company',
  { skip: !LIVE || !fs.existsSync(DB_PATH) },
  t => {
    const { exposureAsOf } = require('../lib/analytics/asof');
    const db = openWarehouse(DB_PATH);
    try {
      if (!db.prepare('SELECT COUNT(*) n FROM companies').get().n) return t.skip('no entities imported');
      const id = name => db.prepare('SELECT id FROM companies WHERE name = ?').get(name).id;
      const one = sql =>
        db
          .prepare(sql)
          .all()
          .map(r => Object.values(r)[0]);
      assert.deepEqual(
        one(`SELECT DISTINCT company_id FROM holdings WHERE (issuer_name LIKE '%databricks%' OR title LIKE '%databricks%')
           AND value_usd > 0 AND instrument_type <> 'debt'`),
        [id('Databricks')]
      );
      assert.deepEqual(
        one("SELECT DISTINCT company_id FROM holdings WHERE issuer_name IN ('STRIPE INC', 'STRIPE LLC')"),
        [id('Stripe')]
      );
      assert.deepEqual(one("SELECT DISTINCT company_id FROM holdings WHERE issuer_name = 'DOUYIN CO LTD'"), [
        id('ByteDance'),
      ]);
      assert.equal(
        db.prepare("SELECT status FROM companies WHERE name = 'Space Exploration Technologies'").get().status,
        'public'
      );
      const by = (name, date) => {
        const r = exposureAsOf(db, { companyId: id(name), date });
        return [r.funds, Math.round(r.total / 1e7) / 100];
      };
      assert.deepEqual(by('Anthropic', '2026-06-30'), [117, 17.26]);
      assert.deepEqual(by('Stripe', '2025-12-31'), [35, 1.31]);
      // Includes Project Debussy Series J, Databricks under a codename (GOLDEN-NUMBERS F25).
      assert.deepEqual(by('Databricks', '2026-06-30'), [120, 6.23]);
    } finally {
      db.close();
    }
  }
);
