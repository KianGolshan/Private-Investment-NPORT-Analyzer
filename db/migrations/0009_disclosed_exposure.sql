-- Phase 4 (added after 0008 was applied to the live warehouse).
-- Fund-level exposure a filing discloses as a range when its structured rows
-- name only vehicles (Fundrise Innovation Fund: "Anthropic PBC … Greater
-- than 20%" of net assets, without saying which vehicles hold it). Shown as
-- the disclosed range with its source, never converted to dollars.
CREATE TABLE disclosed_exposure (
  fund_key          TEXT NOT NULL,
  report_date       TEXT NOT NULL,
  company_id        INTEGER NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  basis             TEXT NOT NULL,          -- the filing's words, e.g. 'Greater than 20% of net assets'
  source_accession  TEXT NOT NULL,
  PRIMARY KEY (fund_key, report_date, company_id)
);
