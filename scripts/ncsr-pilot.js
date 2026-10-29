#!/usr/bin/env node
// N-CSR cost pilot (docs/plans/ncsr-research.md): reads the latest N-CSR / N-CSRS
// filings of a few registrants, parses each fund's restricted-securities table
// (security, acquisition date, cost), joins every row to the same fund's N-PORT
// holdings at the same date by shares and value, and writes a report. Read-only:
// the warehouse is opened read-only and nothing is stored in it.
//
//   node scripts/ncsr-pilot.js                     # the pilot registrants, latest 2 reports each
//   node scripts/ncsr-pilot.js --cik 707823 --periods 1
//   node scripts/ncsr-pilot.js --out reports/ncsr  # where the report goes (default)
//
// Needs SEC_USER_AGENT (.env). SEC requests go through the paced client (secGet);
// documents are cached under <out>/cache so a re-run makes no SEC request. Writes
// <out>/pilot-<date>.csv (one line per cost row) and .md (match rates, checks, every
// row that did not match). Exits 1 when a parse self-check fails or a fund cannot be
// mapped to its series, so a misread table never passes quietly.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { secGet } = require('../lib/warehouse/delta');
const { openWarehouseReadOnly } = require('../lib/warehouse/db');
const { parseNcsr } = require('../lib/ncsr/parse');
const { matchToNport, selfChecks, JOINED } = require('../lib/ncsr/match');

const KINDS = ['exact', 'legs', 'combined', 'value', 'ambiguous', 'debt', 'none'];

// The pilot registrants and the layout each one files in.
const PILOT = {
  707823: { family: 'fidelity', note: 'Fidelity Mt. Vernon Street Trust (Growth Company Fund and 6 more)' },
  24238: { family: 'fidelity', note: 'Fidelity Contrafund' },
  44201: { family: 'capital', note: 'The Growth Fund of America' },
  858744: { family: 'capital', note: 'SMALLCAP World Fund' },
  80257: { family: 'troweprice', note: 'T. Rowe Price Growth Stock Fund' },
  80248: { family: 'troweprice', note: 'T. Rowe Price New Horizons Fund' },
  819930: { family: 'troweprice', note: 'T. Rowe Price Science & Technology Fund' },
  1002624: { family: 'troweprice', note: 'T. Rowe Price Health Sciences Fund' },
  // 40-90 MB per report for about 8 private rows: the latest 2 reports at most
  836487: { family: 'morganstanley', note: 'Morgan Stanley Institutional Fund (22 portfolios)', maxPeriods: 2 },
};
// Morgan Stanley's annual report is 87 MB; the client's default limit is 25 MB.
const LARGE = { maxContentLength: 150 * 1024 * 1024, maxBodyLength: 150 * 1024 * 1024, timeout: 300000 };

function args(argv) {
  const out = { ciks: null, periods: 2, out: 'reports/ncsr' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cik') out.ciks = argv[++i].split(',').map(s => s.replace(/^0+/, ''));
    else if (argv[i] === '--periods') out.periods = Number(argv[++i]);
    else if (argv[i] === '--out') out.out = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!Number.isInteger(out.periods) || out.periods < 1) throw new Error('--periods must be a positive integer');
  return out;
}

async function cached(cacheDir, name, url) {
  const file = path.join(cacheDir, name);
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  const body = String(await secGet(url, LARGE));
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(file, body);
  return body;
}

// The document holding the shareholder report. Usually the primary document; before 2022
// T. Rowe Price filed a short cover (119 KB) with the report as an exhibit, so a small primary
// document gives way to the filing's largest HTML file.
const SMALL_PRIMARY = 1024 * 1024;
async function reportDocument(cacheDir, dir, rep) {
  const html = await cached(cacheDir, `${rep.accession}.htm`, `${dir}/${rep.primaryDocument}`);
  if (html.length >= SMALL_PRIMARY) return html;
  const index = JSON.parse(await cached(cacheDir, `${rep.accession}-index.json`, `${dir}/index.json`));
  const docs = index.directory.item
    .filter(x => /\.html?$/i.test(x.name) && !/index/i.test(x.name) && Number(x.size) > html.length)
    .sort((a, b) => Number(b.size) - Number(a.size));
  return docs.length ? cached(cacheDir, `${rep.accession}-${docs[0].name}`, `${dir}/${docs[0].name}`) : html;
}

// The latest `n` original N-CSR / N-CSRS filings of a registrant (amendments are listed, not read).
async function latestReports(cacheDir, cik, n) {
  const padded = String(cik).padStart(10, '0');
  const sub = JSON.parse(
    await cached(cacheDir, `submissions-${padded}.json`, `https://data.sec.gov/submissions/CIK${padded}.json`)
  );
  const r = sub.filings.recent;
  const reports = [];
  for (let i = 0; i < r.form.length && reports.length < n; i++) {
    if (r.form[i] !== 'N-CSR' && r.form[i] !== 'N-CSRS') continue;
    reports.push({
      cik: String(cik),
      registrant: sub.name,
      form: r.form[i],
      accession: r.accessionNumber[i],
      filingDate: r.filingDate[i],
      reportDate: r.reportDate[i],
      primaryDocument: r.primaryDocument[i],
    });
  }
  return reports;
}

