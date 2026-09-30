-- Phase 4: fund identity corrections (DATA-QUALITY trap 20). Applied by
-- lib/warehouse/fund-keys.js after every ingest, together with the
-- multi-series rule for registrants without series IDs.

-- A filer-reported series ID that belongs to another registrant. Each row
-- cites the EDGAR evidence.
CREATE TABLE fund_key_overrides (
  series_id  TEXT NOT NULL,
  cik        TEXT NOT NULL,
  fund_key   TEXT NOT NULL,
  reason     TEXT NOT NULL,
  PRIMARY KEY (series_id, cik)
);

INSERT INTO fund_key_overrides (series_id, cik, fund_key, reason) VALUES (
  'S000097937', '2021225', 'CIK2021225',
  'EDGAR registers S000097937 to Ultimus Managers Trust (CIK 1545440, Q3 All-Season Tactical Advantage ETF, series LEI 2549007LT04F99R6CR27). Sardis Credit Opportunities Fund reports it in 0000910472-26-007912 with its own series LEI 529900CMQ0OEESBVQ461 and filed without a series ID before (0000910472-26-003753).'
);
