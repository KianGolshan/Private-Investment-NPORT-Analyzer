// One-off backfill of filing_totals (migration 0015) for filings loaded before
// the totals existed: bulk filings from their quarter's zip (re-downloaded),
// catch-up filings from EDGAR (primary_doc.xml again, at the SEC rate).
// Totals only: filings and holdings are not rewritten. Resumable: a quarter
// or filing that already has totals is skipped, and each quarter / batch is
// one transaction. `deadline` (ms timestamp) stops starting new work, so a
// run can be kept to a timed foreground batch (LESSONS 9).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { bulkFilingTotals } = require('./bulk-ingest');
const { insertTotalsStatement } = require('./filing-totals');

// Bulk quarters with filings still lacking totals, oldest first.
function bulkQuartersMissingTotals(db) {
  return db
    .prepare(
      `SELECT substr(f.source, 6) quarter, COUNT(*) missing FROM filings f
       LEFT JOIN filing_totals t ON t.accession = f.accession
       WHERE f.source LIKE 'bulk:%' AND t.accession IS NULL GROUP BY f.source ORDER BY f.source`
    )
    .all();
}

function edgarFilingsMissingTotals(db) {
  return db
    .prepare(
      `SELECT f.accession, f.cik, f.filing_date filingDate, f.form FROM filings f
       LEFT JOIN filing_totals t ON t.accession = f.accession
       WHERE f.source = 'edgar' AND t.accession IS NULL ORDER BY f.filing_date, f.accession`
    )
    .all();
}

// download(quarter, dir) -> { path } (bulk-source's downloadQuarter).
async function backfillBulkTotals(db, { download, quarters, deadline = Infinity, log = () => {} }) {
  const todo = bulkQuartersMissingTotals(db).filter(q => !quarters || quarters.includes(q.quarter));
  const insert = insertTotalsStatement(db);
  const accessionsOf = db.prepare('SELECT accession FROM filings WHERE source = ?');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vantage-totals-'));
  const done = [];
  try {
    for (const { quarter, missing } of todo) {
      if (Date.now() >= deadline) break;
      const t0 = Date.now();
      const zip = await download(quarter, tmpDir);
      try {
        const totals = await bulkFilingTotals(zip.path);
        const stored = accessionsOf.all(`bulk:${quarter}`).map(r => r.accession);
        const absent = stored.filter(a => !totals.has(a));
        // A stored bulk filing must be in its own quarter's zip; if not, the
        // zip changed since we loaded it (trap 41): stop rather than guess.
        if (absent.length)
          throw new Error(`${quarter}: ${absent.length} stored filings are not in the zip (re-posted?)`);
        db.transaction(() => {
          for (const a of stored) insert(a, totals.get(a));
        })();
        done.push({ quarter, filings: stored.length });
        log(
          `${quarter}: totals for ${stored.length} filings (${missing} missing) in ${((Date.now() - t0) / 1000).toFixed(0)} s`
        );
      } finally {
        fs.rmSync(zip.path, { force: true });
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  return { done, left: bulkQuartersMissingTotals(db).length };
}

// fetchRows(entry) -> warehouseRowsFromXml's result (delta's fetchFilingRows).
// The stored holdings are checked against the re-read filing: a different
// kept-row count is reported, never silently accepted.
async function backfillEdgarTotals(
  db,
  { fetchRows, concurrency = 3, batchSize = 50, deadline = Infinity, log = () => {} }
) {
  const todo = edgarFilingsMissingTotals(db);
  const insert = insertTotalsStatement(db);
  const keptCount = db.prepare('SELECT COUNT(*) n FROM holdings WHERE accession = ?');
  const stats = { todo: todo.length, loaded: 0, failed: [], keptMismatch: [] };
  let pending = [];
  const flush = () => {
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    db.transaction(() => {
      for (const r of batch) insert(r.accession, r.totals);
    })();
  };
  let next = 0;
  const t0 = Date.now();
  const worker = async () => {
    for (;;) {
      if (Date.now() >= deadline) return;
      const entry = todo[next++];
      if (!entry) return;
      try {
        const rows = await fetchRows(entry);
        const stored = keptCount.get(entry.accession).n;
        if (stored !== rows.holdings.length) {
          stats.keptMismatch.push({ accession: entry.accession, stored, reread: rows.holdings.length });
        }
        pending.push({ accession: entry.accession, totals: rows.totals });
        stats.loaded++;
        if (pending.length >= batchSize) flush();
      } catch (err) {
        stats.failed.push({
          accession: entry.accession,
          error: err.response?.status ? `HTTP ${err.response.status}` : String(err.message || err),
        });
      }
      const n = stats.loaded + stats.failed.length;
      if (n % 500 === 0) {
        const rate = n / ((Date.now() - t0) / 1000);
        log(`  ${n}/${todo.length} (${rate.toFixed(1)}/s, ~${Math.round((todo.length - n) / rate / 60)} min left)`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  flush();
  stats.left = edgarFilingsMissingTotals(db).length;
  return stats;
}

module.exports = { backfillBulkTotals, backfillEdgarTotals, bulkQuartersMissingTotals, edgarFilingsMissingTotals };
