-- Phase 5b: the refresh lock also guards the admin "make this a company" job
-- (lib/entities/make-company.js). Its runs are recorded here as 'curation', so
-- the lock is one table and an answer's refreshId (the ETag) changes after it.
ALTER TABLE refresh_runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'refresh';  -- refresh | curation
