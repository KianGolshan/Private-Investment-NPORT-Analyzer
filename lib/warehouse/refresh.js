// One refresh = (1) load any SEC bulk quarter published since the last run,
// or re-posted with a different size, which replaces the catch-up rows for
// filings it covers (INSERT OR REPLACE on the accession), then (2) catch up on
// everything filed after the newest bulk filing date, then (3) N-CEN and
// entity upkeep. Recorded in refresh_runs. Only one refresh runs at a time.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { listAvailableQuarters, downloadQuarter, publishedZipHead } = require('./bulk-source');
const { ingestBulkZip } = require('./bulk-ingest');
const { ingestDelta, defaultSince } = require('./delta');
const { refreshNcen } = require('./ncen');
const { entityUpkeep } = require('../entities/upkeep');
const { writeEntityReport, overdue, identityUpkeep } = require('../entities/report');
const { rebuildEntities } = require('../entities/entities');
const { rebuildFundNames } = require('./fund-names');
const { reclassifyStored } = require('./reclassify');
const { buildPositionFacts } = require('./position-facts');

function loadedBulkQuarters(db) {
  return new Set(
    db
      .prepare("SELECT DISTINCT quarter FROM ingest_log WHERE kind = 'bulk' AND status = 'ok'")
      .all()
      .map(r => r.quarter)
  );
}

// Loaded quarters the SEC has re-posted since we loaded them. A quarter counts
// as re-posted when its size differs from the loaded zip's, or its size or
// Last-Modified (or ETag, if one is ever sent) differs from the previous check
// (bulk_source_checks, migration 0020). Each check is recorded. A HEAD can only
// say "no revision detected", never "verified identical" (staff review F12);
// the zip's SHA-256 is kept in ingest_log for that. Quarters loaded from a
// local file (no size) are skipped.
async function republishedQuarters(db, quarters, { now = new Date().toISOString() } = {}) {
  const sizeOf = db.prepare(
    "SELECT zip_bytes FROM ingest_log WHERE kind = 'bulk' AND status = 'ok' AND quarter = ? ORDER BY id DESC LIMIT 1"
  );
  const lastCheck = db.prepare(
    'SELECT bytes, etag, last_modified FROM bulk_source_checks WHERE quarter = ? ORDER BY checked_at DESC LIMIT 1'
  );
  const record = db.prepare(
    'INSERT OR REPLACE INTO bulk_source_checks (quarter, checked_at, bytes, etag, last_modified) VALUES (?, ?, ?, ?, ?)'
  );
  const differs = (a, b) => a != null && b != null && a !== b;
  const out = [];
  for (const q of quarters) {
    const stored = sizeOf.get(q)?.zip_bytes;
    if (!stored) continue;
    const head = await publishedZipHead(q);
    const prev = lastCheck.get(q);
    record.run(q, now, head.bytes, head.etag, head.lastModified);
    if (
      differs(head.bytes, stored) ||
      (prev &&
        (differs(head.bytes, prev.bytes) ||
          differs(head.etag, prev.etag) ||
          differs(head.lastModified, prev.last_modified)))
    )
      out.push(q);
  }
  return out;
}

// A run still marked 'running' after this long was killed without finishing.
// A curation job (the review import, "make this a company") ends within its
// 10-minute job timeout, so its lock goes stale sooner.
const STALE_RUN_MS = 2 * 3600 * 1000;
const STALE_CURATION_MS = 15 * 60 * 1000;

