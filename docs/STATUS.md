# Vantage v2 Status

**Current phase:** Phase 3 (canonical views and as-of engine), **not started**. P0–P2 are signed off. Start
a new session with the Phase 3 prompt in [SESSION-PROMPTS.md](SESSION-PROMPTS.md), and read
[LESSONS.md](LESSONS.md) first.
**Branch:** `v2-plan-and-phase0`
**Last updated:** 2026-09-28

## Phase tracker

- [x] P0: live-app correctness fixes (signed off 2026-09-28)
- [x] P1: warehouse foundation and bulk history (signed off 2026-09-28)
- [x] P2: daily catch-up and refresh (signed off 2026-09-28)
- [ ] P3: canonical views and as-of engine
- [ ] P4: entities (companies, aliases, SPVs, managers, tracked list)
- [ ] P5: service layer and parity migration
- [ ] P6: new analysis and UI
- [ ] P7: MCP server
- [ ] P8: operations hardening

## Phase 2 checkpoint results

- **Built:**
  - `lib/edgar.js`: the paced SEC client, moved from `server.js` unchanged.
  - `lib/warehouse/`: `edgar-rows.js`, `delta.js`, `refresh.js`, `bulk-source.js`.
  - `db/migrations/0002_refresh.sql`: `ingest_errors`, `refresh_runs`.
  - Commands: `npm run ingest:delta`, `npm run refresh`.
  - `parsers.js`: `extractAllHoldings` now records each row's `rowIndex` (additive), and `nportInvestments`
    is exported.
- **Suite:** `npm test` 320 tests, 292 pass, 0 fail (9 new catch-up tests). Lint and format are clean.
- **Parity:** the EDGAR-XML path yields rows identical to bulk in all 21 fields and all filing fields
  (106 rows, 7 real filings). Bulk replacing catch-up rows keeps row count and value sum identical.
- **Real catch-up (filed 2026-06-30..09-28):**
  - 11,824 listed; 11,822 loaded (2 were already in bulk).
  - **26.9 min** across 6 foreground windows, about 9 filings/s.
  - 5 first-pass failures, all loaded on retry; `ingest_errors` is empty.
- **Golden numbers now in the warehouse (catch-up rows):**
  - F2 Growth Fund of America 5/31 Anthropic **$4,979.7M**
  - F3 Fundamental Investors $1,016.7M
  - F4 American Balanced $520.7M
  - F5 AMCAP $469.9M
  - F6 New Economy $486.1M
  - F7 Capital World G&I $46.8M
  - F10 KraneShares Level-1 $12.9M
  - F11 Magnitude SPV $235.7M (indirect)
- **Nightly refresh (real):** run #1 `ok` in 1.1 s. No new bulk quarter yet; the SEC should post 2026q3
  after 2026-09-30.
- **Found on real data and handled** (DATA-QUALITY traps 17–19):
  - EDGAR served a truncated `primary_doc.xml` (First Trust S&P REIT Index Fund); fixed by the `.txt`
    fallback.
  - Transient stalls and `EPIPE`; fixed with retries and a 60 s timeout.
  - The index repeats co-registrant filings; fixed by de-duplication.
- **Correction:** the "May–Sep 2019 gap" from P1 does not exist. That filing is an NPORT-EX, and EDGAR's
  index lists zero NPORT-P filings in 2019 Q2–Q3 (trap 15).
- **Open decision for you:** install the nightly launchd job (ARCHITECTURE §Refresh lifecycle)? It is
  not installed.

## Phase 1 checkpoint results

- **Built:**
  - `lib/warehouse/`: `db.js` (migrations), `bulk-ingest.js`, `tsv-zip.js`, `identifiers.js`
  - `db/migrations/0001_init.sql`
  - `scripts/ingest-bulk.js` (`npm run ingest:bulk`)
  - `test/warehouse-ingest.test.js` (12 tests)
  - `test/live-warehouse.test.js` (`LIVE_SEC`)
  - real-derived fixture `test/fixtures/bulk/` with its builder
