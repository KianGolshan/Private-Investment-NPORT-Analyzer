-- 2026-10-13 review (F-03): what kind of thing a reviewed company is. Funds
-- report private-equity fund stakes, co-investment vehicles, CLO notes and
-- reinsurance sidecars beside operating companies, and all of them are
-- "private" by status (ADR 0003). The category keeps them apart on screen:
-- Market lists operating companies by default. It comes from the reviewed
-- data/review/aliases.csv (blank = company) and changes no stored fact.
--   company    an operating company (or the holding company of one)
--   fund       an interest in a fund, co-investment or continuation vehicle, or a named SPV
--   clo        a collateralized loan obligation's notes or equity
--   insurance  a reinsurance sidecar, segregated account or catastrophe vehicle
ALTER TABLE companies ADD COLUMN category TEXT NOT NULL DEFAULT 'company'
  CHECK (category IN ('company', 'fund', 'clo', 'insurance'));
