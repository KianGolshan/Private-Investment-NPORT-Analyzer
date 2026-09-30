# Vantage v2 Status

**Current phase:** Phase 5 (service layer and parity), **not started**. P0–P4 are complete. P4's entity
review was finalized by Claude on 2026-09-29 at the user's direction ("finalize and push it through") and
imported into `warehouse.db`. Start with the SESSION-PROMPTS prompt "Next session: Phase 5 (written
2026-09-29)"; read [LESSONS.md](LESSONS.md) first.
**Branch:** `v2-plan-and-phase0`
**Last updated:** 2026-09-28

## Phase tracker

- [x] P0: live-app correctness fixes (signed off 2026-09-28)
- [x] P1: warehouse foundation and bulk history (signed off 2026-09-28)
- [x] P2: daily catch-up and refresh (signed off 2026-09-28)
- [x] P3: canonical views and as-of engine (signed off 2026-09-28)
- [x] P4: entities (companies, aliases, SPVs, managers, tracked list) (finalized 2026-09-29)
- [ ] P5: service layer and parity migration
- [ ] P6: new analysis and UI
- [ ] P7: MCP server
- [ ] P8: operations hardening
- [ ] P9: public deployment (live site; hosting choice to confirm with the user as ADR 0006)

## Phase 4 results (complete 2026-09-29)

- **Built:** fund identity by series LEI (0005–0007); N-CEN advisers (ADR 0007); entity tables (0008–0009);
  listing evidence (0010); seed, curation, review-import, resolve and upkeep modules; refresh runs N-CEN
  and entity upkeep.
- **Entity review (finalized by Claude with filing evidence):**
  - `data/review/curation.json` holds every decision with its reason: 25 merges, each citing the filers'
    own evidence (same instrument id, same share count, or a title naming the company), 1 curated SPV,
    18 drops, 26 renames, 38 untracks and 3 firm names.
  - New seed rules found in review:
    - status from post-IPO lock-up/PIPE rows and the best of 4 listing-evidence quarters;
    - reverse-prefix and spelling merges;
    - display names from the filers' own casing;
    - stricter named-SPV test;
    - firm names by brand, with no ownership assumed.
  - Result: 739 companies (257 private, 482 public), **178 tracked** private operating companies,
    2,173 aliases (26 named SPVs), 529 firms, and 11 Fundrise disclosed ranges.
- **Imported into `warehouse.db`:** 305,914 holding rows resolved.
  - Roadmap tests pass live: Databricks' 59 raw strings map to 1 company; Stripe INC/LLC are one company;
    Douyin maps to ByteDance; Magnitude maps to Anthropic via SPV; SpaceX is public; all 7 Capital Group
    CIKs are one firm.
  - Unresolved tracked exposure is **0.46%**.
  - `companyId` reproduces A1, A2 and A5. For A6, Databricks by company is **120 / $6.233B**: a fund's
    codename rows ("Project Debussy") are Databricks (F25, verified on EDGAR).
- **Speed:** `exposureAsOf({ companyId })` takes 176–454 ms cold and ~9 ms warm. P5's p95 < 200 ms needs
  batching or caching of the per-fund canonical lookups.
- **Suite:** 376 tests: 346 pass, 0 fail, 30 skipped (LIVE). The LIVE goldens and LIVE entity test pass. Lint
  and format are clean.

## Phase 3 checkpoint results

- **Refresh at session start:** no 2026Q3 bulk file yet. Catch-up loaded 1,349 filings (filed 2026-09-28)
  in 2.7 min, 0 failed; `ingest_errors` empty. Warehouse: 354,220 filings, 1,163,910 holdings.
- **Built:**
  - `db/migrations/0003_canonical_views.sql`: `canonical_filings`, `fund_filing_timeline`.
  - `lib/analytics/asof.js`: `exposureAsOf(db, { pattern | companyId, date, knownAsOf, instrument,
classifyBy, nullBalance })` returns funds, total, and per fund the value, mark date, accession and
    rows, plus `exited` and `inactive` lists. `instrumentHistory` flags splits with `public/splits.js`.
  - `parsers.js` exports `instrumentKeyOf` (the existing inline rule, now shared).
  - `test/fixtures/warehouse/` (builder + 299 KB real export: 191 funds, 4,832 filings, 6,625 rows) and
    `test/helpers/warehouseFixture.js`.
  - `test/analytics-asof.test.js` (18 tests) and a LIVE golden test in `test/live-warehouse.test.js`.
