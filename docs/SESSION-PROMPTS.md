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

### Next session: Phase 5a (written 2026-09-30, after the Phase 5 plan; use once the user signs off the plan)

> Resume Vantage v2 at Phase 5a (services, search over every issuer, the company page on the warehouse).
> P0–P4.5 are signed off; the Phase 5 plan was decided 2026-09-30 (ADR 0008). Read CLAUDE.md,
> docs/STATUS.md ("Phase 5 planning", Open decisions), docs/LESSONS.md (all), docs/ROADMAP.md §Phase 5
> (the decisions, then 5a), docs/decisions/0008-app-on-the-warehouse.md, ADRs 0003–0005,
> docs/DATA-QUALITY.md (traps 1–42 and Display rules), docs/GOLDEN-NUMBERS.md and docs/ARCHITECTURE.md.
>
> Step 0: `npm run refresh` in the foreground (it loads 2026Q3 bulk if posted); report what it loaded,
> `ingest_errors` and the size against 600 MB (513 MB on 2026-09-30). Run npm test, lint, format and the
> LIVE goldens. Expected by company at 6/30/2026: Anthropic 117 / $17.295B, Databricks 120 / $6.233B, FHU US
> Holdings 13 / $359.0M, OpenAI 87 / $5.490B; Stripe 35 / $1.31B at 12/31/25. If a new bulk quarter or an
> amendment moves a golden, re-verify it on raw EDGAR before anything else.
>
> Then ROADMAP §5a tasks 1–8 in order, each ending green: prune indexes (prove each unused), stable company
> ids in the reviewed files + redirects, entities + holdings.entity_id, the FTS5 trigram search index with
> match reasons, lib/services (search, company, source), read-only server routes with source/refreshId,
> `npm run bench` before any precompute, and the company page. Tests as listed (history starts, goldens
> through the API and on screen, the search cases with their match reasons, routing, ids, read-only). An
> app-test assertion changes only where v1 was wrong, with the golden named in the commit. Long jobs in the
> foreground; one-line status before any wait. Stop for the 5a sign-off; no push, PR or launchd without an
> explicit yes.

### Phase 5b: funds, lists, exports

> Vantage v2 Phase 5b. Read CLAUDE.md, docs/STATUS.md, docs/LESSONS.md, docs/ROADMAP.md §Phase 5 (5b) and ADR 0008. Confirm 5a is signed off. Measure first, then build: filing_totals in both ingest paths with a
> parity test and a foreground, resumable backfill (bulk ~14 min, catch-up ~26 min); measure the
> capital-structure debt rows on one quarter and bring the numbers to me before any keep-rule change; then
> the fund page, compare/returns, Batch and Watchlist on the services (ids, name migration), peer analytics
> to lib/analytics/peer.js, exports, the admin "make this a company" job, and retire the per-filing flows.
> Stop for sign-off.

### Phase 6: new analysis and UI

> Vantage v2 Phase 6. Read CLAUDE.md, docs/ARCHITECTURE.md (Mark series, As-of), ADR 0008 and
> docs/ROADMAP.md §Phase 6. Build the firm page and the P6 sections on the company, fund and firm pages: as-of
> slider with knownAsOf, mark series, holder changes, the what's-new feed (+ RSS), conviction, mark
> disagreement, stale marks, class comparison, indirect exposure, geography, the tracked dashboard, top
> private, exports and the freshness banner. Check any new metric on real filings first. Verify the listed
> goldens on screen.

### Phase 7: MCP server

> Vantage v2 Phase 7 (needs P5a signed off). Read CLAUDE.md, ADR 0008 and docs/ROADMAP.md §Phase 7. Build mcp-server.js over lib/services
> with the listed tools. Tests return golden numbers. Document `claude mcp add` in README.

### Phase 8: operations

> Vantage v2 Phase 8. Read CLAUDE.md and docs/ROADMAP.md §Phase 8. Add backups, refresh alerting, the
> monthly golden regression and `npm run doctor`.

### Phase 9: public deployment

> Vantage v2 Phase 9. Read CLAUDE.md, docs/STATUS.md, docs/LESSONS.md, docs/ROADMAP.md §Phase 9 and
> docs/ARCHITECTURE.md (Refresh lifecycle, Configuration). Confirm P5a, P5b and P8 are signed off and the deployed
> curation path (ADR 0008) is decided.
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
