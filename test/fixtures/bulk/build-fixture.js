#!/usr/bin/env node
// Rebuilds test/fixtures/bulk/ from REAL SEC data (needs network + SEC_USER_AGENT):
//
//   node test/fixtures/bulk/build-fixture.js <path/to/2026q2_nport.zip>
//
// For each accession in ACCESSIONS it copies that filing's rows from the DERA
// quarter zip into mini_nport.zip, and saves its primary_doc.xml trimmed to
// the same holdings, so the warehouse ingest can be compared row-for-row with
// extractAllHoldings() on the XML. Every kept (private-candidate) holding is
// included, plus up to 3 public equity rows and 2 non-equity rows per filing
// that the ingest must drop. Nothing in the output is hand-written.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const yazl = require('yazl');
const { openZip, readTable } = require('../../../lib/warehouse/tsv-zip');
const { isValidIsin } = require('../../../lib/warehouse/identifiers');
const { isPrivateCandidate, isEquityType } = require('../../../lib/warehouse/keep-rule');

const OUT = __dirname;
const ACCESSIONS = {
  '0001193125-26-182055': 'Growth Fund of America 2026-02-28: Anthropic G-1/F-1 (GOLDEN F1), Stripe classes',
  '0000035402-26-004133': 'Fidelity OTC Portfolio 2026-04-30: no Stripe row (GOLDEN F9 pattern)',
  '0002048251-26-004683': 'KraneShares: Anthropic E-1 at fair-value Level 1 with ticker "1892140D"',
  '0001193125-26-239358': 'Innovation Access Fund: Anthropic at Level 2 with ISIN "N/A"',
  '0000894189-26-016628': 'Destiny Tech100 2026-03-31: SPVs via assetConditional (indirect)',
  '0000225318-26-000007': 'Small filing with private warrants (DERIVATIVE_CAT WAR)',
  '0002048251-26-002806': 'Global X Copper Miners: CAD-denominated Level-3 holding (valUSD check)',
};
const TABLES = ['SUBMISSION.tsv', 'REGISTRANT.tsv', 'FUND_REPORTED_INFO.tsv', 'FUND_REPORTED_HOLDING.tsv', 'IDENTIFIERS.tsv'];

