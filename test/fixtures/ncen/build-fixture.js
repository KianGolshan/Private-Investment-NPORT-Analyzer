#!/usr/bin/env node
// Rebuilds test/fixtures/ncen/ from REAL SEC data (needs network + SEC_USER_AGENT):
//
//   node test/fixtures/ncen/build-fixture.js <path/to/2026q1_ncen.zip>
//
// Copies the data set rows (SUBMISSION, FUND_REPORTED_INFO, ADVISER) of the
// filings in DATASET into mini_ncen.zip, and saves each filing's
// primary_doc.xml, so the EDGAR path can be compared with the data set path.
// EDGAR_ONLY is an N-CEN the SEC data sets lack. Nothing is hand-written.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const yazl = require('yazl');
const { openZip, readTable } = require('../../../lib/warehouse/tsv-zip');

const OUT = __dirname;
const DATASET = {
  '0001193125-26-108005': { cik: '729528', note: 'American Funds Insurance Series: 42 series, Capital Research (801-8055)' },
  '0001193125-26-105983': { cik: '1919700', note: 'Touchstone ETF Trust: adviser + sub-adviser per series' },
  '0001410368-26-026363': { cik: '2044519', note: 'Coatue Innovative Strategies Fund: no series ID' },
  '0000894189-26-007823': { cik: '1843974', note: 'Destiny Tech100: closed-end, no series ID' },
};
const EDGAR_ONLY = {
  '0001193125-25-282335': { cik: '44201', note: 'Growth Fund of America 2025-11-14: missing from the 2025q4 data set' },
};
const TABLES = ['SUBMISSION.tsv', 'FUND_REPORTED_INFO.tsv', 'ADVISER.tsv'];

async function main() {
  const zipPath = process.argv[2];
  if (!zipPath) throw new Error('usage: build-fixture.js <N-CEN data set zip>');
  const ua = process.env.SEC_USER_AGENT;
  if (!ua) throw new Error('SEC_USER_AGENT is required');
  const archive = await openZip(zipPath);
  const wanted = new Set(Object.keys(DATASET));
  const out = {};
  const headers = {};
  const fundIds = new Set();
  for (const t of TABLES) {
    out[t] = [];
    await readTable(archive, t, r => {
      headers[t] = headers[t] || Object.keys(r);
      const keep = t === 'ADVISER.tsv' ? fundIds.has(r.FUND_ID) : wanted.has(r.ACCESSION_NUMBER);
      if (!keep) return;
      out[t].push(r);
      if (t === 'FUND_REPORTED_INFO.tsv') fundIds.add(r.FUND_ID);
    });
  }
  archive.zip.close();
  const zip = new yazl.ZipFile();
  for (const t of TABLES) {
    const body = [headers[t].join('\t'), ...out[t].map(r => headers[t].map(h => r[h]).join('\t'))].join('\n') + '\n';
    zip.addBuffer(Buffer.from(body), t);
  }
  zip.end();
  await new Promise((resolve, reject) =>
    zip.outputStream.pipe(fs.createWriteStream(path.join(OUT, 'mini_ncen.zip'))).on('close', resolve).on('error', reject)
  );
  fs.mkdirSync(path.join(OUT, 'xml'), { recursive: true });
  for (const [accession, { cik }] of Object.entries({ ...DATASET, ...EDGAR_ONLY })) {
    const url = `https://www.sec.gov/Archives/edgar/data/${cik}/${accession.replace(/-/g, '')}/primary_doc.xml`;
    const resp = await axios.get(url, { headers: { 'User-Agent': ua }, responseType: 'text' });
    fs.writeFileSync(path.join(OUT, 'xml', `${accession}.xml`), resp.data);
    await new Promise(r => setTimeout(r, 200));
  }
  const manifest = {
    source: path.basename(zipPath),
    builtAt: new Date().toISOString(),
    dataset: DATASET,
    edgarOnly: EDGAR_ONLY,
    rows: Object.fromEntries(TABLES.map(t => [t, out[t].length])),
  };
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(manifest.rows);
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
