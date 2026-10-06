-- P6c R2 (staff review F03, F08, F12, F14): published generations, durable
-- firm ids and bulk source validators.

-- One row per published generation (lib/warehouse/job.js). A job builds a
-- candidate copy of the warehouse, validates it and publishes it whole; the
-- generation id is the job's refresh_runs id and is every answer's refreshId.
-- curation_rev: the git tree of data/review the job read (plus "+dirty" when it
-- had uncommitted edits); code_rev: the commit of the code that built it.
CREATE TABLE generation_meta (
  id            INTEGER PRIMARY KEY,         -- = refresh_runs.id of the job that built it
  kind          TEXT NOT NULL,               -- refresh | curation | ingest-bulk | ingest-delta | ...
  created_at    TEXT NOT NULL,
  status        TEXT NOT NULL,               -- ok | partial (published with per-filing failures queued)
  curation_rev  TEXT,
  code_rev      TEXT,
  note          TEXT
);

-- Firm ids are permanent, like company ids (ADR 0008): data/review/manager_ids.csv
-- is the ledger. A firm dropped from managers.csv is retired here, never reused;
-- new_id is its successor when one firm's keys moved to another.
CREATE TABLE manager_redirects (
  old_id    INTEGER PRIMARY KEY,
  old_name  TEXT NOT NULL,
  new_id    INTEGER,
  reason    TEXT
);

-- What the SEC served for each loaded bulk quarter at each check (HEAD):
-- size, ETag and Last-Modified. A quarter is reloaded when any validator
-- differs from the last check; "no revision detected" is all a HEAD can say.
CREATE TABLE bulk_source_checks (
  quarter        TEXT NOT NULL,
  checked_at     TEXT NOT NULL,
  bytes          INTEGER,
  etag           TEXT,
  last_modified  TEXT,
  PRIMARY KEY (quarter, checked_at)
);
