-- Phase 5a: every issuer is findable and answerable (ADR 0008 decision 7).
-- Rebuilt after every refresh and review import (lib/entities/entities.js).

-- A row no company claims belongs to an unreviewed entity: its identity
-- component (identity_nodes), else its own issuer key. Only unresolved rows
-- carry one; a company's rows are answered by company_id.
ALTER TABLE holdings ADD COLUMN entity_id INTEGER;
CREATE INDEX holdings_entity ON holdings (entity_id) WHERE entity_id IS NOT NULL;

-- One row per component root key, never deleted (an id keeps its key; URLs
-- use the key, since a component can change between refreshes). active = 0
-- when no unresolved row belongs to it any more (a review resolved it).
CREATE TABLE unreviewed_entities (
  id                  INTEGER PRIMARY KEY,
  key                 TEXT NOT NULL UNIQUE,  -- component root issuer key
  display_name        TEXT NOT NULL,         -- the filers' largest raw name
  category            TEXT NOT NULL,         -- company | linked | listed | vehicle | fund | level12 (report.js)
  keys                TEXT NOT NULL,         -- JSON array of the component's issuer keys
  names               TEXT NOT NULL,         -- JSON array, top raw names by value
  linked_company_ids  TEXT NOT NULL DEFAULT '[]',
  funds_ever          INTEGER NOT NULL,
  first_mark_date     TEXT,
  last_mark_date      TEXT,
  current_funds       INTEGER NOT NULL DEFAULT 0,  -- at each active fund's latest filing
  current_value_usd   REAL NOT NULL DEFAULT 0,
  level3_share        REAL,
  active              INTEGER NOT NULL DEFAULT 1
);

-- Search over names, aliases, brands and unreviewed entities. `compact` holds
-- the spelling variants (identity.nameVariants: abbreviations, spacing,
-- legal suffixes) joined by spaces; the trigram tokenizer matches substrings.
CREATE VIRTUAL TABLE search_names USING fts5(
  compact,
  name UNINDEXED,        -- the text as filed or curated
  kind UNINDEXED,        -- name | alias | brand | unreviewed
  ref UNINDEXED,         -- company id, or unreviewed entity id
  detail UNINDEXED,      -- alias kind/source, brand accession, entity category
  tokenize = 'trigram'
);
