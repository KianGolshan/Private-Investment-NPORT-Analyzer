# 0002: SQLite warehouse, separate from the request cache

**Status:** accepted, 2026-09-27

## Context

- `cache.db` is a per-request memo with a TTL and pruning.
- The warehouse is durable, normalized, provenance-carrying data that must never be pruned.
- The prototype showed the data fits comfortably in SQLite: about 150 MB for all history with equity-type
  rows; the queries used for analysis ran in well under a second.

## Decision

- Use a separate `warehouse.db` (`WAREHOUSE_DB_PATH`) on `better-sqlite3`, which is already a dependency.
- WAL mode; numbered SQL migrations; no ORM.
- Views (`canonical_filings`, `fund_filing_timeline`) hold the aggregation rules, so every consumer shares
  them.

## Consequences

- Zero new infrastructure; runs on a laptop.
- If multi-user hosting or much larger scope is needed later, the schema ports to Postgres or DuckDB
  without redesign.
