-- P14 (2026-10-20): sector, industry and theme labels for private operating
-- companies. N-PORT has no industry field, so these are reviewed decisions with
-- their confidence and source, not reported facts (ADR 0010). They come from
-- data/review/taxonomy.json and data/review/industries.csv through the review
-- import, which replaces them whole; they change no stored number.
--   sector    one of about ten (Technology, Health care, ...)
--   industry  exactly one per company; industries add up to their sector
--   theme     any number per company (AI, Fintech, ...); themes overlap and never add up
CREATE TABLE taxonomy_sectors (
  code        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  position    INTEGER NOT NULL
);
CREATE TABLE taxonomy_industries (
  code        TEXT PRIMARY KEY,
  sector      TEXT NOT NULL REFERENCES taxonomy_sectors(code),
  name        TEXT NOT NULL,
  definition  TEXT NOT NULL,
  position    INTEGER NOT NULL
);
CREATE TABLE taxonomy_themes (
  code        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  definition  TEXT NOT NULL,
  position    INTEGER NOT NULL
);
-- One row per company with a decision. industry is NULL for "not yet
-- classified" (confidence 'unclear'), a decision too: every private operating
-- company has a row (the job validates it). No foreign key to companies: the
-- review import replaces companies and labels in one transaction and checks ids.
CREATE TABLE company_industry (
  company_id  INTEGER PRIMARY KEY,
  industry    TEXT REFERENCES taxonomy_industries(code),
  confidence  TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low', 'unclear')),
  source      TEXT NOT NULL,
  note        TEXT,
  CHECK ((industry IS NULL) = (confidence = 'unclear'))
);
CREATE TABLE company_themes (
  company_id  INTEGER NOT NULL,
  theme       TEXT NOT NULL REFERENCES taxonomy_themes(code),
  PRIMARY KEY (company_id, theme)
);
CREATE INDEX company_themes_theme ON company_themes (theme);
-- The taxonomy version the labels were made under (one row).
CREATE TABLE taxonomy_meta (
  version     TEXT NOT NULL
);
