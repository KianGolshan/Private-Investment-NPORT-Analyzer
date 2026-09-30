-- Phase 5a: search evidence for curated companies, rebuilt with the
-- unreviewed entities (lib/entities/entities.js). "Current" follows the
-- review queue's rule: each active fund's latest canonical filing (no filing
-- within 123 days of the newest report date means inactive), equity-type rows
-- with a positive value.
CREATE TABLE company_stats (
  company_id         INTEGER PRIMARY KEY REFERENCES companies (id) ON DELETE CASCADE,
  current_funds      INTEGER NOT NULL,
  current_value_usd  REAL NOT NULL,
  as_of              TEXT,             -- the newest report date the "current" figures use
  funds_ever         INTEGER NOT NULL,
  first_mark_date    TEXT,
  last_mark_date     TEXT
);