- **Suite:** `npm test` 339 tests, 310 pass, 0 fail, 29 skipped (LIVE). Lint and format clean. The LIVE
  golden test passes on the full warehouse (11 s).
- **Golden reproduction from `warehouse.db` (research method):** A1 72 / $5.93B, A2 117 / $17.26B, A5
  49 / 35 / 34 / 37 ($1.02B / $1.31B / $1.91B / $2.44B), A6 120 / $6.22B: all exact. F13 (all four T. Rowe
  Databricks classes 3:1 at 2022-08-31), F14 (active on day 123, inactive on day 124) and F8/F9 pass.
- **Golden corrections (verified on EDGAR):**
  - A3: Capital Group is **9 funds**, same $8.46B. Research missed AFIS Capital World G&I, $0.66M (F17).
  - A4: bulk-only is **82 / $6.23B**. Research's 83 / $6.29B skipped the 123-day rule and counted Fidelity
    Advisor Technology Fund, whose last NPORT-P reports 2025-10-31 (F18). It equals `knownAsOf` 6/30.
- **knownAsOf:** Anthropic as known on 2026-06-30 is 82 / $6.23B; F2–F7 drop out, and Growth Fund of
  America shows its public 2026-02-28 mark (F1).
- **Speed:** 2–6 s per `exposureAsOf` call on the full warehouse, almost all of it the regex scan over 1.16M
  rows. P4's `company_id` replaces the scan. Views: 1 ms per fund.

### Decisions (user chose the recommendations, 2026-09-28; evidence in DATA-QUALITY traps 5, 16, 20 and GOLDEN-NUMBERS F15–F20)

**Implemented:** `exposureAsOf` defaults are now `classifyBy: 'instrument_type'` (everything but debt, as
v1's `isPrivateEquityHolding`) and `nullBalance: true` (as v1's `extractAllHoldings`, which keeps "N/A"
balances). Ingest keys `S000000000` by CIK (`identifiers.fundKeyOf`), and migration 0004 re-keyed the 41
stored filings onto 4 CIK keys; `series_id` keeps the reported value. All seven golden aggregates are
identical to the cent under the new defaults, offline and live. The research rule remains available as
`{ classifyBy: 'asset_cat', nullBalance: false }`. Series-LEI keying moved to Phase 4. Suite: 341 tests,
312 pass, 0 fail, 29 skipped.

The evidence as presented:

1. **Count NULL-balance rows with a real value?** They change **no** golden number (the three companies
   have none). Across the warehouse: 20,939 rows, $149.6B, 28 funds, mostly fund-of-funds LP interests
   (CPG Carlyle, Ares Private Markets) plus SPVs such as Destiny's Brex SPV ($1.33M, F15, verified on
   EDGAR). **Recommendation: count them** (`nullBalance: true`): the value is real and the rule drops it
   silently. They have no per-share price, so they stay out of mark and split series (already true).
2. **Classify by `instrument_type` instead of `asset_cat`?** Also changes **no** golden number. Where they
   differ: 3,017 EP/EC rows are term loans or PIK preferreds with PA units ("Clarience Technologies TL 1L",
   "ALLIANT HOLDINGS 10%/10.5% PIK PREF PERP") that `asset_cat` counts as equity; 1,594 warrants tagged
   DO are excluded while the same warrants tagged DE are included. **Recommendation: switch** to
   `instrument_type IN (equity, indirect, derivative)`, and keep "indirect" in: it holds Coatue's direct
   Anthropic shares ($1.49B at 6/30, tagged "private fund"), so `equity` alone drops Anthropic to $15.51B.
3. **(New) `fund_key` collisions (trap 20).** Invesco BLDRS files 4 series with no series ID (F19), four
   closed-end funds share the placeholder `S000000000` (F20), and one series ID is claimed by two unrelated
   funds. Small (about 90 filings, no golden company). **Recommendation:** treat `S000000000` as blank now
   (a one-line ingest fix plus a data migration) and key blank-series filings by series LEI in P4, which
   needs the LEI stored at ingest.

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

