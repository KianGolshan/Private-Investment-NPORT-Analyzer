// One refresh = (1) load any SEC bulk quarter published since the last run,
// which replaces the catch-up rows for filings it covers (INSERT OR REPLACE
// on the accession), then (2) catch up on everything filed after the newest
// bulk filing date. Recorded in refresh_runs.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { listAvailableQuarters, downloadQuarter } = require('./bulk-source');
const { ingestBulkZip } = require('./bulk-ingest');
const { ingestDelta, defaultSince } = require('./delta');
const { refreshNcen } = require('./ncen');
const { refreshFundAdvisers } = require('../entities/managers');
const { resolveCompanies } = require('../entities/resolve');

function loadedBulkQuarters(db) {
  return new Set(
    db
      .prepare("SELECT DISTINCT quarter FROM ingest_log WHERE kind = 'bulk' AND status = 'ok'")
      .all()
      .map(r => r.quarter)
  );
}

async function loadBulkQuarters(db, quarters, { log = () => {}, keepZip = false } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vantage-bulk-'));
  const results = [];
  try {
    for (const quarter of quarters) {
      const t0 = Date.now();
      const zip = await downloadQuarter(quarter, tmpDir);
      const t1 = Date.now();
      try {
        const stats = await ingestBulkZip(db, zip.path, {
          quarter,
          sourceUrl: zip.url,
          sha256: zip.sha256,
          bytes: zip.bytes,
        });
        results.push(stats);
        log(
          `${quarter}: ${stats.filings} filings, ${stats.rowsKept.toLocaleString()} of ` +
            `${stats.rowsRead.toLocaleString()} holding rows kept ` +
            `(download ${((t1 - t0) / 1000).toFixed(0)}s, load ${((Date.now() - t1) / 1000).toFixed(0)}s)`
        );
      } finally {
        if (!keepZip) fs.rmSync(zip.path, { force: true });
      }
    }
  } finally {
    if (!keepZip) fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  return results;
}

// Catch-up filings older than the bulk coverage that bulk did not replace.
// Expected 0; non-zero means bulk lacks filings EDGAR lists (report it).
function uncoveredEdgarFilings(db) {
  const since = defaultSince(db);
  if (!since) return 0;
  return db.prepare("SELECT COUNT(*) n FROM filings WHERE source = 'edgar' AND filing_date < ?").get(since).n;
}

// ncen: false skips the N-CEN step (offline tests); entity upkeep always runs.
async function refresh(db, { log = () => {}, concurrency = 3, until, ncen = true } = {}) {
  const runId = db
    .prepare("INSERT INTO refresh_runs (started_at, status) VALUES (?, 'running')")
    .run(new Date().toISOString()).lastInsertRowid;
  const finish = db.prepare(
    `UPDATE refresh_runs SET finished_at = ?, bulk_quarters_added = ?, delta_since = ?, delta_filings = ?,
       delta_failures = ?, status = ?, error = ? WHERE id = ?`
  );
  let added = [];
  let since = null;
  try {
    const loaded = loadedBulkQuarters(db);
    const missing = (await listAvailableQuarters()).filter(q => !loaded.has(q));
    log(missing.length ? `New bulk quarter(s): ${missing.join(' ')}` : 'No new bulk quarter');
    added = (await loadBulkQuarters(db, missing, { log })).map(s => s.quarter);

    since = defaultSince(db);
    if (!since) throw new Error('warehouse has no bulk data; run npm run ingest:bulk -- --all first');
    const delta = await ingestDelta(db, { since, until, concurrency, log });
    const uncovered = uncoveredEdgarFilings(db);
    if (uncovered) log(`WARNING: ${uncovered} catch-up filing(s) predate bulk coverage but are not in bulk`);

    // Phase 4: advisers (N-CEN), then fund advisers and company resolution.
    const nc = ncen ? await refreshNcen(db, { log }) : null;
    const ncenFailed = nc?.topUp?.failed.length || 0;
    const advisers = refreshFundAdvisers(db);
    const companies = resolveCompanies(db);
    log(`entities: ${advisers.mapped}/${advisers.funds} funds with an adviser, ${companies.resolved} rows resolved`);

    const problems = [
      delta.failed && `${delta.failed} filing(s) failed; see ingest_errors`,
      ncenFailed && `${ncenFailed} N-CEN filing(s) failed; retried next run`,
    ].filter(Boolean);
    const status = problems.length ? 'failed' : 'ok';
    const error = problems.join('; ') || null;
    finish.run(new Date().toISOString(), added.join(','), since, delta.loaded, delta.failed, status, error, runId);
    return { runId, bulkQuartersAdded: added, since, ...delta, uncovered, ncen: nc, advisers, companies, status };
  } catch (err) {
    finish.run(new Date().toISOString(), added.join(','), since, null, null, 'failed', String(err.message), runId);
    throw err;
  }
}

module.exports = { refresh, loadBulkQuarters, loadedBulkQuarters, uncoveredEdgarFilings };
