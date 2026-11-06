// N-CSR / N-CSRS cost tables (P15, ADR 0011): the cost and acquisition date of each
// restricted holding, from the funds' own shareholder reports, joined to the same fund's
// N-PORT holding at the same report date by shares and value, never by name.
//
// Registrants come from data/review/ncsr_families.csv (reviewed: the family's layout has
// a parser, lib/ncsr/parse.js). Each run reads the filings not yet stored (and retries the
// failed ones), at most `max` per run so the first nightly on a server spreads the
// backfill. One transaction per filing; a filing that cannot be parsed is stored as
// failed (no rows) or unreadable (page images), never half. Nothing here touches an
// N-PORT table: cost_facts (lib/warehouse/cost-facts.js) is the only way a cost reaches
// the app, and only when every admission check passes.
const fs = require('fs');
const path = require('path');
const { secGet } = require('./delta');
const { parseCsv } = require('../entities/csv');
const { parseNcsr, FAMILIES } = require('../ncsr/parse');
const { matchToNport, selfChecks, refusal, allChecksPassed } = require('../ncsr/match');
const { headerSeries, seriesFor, reportDocument, imageOnly } = require('../ncsr/filing');

const ROOT = path.join(__dirname, '..', '..');
const FAMILIES_CSV = path.join(ROOT, 'data', 'review', 'ncsr_families.csv');
const FORMS = new Set(['N-CSR', 'N-CSRS', 'N-CSR/A', 'N-CSRS/A']);
const FIRST_PERIOD = '2019-09-30'; // N-PORT history starts 2019Q4: nothing earlier can join
// Morgan Stanley's annual report is 87 MB; the client's default limit is 25 MB.
const LARGE = { maxContentLength: 150 * 1024 * 1024, maxBodyLength: 150 * 1024 * 1024, timeout: 300000 };

function readFamilies(file = FAMILIES_CSV) {
  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  const seen = new Set();
  return rows.map((r, i) => {
    const cik = String(r.cik || '').replace(/^0+/, '');
    if (!/^\d+$/.test(cik)) throw new Error(`${path.basename(file)} line ${i + 2}: bad cik "${r.cik}"`);
    if (!FAMILIES.includes(r.family))
      throw new Error(`${path.basename(file)} line ${i + 2}: family "${r.family}" has no parser`);
    if (seen.has(cik)) throw new Error(`${path.basename(file)} line ${i + 2}: cik ${cik} listed twice`);
    seen.add(cik);
    return { cik, family: r.family, registrant: r.registrant };
  });
}

// Every N-CSR / N-CSRS (and amendment) a registrant filed for a period on or after
// FIRST_PERIOD, from the SEC submissions API (recent filings, then the older pages).
async function listReports(cik, { get = secGet } = {}) {
  const padded = String(cik).padStart(10, '0');
  const sub = JSON.parse(String(await get(`https://data.sec.gov/submissions/CIK${padded}.json`)));
  const pages = [sub.filings.recent];
  for (const f of sub.filings.files || [])
    if (f.filingTo >= FIRST_PERIOD)
      pages.push(JSON.parse(String(await get(`https://data.sec.gov/submissions/${f.name}`))));
  const out = [];
  for (const r of pages)
    for (let i = 0; i < r.form.length; i++) {
      if (!FORMS.has(r.form[i]) || !r.reportDate[i] || r.reportDate[i] < FIRST_PERIOD) continue;
      out.push({
        cik: String(cik),
        form: r.form[i],
        accession: r.accessionNumber[i],
        filingDate: r.filingDate[i],
        periodEnd: r.reportDate[i],
        primaryDocument: r.primaryDocument[i],
      });
    }
  return out;
}

const nportFilings = db =>
  db.prepare(`SELECT accession, fund_key FROM canonical_filings WHERE series_id = ? AND report_date = ?`);
const nportRows = db =>
  db.prepare(
    `SELECT row_key, issuer_name, title, balance, value_usd, company_id FROM holdings WHERE accession = ? ORDER BY row_key`
  );