// Claims the refresh: fails if another run started within STALE_RUN_MS, and
// closes older 'running' rows as abandoned. One IMMEDIATE transaction, so two
// processes can't both claim it. kind 'curation': the admin job
// (lib/entities/make-company.js) takes the same lock.
// exclusive: the caller already holds the job lock (lib/warehouse/job.js), so
// any 'running' row is from a process that ended without finishing.
function claimRun(db, now = new Date(), kind = 'refresh', { exclusive = false } = {}) {
  return db
    .transaction(() => {
      for (const r of db.prepare("SELECT id, started_at, kind FROM refresh_runs WHERE status = 'running'").all()) {
        if (!exclusive && now - Date.parse(r.started_at) < (r.kind === 'curation' ? STALE_CURATION_MS : STALE_RUN_MS))
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

async function loadBulkQuarters(db, quarters, { log = () => {}, keepZip = false, allowShrink = false } = {}) {
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
          allowShrink,
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

// The ingest half of a refresh: new or re-posted bulk quarters, the EDGAR
// catch-up and N-CEN. ncen: false skips the N-CEN step (offline tests);
// checkRepublished: false skips the HEAD check of loaded quarters. Returns the
// counts and the problems that make the run failed (or, under a job, partial).
async function refreshIngest(
  db,
  { log = () => {}, concurrency = 3, until, ncen = true, checkRepublished = true } = {}
) {
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
  if (republished.length) log(`Re-posted by the SEC (size or date changed), reloading: ${republished.join(' ')}`);
  const added = (await loadBulkQuarters(db, [...republished, ...missing], { log })).map(s => s.quarter);

  const since = defaultSince(db);
  if (!since) throw new Error('warehouse has no bulk data; run npm run ingest:bulk -- --all first');
  const delta = await ingestDelta(db, { since, until, concurrency, log });
  const uncovered = uncoveredEdgarFilings(db);
  const nc = ncen ? await refreshNcen(db, { log }) : null;
  const ncenFailed = nc?.topUp?.failed.length || 0;
  const problems = [
    delta.failed && `${delta.failed} filing(s) failed; see ingest_errors`,
    ncenFailed && `${ncenFailed} N-CEN filing(s) failed; retried next run`,
    uncovered && `${uncovered} catch-up filing(s) predate bulk coverage but are not in bulk (expected 0; report it)`,
  ].filter(Boolean);
  return { added, since, delta, uncovered, ncen: nc, problems };
}

// Everything derived from the stored rows, in dependency order (staff review
// F04: every job that writes the warehouse runs all of it, so no answer reads
// new rows beside old search, names or facts): instrument rule, advisers and
// company resolution, identity, unreviewed entities with their search index
// and company stats, the fund list, the position facts. entityReport: a
// directory for the review queue report (scripts/refresh.js passes
// reports/entities); omitted, no report is written.
function rebuildDerived(db, { log = () => {}, entityReport } = {}) {
  // Stored rows follow today's instrument rule (trap 45); a no-op unless it changed.
  const rc = reclassifyStored(db);
  if (rc.toDebt || rc.fromDebt || rc.other) log(`reclassified: ${rc.toDebt} rows to debt, ${rc.fromDebt} from debt`);
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
  const ent = rebuildEntities(db, up || identityUpkeep(db));
  log(`search: ${ent.entities} unreviewed entities, ${ent.tagged} rows tagged, ${ent.cleared} cleared`);
  const fn = rebuildFundNames(db);
  log(`funds: ${fn.funds} funds, ${fn.names} names indexed`);
  const facts = buildPositionFacts(db, { log });
  return { advisers, companies, entities: ent, funds: fn, facts };
}

// One refresh on an open warehouse, under the refresh_runs row it claims. The
// nightly job runs this inside lib/warehouse/job.js (a validated generation);
// tests call it on a fixture database directly.
async function refresh(db, { log = () => {}, entityReport, ...opts } = {}) {
  const runId = claimRun(db);
  const finish = db.prepare(
    `UPDATE refresh_runs SET finished_at = ?, bulk_quarters_added = ?, delta_since = ?, delta_filings = ?,
       delta_failures = ?, status = ?, error = ? WHERE id = ?`
  );
  try {
    const r = await refreshIngest(db, { log, ...opts });
    const d = rebuildDerived(db, { log, entityReport });
    const status = r.problems.length ? 'failed' : 'ok';
    const error = r.problems.join('; ') || null;
    if (error) log(`FAILED: ${error}`);
    finish.run(
      new Date().toISOString(),
      r.added.join(','),
      r.since,
      r.delta.loaded,
      r.delta.failed,
      status,
      error,
      runId
    );
    return {
      runId,
      bulkQuartersAdded: r.added,
      since: r.since,
      ...r.delta,
      uncovered: r.uncovered,
      ncen: r.ncen,
      advisers: d.advisers,
      companies: d.companies,
      status,
    };
  } catch (err) {
    finish.run(new Date().toISOString(), null, null, null, null, 'failed', String(err.message), runId);
    throw err;
  }
}

module.exports = {
  refresh,
  refreshIngest,
  rebuildDerived,
  claimRun,
  loadBulkQuarters,
  loadedBulkQuarters,
  republishedQuarters,
  uncoveredEdgarFilings,
  STALE_RUN_MS,
  STALE_CURATION_MS,
};
