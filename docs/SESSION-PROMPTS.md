# Session Prompts

Paste one of these at the start of a session. Each prompt tells Claude what to read and when to stop.

**Every prompt implies:**

- Follow `CLAUDE.md`.
- Work on a branch.
- Stop at the checkpoint for user sign-off.
- Update `docs/STATUS.md` before ending.

---

### Resume (any phase)

> Resume Vantage v2. Read CLAUDE.md, docs/STATUS.md, and the current phase in docs/ROADMAP.md. Summarize
> where we are, what's left in this phase, and any open decisions, then continue. Do not start the next
> phase without my sign-off.

### Phase 0: live-app fixes

> Vantage v2 Phase 0. Read CLAUDE.md and docs/ROADMAP.md §Phase 0 and docs/DATA-QUALITY.md trap 11. Fix
> EFTS de-duplication by adsh, quote multi-word queries, and make extractHoldings match on word boundaries.
> Add the listed tests (Revolution Medicines, OpenAir, Anthropics Technology, duplicate adsh). Run npm test,
> lint, format:check. Update STATUS and stop for sign-off.

### Phase 1: warehouse and bulk history

> Vantage v2 Phase 1. Read CLAUDE.md, docs/ARCHITECTURE.md (Schema, Data sources) and docs/ROADMAP.md
> §Phase 1. Build lib/warehouse/db.js with migrations, and scripts/ingest-bulk.js (yauzl streaming; equity
> rows at any fair-value level, including assetConditional; all filings; ISO dates; ingest_log; idempotent;
> fails loudly). Build the real-derived fixture from the GOLDEN-NUMBERS accessions. Prove parity with
> extractAllHoldings. Then run the full 27-quarter backfill **in the foreground in timed batches** and
> record time and size in STATUS. No background wait loops.

### Phase 2: daily catch-up and refresh

> Vantage v2 Phase 2. Read CLAUDE.md and docs/ROADMAP.md §Phase 2. Move fetchWithRetry/pace to
> lib/edgar.js, build scripts/ingest-delta.js (daily form index → primary_doc.xml → the app's parsers,
> source='edgar', resumable) and scripts/refresh.js (new-bulk-quarter replacement + catch-up + refresh_runs).
> Verify golden F2 (Growth Fund of America 5/31/2026 Anthropic $4,979.7M) is in the warehouse. Document the
> cron/launchd entry.

### Phase 3: canonical views and as-of

> Vantage v2 Phase 3. Read CLAUDE.md, docs/STATUS.md, docs/LESSONS.md, docs/ROADMAP.md §Phase 3
> (especially "Before you start"), docs/DATA-QUALITY.md traps 1–5, 7, 9, 16, and docs/GOLDEN-NUMBERS.md.
> Run `npm run refresh` first and report what it loaded.
>
> Then:
>
> 1. Reproduce A1–A6 from warehouse.db with the exact research method in ROADMAP (name patterns;
>    EC/EP/OTHER/DE; value>0 and balance>0; canonical filings; exits; 123-day inactivity). Report any
>    difference with the rows behind it before changing anything.
> 2. Add migration 0003 (canonical_filings, fund_filing_timeline).
> 3. Build lib/analytics/asof.js with `{ pattern }` company selection and `knownAsOf` support, returning
>    per-fund mark dates and accessions. Reuse public/splits.js detectSplit.
> 4. Build test/fixtures/warehouse/ from the real warehouse, with its builder, and golden tests A1–A6,
>    F13 and F14 offline.
> 5. Decide explicitly, with me, how NULL-balance SPV rows and instrument_type vs asset_cat affect the
>    numbers.
>
> Long jobs run in the foreground in batches. Update STATUS and stop for my sign-off.

### Phase 4: entities and tracked list

> Vantage v2 Phase 4. Read CLAUDE.md, docs/DATA-QUALITY.md (traps 7, 8, 10, 13, Open questions) and
> docs/ROADMAP.md §Phase 4. Build the companies/aliases/spv_map/managers/tracked tables, seed-entities and
> review-aliases scripts. Investigate N-CEN for manager mapping with real filings and report findings before
> adopting it. Produce the review CSV for the top ~250 and stop for my review.

### Next session (written 2026-09-29): close Phase 4, then Phase 5