// Parse one filing's report and join each fund to its N-PORT. Pure apart from reads of
// the warehouse; returns what store() writes.
function readFiling(db, rep, family, { html, header, document }) {
  const funds = [];
  const lines = [];
  const findNport = nportFilings(db);
  const rowsOf = nportRows(db);
  const series = headerSeries(header);
  parseNcsr(html, family).forEach((fund, i) => {
    const fundNo = i + 1;
    const s = seriesFor(fund, series);
    const checks = selfChecks(fund);
    if (fund.periodEnd !== rep.periodEnd)
      checks.push({
        check: 'period end = filing report date',
        ok: false,
        detail: `${fund.periodEnd} vs ${rep.periodEnd}`,
      });
    const nport = s ? findNport.all(s.seriesId, rep.periodEnd) : [];
    const status = !s ? 'unmapped' : nport.length !== 1 ? 'no_nport' : !allChecksPassed(checks) ? 'checks' : 'ok';
    funds.push({
      fund_no: fundNo,
      fund_name: fund.fundName || (s && s.name) || null,
      series_id: s ? s.seriesId : null,
      fund_key: nport.length === 1 ? nport[0].fund_key : null,
      period_end: fund.periodEnd,
      value_unit: fund.unit,
      net_assets_usd: fund.netAssets,
      restricted_usd: fund.restrictedTotal && fund.restrictedTotal.value != null ? fund.restrictedTotal.value : null,
      checks: JSON.stringify(checks),
      nport_accession: nport.length === 1 ? nport[0].accession : null,
      status,
    });
    const results = nport.length === 1 ? matchToNport(fund, rowsOf.all(nport[0].accession)) : null;
    fund.restricted.forEach((c, j) => {
      const r = results ? results[j] : { ...c, match: 'none', nport: [], pairedByOrder: false, scheduleFound: false };
      lines.push({
        fund_no: fundNo,
        line_no: j + 1,
        security: c.rawName,
        acquired_first: c.acquiredFirst,
        acquired_last: c.acquiredLast,
        cost_usd: c.cost,
        cost_unit: c.costUnit,
        value_usd: r.value ?? null,
        shares: r.shares ?? null,
        currency: c.currency || null,
        below_unit: c.belowUnit ? 1 : 0,
        paired_by_order: r.pairedByOrder ? 1 : 0,
        match: r.match,
        refused: refusal(r, { fundOk: status === 'ok', unit: fund.unit }),
        links: r.match === 'exact' || r.match === 'legs' ? r.nport.map(h => h.row_key) : [],
        nport_accession: nport.length === 1 ? nport[0].accession : null,
      });
    });
  });
  return { document, funds, lines };
}