// The series a filing covers, from its SGML header (the filer's own identifiers).
function headerSeries(text) {
  const t = text
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
  const out = [];
  for (const m of t.matchAll(/<SERIES-ID>\s*(S\d{9})\s*<SERIES-NAME>\s*([^\n<]+)/g))
    out.push({ seriesId: m[1], name: m[2].trim() });
  return out;
}

const normName = s =>
  String(s)
    .toLowerCase()
    .replace(/[®™]/g, '')
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

function seriesFor(fund, series) {
  if (fund.fundName === null) return series.length === 1 ? series[0] : null;
  const hits = series.filter(s => normName(s.name) === normName(fund.fundName));
  return hits.length === 1 ? hits[0] : null;
}

function nportFor(db, seriesId, reportDate) {
  const filing = db
    .prepare(
      `SELECT accession, fund_key, series_name, net_assets, filing_date FROM canonical_filings
       WHERE series_id = ? AND report_date = ?`
    )
    .get(seriesId, reportDate);
  if (!filing) return { filing: null, holdings: [] };
  const holdings = db
    .prepare(
      `SELECT h.row_key, h.issuer_name, h.title, h.balance, h.value_usd, h.company_id,
              c.name AS company_name, c.category, c.status
       FROM holdings h LEFT JOIN companies c ON c.id = h.company_id
       WHERE h.accession = ? ORDER BY h.row_key`
    )
    .all(filing.accession);
  return { filing, holdings };
}

const csvCell = v => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const usd = v => (v === null ? '—' : `$${Math.round(v).toLocaleString('en-US')}`);
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : '—');

const CSV_COLUMNS = [
  'ncsr_accession',
  'form',
  'family',
  'fund',
  'series_id',
  'period_end',
  'security',
  'acquired_first',
  'acquired_last',
  'cost',
  'ncsr_value',
  'shares',
  'match',
  'paired_by_order',
  'nport_accession',
  'nport_row_keys',
  'nport_value',
  'company_id',
  'company',
  'category',
  'cost_per_share',
  'value_to_cost',
];

