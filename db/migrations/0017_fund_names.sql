-- Phase 5b: finding a fund by name. A LIKE over filings takes 350-970 ms on
-- the live warehouse (measured 2026-09-30), over the 200 ms budget, so the
-- fund list and a word index over every name a fund has filed under are
-- rebuilt after each ingest (lib/warehouse/fund-names.js). Words with prefix
-- queries, not trigrams: 3.3 MiB instead of 6.6 MiB, under 1 ms either way.
CREATE TABLE fund_names (
  fund_key           TEXT PRIMARY KEY,
  cik                TEXT,
  series_id          TEXT,
  series_name        TEXT,    -- from the fund's latest canonical filing
  registrant         TEXT,
  first_report_date  TEXT,
  last_report_date   TEXT,
  last_accession     TEXT,
  last_net_assets    REAL,
  filings            INTEGER NOT NULL   -- canonical filings (one per report date)
) WITHOUT ROWID;

CREATE VIRTUAL TABLE fund_search USING fts5(
  name,                  -- a series or registrant name as filed, any period
  fund_key UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);
