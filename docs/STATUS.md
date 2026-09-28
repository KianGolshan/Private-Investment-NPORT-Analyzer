# Vantage v2 Status

**Current phase:** Phase 0 complete, **awaiting sign-off**. After sign-off, run the Phase 1 prompt from
[SESSION-PROMPTS.md](SESSION-PROMPTS.md).
**Branch:** `v2-plan-and-phase0`
**Last updated:** 2026-09-28

## Phase tracker

- [x] P0: live-app correctness fixes (awaiting sign-off)
- [ ] P1: warehouse foundation and bulk history
- [ ] P2: daily catch-up and refresh
- [ ] P3: canonical views and as-of engine
- [ ] P4: entities (companies, aliases, SPVs, managers, tracked list)
- [ ] P5: service layer and parity migration
- [ ] P6: new analysis and UI
- [ ] P7: MCP server
- [ ] P8: operations hardening

## Phase 0 checkpoint results

- `npm test`: 298 tests, 271 pass, 0 fail (27 are `LIVE_SEC`-gated). `npm run lint` and
  `npm run format:check` are clean.
- Real-data verification (2026-09-28): the real app driven in-process, Single Security at its
  100-filing maximum, fresh cache. The table compares the original app with the P0 app.

| Name              | Unique filings / 100 | Parsed filings with a holding | False positives | Distinct funds |
| ----------------- | -------------------- | ----------------------------- | --------------- | -------------- |
| Revolut           | 67 → **100**         | 67 → **100**                  | 29 → **0**      | 35 → 36        |
| OpenAI            | 87 → **100**         | 67 → **100**                  | 3 → **0**       | 66 → 77        |
| Anthropic         | 75 → **100**         | 36 → **100**                  | 2 → **0**       | 36 → **97**    |
| Redwood Materials | 78 → **100**         | 56 → **100**                  | 0               | 21 → 29        |
| Epic Games        | 79 → **100**         | 79 → **100**                  | 0               | 41 → 53        |
| Databricks        | 88 → **100**         | 61 → **100**                  | 0               | 61 → **100**   |
| Stripe            | 81 → **100**         | 79 → **100**                  | 0               | 33 → 55        |

- The live app now finds Growth Fund of America's 5/31/2026 Anthropic position at **$4,979.7M**,
  matching GOLDEN-NUMBERS F2. Before, it missed Capital Group's July/August filings entirely.
- What P0 changed:
  - EFTS hits are de-duplicated by accession.
  - Multi-word names are sent as an exact phrase.
  - Over the hit cap, the search reads newest-first date windows.
  - NPORT-P search keeps only `primary_doc.xml` matches.
  - `extractHoldings` matches whole words and exact tickers.
  - `PARSE_VERSION` 16 → 17; search cache key v2 → v3.
- Behavior change to note: a partial word (e.g. "Epic Game") no longer matches. Search whole names or
  exact tickers.
- Still true until P1–P5: Single Security sees only the newest 100 filings (for Databricks, about one
  month). The warehouse removes this limit.

## Measurements to record (fill in as phases complete)

| Metric                                  | Budget  | Measured                                                    |
| --------------------------------------- | ------- | ----------------------------------------------------------- |
| Full bulk backfill, 27 quarters         | ≤45 min | n/a (prototype: ~11 min for 12 quarters with equity filter) |
| Warehouse size                          | ≤300 MB | n/a (prototype estimate ~150 MB)                            |
| First catch-up                          | ≤90 min | n/a (estimate ~56 min for 11.7k filings)                    |
| Nightly refresh                         | ≤5 min  | n/a                                                         |
| API p95                                 | <200 ms | n/a                                                         |
| Single Security search (P0, live EDGAR) | n/a     | 15–32 s per name for 100 filings                            |

## Open decisions

- Manager (parent firm) mapping source: curated CSV vs. N-CEN. Investigate in P4.
- Size of the tracked list: ~250 default. Confirm after the P4 review CSV.

## Log

- **2026-09-28:** Phase 0 implemented and verified on real EDGAR data (see results above). Two extra fixes
  were found during verification and added to ROADMAP §Phase 0: newest-first windows over the hit cap,
  and `primary_doc.xml`-only matches.
- **2026-09-27:** Research and planning session.
  - Prototyped bulk ingest (all 27 quarters) and live-app comparison on 20 companies in a scratch area.
  - Verified the golden numbers against raw EDGAR.
  - Found and documented 13 data traps.
  - Wrote CLAUDE.md, ROADMAP, ARCHITECTURE, DATA-QUALITY, GOLDEN-NUMBERS, SESSION-PROMPTS and ADRs
    0001–0005.
  - No application code changed.
