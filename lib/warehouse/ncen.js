// Form N-CEN: each fund's investment adviser and sub-advisers, the source for
// manager (parent firm) mapping. Verified on real filings (P4, STATUS):
// Capital Group's seven registrants all name Capital Research and Management
// Company (801-8055), and N-CEN covers 99.6% of 2026 private-holding value.
//
// Two sources, like N-PORT:
//   - SEC N-CEN data sets (quarterly zips; ADVISER.tsv, FUND_REPORTED_INFO.tsv)
//   - EDGAR primary_doc.xml for N-CEN filings the data sets lack (2025 Q4 is
//     missing 97 of 598 filings; the newest quarter is not published yet).
// Advisers are keyed by SEC file number (801-…): names vary across entities
// of one firm ("BlackRock Fund Advisors", "BlackRock Advisors, LLC") and
// name matching is unsafe ("ACR Alpine Capital Research" vs "Capital Research").
const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const xml2js = require('xml2js');
const { fetchWithRetry } = require('../edgar');
const { openZip, readTable } = require('./tsv-zip');
const { bulkDateToIso } = require('./bulk-ingest');
const { secUserAgent } = require('./bulk-source');
const { listFilings, secGet } = require('./delta');

const DATASET_PAGE = 'https://www.sec.gov/data-research/sec-markets-data/form-n-cen-data-sets';
const NCEN_FORMS = 'N-CEN(?:\\/A)?';
const FIRST_NCEN = '2018-06-01'; // N-CEN replaced N-SAR in mid-2018

function text(value) {
  if (value === null || value === undefined || typeof value === 'object') return null;
  const t = String(value).trim();
  return !t || /^(N\/?A|NONE|NULL|NIL|-+)$/i.test(t) ? null : t;
}
const stripCik = v => String(v || '').replace(/^0+/, '');

// Stable adviser key: SEC file number, else CRD, else the upper-cased name.
function adviserKey({ fileNum, crd, name }) {
  const f = text(fileNum);
  if (f) return f.toUpperCase();
  const c = text(crd);
  if (c) return `CRD:${c.replace(/^0+/, '')}`;
  return `NAME:${String(name || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ')}`;
}

// { quarter, url } for every data set on the SEC page; a re-released zip
// ("2024q1_ncen_0.zip") replaces the original of its quarter.
async function listNcenDatasets() {
  const resp = await fetchWithRetry({
    url: DATASET_PAGE,
    method: 'get',
    headers: { 'User-Agent': secUserAgent() },
    timeout: 30000,
  });
  const byQuarter = new Map();
  for (const m of String(resp.data).matchAll(
    /\/files\/dera\/data\/form-n-cen-data-sets\/((\d{4}q[1-4])_ncen(_\d+)?\.zip)/g
  )) {
    const prev = byQuarter.get(m[2]);
    if (!prev || m[1] > prev.file)
      byQuarter.set(m[2], { quarter: m[2], file: m[1], url: `https://www.sec.gov${m[0]}` });
  }
  if (!byQuarter.size) throw new Error('no N-CEN data sets found on the SEC page');
  return [...byQuarter.values()].sort((a, b) => a.quarter.localeCompare(b.quarter));
}

// Writes one N-CEN filing: its adviser rows and the adviser names.
function storeFiling(db, filing, rows, source) {
  const upsertAdviser = db.prepare(
    `INSERT INTO advisers (file_num, name, crd, lei) VALUES (@file_num, @name, @crd, @lei)
     ON CONFLICT (file_num) DO UPDATE SET name = excluded.name, crd = COALESCE(excluded.crd, crd),
       lei = COALESCE(excluded.lei, lei)`
  );
  const insertRow = db.prepare(
    `INSERT OR IGNORE INTO ncen_advisers (accession, cik, series_id, series_lei, file_num, role, filing_date)
     VALUES (@accession, @cik, @series_id, @series_lei, @file_num, @role, @filing_date)`
  );
  db.prepare('DELETE FROM ncen_advisers WHERE accession = ?').run(filing.accession);
  for (const r of rows) {
    upsertAdviser.run(r);
    insertRow.run({ ...r, accession: filing.accession, cik: filing.cik, filing_date: filing.filing_date });
  }
  db.prepare(
    'INSERT OR REPLACE INTO ncen_filings (accession, cik, filing_date, source) VALUES (@accession, @cik, @filing_date, @source)'
  ).run({ ...filing, source });
}

