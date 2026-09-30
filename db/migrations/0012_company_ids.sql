-- Phase 5a: stable company ids (ADR 0008) and the first size pruning.

-- Only job queries filter on filings.source (a quarter reload, refresh and
-- catch-up checks); no reader does. Without the index they scan filings in
-- ~35 ms (measured 2026-09-30); the index costs 7.7 MiB.
DROP INDEX IF EXISTS filings_source;

-- Company ids are stable: they live in data/review/company_ids.csv, and an id
-- is never reused. A company that leaves the reviewed files is retired here,
-- pointing to the company that now owns its aliases (merged) or to nothing
-- (dropped), so links to the old id still resolve.
CREATE TABLE company_redirects (
  old_id      INTEGER PRIMARY KEY,
  old_name    TEXT NOT NULL,
  new_id      INTEGER,                     -- NULL when dropped
  reason      TEXT NOT NULL CHECK (reason IN ('merged', 'dropped')),
  retired_at  TEXT NOT NULL
);
