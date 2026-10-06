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

async function main() {
  const [cik, pattern, ...accessions] = process.argv.slice(2);
  if (!cik || !pattern || !accessions.length) {
    console.error('usage: node scripts/verify-edgar.js <cik> <pattern> <accession> [...]');
    process.exit(2);
  }
  const re = new RegExp(pattern, 'i');
  const problems = [];
  for (const acc of accessions) {
    const url = `https://www.sec.gov/Archives/edgar/data/${cik}/${acc.replace(/-/g, '')}/primary_doc.xml`;
    const xml = String(await secGet(url));
    // a tag with or without attributes or a namespace prefix
    const open = t => `<(?:\\w+:)?${t}(?:\\s[^>]*)?>`;
    const tag = t => (xml.match(new RegExp(`${open(t)}([^<]+)`)) || [])[1];
    console.log(`\n== ${acc} repPdDate=${tag('repPdDate')} series=${tag('seriesId')} registrant=${tag('regName')}`);
    let inspected = 0;
    let matched = 0;
    for (const m of xml.matchAll(/<(?:\w+:)?invstOrSec(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?invstOrSec>/g)) {
      const b = m[1];
      inspected++;
      const g = t => (b.match(new RegExp(`${open(t)}([^<]*)<`)) || [])[1];
      if (!re.test(g('name') || '') && !re.test(g('title') || '')) continue;
      matched++;
      const other = (b.match(/<other[^>]*otherDesc="([^"]*)"[^>]*value="([^"]*)"/) || []).slice(1).join(' ');
      const cat = (b.match(/<assetCat>([^<]*)/) || b.match(/assetConditional desc="([^"]*)"/) || [])[1];
      console.log(
        [
          g('name'),
          g('title'),
          `id:${other}`,
          `bal:${g('balance')}`,
          g('units'),
          `val:${g('valUSD')}`,
          `pct:${g('pctVal')}`,
          cat,
        ].join(' | ')
      );
    }
    console.log(`-- ${acc}: ${matched} of ${inspected} holdings match /${pattern}/i`);
    if (!inspected) problems.push(`${acc}: no holdings read (not an N-PORT primary_doc.xml, or an unknown layout)`);
    else if (!matched) problems.push(`${acc}: no holding matches /${pattern}/i`);
  }
  if (problems.length) {
    for (const p of problems) console.error(`FAILED ${p}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