const tag = (block, name) => {
  const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(block);
  return m ? m[1].trim() : '';
};
const decode = s =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
// Numeric compare where "N/A" (XML) and "" (bulk) both mean missing — real
// SPV rows report <balance>N/A</balance> with a value.
const numOrNull = v => (String(v).trim() === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const close = (a, b) => {
  const x = numOrNull(a);
  const y = numOrNull(b);
  if (x === null || y === null) return x === y;
  return Math.abs(x - y) <= 1e-6 * Math.max(1, Math.abs(x));
};

async function main() {
  const zipPath = process.argv[2];
  if (!zipPath) throw new Error('usage: build-fixture.js <quarter zip>');
  const ua = process.env.SEC_USER_AGENT;
  if (!ua) throw new Error('SEC_USER_AGENT is required');
  const wanted = new Set(Object.keys(ACCESSIONS));
  const archive = await openZip(zipPath);

  const headers = {};
  const rows = Object.fromEntries(TABLES.map(t => [t, []]));
  const keepHeader = (t, r) => (headers[t] = headers[t] || Object.keys(r));
  for (const t of ['SUBMISSION.tsv', 'REGISTRANT.tsv', 'FUND_REPORTED_INFO.tsv', 'FUND_REPORTED_HOLDING.tsv']) {
    await readTable(archive, t, r => {
      keepHeader(t, r);
      if (wanted.has(r.ACCESSION_NUMBER)) rows[t].push(r);
    });
  }
  const holdingIds = new Set(rows['FUND_REPORTED_HOLDING.tsv'].map(r => r.HOLDING_ID));
  const idRows = [];
  await readTable(archive, 'IDENTIFIERS.tsv', r => {
    keepHeader('IDENTIFIERS.tsv', r);
    if (holdingIds.has(r.HOLDING_ID)) idRows.push(r);
  });
  archive.zip.close();
  const isinHolders = new Set(idRows.filter(r => isValidIsin(r.IDENTIFIER_ISIN)).map(r => r.HOLDING_ID));

  const manifest = { source: path.basename(zipPath), builtAt: new Date().toISOString(), filings: {} };
  const selectedHoldings = [];
  const xmlDir = path.join(OUT, 'xml');
  fs.mkdirSync(xmlDir, { recursive: true });

  for (const accession of Object.keys(ACCESSIONS)) {
    const cik = rows['REGISTRANT.tsv'].find(r => r.ACCESSION_NUMBER === accession)?.CIK.replace(/^0+/, '');
    if (!cik) throw new Error(`${accession} not in this quarter zip`);
    const all = rows['FUND_REPORTED_HOLDING.tsv'].filter(r => r.ACCESSION_NUMBER === accession);
    const kept = all.filter(r => isPrivateCandidate(r, isinHolders.has(r.HOLDING_ID)));
    const publicEquity = all.filter(r => isEquityType(r) && !kept.includes(r)).slice(0, 3);
    const nonEquity = all.filter(r => !isEquityType(r)).slice(0, 2);
    const selected = [...kept, ...publicEquity, ...nonEquity];

    const url = `https://www.sec.gov/Archives/edgar/data/${cik}/${accession.replace(/-/g, '')}/primary_doc.xml`;
    const xml = (await axios.get(url, { headers: { 'User-Agent': ua }, responseType: 'text', timeout: 120000 })).data;
    const first = xml.indexOf('<invstOrSec>');
    const last = xml.lastIndexOf('</invstOrSec>') + '</invstOrSec>'.length;
    const blocks = xml.slice(first, last).match(/<invstOrSec>[\s\S]*?<\/invstOrSec>/g) || [];

    // Match each selected TSV row to one XML block by title + balance + valUSD.
    const used = new Set();
    const chosen = [];
    for (const r of selected) {
      const i = blocks.findIndex(
        (b, idx) =>
          !used.has(idx) &&
          decode(tag(b, 'title')) === r.ISSUER_TITLE &&
          close(tag(b, 'balance'), r.BALANCE) &&
          close(tag(b, 'valUSD'), r.CURRENCY_VALUE)
      );
      if (i < 0) throw new Error(`${accession}: no XML block for holding ${r.HOLDING_ID} "${r.ISSUER_TITLE}"`);
      used.add(i);
      chosen.push(i);
    }
    chosen.sort((a, b) => a - b);
    const trimmed = xml.slice(0, first) + chosen.map(i => blocks[i]).join('\n') + xml.slice(last);
    fs.writeFileSync(path.join(xmlDir, `${accession}.xml`), trimmed);

    selectedHoldings.push(...selected);
    manifest.filings[accession] = {
      cik,
      note: ACCESSIONS[accession],
      keptHoldingIds: kept.map(r => r.HOLDING_ID),
      droppedHoldingIds: [...publicEquity, ...nonEquity].map(r => r.HOLDING_ID),
    };
    console.log(`${accession}: ${kept.length} kept, ${publicEquity.length + nonEquity.length} dropped rows`);
  }

  const selectedIds = new Set(selectedHoldings.map(r => r.HOLDING_ID));
  const out = new yazl.ZipFile();
  const tsv = (t, list) => [headers[t].join('\t'), ...list.map(r => headers[t].map(h => r[h]).join('\t'))].join('\n') + '\n';
  out.addBuffer(Buffer.from(tsv('SUBMISSION.tsv', rows['SUBMISSION.tsv'])), 'SUBMISSION.tsv');
  out.addBuffer(Buffer.from(tsv('REGISTRANT.tsv', rows['REGISTRANT.tsv'])), 'REGISTRANT.tsv');
  out.addBuffer(Buffer.from(tsv('FUND_REPORTED_INFO.tsv', rows['FUND_REPORTED_INFO.tsv'])), 'FUND_REPORTED_INFO.tsv');
  out.addBuffer(Buffer.from(tsv('FUND_REPORTED_HOLDING.tsv', selectedHoldings)), 'FUND_REPORTED_HOLDING.tsv');
  out.addBuffer(
    Buffer.from(tsv('IDENTIFIERS.tsv', idRows.filter(r => selectedIds.has(r.HOLDING_ID)))),
    'IDENTIFIERS.tsv'
  );
  out.end();
  await new Promise((resolve, reject) =>
    out.outputStream.pipe(fs.createWriteStream(path.join(OUT, 'mini_nport.zip'))).on('close', resolve).on('error', reject)
  );
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log('wrote mini_nport.zip, xml/, manifest.json');
}

main().catch(err => {
  console.error(err.message);
  process.exitCode = 1;
});