async function main() {
  const opt = args(process.argv.slice(2));
  const ciks = opt.ciks || Object.keys(PILOT);
  const cacheDir = path.join(opt.out, 'cache');
  const db = openWarehouseReadOnly();
  const csv = [CSV_COLUMNS.join(',')];
  const funds = [];
  const unreadable = [];
  const problems = [];
  try {
    for (const cik of ciks) {
      const p = PILOT[cik];
      if (!p) throw new Error(`CIK ${cik} is not a pilot registrant (${Object.keys(PILOT).join(', ')})`);
      for (const rep of await latestReports(cacheDir, cik, Math.min(opt.periods, p.maxPeriods || Infinity))) {
        const dir = `https://www.sec.gov/Archives/edgar/data/${cik}/${rep.accession.replace(/-/g, '')}`;
        const header = await cached(
          cacheDir,
          `${rep.accession}-headers.html`,
          `${dir}/${rep.accession}-index-headers.html`
        );
        const html = await reportDocument(cacheDir, dir, rep);
        const series = headerSeries(header);
        let parsed;
        try {
          parsed = parseNcsr(html, p.family);
        } catch (err) {
          // an unreadable filing is reported and fails the run, but the other filings are still read
          unreadable.push({ rep, error: err.message });
          problems.push(`${rep.accession} (${rep.form} ${rep.reportDate}): ${err.message}`);
          continue;
        }
        for (const fund of parsed) {
          const s = seriesFor(fund, series);
          const name = fund.fundName || (s && s.name) || rep.registrant;
          const checks = selfChecks(fund);
          if (fund.periodEnd !== rep.reportDate)
            checks.push({
              check: 'period end = filing report date',
              ok: false,
              detail: `${fund.periodEnd} vs ${rep.reportDate}`,
            });
          const entry = { rep, family: p.family, name, series: s, fund, checks, results: [], nport: null };
          funds.push(entry);
          for (const c of checks)
            if (!c.ok && c.severity !== 'note') problems.push(`${rep.accession} ${name}: ${c.check} (${c.detail})`);
          if (!s) {
            problems.push(`${rep.accession} ${name}: no single series in the filing header matches this fund`);
            continue;
          }
          const { filing, holdings } = nportFor(db, s.seriesId, fund.periodEnd);
          entry.nport = filing;
          if (!filing) continue; // reported as "no N-PORT at this date"
          entry.results = matchToNport(fund, holdings);
          for (const r of entry.results)
            csv.push(
              [
                rep.accession,
                rep.form,
                p.family,
                name,
                s.seriesId,
                fund.periodEnd,
                r.rawName,
                r.acquiredFirst,
                r.acquiredLast,
                r.cost,
                r.value,
                r.shares,
                r.match,
                r.pairedByOrder ? 'yes' : '',
                filing.accession,
                r.nport.map(h => h.row_key).join(' '),
                r.nportValue,
                r.companyId,
                r.companyName,
                r.category,
                r.costPerShare === null ? null : r.costPerShare.toFixed(4),
                r.valueToCost === null ? null : r.valueToCost.toFixed(4),
              ]
                .map(csvCell)
                .join(',')
            );
        }
      }
    }
  } finally {
    db.close();
  }

  const day = new Date().toISOString().slice(0, 10);
  fs.mkdirSync(opt.out, { recursive: true });
  const csvPath = path.join(opt.out, `pilot-${day}.csv`);
  fs.writeFileSync(csvPath, csv.join('\n') + '\n');

  const md = [
    `# N-CSR cost pilot (${day})`,
    '',
    'Read-only. One line per fund; every row that did not match is listed.',
    '',
  ];
  md.push(
    `| Filing | Fund | Series | Period | Cost rows | ${KINDS.join(' | ')} | Equity cost joined | N-PORT filing | Checks |`,
    `| --- | --- | --- | --- | ---: | ${KINDS.map(() => '---:').join(' | ')} | ---: | --- | --- |`
  );
  const totals = { rows: 0, cost: 0, costMatched: 0, ...Object.fromEntries(KINDS.map(k => [k, 0])) };
  for (const f of funds) {
    const count = k => f.results.filter(r => r.match === k).length;
    // equity-type rows only: the warehouse keeps no notes or bonds
    const cost = f.results.filter(r => r.match !== 'debt').reduce((s, r) => s + r.cost, 0);
    const costMatched = f.results.filter(r => JOINED.has(r.match)).reduce((s, r) => s + r.cost, 0);
    totals.rows += f.fund.restricted.length;
    for (const k of KINDS) totals[k] += count(k);
    totals.cost += cost;
    totals.costMatched += costMatched;
    const failed = f.checks.filter(c => !c.ok && c.severity !== 'note');
    md.push(
      `| ${f.rep.form} ${f.rep.accession} | ${f.name} | ${f.series ? f.series.seriesId : 'unmapped'} | ${f.fund.periodEnd} | ${f.fund.restricted.length} | ${KINDS.map(count).join(' | ')} | ${usd(costMatched)} of ${usd(cost)} (${pct(costMatched, cost)}) | ${f.nport ? f.nport.accession : 'none at this date'} | ${failed.length ? failed.map(c => c.check).join('; ') : `${f.checks.length} ok`} |`
    );
  }
  md.push(
    '',
    `**All:** ${totals.rows} cost rows; ${KINDS.map(k => `${k} ${totals[k]}`).join(', ')}; equity cost joined ${usd(totals.costMatched)} of ${usd(totals.cost)} (${pct(totals.costMatched, totals.cost)}).`,
    ''
  );
  if (unreadable.length) {
    md.push('## Filings the parsers could not read', '');
    for (const u of unreadable)
      md.push(`- ${u.rep.accession} ${u.rep.registrant} ${u.rep.form} ${u.rep.reportDate}: ${u.error}`);
    md.push('');
  }
  md.push('## Rows not joined one to one', '');
  for (const f of funds)
    for (const r of f.results.filter(x => x.match !== 'exact'))
      md.push(
        `- ${f.rep.accession} ${f.name}: **${r.rawName}** (${r.match}${r.pairedByOrder ? ', name printed more than once' : ''}${r.scheduleFound ? '' : ', no schedule row'}) cost ${usd(r.cost)}, value ${usd(r.value)}, shares ${r.shares === null ? '—' : r.shares.toLocaleString('en-US')}; N-PORT rows ${r.nport.map(h => `${h.row_key} (${h.title}, ${h.balance}, ${usd(h.value_usd)})`).join('; ') || 'none'}`
      );
  md.push('', '## Checks', '');
  for (const f of funds)
    for (const c of f.checks)
      md.push(
        `- ${c.ok ? 'ok' : c.severity === 'note' ? 'note' : '**FAILED**'} ${f.rep.accession} ${f.name}: ${c.check} (${c.detail})`
      );
  const mdPath = path.join(opt.out, `pilot-${day}.md`);
  fs.writeFileSync(mdPath, md.join('\n') + '\n');

  console.log(md.slice(0, 6 + funds.length + 2).join('\n'));
  console.log(`\nwrote ${csvPath}\nwrote ${mdPath}`);
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

module.exports = { headerSeries, seriesFor, normName, PILOT };
