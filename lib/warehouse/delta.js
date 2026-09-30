// Daily catch-up: every NPORT-P / NPORT-P/A filed on or after `since`
// (normally the newest bulk filing date), listed from EDGAR's quarterly
// form index, fetched as primary_doc.xml and stored with source='edgar'.
//
// Resumable: accessions already in `filings` are skipped, and each batch of
// filings is written in one transaction, so an interrupted run loses at most
// the batch in flight. Filings that fail to fetch or parse go to
// ingest_errors and are retried on the next run.
const { fetchWithRetry } = require('../edgar');
const { secUserAgent } = require('./bulk-source');
const { parseNportXml, warehouseRowsFromXml } = require('./edgar-rows');
const { rekeyFunds } = require('./fund-keys');
const { insertTotalsStatement } = require('./filing-totals');

const MAX_XML_BYTES = 300 * 1024 * 1024; // real primary_doc.xml sizes: median 352 KB, sampled max 15 MB

// '2026-07-01'..'2026-09-28' -> ['2026/QTR3']; spans quarter boundaries.
function indexQuarters(since, until) {
  const out = [];
  let y = Number(since.slice(0, 4));
  let q = Math.floor((Number(since.slice(5, 7)) - 1) / 3) + 1;
  const endY = Number(until.slice(0, 4));
  const endQ = Math.floor((Number(until.slice(5, 7)) - 1) / 3) + 1;
  while (y < endY || (y === endY && q <= endQ)) {
    out.push(`${y}/QTR${q}`);
    q++;
    if (q > 4) {
      q = 1;
      y++;
    }
  }
  return out;
}

// Lines of EDGAR's form.idx: form type, company, CIK, date filed, file name.
const NPORT_FORMS = 'NPORT-P(?:\\/A)?';
const indexLine = forms => new RegExp(`^(${forms})\\s+(.*?)\\s+(\\d+)\\s+(\\d{4}-\\d{2}-\\d{2})\\s+(\\S+)\\s*$`);
// `forms`: a regex alternative for the form column (default NPORT-P and /A).
function parseFormIndex(text, { since, until, forms = NPORT_FORMS }) {
  const entries = [];
  const re = indexLine(forms);
  for (const line of String(text).split('\n')) {
    const m = re.exec(line);
    if (!m) continue;
    const [, form, company, cik, filingDate, file] = m;
    if (filingDate < since || filingDate > until) continue;
    const accession = /(\d{10}-\d{2}-\d{6})\.txt$/.exec(file)?.[1];
    if (accession) entries.push({ form, company: company.trim(), cik: cik.replace(/^0+/, ''), filingDate, accession });
  }
  return entries;
}

// Network-level failures with no HTTP response. Real catch-up run
// (2026-07-11..31): 2 of 2,719 filings stalled past a 180 s timeout and 2 hit
// EPIPE, yet the same files (138–186 KB) downloaded in 0.1 s moments later.
// These are retried here; HTTP throttling is handled by fetchWithRetry.
const NETWORK_ERRORS = new Set(['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'EAI_AGAIN', 'ERR_BAD_RESPONSE']);
const NETWORK_RETRY_DELAYS_MS = [2000, 8000];

async function secGet(url, extra = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const resp = await fetchWithRetry({
        url,
        method: 'get',
        headers: { 'User-Agent': secUserAgent() },
        responseType: 'text',
        timeout: 60000,
        ...extra,
      });
      return resp.data;
    } catch (err) {
      const network = !err.response && NETWORK_ERRORS.has(err.code);
      if (!network || attempt >= NETWORK_RETRY_DELAYS_MS.length) throw err;
      await new Promise(r => setTimeout(r, NETWORK_RETRY_DELAYS_MS[attempt]));
    }
  }
}

// One entry per accession: the index lists a filing once per filer, so a
// co-registrant filing would otherwise be fetched twice.
async function listFilings({ since, until, forms = NPORT_FORMS }) {
  const byAccession = new Map();
  for (const q of indexQuarters(since, until)) {
    const text = await secGet(`https://www.sec.gov/Archives/edgar/full-index/${q}/form.idx`, {
      maxContentLength: 200 * 1024 * 1024,
    });
    for (const e of parseFormIndex(text, { since, until, forms })) {
      if (!byAccession.has(e.accession)) byAccession.set(e.accession, e);
    }
  }
  return [...byAccession.values()];
}

// The N-PORT XML inside a full submission (.txt): the first
// <edgarSubmission …>…</edgarSubmission> element, or null.
function nportXmlFromSubmission(text) {
  const s = String(text);
  const start = s.search(/<edgarSubmission[\s>]/);
  const end = s.indexOf('</edgarSubmission>', start);
  return start < 0 || end < 0 ? null : s.slice(start, end + '</edgarSubmission>'.length);
}

// primary_doc.xml first. If EDGAR serves it malformed, fall back to the full
// submission text, which carries the same document intact (real:
// 0000940400-26-033042, First Trust S&P REIT Index Fund 2026-06-30 — the
// served primary_doc.xml stops mid-holding at 120 of 129 <invstOrSec>, while
// the .txt submission has all 129 and a closing tag).
async function fetchFilingRows(entry) {
  const base = `https://www.sec.gov/Archives/edgar/data/${entry.cik}/${entry.accession.replace(/-/g, '')}`;
  let xml;
  try {
    xml = await parseNportXml(await secGet(`${base}/primary_doc.xml`, { maxContentLength: MAX_XML_BYTES }));
  } catch (err) {
    if (err.response) throw err; // HTTP errors are not a parse problem
    const inner = nportXmlFromSubmission(
      await secGet(`${base}/${entry.accession}.txt`, { maxContentLength: MAX_XML_BYTES })
    );
    if (!inner) {
      throw new Error(`primary_doc.xml unparseable (${err.message.split('\n')[0]}); no XML in .txt`, { cause: err });
    }
    xml = await parseNportXml(inner);
  }
  return warehouseRowsFromXml(xml, entry);
}