async function ingestNcenDataset(db, zipPath, { quarter }) {
  if (!/^\d{4}q[1-4]$/.test(quarter || '')) throw new Error(`bad quarter "${quarter}"`);
  const logId = db
    .prepare(
      "INSERT INTO ingest_log (kind, quarter, source_url, started_at, status) VALUES ('ncen', ?, ?, ?, 'running')"
    )
    .run(quarter, zipPath, new Date().toISOString()).lastInsertRowid;
  let archive;
  try {
    archive = await openZip(zipPath);
    const filings = new Map();
    await readTable(archive, 'SUBMISSION.tsv', r => {
      filings.set(r.ACCESSION_NUMBER, {
        accession: r.ACCESSION_NUMBER,
        cik: stripCik(r.CIK),
        filing_date: bulkDateToIso(r.FILING_DATE),
      });
    });
    const funds = new Map();
    await readTable(archive, 'FUND_REPORTED_INFO.tsv', r =>
      funds.set(r.FUND_ID, {
        accession: r.ACCESSION_NUMBER,
        series_id: text(r.SERIES_ID) || '',
        series_lei: text(r.LEI) || '',
      })
    );
    const rowsByAccession = new Map();
    await readTable(archive, 'ADVISER.tsv', r => {
      const role = { Advisor: 'adviser', Subadvisor: 'subadviser' }[r.ADVISER_TYPE];
      const fund = funds.get(r.FUND_ID);
      if (!role || !fund) return; // terminated advisers are history, not the current mapping
      const row = {
        series_id: fund.series_id,
        series_lei: fund.series_lei,
        file_num: adviserKey({ fileNum: r.FILE_NUM, crd: r.CRD_NUM, name: r.ADVISER_NAME }),
        name: String(r.ADVISER_NAME || '').trim(),
        crd: text(r.CRD_NUM),
        lei: text(r.ADVISER_LEI),
        role,
      };
      if (!rowsByAccession.has(fund.accession)) rowsByAccession.set(fund.accession, []);
      rowsByAccession.get(fund.accession).push(row);
    });
    let rows = 0;
    db.transaction(() => {
      for (const f of filings.values()) {
        if (!f.filing_date) throw new Error(`${f.accession}: unreadable filing date`);
        const fr = rowsByAccession.get(f.accession) || [];
        storeFiling(db, f, fr, `dataset:${quarter}`);
        rows += fr.length;
      }
    })();
    db.prepare("UPDATE ingest_log SET finished_at = ?, status = 'ok', filings = ?, rows_kept = ? WHERE id = ?").run(
      new Date().toISOString(),
      filings.size,
      rows,
      logId
    );
    return { quarter, filings: filings.size, rows };
  } catch (err) {
    db.prepare("UPDATE ingest_log SET finished_at = ?, status = 'failed', error = ? WHERE id = ?").run(
      new Date().toISOString(),
      String(err.message || err),
      logId
    );
    throw err;
  } finally {
    if (archive) archive.zip.close();
  }
}

const asArray = v => (v == null ? [] : Array.isArray(v) ? v : [v]);
const pick = (o, ...names) => {
  for (const n of names) if (o && o[n] !== undefined) return o[n];
  return undefined;
};

