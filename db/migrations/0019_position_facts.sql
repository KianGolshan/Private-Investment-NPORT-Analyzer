-- P6b W1: position facts (lib/warehouse/position-facts.js). One row per change
-- leg of a fund's position in a private company at a canonical filing: the
-- legs of activity.walkPosition (diffPosition, rekeyed, leg), unchanged legs
-- included, and a leg with value 0 where a class or the position is no longer
-- reported. Derived data: rebuilt by every refresh and curation run.
--   value as of D (ADR 0004) = SUM(value) over a fund's legs in a company with
--     report_date <= D < COALESCE(next_report_date, '9999-12-31') and
--     julianday(D) - julianday(report_date) <= 123
--   value change = position_effect + mark_effect + other_effect (activity.leg)
-- Firms are not stored: a fund maps to its firms through the current N-CEN
-- adviser (services/firm.fundFirms), which a review can change.
CREATE TABLE position_facts (
  fund_key          TEXT NOT NULL,
  company_id        INTEGER NOT NULL,
  accession         TEXT NOT NULL,     -- the filing the change is in
  report_date       TEXT NOT NULL,     -- its mark date
  filing_date       TEXT NOT NULL,
  next_report_date  TEXT,              -- the fund's next canonical filing (any content); NULL = none yet
  prev_accession    TEXT,              -- the fund's previous canonical filing
  prev_report_date  TEXT,
  event             TEXT NOT NULL,     -- activity TYPES key: new, added, reduced, mixed, unchanged, exited,
                                       -- zeroed, firstFiling, resumed
  change            TEXT NOT NULL,     -- the leg: new class, added, reduced, unchanged, value only,
                                       -- class no longer reported
  instrument_key    TEXT NOT NULL,
  rekeyed_from      TEXT,              -- trap 51: the filer's previous key for this holding
  merged_keys       TEXT,              -- trap 52: the class's other keys merged into this leg (comma list)
  class_label       TEXT NOT NULL,     -- classes.classOfRow (trap 50)
  instrument_label  TEXT,
  kind              TEXT NOT NULL,     -- asof.kindOf: direct | spv | fund
  unit              TEXT,
  title             TEXT,
  balance           REAL,
  prev_balance      REAL,
  value             REAL NOT NULL,
  prev_value        REAL NOT NULL,
  price             REAL,              -- per share (NS) or per unit (trap 40)
  prev_price        REAL,
  per_share         INTEGER NOT NULL,
  split             REAL,              -- public/splits.js factor, when detected
  position_effect   REAL NOT NULL,
  mark_effect       REAL NOT NULL,
  other_effect      REAL NOT NULL,
  pct_nav           REAL,
  PRIMARY KEY (accession, company_id, instrument_key)
) WITHOUT ROWID;
CREATE INDEX position_facts_company ON position_facts (company_id, fund_key, report_date);
CREATE INDEX position_facts_fund ON position_facts (fund_key, report_date);
