# 0009: One write path; the warehouse is published in whole generations

**Status:** accepted, 2026-10-05 (P6c R2; staff engineering review F03, F04, F08, F11, F12). The user approved the
remediation plan and delegated the design ("go with your recommendation").

## Context

The staff review of 2026-10-05 found, and the code confirmed:

- **No publication boundary (F03).** A refresh committed each phase separately (quarters, catch-up, N-CEN,
  reclassify, entities, search, fund names, facts). Readers saw new holdings beside old facts and search while a
  job ran. A failed or partial run left its commits behind, but answers and caches stayed keyed to the last _ok_
  run, so cached and uncached endpoints could disagree indefinitely.
- **Writers outside the lifecycle (F04).** `ingest:bulk`, `ingest:delta`, `ingest:ncen`, the backfills and
  `entities-report` wrote without the run lock. Each rebuilt a different subset of the derived tables, or none.
- **A lease that expires live work (F11).** The lock was a `refresh_runs` row judged stale after a fixed 2 hours.
- **Firm ids reused (F08), and size-only re-post detection (F12).**

## Decision

1. **`lib/warehouse/job.js` `runJob(kind, fn)` is the only write path.** Every command that changes data runs
   through it: `refresh`, `ingest:bulk`, `ingest:delta`, `ingest:ncen`, `review:aliases`, `make-company` (the
   admin route's child process), the three backfills and `entities-report` (which rebuilds identity, so it is a
   writer and is labeled one). `seed:entities` and `backfill-filing-totals --status` only read.
2. **A job works on a candidate copy, never on the published file.**
   1. Take the job lock: `warehouse.db.lock`, created exclusively. It holds pid, host and kind, and its mtime is a
      heartbeat every 30 s. A lock whose process is gone, or whose heartbeat stopped more than 10 minutes ago, is
      taken over. A long job is never expired while it runs.
   2. Copy the published generation to `generations/warehouse.candidate-<pid>.db` with the SQLite backup API.
      Readers are not blocked.
   3. Run the job under a `refresh_runs` row.
   4. Run the whole derived chain (`refresh.rebuildDerived`): instrument rule, advisers and resolution, identity,
      unreviewed entities with search and `company_stats`, fund names, position facts.
   5. Validate: `quick_check`, the schema is current, no foreign key violations, `filings`/`holdings`/
      `companies`/`managers` shrink by no more than 2% against the published generation (`--allow-shrink`
      overrides it for an intended reload), and the derived tables are present.
   6. Record `generation_meta`: id = run id, kind, status, the `data/review` git tree (with `+dirty` for
      uncommitted edits), and the code commit.
   7. Switch the candidate to journal mode DELETE, rename it to `generations/warehouse-<id>.db`, and swap the
      `warehouse.db` symlink to it in one `rename`.
3. **Failure publishes nothing.** The candidate is deleted, and the published generation, its version and every
   reader are untouched. The last job's state (running, ok, partial, failed, with the error) is in
   `warehouse.db.job.json` (history in `.jobs.log`) and in `/api/freshness` as `job`, apart from the data version.
4. **Partial is published, and labeled.** A refresh that finished but left filings queued in `ingest_errors`
   publishes with status `partial` (the queued filings retry next run) and still exits non-zero for alerting.
5. **Readers follow the link.** `warehouse.db` is a symlink, so `openWarehouseReadOnly`, `sqlite3` and the
   bench keep working unchanged. The warehouse router checks the link target on each request and opens the new
   file when it moved. Every route is synchronous, so no request straddles the switch. `refreshId`, the ETag and the
   memo key are the generation id (`db.generationOf`).
6. **Two generations are kept**, the published one and the one before. `npm run warehouse` lists them,
   `-- --rollback` republishes the previous one. The first job on a pre-generation warehouse moves the plain file
   to `generations/warehouse-0.db` after a WAL checkpoint.
7. **Firm ids are a ledger** like company ids: `data/review/manager_ids.csv`, `manager_redirects`. A renamed
   firm keeps its id when the new name holds exactly the old keys, a firm that leaves is retired (merged into the
   firm that took most of its keys, else dropped), and no id is reused. The API answers 301 or 410, and the
   watchlist moves a merged id to its successor.
8. **Bulk sources are validated before they replace data.** Required columns per table, non-empty tables,
   every kept row belongs to a filing in the archive, and a reload must keep at least 90% of the last good load's
   filings. A re-post is detected by size or `Last-Modified` (the SEC sends no ETag, checked 2026-10-05), recorded
   in `bulk_source_checks`. A HEAD says only "no revision detected"; the zip's SHA-256 stays in `ingest_log`.

## Consequences

- Disk: about two generations plus a candidate (~1.8 GB at 577 MB per generation). The 1 GB budget applies to
  one generation.
- Time: the copy, validation and swap add about 20–30 s per job (refresh #22: 47 s in all, nothing new).
- A job's view is the published generation at its start. Two writers can no longer interleave.
- Not adopted (out of proportion for a single-node research tool): a database server, staged tables with
  generation columns, and full bitemporal curation history. The curation revision is stamped per generation
  instead (F14).