async function ingestDelta(db, { since, until, concurrency = 3, batchSize = 25, log = () => {} } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since || '')) throw new Error(`since must be YYYY-MM-DD, got "${since}"`);
  until = until || new Date().toISOString().slice(0, 10);
  const startedAt = new Date().toISOString();
  const logId = db
    .prepare(
      "INSERT INTO ingest_log (kind, quarter, source_url, started_at, status) VALUES ('edgar', NULL, ?, ?, 'running')"
    )
    .run(`edgar full-index ${since}..${until}`, startedAt).lastInsertRowid;

  const insertFiling = db.prepare(
    `INSERT OR REPLACE INTO filings (accession, fund_key, cik, series_id, registrant, series_name, report_date,
       filing_date, form, net_assets, total_assets, source, series_lei, registrant_lei)
     VALUES (@accession, @fund_key, @cik, @series_id, @registrant, @series_name, @report_date, @filing_date,
       @form, @net_assets, @total_assets, @source, @series_lei, @registrant_lei)`
  );
  const insertHolding = db.prepare(
    `INSERT INTO holdings (accession, row_key, issuer_name, title, cusip, lei, isin, ticker, other_id, other_id_desc,
       balance, unit, currency, value_usd, pct_nav, asset_cat, other_asset, issuer_type, country, restricted,
       fv_level, deriv_cat, instrument_type)
     VALUES (@accession, @row_key, @issuer_name, @title, @cusip, @lei, @isin, @ticker, @other_id, @other_id_desc,
       @balance, @unit, @currency, @value_usd, @pct_nav, @asset_cat, @other_asset, @issuer_type, @country,
       @restricted, @fv_level, @deriv_cat, @instrument_type)`
  );
  const insertTotals = insertTotalsStatement(db);
  const clearError = db.prepare('DELETE FROM ingest_errors WHERE accession = ?');
  const recordError = db.prepare(
    `INSERT INTO ingest_errors (accession, cik, filing_date, form, error, attempts, last_attempt_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(accession) DO UPDATE SET error = excluded.error, attempts = attempts + 1,
       last_attempt_at = excluded.last_attempt_at`
  );
  const writeBatch = db.transaction(results => {
    for (const r of results) {
      insertFiling.run(r.filing); // REPLACE cascades away any earlier rows for this accession
      for (const h of r.holdings) insertHolding.run(h);
      insertTotals(r.filing.accession, r.totals);
      clearError.run(r.filing.accession);
    }
  });

  try {
    const listed = await listFilings({ since, until });
    const known = db.prepare('SELECT 1 FROM filings WHERE accession = ?');
    const todo = listed.filter(e => !known.get(e.accession));
    log(`EDGAR index ${since}..${until}: ${listed.length} NPORT filings listed, ${todo.length} not yet in warehouse`);

    const stats = { listed: listed.length, loaded: 0, failed: 0, rowsRead: 0, rowsKept: 0 };
    let pending = [];
    let next = 0;
    const t0 = Date.now();
    const flush = () => {
      if (!pending.length) return;
      writeBatch(pending);
      pending = [];
    };
    const worker = async () => {
      for (;;) {
        const entry = todo[next++];
        if (!entry) return;
        try {
          const rows = await fetchFilingRows(entry);
          pending.push(rows);
          stats.loaded++;
          stats.rowsRead += rows.rowsRead;
          stats.rowsKept += rows.holdings.length;
          if (pending.length >= batchSize) flush();
        } catch (err) {
          stats.failed++;
          const msg = err.response?.status ? `HTTP ${err.response.status}` : String(err.message || err);
          recordError.run(entry.accession, entry.cik, entry.filingDate, entry.form, msg, new Date().toISOString());
        }
        const done = stats.loaded + stats.failed;
        if (done % 500 === 0) {
          const rate = done / ((Date.now() - t0) / 1000);
          log(
            `  ${done}/${todo.length} (${rate.toFixed(1)}/s, ~${Math.round((todo.length - done) / rate / 60)} min left)`
          );
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
    flush();

    rekeyFunds(db);
    db.prepare(
      'UPDATE ingest_log SET filings = ?, rows_read = ?, rows_kept = ?, finished_at = ?, status = ?, error = ? WHERE id = ?'
    ).run(
      stats.loaded,
      stats.rowsRead,
      stats.rowsKept,
      new Date().toISOString(),
      stats.failed ? 'failed' : 'ok',
      stats.failed ? `${stats.failed} filing(s) failed; see ingest_errors` : null,
      logId
    );
    return stats;
  } catch (err) {
    db.prepare("UPDATE ingest_log SET finished_at = ?, status = 'failed', error = ? WHERE id = ?").run(
      new Date().toISOString(),
      String(err.message || err),
      logId
    );
    throw err;
  }
}

// Default catch-up start: the newest filing date the bulk data covers (the
// bulk file for a quarter holds filings made through that quarter's end).
function defaultSince(db) {
  const row = db.prepare("SELECT MAX(filing_date) d FROM filings WHERE source LIKE 'bulk:%'").get();
  return row?.d || null;
}

module.exports = { ingestDelta, listFilings, parseFormIndex, indexQuarters, defaultSince, fetchFilingRows, secGet };
