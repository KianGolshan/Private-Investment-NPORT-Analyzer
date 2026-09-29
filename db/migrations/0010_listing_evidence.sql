-- Phase 4: evidence that an issuer is publicly listed, from the rows the keep
-- rule drops (ADR 0003): equity rows at fair-value Level 1 with a valid
-- ISIN/CUSIP and no restriction flag. The warehouse stores only a company's
-- Level-3/restricted rows, so without this a listed company holding a PIPE or
-- restricted block (Pfizer, Apollo, QXO in 2026q2) looks 100% private.
-- One row per issuer key (parsers.issuerKeyOf) per bulk quarter.
CREATE TABLE listing_evidence (
  issuer_key        TEXT NOT NULL,
  quarter           TEXT NOT NULL,          -- bulk quarter, e.g. 2026q2
  rows              INTEGER NOT NULL,
  filings           INTEGER NOT NULL,       -- distinct N-PORT filings reporting it
  value_usd         REAL NOT NULL,
  sample_accession  TEXT NOT NULL,          -- the largest such row's filing
  sample_cusip      TEXT,
  PRIMARY KEY (issuer_key, quarter)
);
