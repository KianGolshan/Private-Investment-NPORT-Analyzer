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

### Next session: Phase 5b (written 2026-09-30, after the 5a checkpoint; use once the user signs off 5a)

> Resume Vantage v2 at Phase 5b (fund pages, lists, exports, retiring the per-filing flows). P5a is built
> (STATUS "Phase 5a results"). Read CLAUDE.md, docs/STATUS.md, docs/LESSONS.md (all), docs/ROADMAP.md §Phase 5 (the
> decisions and 5b), ADR 0008, ADRs 0003–0004, docs/DATA-QUALITY.md (traps 1–44, Display rules),
> docs/GOLDEN-NUMBERS.md and docs/ARCHITECTURE.md.
>
> Step 0: `npm run refresh` in the foreground (it loads 2026Q3 bulk if posted and rebuilds entities and search);
> report what it loaded, `ingest_errors` and the size against 600 MB (run `sqlite3 warehouse.db VACUUM` first if the
> free-page count is large). Run npm test, lint, format, the LIVE goldens and `npm run bench` (note the load average).
>
> Then ROADMAP §5b in order. Measure first: `filing_totals` in both ingest paths with a parity test on the 7 real
> fixture filings, then a foreground, resumable backfill (bulk ~14 min, catch-up ~26 min); measure the
> capital-structure debt rows on one quarter and bring me the numbers before any keep-rule change. Then the fund
> page (private = company status; unreviewed labeled), compare and returns across canonical filings, Batch and
> Watchlist on the company services (ids; existing names resolved once through search, unmatched kept), peer
> analytics to lib/analytics/peer.js, exports with mark date / accession / source, the admin-only "make this a
> company" job under the refresh lock, and the per-filing flows kept only as a compatibility layer. Stop for the 5b
> sign-off; no push to main, PR or launchd without an explicit yes.

### Next session: Phase 6 (written 2026-09-30, after the 5b checkpoint; use once the user signs off 5b)

> Resume Vantage v2 at Phase 6 (new analysis and UI). P5b is built on `v2-phase5b` (STATUS "Phase 5b results"); if the
> user signed it off, it may already be merged. Read CLAUDE.md, docs/STATUS.md, docs/LESSONS.md (all, especially
> 36–41), docs/ROADMAP.md §Phase 6, ADR 0008, docs/ARCHITECTURE.md (Mark series, As-of, module map),
> docs/DATA-QUALITY.md (traps 1–46, Display rules) and docs/GOLDEN-NUMBERS.md.
>
> Step 0: confirm CI is green on the branch you start from; `npm run refresh` in the foreground (2026Q3 bulk loads if
> posted; report what it loaded, `ingest_errors`, and the size against 600 MB, about 57 MB left after P5b); npm test,
> lint, format, **the whole `npm run test:live`** (not only the goldens) and `npm run bench` with the load average.
> Ask about the open decisions in STATUS (trap 45's loan rows, `npm audit`) before touching them.
>
> Then ROADMAP §6 in order, checking every new metric on real filings first and recording new numbers in
> GOLDEN-NUMBERS with accessions. Reuse lib/services (company, fund) and lib/analytics/peer.js; compare across funds
> as filed (LESSONS 39); look at worst cases as well as p95 (LESSONS 40). Stop for the P6 sign-off; no merge to main,
> PR or launchd without an explicit yes.

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
