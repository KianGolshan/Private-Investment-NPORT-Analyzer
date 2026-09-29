-- Phase 4: entities. Companies and their aliases, SPV look-through, managers
-- (parent firms) and the tracked list. See docs/ROADMAP.md §Phase 4 and
-- docs/decisions/0003 ("private" is a company status).

CREATE TABLE companies (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL CHECK (status IN ('private', 'public')),
  public_since  TEXT,                       -- ISO date, when known
  notes         TEXT
);

-- How holding rows resolve to a company (lib/entities/resolve.js).
--   issuer_key: parsers.issuerKeyOf(row) equals pattern (the seed clusters)
--   exact:      upper(trim(issuer_name or title)) equals pattern
--   regex:      case-insensitive pattern over issuer_name / title
-- via_spv = 1: the row is a named vehicle holding the company (DATA-QUALITY
-- trap 8), e.g. "Magnitude ANC III, LLC (economic exposure to Anthropic…)".
CREATE TABLE company_aliases (
  company_id  INTEGER NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('issuer_key', 'exact', 'regex')),
  pattern     TEXT NOT NULL,
  via_spv     INTEGER NOT NULL DEFAULT 0,
  source      TEXT NOT NULL,                -- 'review:<file>' | 'seed' | a citation
  PRIMARY KEY (kind, pattern)
);

-- Opaque SPVs: the vehicle's name does not name the company, but a filing
-- says what that vehicle holds. Every row cites it (DATA-QUALITY trap 8).
CREATE TABLE spv_map (
  fund_key          TEXT NOT NULL,
  holding_match     TEXT NOT NULL,          -- upper-case issuer_name/title of the vehicle row
  company_id        INTEGER NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  basis             TEXT NOT NULL,          -- e.g. 'Anthropic >20% of net assets per attachment'
  source_accession  TEXT NOT NULL,
  PRIMARY KEY (fund_key, holding_match, company_id)
);

-- Investment advisers from Form N-CEN, keyed by SEC file number (801-…).
-- file_num is 'CRD:<crd>' or 'NAME:<name>' for the few foreign sub-advisers
-- with no SEC file number (860 of 76,178 sub-adviser rows).
CREATE TABLE advisers (
  file_num  TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  crd       TEXT,
  lei       TEXT
);

-- Every adviser and sub-adviser row of every N-CEN read, as filed.
CREATE TABLE ncen_advisers (
  accession    TEXT NOT NULL,
  cik          TEXT NOT NULL,
  series_id    TEXT NOT NULL DEFAULT '',    -- '' for registrants without series
  series_lei   TEXT NOT NULL DEFAULT '',
  file_num     TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('adviser', 'subadviser')),
  filing_date  TEXT NOT NULL,
  PRIMARY KEY (accession, series_id, series_lei, file_num, role)
);
CREATE INDEX ncen_advisers_series ON ncen_advisers (series_id, filing_date);
CREATE INDEX ncen_advisers_cik ON ncen_advisers (cik, filing_date);

-- Each warehouse fund's advisers per its latest N-CEN. Derived from
-- ncen_advisers + filings after every ingest (lib/entities/managers.js).
CREATE TABLE fund_advisers (
  fund_key          TEXT NOT NULL,
  file_num          TEXT NOT NULL,
  role              TEXT NOT NULL CHECK (role IN ('adviser', 'subadviser')),
  source_accession  TEXT NOT NULL,          -- the N-CEN
  ncen_filing_date  TEXT NOT NULL,
  PRIMARY KEY (fund_key, file_num, role)
);

-- N-CEN filings read (data sets or EDGAR), so the EDGAR top-up is resumable.
CREATE TABLE ncen_filings (
  accession    TEXT PRIMARY KEY,
  cik          TEXT NOT NULL,
  filing_date  TEXT NOT NULL,
  source       TEXT NOT NULL               -- 'dataset:2026q2' | 'edgar'
);

-- Parent firms (the "manager" in firm analytics), curated in data/managers.csv.
CREATE TABLE managers (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE
);
CREATE TABLE manager_advisers (
  manager_id  INTEGER NOT NULL REFERENCES managers (id) ON DELETE CASCADE,
  file_num    TEXT NOT NULL PRIMARY KEY
);
-- Fallback for registrants with no N-CEN adviser (new or internally managed).
CREATE TABLE manager_registrants (
  manager_id  INTEGER NOT NULL REFERENCES managers (id) ON DELETE CASCADE,
  cik         TEXT NOT NULL PRIMARY KEY
);

CREATE TABLE tracked_companies (
  company_id  INTEGER PRIMARY KEY REFERENCES companies (id) ON DELETE CASCADE,
  added_at    TEXT NOT NULL,
  note        TEXT
);

CREATE INDEX holdings_via_spv ON holdings (via_spv) WHERE via_spv = 1;
