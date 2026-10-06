#!/usr/bin/env node
// Print the raw EDGAR rows behind a number (LESSONS 4: verify from the source,
// not derived data). Fetches each filing's primary_doc.xml through the paced
// SEC client and prints the holdings whose name or title matches a pattern.
//
//   node scripts/verify-edgar.js <cik> <pattern> <accession> [<accession> ...]
//   node scripts/verify-edgar.js 44201 stripe 0001193125-26-182055 0001193125-26-323081
//
// Needs SEC_USER_AGENT (read from .env). Prints per row: name | title | filer id |
// balance | units | value | percent of net assets | asset category, then how many
// holdings each filing had and how many matched. Fails closed (staff review): a
// filing with no holdings it can read, or no matching row, exits non-zero, so a
// golden check never passes on an empty result.
require('dotenv').config();
const { secGet } = require('../lib/warehouse/delta');

// The raw holdings of one filing whose name or title matches `re`, read straight
// from primary_doc.xml with regular expressions (never parsers.js: an
// independent reading for golden checks and the test oracle, staff review F17).
// Returns the filing header, the rows, and how many holdings were inspected.
async function rawHoldings(cik, accession, re) {
  const url = `https://www.sec.gov/Archives/edgar/data/${cik}/${accession.replace(/-/g, '')}/primary_doc.xml`;
  const xml = String(await secGet(url));
  // a tag with or without attributes or a namespace prefix
  const open = t => `<(?:\\w+:)?${t}(?:\\s[^>]*)?>`;
  const tag = t => (xml.match(new RegExp(`${open(t)}([^<]+)`)) || [])[1];
  const rows = [];
  let inspected = 0;
  for (const m of xml.matchAll(/<(?:\w+:)?invstOrSec(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?invstOrSec>/g)) {
    const b = m[1];
    inspected++;
    const g = t => (b.match(new RegExp(`${open(t)}([^<]*)<`)) || [])[1];
    if (!re.test(g('name') || '') && !re.test(g('title') || '')) continue;
    const other = b.match(/<other[^>]*otherDesc="([^"]*)"[^>]*value="([^"]*)"/) || [];
    rows.push({
      name: g('name'),
      title: g('title'),
      otherDesc: other[1] || null,
      otherId: other[2] || null,
      balance: g('balance'),
      units: g('units'),
      valUSD: g('valUSD'),
      pctVal: g('pctVal'),
      assetCat: (b.match(/<assetCat>([^<]*)/) || b.match(/assetConditional desc="([^"]*)"/) || [])[1] || null,
    });
  }
  return {
    accession,
    cik: String(cik),
    repPdDate: tag('repPdDate'),
    seriesId: tag('seriesId') || null,
    regName: tag('regName'),
    inspected,
    rows,
  };
}

async function main() {
  const [cik, pattern, ...accessions] = process.argv.slice(2);
  if (!cik || !pattern || !accessions.length) {
    console.error('usage: node scripts/verify-edgar.js <cik> <pattern> <accession> [...]');
    process.exit(2);
  }
  const re = new RegExp(pattern, 'i');
  const problems = [];
  for (const acc of accessions) {
    const f = await rawHoldings(cik, acc, re);
    console.log(`\n== ${acc} repPdDate=${f.repPdDate} series=${f.seriesId} registrant=${f.regName}`);
    for (const r of f.rows)
      console.log(
        [
          r.name,
          r.title,
          `id:${[r.otherDesc, r.otherId].filter(Boolean).join(' ')}`,
          `bal:${r.balance}`,
          r.units,
          `val:${r.valUSD}`,
          `pct:${r.pctVal}`,
          r.assetCat,
        ].join(' | ')
      );
    console.log(`-- ${acc}: ${f.rows.length} of ${f.inspected} holdings match /${pattern}/i`);
    if (!f.inspected) problems.push(`${acc}: no holdings read (not an N-PORT primary_doc.xml, or an unknown layout)`);
    else if (!f.rows.length) problems.push(`${acc}: no holding matches /${pattern}/i`);
  }
  if (problems.length) {
    for (const p of problems) console.error(`FAILED ${p}`);
    process.exit(1);
  }
}

if (require.main === module)
  main().catch(err => {
    console.error(err.message);
    process.exit(1);
  });

module.exports = { rawHoldings };
