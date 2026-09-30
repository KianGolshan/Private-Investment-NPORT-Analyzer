-- Lookup for the series-LEI rules in lib/warehouse/fund-keys.js.
CREATE INDEX filings_cik_series_lei ON filings (cik, series_lei);
