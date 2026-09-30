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

### Next session: Phase 5 (written 2026-09-29)

> Resume Vantage v2 at Phase 5 (service layer and parity migration).
>
> **State.**
>
> - Branch `v2-plan-and-phase0`, pushed; no PR; not merged to main. P0–P4 are complete.
> - P4's entity lists were finalized with filing evidence and imported into `warehouse.db`:
>   - 739 companies (257 private, 482 public), 178 tracked, 2,173 aliases, 529 firms
>   - 305,914 holdings rows resolved; unresolved tracked exposure 0.46%
> - `warehouse.db` (git-ignored) is 472 MB of a 500 MB budget, migrations through 0010.
> - The app (server.js + public/app.js) still runs on live EDGAR: v1 behavior plus the P0 fixes.
>   Phase 5 moves it onto the warehouse.
>
> **Read first, in order:**
>
> 1. CLAUDE.md
> 2. docs/STATUS.md: Phase 4 results, Open decisions, Warehouse state
> 3. docs/LESSONS.md (all 22)
> 4. docs/ROADMAP.md §Phase 5 and §Phase 6 (so P5 doesn't build P6)
> 5. docs/DATA-QUALITY.md, all traps (1–30)
> 6. docs/GOLDEN-NUMBERS.md
> 7. ADRs 0003, 0004, 0007
> 8. docs/ARCHITECTURE.md
> 9. Then read server.js routes, public/app.js and the test/app-*.test.js files before designing
>    lib/services.
>
> **Step 0: refresh and health check.**
>
> - Run `npm run refresh` in the foreground and report what it loaded. After 2026-09-30 the SEC should post
>   the 2026Q3 N-PORT bulk file: refresh loads it, replaces catch-up rows, adds listing evidence for 2026q3,
>   re-keys funds, re-resolves companies and refreshes fund advisers.
> - Confirm `ingest_errors` is empty and the run is `ok`, and check `du -h warehouse.db` against the budget.
> - Run `npm test`, `npm run lint`, `npm run format:check` and
>   `LIVE_SEC=1 node --test --test-name-pattern="LIVE: (as-of golden|reviewed entities)" test/live-warehouse.test.js`.
> - Expected goldens:
>   - by pattern: A1 72/$5.93B, A2 117/$17.26B, A5 49/35/34/37, A6 120/$6.22B;
>   - by company: Anthropic 117/$17.26B at 6/30; Stripe 35/$1.31B at 12/31/25; Databricks 120/$6.23B at
>     6/30 (includes the Project Debussy codename rows, F25).
>     If a new amendment moved one, verify on EDGAR before changing GOLDEN-NUMBERS; never tune code.
> - A new quarter can change company status (new listing evidence or lock-ups). Before Phase 5 work, re-run
>   `npm run seed:entities -- --force` (it applies `data/review/curation.json`), diff `data/review/`, report
>   status changes to me, then `npm run review:aliases`.
>
> **Phase 5 tasks (ROADMAP §Phase 5).**
>
> - Build `lib/services/{search,company,fund,manager,marks,peer}.js` over `exposureAsOf`,
>   `instrumentHistory`, the canonical views and the entity tables. Move peer analytics (outliers, velocity,
>   repricing) from `public/app.js` into `peer.js`, reusing, not re-implementing.
> - Existing routes (`/api/search-nport`, `/api/parse-nport`, `/api/search-fund`, `/api/fund-xray*`,
>   `/api/fund-series*`) answer from the warehouse, with a labeled live-EDGAR fallback for names the
>   warehouse has never seen.
> - Fund X-Ray: "private" = `companies.status`, not Level 3, keyed by `fund_key`.
> - Existing app/server tests pass: update fixtures, never assertions.
> - New tests: Single Security returns Anthropic history from 2023-04-28, and Stripe (2019-12-31) and
>   Databricks (2019-10-31) from 2019.
> - Success criteria: full parity, API p95 < 200 ms, identical CSV/XLSX/PDF exports.
>
> **My requirements.**
>
> - v1 is the guidepost: same screens and behavior, but complete and correct answers.
> - Any company in the warehouse stays searchable by name even if it isn't in `companies`. Fall back to
>   `exposureAsOf({ pattern })`, and offer to add it (a CSV row plus `npm run review:aliases`). The on-demand
>   EDGAR keyword search stays.
> - Always show each fund's mark date and accession.
> - Label via_spv value "indirect".
> - Show `disclosed_exposure` as the filing's words, never as dollars.
> - Show exits as "no longer reported", never with a guessed reason.
> - Speed risk: `exposureAsOf({ companyId })` takes 176–454 ms cold and ~9 ms warm; the pattern path takes
>   2–6 s. Measure p95 early. Batch the per-fund canonical lookups (one query per company, not per fund)
>   or cache per refresh run, before reaching for anything bigger.
>
> **Settled decisions (don't reopen):**
>
> - Row rule: equity-type means `instrument_type` other than debt, as in v1; value > 0; NULL-balance rows
>   count.
> - `instrument: 'debt'` throws.
> - Canonical filing: the latest filing date wins; on a same-day tie NPORT-P/A, then the higher accession.
> - Inactive after 123 days; `knownAsOf` = filings made by that date.
> - fund_key rules: `S000000000` counts as blank; overrides; series-LEI joins; CIK+LEI for registrants with
>   several series.
> - Managers come from N-CEN advisers by SEC file number. Firm = the brand in the adviser's name; no
>   ownership is assumed.
> - Company status: known evidence, then lock-up/PIPE, then listing evidence (best of 4 quarters), then
>   Level-3 share.
> - Merges only on filer evidence, recorded in curation.json. Fundrise is a disclosed range, not an SPV
>   mapping.
>
> **Open decisions (ask me; don't build without a yes):**
>
> - several named tracked lists vs. one (a schema change best made before P5 routes depend on it);
> - alerts on new marks (P6?);
> - installing the nightly launchd job;
> - opening a PR or merging to main.
>
> **How we work.**
>
> - Real SEC data only. Check every new number on raw EDGAR and add it to GOLDEN-NUMBERS with its accession.
>   SpaceX is public.
> - Long jobs run in the foreground in batches under 10 minutes, with a one-line status before each wait. No
>   orphan loops.
> - Never edit an applied migration.
> - Edit scripts read a file before writing it.
> - zsh doesn't word-split unquoted variables.
> - SEC dates are DD-MON-YYYY; use `bulkDateToIso`.
> - Every SEC call goes through `fetchWithRetry`.
> - `seed:entities` needs `--force`, and curation.json keeps reviewed decisions.
> - Watch the 500 MB budget.
> - If the auto-mode classifier fails twice in a row, stop and report the resume point.
>
> **Gates.** Stop for my sign-off at the Phase 5 checkpoint. Don't push, open a PR, or install launchd
> without my explicit yes. Finish with the suite, lint and format green; docs updated (STATUS, ROADMAP,
> GOLDEN-NUMBERS, DATA-QUALITY, LESSONS, ARCHITECTURE as needed); and a commit.

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
