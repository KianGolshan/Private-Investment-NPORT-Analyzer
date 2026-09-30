-- Phase 4.5: evidence-based company identity (lib/entities/identity.js).
-- Rebuilt after every ingest (lib/entities/upkeep.js); the review queue
-- (npm run entities:report) reads it. See docs/ROADMAP.md §Phase 4.5.

-- An edge joins two issuer keys (parsers.issuerKeyOf) on filing evidence.
-- applied = 0: a guard stopped the union (conflict says why); flagged for
-- review, never merged.
CREATE TABLE identity_edges (
  a           TEXT NOT NULL,
  b           TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('lei', 'instrument_id', 'share_count', 'same_mark', 'title', 'name')),
  accession   TEXT NOT NULL DEFAULT '',   -- the filing that shows it ('' for name edges)
  confidence  TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  detail      TEXT,
  applied     INTEGER NOT NULL,
  conflict    TEXT,
  PRIMARY KEY (a, b, kind)
) WITHOUT ROWID;

-- Component of every issuer key that has at least one applied edge (a key not
-- listed is its own component). vehicle_target: a per-fund holding vehicle's
-- target ("FHUS HOLDINGS LLC").
CREATE TABLE identity_nodes (
  key             TEXT PRIMARY KEY,
  component       TEXT NOT NULL,
  vehicle_target  TEXT
) WITHOUT ROWID;
CREATE INDEX identity_nodes_component ON identity_nodes (component);

-- Brands a filing names for a company ("FHU US HLDGS Units dba Chobani LLC"),
-- so either name finds it (DATA-QUALITY trap 33). Search only: holdings never
-- resolve through a brand.
CREATE TABLE company_brands (
  company_id        INTEGER NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  brand             TEXT NOT NULL,
  source_accession  TEXT NOT NULL,
  PRIMARY KEY (company_id, brand)
);
