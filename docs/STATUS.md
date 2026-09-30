# Vantage v2 Status

**Current phase:** Phase 5b **next** (P5a signed off 2026-09-30, merged to `main`). Previously: Phase 5a (services, search over every issuer, the company page on the
read-only warehouse). 5b follows the sign-off. Read [LESSONS.md](LESSONS.md) first.
**Branch:** `v2-phase5a` (off `main` after PR #2 merged as e3164f6, 2026-09-30). No PR yet.
**Last updated:** 2026-09-30

## Phase tracker

- [x] P0: live-app correctness fixes (signed off 2026-09-28)
- [x] P1: warehouse foundation and bulk history (signed off 2026-09-28)
- [x] P2: daily catch-up and refresh (signed off 2026-09-28)
- [x] P3: canonical views and as-of engine (signed off 2026-09-28)
- [x] P4: entities (companies, aliases, SPVs, managers, tracked list) (finalized 2026-09-29)
- [x] P4.5: evidence-based company identity + unresolved-value report (signed off 2026-09-30)
- [x] P5a: services, search over every issuer, company page on the warehouse (signed off 2026-09-30)
- [ ] P5b: fund pages, lists, exports, per-filing flows retired
- [ ] P6: new analysis and UI
- [ ] P7: MCP server (may start after P5a)
- [ ] P8: operations hardening
- [ ] P9: public deployment (live site; hosting choice to confirm with the user as ADR 0006)

## Phase 5a results (built 2026-09-30, awaiting sign-off)

- **Step 0:** refresh #8 `ok` (no 2026Q3 bulk, nothing to catch up), `ingest_errors` empty, 513.0 MB; LIVE goldens
  pass. PR #2 merged to `main` (e3164f6) at the user's request; 5a is on `v2-phase5a`.
- **Built (ROADMAP §5a tasks 1–8, one commit each):**
  1. Migration 0012 drops `filings_source` (job queries only; 35 ms as a scan) and adds `company_redirects`.
  2. Stable ids: `data/review/company_ids.csv` (806 ids, bootstrapped unchanged; 0 holdings re-resolved); the import
     keeps renames on their id, retires removed ids with a redirect (chains collapse), never reuses one.
  3. Migrations 0013–0014: `holdings.entity_id`, `unreviewed_entities` (71,831; 846,385 rows tagged),
     `search_names` (FTS5 trigram, 106k rows), `company_stats`; rebuilt by every refresh and review import
     (~20–28 s). `exposureAsOf` selects by `entityId`.
  4. `lib/services/search.js`: exact / normalized / prefix / word-start substring / similar, each result with its
     match reason and evidence.
  5. `lib/services/company.js` (exposure with labels, history, stable-id lookup, routing) and `companyHistory`
     (one query per company; identical to `instrumentHistory` per fund).
  6. `lib/api/warehouse.js` in `server.js` (read-only, lazy `openWarehouseReadOnly`; 503 when missing or behind;
     `source` + `refreshId`; ETag = refresh id + build; 301 merged / 410 dropped ids).
  7. `npm run bench` and a warm-up at server start; no precomputed tables needed.
  8. The company page (search with typeahead and candidates, holders as of a date with every label, history
     through v1's sections and exports, permalinks `/company/<id>-<slug>` and `/name/<key>`, debt from live EDGAR on
     request, listed and unknown names on the labeled live path).
- **Results (live warehouse):**
  - Search: Chobani (brand), FHU (prefix), FHUS (normalized), "fhu us holdings" (exact) → FHU US Holdings; "Open AI" →
    OpenAI; "OpenAir" → OpenAI only through the curated alias (F32), never by spelling; "Databrick" (prefix) and
    "Databriks" (similar) → Databricks; "Hub International" → Hockey Parent Holdings by brand HUB INTL; 0.1–40 ms.
  - History starts: Anthropic 2023-04-28, Stripe 2019-12-31, Databricks 2019-10-31.
  - On screen in the browser: FHU US Holdings 13 / $359.0M at 2026-06-30 (F29); Anthropic 117 / $17.29B (F31);
    Vercel as unreviewed; Pfizer on the live path. No console errors.
  - `company_stats` equals `exposureAsOf` at the newest report date (Anthropic 123 / $18.1639B at 2026-07-31,
    Databricks 120 / $6.6230B, Stripe 38 / $2.4969B, OpenAI 87 / $5.4914B, FHU 13 / $0.3619B).
- **Speed (`npm run bench`, 774 real requests, p95 fresh process / second pass):** quiet machine: search 2.8 / 1.2
  ms, exposure 44 / 8.8, history 7.5 / 7.5, all 15.9 / 5.6. Under load (load average ~3.5 from other processes):
  exposure 70 / 40, history 37 / 35, all 35 / 28; single requests up to 0.4–0.6 s. Under 200 ms p95 everywhere.
- **Size:** 574 MB right after the first full tagging (fragmented pages), **503.0 MB after `VACUUM`**, 504.8 MB after
  refresh #10. Under 600 MB with ~95 MB of room (about 3–4 bulk quarters).
- **Found on real data and fixed:**
  - Trap 43 / F35 (verified on raw EDGAR): 21,942 rows ($233.2B) report balance 0 with a real value ("Investment does
    not issue shares"); `exposureAsOf` dropped them. They now count like NULL balances (the P3 decision), with no
    per-share price. No golden changes (A1–A6 and by-company pass live). **Decided by Claude under the P3 precedent;
    the user can overrule.** Tracked impact: 19 rows, $273.7M over the history (Hockey Parent via AMG Pantheon
    $45.4M at 2026-06-30; AmSurg).
  - Trap 44: the review queue's "current" rows came from each fund's latest private row, not its latest filing,
    counting exited positions ($2.26B of Janus cash-collateral lines in 24 funds). Fixed; 39 components left the queue,
    55 changed; nothing over the threshold; tracked unresolved still 0.21%.
  - A stale 304 after a code change (ETag lacked the build); mid-word substring matches ("Stri" in INDUSTRIES).
- **For the next curation pass (not changed in 5a):** SpaceX rows filed as "SPACEX …" (incl. an "SPACEX, SPV" line)
  are linked by identity but not aliased to the public company; Vercel ($46.5M, 2 funds) sits just under the $50M bar;
  AMG Pantheon's "Hub International" co-investment line ($41.3M, last 2025-03-31) stays apart from Hockey Parent
  (no filing links them).
- **Suite:** 425 tests, 395 pass, 0 fail, 30 skipped (LIVE); LIVE goldens pass; lint and format clean. One v1 server
  test ("retries a 429 with backoff") failed once under load and passed 3/3 alone and on every rerun (timing).

## Phase 5 planning (2026-09-30)

A planning-only session: no application code, no migrations.

- **Step 0.** Refresh #7 `ok` in 0.6 min. No 2026Q3 bulk file yet. The EDGAR index lists 13,950 NPORT
  filings for 2026-06-30..09-30, and all are already stored. N-CEN had nothing new. `ingest_errors` is empty.
  The review queue has nothing over the threshold; tracked unresolved is 0.21%. Size: **513.0 MB (489 MiB)**
  of 600 MB. Suite: 394 tests, 364 pass, 0 fail, 30 skipped. Lint and format are clean.
- **The first P5 plan, checked against code and the live warehouse:**
  - _Parity:_ all 502 listed companies have stored restricted/PIPE rows, so "seen by the warehouse" is not
    "answered by it" (Pfizer, F24). v1's Single Security shows debt and any listed name.
  - _v1 math:_ EFTS hits are capped at 50 filings by default and 250 at most (not 100). `groupAndDedupe`
    keys on (date, shares, instrumentKey), so an amendment is kept arbitrarily or counted twice, and exits are
    invisible.
  - _Speed (live warehouse):_ one company p95 7 ms warm over the 180 tracked, 230–570 ms cold (Anthropic 362,
    Databricks 568, Stripe 232). All 180 take 0.4 s warm and 1.7–4 s cold. A name pattern takes 2.7 s.
    Anthropic at all 38 report dates takes 142 ms. SQLite 3.53.4 has FTS5 with the trigram tokenizer; spellfix
    is not available.
  - _History starts (P5 tests):_ Anthropic 2023-04-28, Stripe 2019-12-31, Databricks 2019-10-31.
  - _Ids:_ a rename keeps the id (`renameInPlace`), but ids are SQLite-assigned and in no reviewed file. A
    rebuild renumbers them, and a merged or dropped id disappears.
  - _Fund X-Ray_ needs every row of a filing: totals, the listed count, % of holdings value, and debt tranches.
  - _Unresolved rows:_ 846,488 stored rows have no company, and `holdings` has no issuer-key column, so an
    "unreviewed" answer would take the regex path.
  - _Search data:_ Hockey Parent's brand is stored as "HUB INTL", so search needs abbreviation pairs.
    `OPENAIR` is a curated OpenAI alias (F32), so the OpenAir test asserts the match reason.
  - _Size:_ an integer column's index costs about 15 MiB (`holdings_company` 15.1 MiB). Largest objects:
    holdings 216.7 MiB, filings 84.7 MiB, the holdings key index 51.0 MiB.
  - _Field coverage for P6:_ `pct_nav` is on 100% of tracked-company rows, `country` on 99.3%, and
    `net_assets` on 100% of filings. Filings arrive about 58 days after the report date, and 3,884 arrived in
    the 7 days to 2026-09-30. `companies.public_since` is empty for all 502 listed companies. N-CEN fund type
    is not stored.
- **Decisions (user, 2026-09-30; ADR 0008):**
  - All 8 recommendations were accepted: routing by company status, the new API, stable ids, one tracked
    list, the 5a/5b split, admin-only curation, unreviewed names, and a size gate.
  - Two changes to the first recommendation: store X-Ray's full-book fields per filing (`filing_totals`),
    and measure before precomputing.
  - New features are folded into P6: firm pages, an as-of slider with `knownAsOf`, a what's-new feed and
    RSS, conviction, mark disagreement, stale marks, an indirect exposure view, and geography.
  - Two research tasks go to P8: the last private mark vs. the first listed price, and N-CEN fund type.
- **Docs changed:**
  - ROADMAP: §Phase 5 rewritten as 5a/5b, with P6, P7, P8 and P9 updated.
  - ADR 0008 added.
  - ARCHITECTURE: pipeline and planned modules.
  - SESSION-PROMPTS: the 5a and 5b prompts; the P6, P7 and P9 prompts updated.
- **Next:** the user signs off the plan, then Phase 5a with the SESSION-PROMPTS "Next session: Phase 5a"
  prompt.

## Pre-Phase 5 review (2026-09-30)

A full review of the v2 build (bugs, code, docs, git, alignment with the goal) before Phase 5. Everything
it found in the code and docs is fixed; the Phase 5 plan questions go to the planning session.

- **Bugs fixed:**
  - A fund still reporting a company at $0 was counted as an exit ("no longer reported"). `exposureAsOf`
    now returns it under `zeroValue` (F34, trap 42, ADR 0004 amended). At 2026-06-30: 4 funds in Altice
    France, Incora and Mesquite Energy; 140 canonical filings over the full history.
  - `pricePerShare` was value / balance for any unit. Now share rows only; every row has `pricePerUnit`,
    and splits are detected on it (trap 40).
  - Company ids changed on every rename (the import matched by name). A renamed company now keeps its id
    and its tracked date; untracking still removes it.
  - The identity graph read rows in no fixed order, so guarded unions could differ between runs (63 of
    38,224 review-queue rows moved once ordered; totals, threshold and tracked 0.21% unchanged). Two runs
    now give identical files.
  - Refresh: one run at a time (a `running` row under 2 h blocks; older ones close as abandoned); a
    catch-up filing uncovered by bulk now fails the run (it only set the exit code); a loaded quarter the
    SEC re-posts at a different size is reloaded (trap 41: all 2019q4–2024q2 zips were re-posted in
    July 2024; all 27 sizes still match ours, C22).
  - Readers get `openWarehouseReadOnly` (never creates the file, never migrates, refuses a schema that is
    behind). The P5 server must use it.
- **Clean code:** shared helpers in one place (`lib/entities/names.js`, `lib/warehouse/keep-rule.js`,
  `lib/warehouse/values.js`, the placeholder-series rule in `identifiers.js`, `INACTIVE_DAYS` from
  `asof.js`); the two different `VEHICLE_WORDS` renamed for what they mean; the seed↔identity require
  cycle and the listing-evidence lazy require removed; SpaceX's curated status moved from code to
  `curation.json` (`status`); v1's firm list moved to `public/fund-groups.js` (shared by the UI and the
  seed, which no longer evaluates a slice of `app.js`); a stale comment removed.
- **Tests (+6):** $0 positions on a new real fixture (`test/fixtures/asof-zero/`, verified on EDGAR), units,
  stable ids, read-only open, refresh lock, re-posted quarters, and the committed `data/review/` files
  import cleanly with every issuer-key alias a fixed point of `issuerKeyOf` (guards P5's name changes).
- **CI:** the workflow ran only on `main`, so it had never run on v2. It now runs on every push and PR.
- **Docs:** README (v2 status, entity commands), CLAUDE.md (`entities:report`, read-only readers),
  ROADMAP (migration numbers, paths, sizes), ARCHITECTURE (refresh steps, module map), DATA-QUALITY (traps
  40–42, trap 8, SPV look-through answered: 0.9% of tracked exposure is held through named SPVs),
  GOLDEN-NUMBERS (F34, C22, C5 order), LESSONS 28–30, SESSION-PROMPTS (obsolete P4.5 prompt removed).
- **Suite:** 394 tests, 364 pass, 0 fail, 30 skipped (LIVE). LIVE goldens A1–A6 and LIVE entities pass. Lint
  and format clean.
- **For Phase 5 planning (not decided):** parity scope (the warehouse holds no debt and no public
  securities, both of which v1's Single Security shows); API shape (v1 aggregates in the browser, filing by
  filing, without amendment handling); company ids in URLs and MCP; one or several tracked lists;
  precomputed tracked as-of (all 180 take 1.1 s) and a search index (a name pattern takes 1.3 s); where
  "make this a company" writes in a deployed app; human review as the only path for new names.

## Phase 4.5 results (signed off 2026-09-30)

- **Refresh at session start:** #5 ok, no 2026Q3 bulk file yet; 777 catch-up filings loaded, 0 failed;
  `ingest_errors` empty. Goldens A1–A6 and the P4 by-company goldens reproduced before any change.
- **Built:**
  - `lib/entities/identity.js`: evidence edges (LEI, instrument id, share count, same mark, title/dba,
    normalized names, Fidelity-style per-fund vehicles) and guarded components (two LEIs, listed vs private,
    two curated companies, curation `separate`).
  - `lib/entities/report.js`, `npm run entities:report`: stores the graph, ranks unresolved value by
    component and category, measures tracked unresolved exposure; also runs in every `npm run refresh`
    (writes `reports/entities/{unresolved,conflicts}.csv`, git-ignored).
  - Migration 0011: `identity_edges`, `identity_nodes`, `company_brands`.
  - Seed: component-level candidate rule; the user's 2-fund/$50M rule; vehicles as indirect; brands
    (`kind=brand` rows in aliases.csv, evidence required); generic keys never anchor.
  - Tests: `test/identity.test.js` (12, on the new real-data fixture `test/fixtures/identity/`, 393 KB).
- **Decisions (user, 2026-09-30):** threshold = no unresolved component >= $50M held by >= 2 funds that is not
  an opaque vehicle on the review list. OpenAir merges into OpenAI on BlackRock's filer evidence (F32).
- **Curation (curation.json, each with an accession):** Anthropics Technology -> Anthropic (F31), OpenAir ->
  OpenAI (F32), RAMP -> Ramp (F33), Aestas LLC dba OpenAI and the SpaceX SPVs as indirect, Ascent CNR /
  Ascent Capital kept separate (contradicting marks), renames (FHU US Holdings, Trumid, Hockey Parent
  Holdings), 3 untracks.
- **Results on the live warehouse:** 806 companies (304 private, 502 public), 180 tracked, 2,402 aliases, 4
  brands; 318,751 rows resolved; 5,206 evidence edges, 51 conflicts flagged.
  - FHU US Holdings (brand Chobani): **13 funds / $359.0M** at 2026-06-30, identical to the F29 pattern;
    Fidelity's 10 per-fund LLCs resolve as indirect.
  - Threshold met: the only unresolved components >= $50M in 2+ funds are 3 opaque Fidelity per-fund vehicles
    (VETERINARY HOLDINGS $257.7M / 9 funds, AB HOLDINGS $90.5M, TC HOLDINGS $81.6M). EDGAR full-text search
    finds no filing stating what they hold (negative finding), so they stay on the review list.
  - Tracked unresolved exposure **0.21%** ($135M of $63.4B; the largest items are look-alikes curation keeps
    apart).
  - By company at 6/30: Anthropic 117 / $17.295B (+$34.1M, F31), Stripe 35 / $1.31B (12/31/25), Databricks
    120 / $6.233B, OpenAI 87 / $5.490B. Pattern goldens A1–A6 unchanged.
- **Suite:** 388 tests, 358 pass, 0 fail, 30 skipped (LIVE). LIVE goldens and LIVE entities pass. Lint and
  format clean.

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

| Metric                                  | Budget                      | Measured                                                                                         |
| --------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------ |
| Full bulk backfill, 27 quarters         | ≤45 min                     | **13.6 min** (2026-09-28)                                                                        |
| Warehouse size                          | ≤600 MB (raised 2026-09-30) | 364 MB (P1); 472 MB (P4); 513 MB (P4.5); **503–505 MB after VACUUM (P5a)**                       |
| First catch-up                          | ≤90 min                     | **26.9 min** for 11,822 filings (about 9/s)                                                      |
| Nightly refresh                         | ≤5 min                      | 1.1 s (P2, nothing new); **20–160 s** with N-CEN, entity upkeep and the review queue (runs #2–6) |
| API p95                                 | <200 ms                     | **P5a: all routes 15.9 ms first pass / 5.6 ms warm (quiet); 35 / 28 ms under load**              |
| Single Security search (P0, live EDGAR) | n/a                         | 15–32 s per name for 100 filings                                                                 |

## Open decisions

- **Nightly refresh scheduling:** not installed. A ready-to-use launchd job is in ARCHITECTURE
  §Refresh lifecycle. Install only with the user's yes. Until then, run `npm run refresh` at the start of
  each session.
- **Branch:** PR #2 (`v2-plan-and-phase0`, with the Phase 5 plan) merged to `main` on 2026-09-30 at the user's
  request. P5a is on `v2-phase5a`. Ask before merging to `main`, opening PRs, renaming or deleting branches
  (`audit-fixes`, `v2-plan-and-phase0`, `v2-phase5-plan` are all contained in `main`).
- ~~Phase 5 plan sign-off~~ Signed off 2026-09-30.
- ~~5a sign-off~~ Signed off by the user 2026-09-30; `v2-phase5a` merged to `main` by PR.
- **Balance-0 rows (trap 43):** counted under the P3 NULL-balance precedent; the user can overrule (then
  `nullBalance` would need a separate flag for 0).
- ~~Manager mapping source~~ Decided in P4: N-CEN advisers + reviewed `managers.csv` (ADR 0007).
- ~~Entity review~~ Done 2026-09-29 (Claude, at the user's direction; `data/review/curation.json`). The
  user can still edit the CSVs or curation file; re-import with `npm run review:aliases`.
- **Tracked list (user, 2026-09-29):** size is the user's choice (100–200 likely); the 242 in the draft
  are a suggestion. The user may send their own names to resolve against the warehouse.
- ~~P4.5 threshold~~ Decided 2026-09-30: >= $50M held by >= 2 funds.
- ~~P4.5 sign-off~~ Signed off by the user 2026-09-30.
- ~~Size budget~~ Raised to **600 MB** by the user (2026-09-30). `warehouse.db` is **513 MB on disk (489 MiB)**
  after P4.5, growing about 25 MB per bulk quarter. Raise the budget, or prune (e.g. unused indexes, old
  listing evidence), before it passes 600 MB.
- **Fidelity opaque vehicles:** ~$0.6B across VETERINARY, AB, TC, TB, TRB, TB2 and THRIVE HOLDINGS LLCs. No
  filing names their targets; they stay on the review list (search again if Fidelity's N-CSR text becomes
  searchable).
- ~~One or several tracked lists~~ Decided 2026-09-30: one curated list; viewer watchlists in the browser store
  ids (ADR 0008). Alerts: an RSS/Atom feed per company in P6 (no accounts).
- **Search outside the list must keep working (user, 2026-09-29):** any company in the warehouse is
  analyzable by name pattern even if not in `companies`; P5 search must fall back to the pattern path
  and offer to add the company. The on-demand EDGAR keyword search stays.

## Warehouse state (2026-09-30, after Phase 5a)

- Schema at migration 0014; refresh #10 `ok`; `ingest_errors` empty.
- 354,997 N-PORT filings (bulk 2019Q4–2026Q2 plus EDGAR catch-up through filings of 2026-09-29) and 1,165,239
  private-candidate holdings; 806 companies (304 private), 180 tracked, ids in `data/review/company_ids.csv`;
  318,751 rows resolved; 71,831 unreviewed entities (846,385 rows tagged); 106k search rows.
- N-CEN: 17,841 of 18,852 funds have an adviser.
- `listing_evidence` covers the latest 4 bulk quarters. **Don't backfill all 27** (+60–70 MB) without pruning or
  asking.
- 503–505 MB on disk after `VACUUM`. A refresh that re-tags many rows leaves free pages; `VACUUM` (10 s) returns them.
- The SEC 2026Q3 bulk file (expected after 2026-09-30) loads on the next `npm run refresh`.

## Log

- **2026-09-30:** User signed off P5a (incl. the balance-0 rule, trap 43); PR opened and merged to `main`. Next: Phase 5b.

- **2026-09-30:** Phase 5a built (tasks 1–8, one commit each) on `v2-phase5a` after PR #2 merged. Traps 43–44, F35,
  ADR 0004 amended, LESSONS 32–35. Stopped for the 5a sign-off.

- **2026-09-30:** Phase 5 planning. Refresh #7 `ok` (nothing new). The first P5 plan was checked against the
  code and the warehouse (8 findings confirmed, 4 new). The user decided all 8 recommendations and the 2
  changes. ROADMAP §5 was rewritten as 5a/5b, P6–P9 updated, and ADR 0008 added. Stopped for plan sign-off.

- **2026-09-30:** Pre-P5 review of the whole v2 build, and every code and doc finding fixed (see "Pre-Phase 5
  review"). Next: Phase 5 planning with the user.

- **2026-09-30:** User signed off P4.5 and raised the warehouse size budget to 600 MB. Next: Phase 5.

- **2026-09-30:** Phase 4.5 built: identity graph, review queue (also in refresh), migration 0011, re-seed with evidence, curation (Anthropics, OpenAir, Ramp, SpaceX SPVs), threshold agreed (2 funds / $50M) and met; F31–F33, C21, traps 35–39, lessons 24–27. Stopped for sign-off.

- **2026-09-29:** Reviewed FHU US Holdings (Chobani) and Anthropic class marks with the user. Added Phase 4.5 (identity graph, vehicles, unresolved-value report) and search/class-comparison/watch items to P5, P6 and P8; findings recorded (GOLDEN F29–F30, traps 31–34, lesson 23); handoff prompt rewritten.

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
