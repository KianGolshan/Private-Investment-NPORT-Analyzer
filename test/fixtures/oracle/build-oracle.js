#!/usr/bin/env node
// Builds test/fixtures/oracle/oracle.json: raw holdings straight from EDGAR's
// primary_doc.xml (scripts/verify-edgar.js rawHoldings: regular expressions,
// not parsers.js) for a small, hand-chosen set of cases (staff review F17).
// test/oracle.test.js computes every expected answer from these raw rows with
// plain arithmetic and compares the app's answers on the golden fixture.
//
//   node test/fixtures/oracle/build-oracle.js     # needs SEC_USER_AGENT (.env); ~20 paced requests
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { rawHoldings } = require('../../../scripts/verify-edgar');
const { openFixtureWarehouse } = require('../../helpers/warehouseFixture');

// Each case names the filings it reads. Which raw rows belong to a class is
// picked by hand in test/oracle.test.js (accession, title and shares, read
// from the printed rows), never by app code.
const CASES = [
  {
    id: 'class-multi-lot',
    why: 'one class, several lots in one fund (F06): one observation per fund',
    company: 'Databricks',
    pattern: 'databricks',
    markDate: '2026-02-27',
    instrument: 'Common',
    accessions: ['0000940400-26-014719', '0000940400-26-014713', '0000940400-26-014717'],
  },
  {
    id: 'class-six-funds',
    why: 'Anthropic common at one date across six funds and two filer families (F06 regression)',
    company: 'Anthropic',
    pattern: 'anthropic',
    markDate: '2026-03-31',
    instrument: 'Common',
    accessions: [
      '0001410368-26-054494',
      '0001410368-26-054509',
      '0001410368-26-054489',
      '0001193125-26-243966',
      '0001410368-26-054534',
      '0001410368-26-054521',
    ],
  },
  {
    id: 'class-two-filers',
    why: 'Stripe Series H at 2026-03-31: Fidelity and Capital Group file the same class in their own words',
    company: 'Stripe',
    pattern: 'stripe',
    markDate: '2026-03-31',
    instrument: 'Series H',
    accessions: [
      '0000035402-26-003312',
      '0001193125-26-243966',
      '0000035402-26-003299',
      '0000035402-26-003445',
      '0000035402-26-003310',
      '0000035402-26-003406',
    ],
  },
  {
    id: 'exit',
    why: 'Fidelity OTC Portfolio files 2026-01-31 without Stripe: no longer reported, the whole prior value',
    company: 'Stripe',
    pattern: 'stripe',
    fundKey: null,
    prev: '0000035402-25-002966',
    cur: '0000035402-26-002031',
    accessions: ['0000035402-25-002966', '0000035402-26-002031'],
  },
  {
    id: 'mark-move',
    why: 'Growth Fund of America re-marks Stripe $41.42 -> $63.00 with the same shares: all mark, no position',
    company: 'Stripe',
    pattern: 'stripe',
    fundKey: 'S000009228',
    prev: '0001193125-26-027715',
    cur: '0001193125-26-182055',
    accessions: ['0001193125-26-027715', '0001193125-26-182055'],
  },
  {
    id: 'amendment',
    why: 'an NPORT-P/A replaces its original: the amended filing is the one counted',
    company: 'Anthropic',
    pattern: 'anthropic',
    fundKey: 'S000004071',
    markDate: '2026-03-31',
    accessions: ['0000940400-26-036410'],
  },
];

async function main() {
  const { db } = openFixtureWarehouse();
  const cikOf = acc => {
    const f = db.prepare('SELECT cik, fund_key FROM filings WHERE accession = ?').get(acc);
    if (!f) throw new Error(`${acc} is not in the golden fixture`);
    return f;
  };
  // one fetch per filing, for every company a case reads in it
  const patterns = new Map();
  for (const c of CASES)
    for (const acc of c.accessions) (patterns.get(acc) || patterns.set(acc, new Set()).get(acc)).add(c.pattern);
  const filings = {};
  for (const [acc, ps] of patterns) {
    const { cik, fund_key } = cikOf(acc);
    const re = new RegExp([...ps].join('|'), 'i');
    const raw = await rawHoldings(cik, acc, re);
    if (!raw.inspected) throw new Error(`${acc}: no holdings read`);
    filings[acc] = { ...raw, fundKey: fund_key };
    console.log(`${acc} ${fund_key} ${raw.repPdDate}: ${raw.rows.length} of ${raw.inspected} rows match ${re}`);
  }
  const out = { builtAt: new Date().toISOString().slice(0, 10), source: 'EDGAR primary_doc.xml', cases: CASES, filings };
  fs.writeFileSync(path.join(__dirname, 'oracle.json'), JSON.stringify(out, null, 1) + '\n');
  console.log(`wrote oracle.json: ${CASES.length} cases, ${Object.keys(filings).length} filings`);
}

main().catch(err => {
  console.error(err.message);
  process.exitCode = 1;
});
