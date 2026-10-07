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
const { openWarehouseReadOnly, defaultWarehousePath } = require('../lib/warehouse/db');

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
    const db = openWarehouseReadOnly(DB_PATH);
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
  const db = openWarehouseReadOnly(DB_PATH);
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
    const db = openWarehouseReadOnly(DB_PATH);
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
      // By company Anthropic includes BlackRock's "Anthropics Technology Ltd., Series G" rows (same
      // instrument id and marks as its "ANTHROPIC SERIES G", GOLDEN F31): +$34.1M in 3 funds that already
      // hold Anthropic. The pattern golden A2 (117 / $17.26B) is unchanged.
      assert.deepEqual(by('Anthropic', '2026-06-30'), [117, 17.29]);
      assert.deepEqual(by('Stripe', '2025-12-31'), [35, 1.31]);
      // Includes Project Debussy Series J, Databricks under a codename (GOLDEN-NUMBERS F25).
      assert.deepEqual(by('Databricks', '2026-06-30'), [120, 6.23]);
      // Phase 4.5: FHU US Holdings (Chobani) is one company (GOLDEN F29); BlackRock's "OpenAir.com"
      // rows are OpenAI (F32).
      assert.deepEqual(by('FHU US Holdings', '2026-06-30'), [13, 0.36]);
      assert.deepEqual(by('OpenAI', '2026-06-30'), [87, 5.49]);
      assert.deepEqual(one("SELECT DISTINCT company_id FROM holdings WHERE issuer_name = 'OpenAir.com'"), [
        id('OpenAI'),
      ]);
      assert.deepEqual(
        one("SELECT DISTINCT company_id FROM holdings WHERE issuer_name = 'Anthropics Technology Ltd.'"),
        [id('Anthropic')]
      );
      assert.deepEqual(
        one(
          "SELECT DISTINCT via_spv FROM holdings WHERE issuer_name LIKE '% FHUS HOLDINGS LLC' AND company_id IS NOT NULL"
        ),
        [1]
      );
    } finally {
      db.close();
    }
  }
);

// Phase 5b: filing_totals from the bulk dataset equal v1 Fund X-Ray
// (buildFundXRay) on the full, untrimmed primary_doc.xml from EDGAR.
test('LIVE: bulk filing_totals equal v1 Fund X-Ray on the full EDGAR XML', { skip: !LIVE }, async () => {
  const { fetchFilingRows } = require('../lib/warehouse/delta');
  const { parseNportXml } = require('../lib/warehouse/edgar-rows');
  const { extractAllHoldings, extractFundMeta, buildFundXRay } = require('../parsers');
  const db = openWarehouseReadOnly(DB_PATH);
  const cases = [
    ['0001193125-26-182055', '44201'], // Growth Fund of America 2026-02-28 (F1): a large book
    ['0000035402-25-002966', '754510'], // Fidelity OTC 2025-10-31 (F8)
    ['0001752724-22-239970', null], // T. Rowe Tax-Efficient Equity 2022-08-31 (F13), bulk 2022q3
  ];
  const close = (a, b) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a));
  for (const [accession, knownCik] of cases) {
    const f = db.prepare('SELECT * FROM filings WHERE accession = ?').get(accession);
    assert.ok(f && f.source.startsWith('bulk:'), `${accession} is a bulk filing`);
    const t = db.prepare('SELECT * FROM filing_totals WHERE accession = ?').get(accession);
    const cik = knownCik || f.cik;
    const url = `https://www.sec.gov/Archives/edgar/data/${cik}/${accession.replace(/-/g, '')}/primary_doc.xml`;
    await sleep(150);
    const xml = await parseNportXml(
      (await axios.get(url, { headers: { 'User-Agent': process.env.SEC_USER_AGENT }, timeout: 60000 })).data
    );
    const v1 = buildFundXRay(extractAllHoldings(xml), extractFundMeta(xml));
    assert.equal(t.rows, v1.totalHoldingsCount, `${accession} rows`);
    assert.ok(close(t.value_usd, v1.totalValueUSD), `${accession} value ${t.value_usd} vs ${v1.totalValueUSD}`);
    assert.equal(t.rows_l3_equity, v1.privateHoldingsCount, `${accession} v1 private rows`);
    assert.ok(close(t.value_l3_equity, v1.privateValueUSD), `${accession} v1 private value`);
    const edgar = (await fetchFilingRows({ accession, cik, filingDate: f.filing_date, form: f.form })).totals;
    for (const k of Object.keys(edgar)) assert.ok(close(t[k], edgar[k]), `${accession} ${k}: ${t[k]} vs ${edgar[k]}`);
  }
  db.close();
});
