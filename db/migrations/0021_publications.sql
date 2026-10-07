-- P6d W1 (staff full-stack review R01, R05, R18): generation ids that never
-- repeat, rollback as a new generation, and the exact curation a generation
-- was imported from.

-- generation_meta.id is now the publication id: allocated outside the data
-- (lib/warehouse/job.js nextGenerationId), always above every earlier one,
-- including after a rollback. run_id: the job's refresh_runs row (null for a
-- rollback). restores: the generation whose contents a rollback republished.
-- curation_digest: sha256 over curation_snapshot, the reviewed files the data
-- reflects (null before the first curation job after this migration).
ALTER TABLE generation_meta ADD COLUMN run_id INTEGER;
ALTER TABLE generation_meta ADD COLUMN restores INTEGER;
ALTER TABLE generation_meta ADD COLUMN curation_digest TEXT;

-- The data/review files of the last curation job, byte for byte. Carried from
-- generation to generation; replaced only by a job that imports curation.
-- `npm run warehouse -- --sync-curation` writes them back to data/review.
CREATE TABLE curation_snapshot (
  name     TEXT PRIMARY KEY,
  sha256   TEXT NOT NULL,
  content  BLOB NOT NULL
);
