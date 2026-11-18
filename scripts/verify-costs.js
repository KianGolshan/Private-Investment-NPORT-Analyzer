#!/usr/bin/env node
// P15 W5: checks every admitted cost of the given companies against the raw SEC
// documents, without the parsers that admitted it (LESSONS 4: verify from the source).
//
//   node scripts/verify-costs.js Anthropic Databricks "Anduril Industries"
//
// For each cost_facts row:
//   N-PORT  the filing's primary_doc.xml (scripts/verify-edgar.js rawHoldings, regex
//           reading): the rows joined to the cost exist with the same shares and value;
//   N-CSR   the report document's text holds, within one line of the security's name, the
//           acquisition date(s) and the cost as printed (dollars or thousands).
// Read-only (the warehouse is opened read-only; SEC requests go through the paced client).
// Prints every row that fails and exits 1 if any does. Writes reports/p15/verify-costs.csv.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { secGet } = require('../lib/warehouse/delta');
const { openWarehouseReadOnly } = require('../lib/warehouse/db');
const { rawHoldings } = require('./verify-edgar');
const { htmlEvents } = require('../lib/ncsr/html');

const LARGE = { maxContentLength: 150 * 1024 * 1024, maxBodyLength: 150 * 1024 * 1024, timeout: 300000 };
const commas = n => Math.round(n).toLocaleString('en-US');
const mdy = iso => {
  const [y, m, d] = iso.split('-');
  return [
    `${Number(m)}/${Number(d)}/${y}`,
    `${Number(m)}/${d}/${y.slice(2)}`,
    `${Number(m)}/${Number(d)}/${y.slice(2)}`,
  ];
};

async function main() {
  const names = process.argv.slice(2);
  if (!names.length) throw new Error('usage: verify-costs.js <company name> [...]');
  const db = openWarehouseReadOnly();
  const facts = db
    .prepare(
      `SELECT f.*, c.name AS company, nf.cik AS ncsr_cik, nf.document, nc.security, nc.shares AS ncsr_shares,
              nc.value_usd AS ncsr_value, fi.cik AS nport_cik
       FROM cost_facts f JOIN companies c ON c.id = f.company_id
       JOIN ncsr_filings nf ON nf.accession = f.ncsr_accession
       JOIN ncsr_costs nc ON nc.accession = f.ncsr_accession AND nc.fund_no = f.fund_no AND nc.line_no = f.line_no
       JOIN filings fi ON fi.accession = f.nport_accession
       WHERE c.name IN (${names.map(() => '?').join(',')})
       ORDER BY c.name, f.report_date, f.fund_key, f.class_label`
    )
    .all(...names);
  const links = db.prepare(
    `SELECT h.row_key, h.title, h.balance, h.value_usd FROM ncsr_cost_links l
     JOIN holdings h ON h.accession = l.nport_accession AND h.row_key = l.row_key
     WHERE l.accession = ? AND l.fund_no = ? AND l.line_no = ?`
  );
  console.log(`${facts.length} admitted costs for ${names.join(', ')}`);
  const nportCache = new Map();
  const ncsrCache = new Map();
  const out = [['company', 'fund', 'class', 'report_date', 'shares', 'value', 'cost', 'nport', 'ncsr', 'problem']];
  let bad = 0;
  for (const [i, f] of facts.entries()) {
    const problems = [];
    // N-PORT: the joined rows, read straight from primary_doc.xml
    const rows = links.all(f.ncsr_accession, f.fund_no, f.line_no);
    const key = f.nport_accession;
    if (!nportCache.has(key)) nportCache.set(key, await rawHoldings(f.nport_cik, key, /./));
    const raw = nportCache.get(key).rows;
    let shares = 0;
    let value = 0;
    for (const r of rows) {
      const hit = raw.filter(x => Number(x.balance) === r.balance && Math.abs(Number(x.valUSD) - r.value_usd) < 0.005);
      if (hit.length < 1) problems.push(`N-PORT row ${r.row_key} (${r.title}) not in primary_doc.xml`);
      shares += r.balance;
      value += r.value_usd;
    }
    if (Math.abs(shares - f.shares) > 1e-6) problems.push(`shares ${shares} vs cost fact ${f.shares}`);
    if (Math.abs(value - f.value_usd) > 0.005) problems.push(`value ${value} vs cost fact ${f.value_usd}`);
    // N-CSR: the cost and date printed near the security's name
    if (!ncsrCache.has(f.ncsr_accession)) {
      const dir = `https://www.sec.gov/Archives/edgar/data/${f.ncsr_cik}/${f.ncsr_accession.replace(/-/g, '')}`;
      const html = String(await secGet(`${dir}/${f.document}`, LARGE));
      // one line of text with single spaces: T. Rowe Price prints each word as its own positioned
      // piece, so a name only reads whole once the pieces are joined
      ncsrCache.set(
        f.ncsr_accession,
        htmlEvents(html)
          .map(e => (e.type === 'row' ? e.cells.join(' ') : e.text))
          .join(' ')
          .replace(/[\s\u200c]+/g, ' ')
      );
    }
    const text = ncsrCache.get(f.ncsr_accession);
    const printed = f.cost_unit === 1000 ? commas(f.cost_usd / 1000) : commas(f.cost_usd);
    const name = f.security
      .replace(/\s*\(([a-z]{1,2})\)/g, '')
      .replace(/\s+\d{1,2}(,\d{1,2})*$/, '')
      .trim();
    const dates = [...new Set([...mdy(f.acquired_first), ...mdy(f.acquired_last)])];
    let found = false;
    for (let at = text.indexOf(name); at >= 0 && !found; at = text.indexOf(name, at + 1)) {
      const window = text.slice(at, at + name.length + 400);
      found = window.includes(printed) && dates.some(d => window.includes(d));
    }
    if (!found) problems.push(`N-CSR: "${name}" with cost ${printed} and its date not found together`);
    if (problems.length) {
      bad++;
      console.error(`FAIL ${f.company} ${f.fund_key} ${f.class_label} ${f.report_date}: ${problems.join('; ')}`);
    }
    out.push([
      f.company,
      f.fund_key,
      f.class_label,
      f.report_date,
      f.shares,
      f.value_usd,
      f.cost_usd,
      f.nport_accession,
      f.ncsr_accession,
      problems.join('; '),
    ]);
    if ((i + 1) % 50 === 0) console.log(`  ${i + 1}/${facts.length}`);
  }
  db.close();
  const file = path.join(__dirname, '..', 'reports', 'p15', 'verify-costs.csv');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    out
      .map(r => r.map(v => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(','))
      .join('\n') + '\n'
  );
  console.log(`${facts.length} checked against raw EDGAR, ${bad} failed; ${file}`);
  if (bad) process.exit(1);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
