-- Phase 2: daily catch-up (EDGAR index + primary_doc.xml) and refresh runs.

-- Filings the catch-up could not fetch or parse. Retried on every run until
-- they load (then the row is deleted). A filing never half-loads: its
-- filing row and holdings are written together or not at all.
CREATE TABLE ingest_errors (
  accession        TEXT PRIMARY KEY,
  cik              TEXT,
  filing_date      TEXT,
  form             TEXT,
  error            TEXT NOT NULL,
  attempts         INTEGER NOT NULL DEFAULT 1,
  last_attempt_at  TEXT NOT NULL
);

-- One row per `npm run refresh`.
CREATE TABLE refresh_runs (
  id                   INTEGER PRIMARY KEY,
  started_at           TEXT NOT NULL,
  finished_at          TEXT,
  bulk_quarters_added  TEXT,                 -- comma-separated, e.g. '2026q3'
  delta_since          TEXT,
  delta_filings        INTEGER,
  delta_failures       INTEGER,
  status               TEXT NOT NULL,        -- running | ok | failed
  error                TEXT
);
