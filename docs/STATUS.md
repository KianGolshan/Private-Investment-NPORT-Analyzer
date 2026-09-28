# Vantage v2 Status

**Current phase:** Phase 0 (not started). Next action: run the Phase 0 prompt from
[SESSION-PROMPTS.md](SESSION-PROMPTS.md).
**Last updated:** 2026-09-27

## Phase tracker

- [ ] P0: live-app correctness fixes
- [ ] P1: warehouse foundation and bulk history
- [ ] P2: daily catch-up and refresh
- [ ] P3: canonical views and as-of engine
- [ ] P4: entities (companies, aliases, SPVs, managers, tracked list)
- [ ] P5: service layer and parity migration
- [ ] P6: new analysis and UI
- [ ] P7: MCP server
- [ ] P8: operations hardening

## Measurements to record (fill in as phases complete)

| Metric                          | Budget  | Measured                                                    |
| ------------------------------- | ------- | ----------------------------------------------------------- |
| Full bulk backfill, 27 quarters | ≤45 min | n/a (prototype: ~11 min for 12 quarters with equity filter) |
| Warehouse size                  | ≤300 MB | n/a (prototype estimate ~150 MB)                            |
| First catch-up                  | ≤90 min | n/a (estimate ~56 min for 11.7k filings)                    |
| Nightly refresh                 | ≤5 min  | n/a                                                         |
| API p95                         | <200 ms | n/a                                                         |

## Open decisions

- Manager (parent firm) mapping source: curated CSV vs. N-CEN. Investigate in P4.
- Size of the tracked list: ~250 default. Confirm after the P4 review CSV.

## Log

- **2026-09-27:** Research and planning session.
  - Prototyped bulk ingest (all 27 quarters) and live-app comparison on 20 companies in a scratch area.
  - Verified the golden numbers against raw EDGAR.
  - Found and documented 13 data traps.
  - Wrote CLAUDE.md, ROADMAP, ARCHITECTURE, DATA-QUALITY, GOLDEN-NUMBERS, SESSION-PROMPTS and ADRs
    0001–0005.
  - No application code changed.
