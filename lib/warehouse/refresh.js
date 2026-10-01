// One refresh = (1) load any SEC bulk quarter published since the last run,
// or re-posted with a different size, which replaces the catch-up rows for
// filings it covers (INSERT OR REPLACE on the accession), then (2) catch up on
// everything filed after the newest bulk filing date, then (3) N-CEN and
// entity upkeep. Recorded in refresh_runs. Only one refresh runs at a time.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { listAvailableQuarters, downloadQuarter, publishedZipBytes } = require('./bulk-source');
const { ingestBulkZip } = require('./bulk-ingest');
const { ingestDelta, defaultSince } = require('./delta');
const { refreshNcen } = require('./ncen');
const { entityUpkeep } = require('../entities/upkeep');
const { writeEntityReport, overdue, identityUpkeep } = require('../entities/report');
const { rebuildEntities } = require('../entities/entities');
const { rebuildFundNames } = require('./fund-names');
const { reclassifyStored } = require('./reclassify');

function loadedBulkQuarters(db) {
  return new Set(
    db
      .prepare("SELECT DISTINCT quarter FROM ingest_log WHERE kind = 'bulk' AND status = 'ok'")
      .all()
      .map(r => r.quarter)
  );
}

// Loaded quarters whose zip the SEC now serves at a different size (re-posted
// since we loaded it). Quarters loaded from a local file (no size) are skipped.
async function republishedQuarters(db, quarters) {
  const sizeOf = db.prepare(
    "SELECT zip_bytes FROM ingest_log WHERE kind = 'bulk' AND status = 'ok' AND quarter = ? ORDER BY id DESC LIMIT 1"
  );
  const out = [];
  for (const q of quarters) {
    const stored = sizeOf.get(q)?.zip_bytes;
    if (!stored) continue;
    const now = await publishedZipBytes(q);
    if (now && now !== stored) out.push(q);
  }
  return out;
}

// A run still marked 'running' after this long was killed without finishing.
const STALE_RUN_MS = 2 * 3600 * 1000;

// Claims the refresh: fails if another run started within STALE_RUN_MS, and
// closes older 'running' rows as abandoned. One IMMEDIATE transaction, so two
// processes can't both claim it. kind 'curation': the admin job
// (lib/entities/make-company.js) takes the same lock.
function claimRun(db, now = new Date(), kind = 'refresh') {
  return db
    .transaction(() => {
      for (const r of db.prepare("SELECT id, started_at FROM refresh_runs WHERE status = 'running'").all()) {
        if (now - Date.parse(r.started_at) < STALE_RUN_MS)
          throw new Error(`refresh #${r.id} is already running (started ${r.started_at})`);
        db.prepare(
          "UPDATE refresh_runs SET status = 'failed', finished_at = ?, error = 'abandoned: the process ended without finishing' WHERE id = ?"
        ).run(now.toISOString(), r.id);
      }
      return db
        .prepare("INSERT INTO refresh_runs (started_at, status, kind) VALUES (?, 'running', ?)")
        .run(now.toISOString(), kind).lastInsertRowid;
    })
    .immediate();
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
// entityReport: a directory for the P4.5 review queue (scripts/refresh.js
// passes reports/entities); omitted, no report is written.
// checkRepublished: false skips the HEAD check of loaded quarters.
async function refresh(
  db,
  { log = () => {}, concurrency = 3, until, ncen = true, entityReport, checkRepublished = true } = {}
) {
  const runId = claimRun(db);
  const finish = db.prepare(
    `UPDATE refresh_runs SET finished_at = ?, bulk_quarters_added = ?, delta_since = ?, delta_filings = ?,
       delta_failures = ?, status = ?, error = ? WHERE id = ?`
  );
  let added = [];
  let since = null;
  try {
    const loaded = loadedBulkQuarters(db);
    const available = await listAvailableQuarters();
    const missing = available.filter(q => !loaded.has(q));
    log(missing.length ? `New bulk quarter(s): ${missing.join(' ')}` : 'No new bulk quarter');
    const republished = checkRepublished
      ? await republishedQuarters(
          db,
          available.filter(q => loaded.has(q))
        )
      : [];
    if (republished.length) log(`Re-posted by the SEC (size changed), reloading: ${republished.join(' ')}`);
    added = (await loadBulkQuarters(db, [...republished, ...missing], { log })).map(s => s.quarter);

    since = defaultSince(db);
    if (!since) throw new Error('warehouse has no bulk data; run npm run ingest:bulk -- --all first');
    const delta = await ingestDelta(db, { since, until, concurrency, log });
    const uncovered = uncoveredEdgarFilings(db);

    // Stored rows follow today's instrument rule (trap 45); a no-op unless it changed.
    const rc = reclassifyStored(db);
    if (rc.toDebt || rc.fromDebt || rc.other) log(`reclassified: ${rc.toDebt} rows to debt, ${rc.fromDebt} from debt`);

    // Phase 4: advisers (N-CEN), then fund advisers and company resolution.
    const nc = ncen ? await refreshNcen(db, { log }) : null;
    const ncenFailed = nc?.topUp?.failed.length || 0;
    const { advisers, companies } = entityUpkeep(db);
    log(`entities: ${advisers.mapped}/${advisers.funds} funds with an adviser, ${companies.resolved} rows resolved`);
    let up;
    if (entityReport) {
      const written = writeEntityReport(db, entityReport);
      up = written.up;
      const { report } = written;
      const due = overdue(report);
      log(
        `review queue: ${report.components.length} unresolved components, ${report.conflicts.length} conflicts, ` +
          `${due.length} over the threshold; tracked unresolved ${(report.tracked.share * 100).toFixed(2)}%`
      );
    }
    // Phase 5a: unreviewed entities, their row tags and the search index.
    const ent = rebuildEntities(db, up || identityUpkeep(db));
    log(`search: ${ent.entities} unreviewed entities, ${ent.tagged} rows tagged, ${ent.cleared} cleared`);
    // Phase 5b: the fund list and fund-name index.
    const fn = rebuildFundNames(db);
    log(`funds: ${fn.funds} funds, ${fn.names} names indexed`);

    const problems = [
      delta.failed && `${delta.failed} filing(s) failed; see ingest_errors`,
      ncenFailed && `${ncenFailed} N-CEN filing(s) failed; retried next run`,
      uncovered && `${uncovered} catch-up filing(s) predate bulk coverage but are not in bulk (expected 0; report it)`,
    ].filter(Boolean);
    const status = problems.length ? 'failed' : 'ok';
    const error = problems.join('; ') || null;
    if (error) log(`FAILED: ${error}`);
    finish.run(new Date().toISOString(), added.join(','), since, delta.loaded, delta.failed, status, error, runId);
    return { runId, bulkQuartersAdded: added, since, ...delta, uncovered, ncen: nc, advisers, companies, status };
  } catch (err) {
    finish.run(new Date().toISOString(), added.join(','), since, null, null, 'failed', String(err.message), runId);
    throw err;
  }
}

module.exports = {
  refresh,
  claimRun,
  loadBulkQuarters,
  loadedBulkQuarters,
  republishedQuarters,
  uncoveredEdgarFilings,
  STALE_RUN_MS,
};
