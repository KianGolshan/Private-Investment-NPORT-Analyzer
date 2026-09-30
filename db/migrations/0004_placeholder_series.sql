-- Placeholder series ID S000000000 is not a fund identity (DATA-QUALITY trap
-- 20, GOLDEN-NUMBERS F20): four unrelated closed-end funds report it. Re-key
-- their filings by CIK, as ingest now does (identifiers.fundKeyOf).
-- series_id keeps the value as reported.
UPDATE filings
SET fund_key = 'CIK' || cik
WHERE series_id GLOB 'S0*' AND series_id NOT GLOB '*[^S0]*' AND cik IS NOT NULL;