> Resume Vantage v2. Close Phase 4 (import the reviewed entity files, re-measure, sign-off), then start
> Phase 5 (service layer and parity) only after my explicit sign-off.
>
> **State.** Branch `v2-plan-and-phase0` (pushed; no PR; not merged to main). P0–P3 are signed off. P4 is
> built and code-reviewed (latest P4 commit 6178f6e) and waits on my review of `data/review/aliases.csv`
> (731 companies: 242 tracked, 289 other private, 442 public), `managers.csv` (619 rows) and
> `disclosed_exposure.csv` (Fundrise ranges). `warehouse.db` (git-ignored, 472 MB of a 500 MB budget,
> migrations through 0010) has no reviewed entities yet, so every `holdings.company_id` is NULL. The app
> still runs on live EDGAR (v1 behavior plus P0 fixes); it reads the warehouse from Phase 5.
>
> **Read first, in order:** CLAUDE.md; docs/STATUS.md (Phase 4 checkpoint, Open decisions, Warehouse
> state); docs/LESSONS.md (all, especially 15–19); docs/ROADMAP.md §Phase 4 "Checkpoint" and §Phase 5;
> docs/DATA-QUALITY.md traps 1–5, 7–10, 16, 20–26; docs/GOLDEN-NUMBERS.md; ADRs 0003, 0004, 0007.
>
> **Step 0: refresh and health check.**
>
> - Run `npm run refresh` in the foreground. After 2026-09-30 the SEC should post the 2026Q3 N-PORT bulk
>   file; refresh loads it (~30 s), replaces the matching catch-up rows, collects listing evidence and
>   re-keys funds. Report what it loaded.
> - Confirm `ingest_errors` is empty and the run is `ok`, and check `du -h warehouse.db` against the budget.
> - Run `npm test`, `npm run lint`, `npm run format:check` and
>   `LIVE_SEC=1 node --test --test-name-pattern="as-of golden" test/live-warehouse.test.js`.
>   The goldens must still be A1 72/$5.93B, A2 117/$17.26B, A5 49/35/34/37, A6 120/$6.22B. If a new
>   amendment moved one, verify on EDGAR before changing GOLDEN-NUMBERS; never tune code.
>
> **Step 1: ask me how to handle the entity review.** Check `git diff 6178f6e -- data/review/` to see
> whether I edited the files. Offer these options:
>
> - (a) import the draft as-is;
> - (b) import my edited files;
> - (c) I send my own 100–200 tracked names: resolve each against the warehouse and report the ones not
>   found or that look public;
> - also re-ask whether I want several named lists (a schema change best made before P5) and whether
>   alerts on new marks belong in P6.
>
> Don't build a list or alerts feature without a yes.
>
> **Step 2: Phase 4 close-out** (on my answer).
>
> - Run `npm run review:aliases`. It is transactional, fails loudly on bad rows, and re-resolves all rows
>   (~8 s).
> - Re-measure on the live warehouse: Databricks' 59 raw strings map to 1 company; STRIPE INC/LLC are one
>   company; Douyin maps to ByteDance; Magnitude maps to Anthropic with via_spv = 1; SpaceX is public; the
>   Capital Group manager includes CIKs 44201, 719608, 4405, 39473, 4568, 894005 and 729528; unresolved
>   tracked exposure is under 1% (trial result: 0.71%); `exposureAsOf({ companyId })` equals the pattern
>   result for A1–A6.
> - Record the results in GOLDEN-NUMBERS (C19) and STATUS, commit, and stop for P4 sign-off.
>
> **Step 3: Phase 5, after my sign-off only.** Follow ROADMAP §Phase 5:
>
> - build `lib/services/*`;
> - make the existing routes answer from the warehouse, with a labeled live-EDGAR fallback for names the
>   warehouse has never seen;
> - make Fund X-Ray's "private" mean company status;
> - pass all existing app/server tests (update fixtures, never assertions);
> - meet p95 < 200 ms;
> - produce identical CSV/XLSX/PDF exports.
>
> My requirements for Phase 5:
>
> - Any company in the warehouse stays searchable by name even if it isn't in `companies`. Fall back to the
>   `exposureAsOf({ pattern })` path and offer to add the company; the on-demand EDGAR keyword search stays.
> - Treat v1 as the guidepost: keep its screens and behavior, but make the answers complete and correct.
> - Always show each fund's mark date and accession, and label SPV (via_spv) value "indirect".
> - Show Fundrise-style `disclosed_exposure` as the filing's words, never as dollars.
> - Known risk: the pattern path costs 2–6 s per call (a regex over 1.16M rows); `companyId` uses an index.
>   Measure p95 early.
> - Real history now: Anthropic from 2023-04-28; Stripe from 2019-12-31; Databricks from 2019-10-31.
>
> **Settled decisions (don't reopen):**
>
> - Row rule: equity-type means `instrument_type` other than debt, as in v1; value > 0; NULL-balance rows
>   count. The research rule is still available as an option.
> - `instrument: 'debt'` throws, because the warehouse stores no debt rows.
> - Canonical filing: the latest filing date wins; on a same-day tie, NPORT-P/A beats NPORT-P, then the
>   higher accession.
> - Inactive after 123 days; `knownAsOf` = filings made by that date.
> - fund_key rules: `S000000000` counts as blank; overrides table; series-LEI joins; CIK+LEI for
>   registrants with several series.
> - Managers come from N-CEN advisers keyed by SEC file number.
> - Status comes from listing evidence first, then Level-3 share.
> - Fundrise is a disclosed range, not an SPV mapping.
>
> **How we work.**
>
> - Real SEC data only; check every new number on raw EDGAR and add it to GOLDEN-NUMBERS with its
>   accession. SpaceX is public.
> - Long jobs run in the foreground in batches under 10 minutes, with a one-line status before each wait.
>   No orphan background loops.
> - Never edit an applied migration; add a new one and compare a fresh schema with the live one.
> - Edit scripts must read a file before writing it (`open(p,'w')` truncates).
> - zsh doesn't word-split unquoted variables; use `while read`.
> - SEC dates are DD-MON-YYYY; convert them with `bulkDateToIso`.
> - Every SEC call goes through the paced `fetchWithRetry`.
> - `seed:entities` needs `--force` to overwrite the review files.
> - Watch the 500 MB budget: don't backfill listing evidence for all 27 quarters without asking.
> - If the auto-mode classifier fails twice in a row, stop and report the resume point.
>
> **Gates.** Stop for my sign-off at each phase checkpoint. Don't push, open a PR, or install the nightly
> launchd job without my explicit yes. Finish each step with the suite, lint and format green, docs updated
> (STATUS, ROADMAP, GOLDEN-NUMBERS, DATA-QUALITY and LESSONS as needed) and a commit.

### Phase 5: service layer and parity

> Vantage v2 Phase 5. Read CLAUDE.md and docs/ROADMAP.md §Phase 5. Create lib/services, move peer
> analytics out of public/app.js, and point existing routes at the warehouse with a labeled live-EDGAR
> fallback. All existing tests must pass with assertions unchanged. Measure API p95.

### Phase 6: new analysis and UI

> Vantage v2 Phase 6. Read CLAUDE.md, docs/ARCHITECTURE.md (Mark series, As-of) and docs/ROADMAP.md
> §Phase 6. Build as-of exposure (company → firm → fund → class), firm/fund/class mark charts at every
> report date, holder changes, the tracked-list dashboard, top-private ranking, freshness banner and
> exports. Verify the Capital Group Stripe path from GOLDEN-NUMBERS renders on screen.

### Phase 7: MCP server

> Vantage v2 Phase 7. Read CLAUDE.md and docs/ROADMAP.md §Phase 7. Build mcp-server.js over lib/services
> with the listed tools. Tests return golden numbers. Document `claude mcp add` in README.

### Phase 8: operations

> Vantage v2 Phase 8. Read CLAUDE.md and docs/ROADMAP.md §Phase 8. Add backups, refresh alerting, the
> monthly golden regression and `npm run doctor`.

### Phase 9: public deployment

> Vantage v2 Phase 9. Read CLAUDE.md, docs/STATUS.md, docs/LESSONS.md, docs/ROADMAP.md §Phase 9 and
> docs/ARCHITECTURE.md (Refresh lifecycle, Configuration). Confirm P5 and P8 are signed off.
>
> First, present the hosting options with current pricing and limits (verified now, not remembered), with
> a recommendation. Record my choice as ADR 0006 before building.
>
> Then build and deploy to **staging** only:
>
> - Dockerfile
> - `/healthz`
> - scheduled `npm run refresh` with a lock and health-check pings
> - Litestream backups with a restore drill
> - Cache-Control plus CDN
> - secrets in the host's store
> - CI deploy
>
> Run the Phase 9 tests (restore drill, zero SEC calls under load, golden numbers on staging). Stop for my
> sign-off before production, the custom domain, or anything public.

### Ad-hoc research (no building)

> Vantage research only. Do not build. Follow CLAUDE.md's data rules: pull real SEC data, verify against
> raw EDGAR, and report findings, including negative ones, with accessions. Question: <…>