| Metric                                  | Budget  | Measured                                        |
| --------------------------------------- | ------- | ----------------------------------------------- |
| Full bulk backfill, 27 quarters         | ≤45 min | **13.6 min** (2026-09-28)                       |
| Warehouse size                          | ≤500 MB | 364 MB (P1); **472 MB** after P4 (2026-09-29)   |
| First catch-up                          | ≤90 min | **26.9 min** for 11,822 filings (about 9/s)     |
| Nightly refresh                         | ≤5 min  | **1.1 s** with nothing new (run #1, 2026-09-28) |
| API p95                                 | <200 ms | n/a                                             |
| Single Security search (P0, live EDGAR) | n/a     | 15–32 s per name for 100 filings                |

## Open decisions

- **Nightly refresh scheduling:** not installed. A ready-to-use launchd job is in ARCHITECTURE
  §Refresh lifecycle. Install only with the user's yes. Until then, run `npm run refresh` at the start of
  each session.
- **Branch:** all work is on `v2-plan-and-phase0`, pushed to origin (P0–P4 review, 2026-09-29). No PR
  is open and it is not merged to `main`. Ask before opening a PR.
- ~~Manager mapping source~~ Decided in P4: N-CEN advisers + reviewed `managers.csv` (ADR 0007).
- ~~Entity review~~ Done 2026-09-29 (Claude, at the user's direction; `data/review/curation.json`). The
  user can still edit the CSVs or curation file; re-import with `npm run review:aliases`.
- **Tracked list (user, 2026-09-29):** size is the user's choice (100–200 likely); the 242 in the draft
  are a suggestion. The user may send their own names to resolve against the warehouse.
- **Open for the user:** one tracked list or several named lists (a schema change best made before P5), and
  whether alerts on new marks belong in P6. Not decided; don't build either without a yes.
- **Search outside the list must keep working (user, 2026-09-29):** any company in the warehouse is
  analyzable by name pattern even if not in `companies`; P5 search must fall back to the pattern path
  and offer to add the company. The on-demand EDGAR keyword search stays.

## Warehouse state at hand-off (2026-09-29, after the Phase 4 review)

- `warehouse.db` (git-ignored, **472 MB of the 500 MB budget**), schema at migration 0010. Largest: holdings
  215 MB (+54 MB key index), filings 89 MB, N-CEN adviser rows 38 MB, listing evidence ~10 MB per 4 quarters.
  - 354,220 N-PORT filings (341,049 bulk 2019Q4–2026Q2; 13,171 EDGAR catch-up through filings of
    2026-09-28), all with registrant LEIs; 1,163,910 private-candidate holdings.
  - N-CEN: 29,124 filings (28,590 data sets + 534 EDGAR); 17,841 of 18,828 funds have an adviser.
  - `listing_evidence` for 2025q3–2026q2. Status needs only the latest quarter. **Don't backfill all 27
    quarters** (+60–70 MB, over budget) without first pruning old quarters or raising the budget with the
    user.
  - Entities imported (2026-09-29): 739 companies, 178 tracked, 529 firms; 305,914 holdings resolved.
- `ingest_errors` empty; `refresh_runs` #4 ok. The SEC 2026Q3 N-PORT bulk file (expected after 2026-09-30)
  loads on the next `npm run refresh`, replacing matching catch-up rows and adding listing evidence.

## Log

- **2026-09-29:** Finalized the Phase 4 entity lists with filing evidence (curation.json, new seed rules); imported into the warehouse; P4 complete; pushed.

- **2026-09-29:** Answered the user's questions (aliases, search outside the list, custom tracked list); recorded them under Open decisions. Wrote the next-session handoff prompt. Pushed.
- **2026-09-29:** Full P3–P4 review. Fixed six issues (listed companies seeded as private, among others); docs brought current (ADR 0007, traps 20–26, F21–F24, C16–C20).

- **2026-09-28:** P3 signed off; branch pushed; Phase 4 started.

- **2026-09-28:** Phase 3 decisions 1–3 implemented as recommended (defaults, `fundKeyOf`, migration 0004).
- **2026-09-28:** Phase 3 built. Refresh #2 loaded 1,349 filings. Goldens reproduced from the warehouse;
  A3 and A4 corrected with EDGAR evidence; trap 20 found. Stopped for sign-off and three decisions.

- **2026-09-28:** Added Phase 9 (public deployment) to ROADMAP at the user's request. It is gated on P5 (no
  visitor-triggered SEC calls) and P8.

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