// Adviser rows from one N-CEN primary_doc.xml (same shape as the data sets).
async function ncenRowsFromXml(xmlText) {
  const doc = await xml2js.parseStringPromise(xmlText, {
    explicitArray: false,
    tagNameProcessors: [xml2js.processors.stripPrefix],
  });
  const formData = pick(doc?.edgarSubmission, 'formData');
  if (!formData) throw new Error('not an N-CEN document (no formData)');
  const rows = [];
  for (const q of asArray(pick(formData, 'managementInvestmentQuestionSeriesInfo')?.managementInvestmentQuestion)) {
    const series_id = text(q.mgmtInvSeriesId) || '';
    const series_lei = text(q.mgmtInvLei) || '';
    for (const a of asArray(q.investmentAdvisers?.investmentAdviser)) {
      rows.push({
        series_id,
        series_lei,
        role: 'adviser',
        name: String(a.investmentAdviserName || '').trim(),
        file_num: adviserKey({
          fileNum: a.investmentAdviserFileNo,
          crd: a.investmentAdviserCrdNo,
          name: a.investmentAdviserName,
        }),
        crd: text(a.investmentAdviserCrdNo),
        lei: text(a.investmentAdviserLei),
      });
    }
    for (const a of asArray(q.subAdvisers?.subAdviser)) {
      rows.push({
        series_id,
        series_lei,
        role: 'subadviser',
        name: String(a.subAdviserName || '').trim(),
        file_num: adviserKey({ fileNum: a.subAdviserFileNo, crd: a.subAdviserCrdNo, name: a.subAdviserName }),
        crd: text(a.subAdviserCrdNo),
        lei: text(a.subAdviserLei),
      });
    }
  }
  return rows.filter(r => r.name);
}

// N-CEN filings listed in EDGAR's index but not yet read from a data set.
async function topUpNcenFromEdgar(db, { since = FIRST_NCEN, until, log = () => {} } = {}) {
  until = until || new Date().toISOString().slice(0, 10);
  const listed = await listFilings({ since, until, forms: NCEN_FORMS });
  const have = new Set(
    db
      .prepare('SELECT accession FROM ncen_filings')
      .all()
      .map(r => r.accession)
  );
  const todo = listed.filter(e => !have.has(e.accession));
  log(`N-CEN: ${listed.length} listed on EDGAR, ${todo.length} not in the data sets`);
  const failed = [];
  for (const [i, e] of todo.entries()) {
    try {
      const base = `https://www.sec.gov/Archives/edgar/data/${e.cik}/${e.accession.replace(/-/g, '')}`;
      const rows = await ncenRowsFromXml(await secGet(`${base}/primary_doc.xml`));
      db.transaction(() =>
        storeFiling(db, { accession: e.accession, cik: e.cik, filing_date: e.filingDate }, rows, 'edgar')
      )();
    } catch (err) {
      failed.push({ accession: e.accession, error: String(err.message || err).split('\n')[0] });
    }
    if ((i + 1) % 100 === 0) log(`  ${i + 1}/${todo.length}`);
  }
  return { listed: listed.length, fetched: todo.length - failed.length, failed };
}

async function downloadDataset(url, dest) {
  const resp = await axios.get(url, {
    responseType: 'arraybuffer',
    headers: { 'User-Agent': secUserAgent() },
    timeout: 120000,
  });
  fs.writeFileSync(dest, resp.data);
}

// Data sets not yet loaded (all of them with { all: true }), then the EDGAR
// top-up: every N-CEN in EDGAR's index since 2018 that is not stored yet, so
// a filing that failed once is retried on the next run (~33 index requests).
async function refreshNcen(db, { all = false, edgar = true, log = () => {} } = {}) {
  const loaded = new Set(
    db
      .prepare("SELECT source_url FROM ingest_log WHERE kind = 'ncen' AND status = 'ok'")
      .all()
      .map(r => path.basename(r.source_url))
  );
  const sets = (await listNcenDatasets()).filter(s => all || !loaded.has(s.file));
  log(`N-CEN data sets to load: ${sets.length}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vantage-ncen-'));
  const datasets = [];
  try {
    for (const s of sets) {
      const zip = path.join(dir, s.file);
      await downloadDataset(s.url, zip);
      try {
        datasets.push(await ingestNcenDataset(db, zip, { quarter: s.quarter }));
      } finally {
        fs.rmSync(zip, { force: true });
      }
      log(`  ${s.quarter}: ${datasets.at(-1).filings} filings, ${datasets.at(-1).rows} adviser rows`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (!edgar) return { datasets, topUp: null };
  const topUp = await topUpNcenFromEdgar(db, { log });
  return { datasets, topUp };
}

module.exports = {
  refreshNcen,
  listNcenDatasets,
  ingestNcenDataset,
  ncenRowsFromXml,
  topUpNcenFromEdgar,
  adviserKey,
  DATASET_PAGE,
};