- **Suite:** `npm test` 310 tests, 283 pass, 0 fail. Lint and format are clean.
- **Full backfill (real SEC data, 2026-09-28):** all 27 quarters 2019Q4–2026Q2 loaded, `ingest_log` 27/27 `ok`.
  - 341,049 filings; 1,086,310 private-candidate holdings; 18,481 distinct funds.
  - **13.6 min** total load time (about 27 s per quarter, including download); **364 MB**.
- **Fidelity:**
  - 106 of 106 fixture rows equal `extractAllHoldings` on the same XML, field by field.
  - `CURRENCY_VALUE` equals XML `valUSD` for a CAD holding.
- **Completeness (LIVE):** 20 random registrants, 2,905 EDGAR filings in the bulk window, **0 missing**.
- **Golden numbers found in the warehouse:**
  - F1: Growth Fund of America Anthropic G-1 and F-1
  - F8/F9: Fidelity OTC Stripe present in Oct-25, absent in Jan-26
  - F13: Databricks split, 3,712 sh @ $165.88 → 11,136 sh @ $55.29
  - Capital Group Stripe path: $33.73 → $33.73 → $35.50 → $41.42 → $63.00
- **Golden correction:** F14 KP Large Cap's last report is **2020-09-30**, not 2020-03-31. The earlier value
  came from sorting `DD-MON-YYYY` text dates (DATA-QUALITY trap 14). Confirmed on EDGAR.
- **Decisions changed by measurement:**
  - Keep rule (ADR 0003 amended): Level 3, restricted, or no check-digit-valid ISIN/CUSIP, instead of
    "any level". Keeping every level would add about 1.9M public rows per quarter.
  - Size budget raised to ≤500 MB.
- **Found during P1, carried to P2:**
  - ~~Public N-PORTs filed about May–Sep 2019 are in no bulk file~~. Corrected in P2: that filing was an
    NPORT-EX. No gap exists (trap 15).
  - Placeholder rows are skipped the same way `extractAllHoldings` skips them (trap 16).
- The app does not read `warehouse.db` yet. That starts in P5.

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

| Metric                                  | Budget  | Measured                                              |
| --------------------------------------- | ------- | ----------------------------------------------------- |
| Full bulk backfill, 27 quarters         | ≤45 min | **13.6 min** (2026-09-28)                             |
| Warehouse size                          | ≤500 MB | **364 MB** (budget revised from 300 MB, see ADR 0003) |
| First catch-up                          | ≤90 min | **26.9 min** for 11,822 filings (about 9/s)           |
| Nightly refresh                         | ≤5 min  | **1.1 s** with nothing new (run #1, 2026-09-28)       |
| API p95                                 | <200 ms | n/a                                                   |
| Single Security search (P0, live EDGAR) | n/a     | 15–32 s per name for 100 filings                      |

## Open decisions

- **Nightly refresh scheduling:** not installed. A ready-to-use launchd job is in ARCHITECTURE
  §Refresh lifecycle. Install only with the user's yes. Until then, run `npm run refresh` at the start of
  each session.
- **Branch:** all work is on `v2-plan-and-phase0`, pushed to origin. No PR is open and it is not merged
  to `main`. Ask before opening a PR.
- Manager (parent firm) mapping source: curated CSV vs. N-CEN. Investigate in P4.
- Size of the tracked list: ~250 default. Confirm after the P4 review CSV.

## Warehouse state at hand-off (2026-09-28)

- `warehouse.db` (git-ignored, 385 MB):
  - 352,871 filings: 341,049 from bulk 2019Q4–2026Q2, 11,822 from the EDGAR catch-up through filings made
    2026-09-25.
  - 1,160,725 private-candidate holdings.
- `ingest_errors` is empty. `refresh_runs` #1 is `ok`.
- The SEC should post the 2026Q3 bulk file shortly after 2026-09-30. `npm run refresh` loads it and
  replaces the matching catch-up rows.

## Log

- **2026-09-28:** P2 signed off. Wrote the hand-off (LESSONS.md, the Phase 3 "Before you start" notes
  in ROADMAP, the Phase 3 prompt) and pushed the branch.

- **2026-09-28:** Phase 2 implemented; catch-up ran in the foreground in 6 date windows; nightly refresh verified.

- **2026-09-28:** Phase 1 implemented; the full backfill ran in the foreground in three timed batches.
  Results above.

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
