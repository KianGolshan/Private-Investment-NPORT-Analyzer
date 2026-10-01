-- Phase 5b (user, 2026-09-30; ADR 0003 amended): the debt rows Fund X-Ray's
-- capital structure needs. A debt row the keep rule drops is stored here when
-- its issuer key equals that of a kept, non-debt (private-candidate) row in
-- the same filing (lib/warehouse/capital-structure.js). Measured on 2026q2:
-- 1,855 of 3.02M debt rows, $7.88B, 420 filings. Never in `holdings`, so
-- exposure, identity, search and the review queue do not see them.
CREATE TABLE capital_structure_rows (
  accession        TEXT NOT NULL REFERENCES filings (accession) ON DELETE CASCADE,
  row_key          TEXT NOT NULL,           -- bulk HOLDING_ID, or 'doc:<index>' for EDGAR XML rows
  issuer_key       TEXT NOT NULL,           -- issuerKeyOf, shared with the private-candidate row it sits beside
  issuer_name      TEXT,
  title            TEXT,
  cusip            TEXT,
  lei              TEXT,
  isin             TEXT,
  ticker           TEXT,
  other_id         TEXT,
  other_id_desc    TEXT,
  balance          REAL,
  unit             TEXT,
  currency         TEXT,
  value_usd        REAL,
  pct_nav          REAL,
  asset_cat        TEXT,
  other_asset      TEXT,
  issuer_type      TEXT,
  country          TEXT,
  restricted       TEXT,
  fv_level         TEXT,
  deriv_cat        TEXT,
  instrument_type  TEXT NOT NULL,
  PRIMARY KEY (accession, row_key)
) WITHOUT ROWID;

-- Rows stored in capital_structure_rows for the filing; NULL = not computed
-- yet (filings loaded before this migration, until the backfill reaches them).
ALTER TABLE filing_totals ADD COLUMN rows_capital INTEGER;
