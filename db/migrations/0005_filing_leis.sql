-- Phase 4: fund identity for registrants that file several series without a
-- series ID (DATA-QUALITY trap 20, GOLDEN-NUMBERS F19). The series LEI tells
-- those funds apart. Bulk: FUND_REPORTED_INFO.SERIES_LEI and REGISTRANT.LEI;
-- EDGAR: genInfo seriesLei / regLei. Backfilled by scripts/backfill-leis.js.
ALTER TABLE filings ADD COLUMN series_lei TEXT;
ALTER TABLE filings ADD COLUMN registrant_lei TEXT;
