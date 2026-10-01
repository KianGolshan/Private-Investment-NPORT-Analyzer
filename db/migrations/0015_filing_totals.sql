-- Phase 5b: per-filing totals over ALL rows of the filing, before the keep
-- rule (lib/warehouse/filing-totals.js), written by both ingest paths and by
-- scripts/backfill-filing-totals.js. The fund page takes its denominators
-- from here: the warehouse stores private-candidate rows only (ADR 0003).
CREATE TABLE filing_totals (
  accession        TEXT PRIMARY KEY REFERENCES filings (accession) ON DELETE CASCADE,
  rows             INTEGER NOT NULL,   -- every reported row (placeholders skipped, as extractAllHoldings)
  value_usd        REAL NOT NULL,      -- sum of valUSD over those rows (shorts count negative)
  rows_listed      INTEGER NOT NULL,   -- equity-type rows the keep rule drops: valid ISIN/CUSIP, Level 1/2, unrestricted
  value_listed     REAL NOT NULL,
  rows_debt        INTEGER NOT NULL,   -- instrument_type debt (classifyInstrument)
  value_debt       REAL NOT NULL,
  rows_l3_equity   INTEGER NOT NULL,   -- v1 Fund X-Ray's "private": fair-value Level 3, not debt
  value_l3_equity  REAL NOT NULL
) WITHOUT ROWID;