// One filing in one transaction: a re-read replaces everything stored for the accession.
function store(db, rep, family, result, { status, error = null, now }) {
  const prior = db.prepare('SELECT attempts FROM ncsr_filings WHERE accession = ?').get(rep.accession);
  db.transaction(() => {
    db.prepare('DELETE FROM ncsr_filings WHERE accession = ?').run(rep.accession); // cascades
    db.prepare(
      `INSERT INTO ncsr_filings (accession, cik, family, form, period_end, filing_date, document, status, error,
         funds, lines, attempts, read_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      rep.accession,
      rep.cik,
      family,
      rep.form,
      rep.periodEnd,
      rep.filingDate,
      result ? result.document : null,
      status,
      error,
      result ? result.funds.length : 0,
      result ? result.lines.length : 0,
      (prior ? prior.attempts : 0) + 1,
      now
    );
    if (!result) return;
    const fund = db.prepare(
      `INSERT INTO ncsr_funds (accession, fund_no, fund_name, series_id, fund_key, period_end, value_unit,
         net_assets_usd, restricted_usd, checks, nport_accession, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    for (const f of result.funds)
      fund.run(
        rep.accession,
        f.fund_no,
        f.fund_name,
        f.series_id,
        f.fund_key,
        f.period_end,
        f.value_unit,
        f.net_assets_usd,
        f.restricted_usd,
        f.checks,
        f.nport_accession,
        f.status
      );
    const line = db.prepare(
      `INSERT INTO ncsr_costs (accession, fund_no, line_no, security, acquired_first, acquired_last, cost_usd,
         cost_unit, value_usd, shares, currency, below_unit, paired_by_order, match, refused)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    const link = db.prepare(
      'INSERT INTO ncsr_cost_links (accession, fund_no, line_no, nport_accession, row_key) VALUES (?,?,?,?,?)'
    );
    for (const l of result.lines) {
      line.run(
        rep.accession,
        l.fund_no,
        l.line_no,
        l.security,
        l.acquired_first,
        l.acquired_last,
        l.cost_usd,
        l.cost_unit,
        l.value_usd,
        l.shares,
        l.currency,
        l.below_unit,
        l.paired_by_order,
        l.match,
        l.refused
      );
      for (const k of l.links) link.run(rep.accession, l.fund_no, l.line_no, l.nport_accession, String(k));
    }
  })();
}

// The ingest. Reads, for each registrant in the registry, every report not stored yet
// (ok and unreadable filings are final; failed ones are retried), oldest first, at most
// `max` filings in all. Returns counts and the filings that failed this run.
async function ingestNcsr(
  db,
  { ciks = null, max = Infinity, log = () => {}, get = secGet, now = () => new Date().toISOString() } = {}
) {
  const startedAt = now();
  const families = readFamilies().filter(f => !ciks || ciks.includes(f.cik));
  const final = new Set(
    db
      .prepare("SELECT accession FROM ncsr_filings WHERE status IN ('ok', 'unreadable')")
      .all()
      .map(r => r.accession)
  );
  const todo = [];
  for (const f of families)
    for (const rep of await listReports(f.cik, { get }))
      if (!final.has(rep.accession)) todo.push({ rep, family: f.family });
  todo.sort(
    (a, b) => a.rep.filingDate.localeCompare(b.rep.filingDate) || a.rep.accession.localeCompare(b.rep.accession)
  );
  const batch = todo.slice(0, max);
  log(`N-CSR: ${families.length} registrants, ${todo.length} filings to read, ${batch.length} this run`);
  const counts = { ok: 0, failed: 0, unreadable: 0, lines: 0, admitted: 0 };
  const failed = [];
  for (const [i, { rep, family }] of batch.entries()) {
    const dir = `https://www.sec.gov/Archives/edgar/data/${rep.cik}/${rep.accession.replace(/-/g, '')}`;
    let doc = null;
    try {
      const header = String(await get(`${dir}/${rep.accession}-index-headers.html`));
      doc = await reportDocument(
        rep.primaryDocument,
        async name => String(await get(`${dir}/${name}`, LARGE)),
        async () => JSON.parse(String(await get(`${dir}/index.json`)))
      );
      const result = readFiling(db, rep, family, { html: doc.html, header, document: doc.name });
      store(db, rep, family, result, { status: 'ok', now: now() });
      counts.ok++;
      counts.lines += result.lines.length;
      counts.admitted += result.lines.filter(l => !l.refused).length;
    } catch (err) {
      if (err.response && err.response.status !== 404) throw err; // the SEC refused: stop, nothing half-read
      const unreadable = doc && imageOnly(doc.html, doc.images || 0);
      const message = String(err.message || err).split('\n')[0];
      store(db, rep, family, null, { status: unreadable ? 'unreadable' : 'failed', error: message, now: now() });
      counts[unreadable ? 'unreadable' : 'failed']++;
      if (!unreadable) failed.push({ accession: rep.accession, cik: rep.cik, form: rep.form, error: message });
    }
    if ((i + 1) % 25 === 0) log(`  ${i + 1}/${batch.length}`);
  }
  db.prepare(
    `INSERT INTO ingest_log (kind, quarter, source_url, filings, rows_read, rows_kept, started_at, finished_at, status, error)
     VALUES ('ncsr', NULL, 'data.sec.gov submissions', ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    batch.length,
    counts.lines,
    counts.admitted,
    startedAt,
    now(),
    failed.length ? 'partial' : 'ok',
    failed.length ? `${failed.length} filing(s) failed` : null
  );
  log(
    `N-CSR: ${counts.ok} read, ${counts.unreadable} unreadable, ${counts.failed} failed; ` +
      `${counts.lines} cost lines, ${counts.admitted} pass the number checks`
  );
  return { ...counts, pending: todo.length - batch.length, failedFilings: failed };
}

module.exports = { ingestNcsr, readFamilies, listReports, readFiling, store, FIRST_PERIOD, FAMILIES_CSV };
