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

### Next session: Phase 5 (written 2026-09-30, after P4.5 sign-off; plan under revision)

_The pre-P5 review (STATUS "Pre-Phase 5 review") found that ROADMAP §Phase 5 needs decisions on parity
scope (debt, public securities), API shape, company ids and tracked lists before it starts. Use this
prompt only after the revised plan is in ROADMAP._

> Resume Vantage v2 at Phase 5 (service layer, parity, search over every issuer). P0–P4.5 are complete
> (P4.5 signed off 2026-09-30). Read CLAUDE.md, docs/STATUS.md (Phase 4.5
> results, Open decisions), docs/LESSONS.md (all 30), docs/ROADMAP.md §Phase 5 and the P6/P8 items,
> docs/DATA-QUALITY.md (traps 1–42), docs/GOLDEN-NUMBERS.md (F29–F34), docs/ARCHITECTURE.md §Company identity.
>
> Step 0: `npm run refresh` in the foreground (it loads 2026Q3 bulk if posted and rewrites the review queue
> in reports/entities/); check `ingest_errors`, the size budget (600 MB; 513 MB after P4.5), and that the queue shows nothing over the threshold (>= $50M, 2+ funds) except the 3 opaque Fidelity
> vehicles. Run `npm test`, lint, format and the LIVE golden + entities tests. Expected by company at 6/30:
> Anthropic 117 / $17.29B, Databricks 120 / $6.23B, FHU US Holdings 13 / $0.36B, OpenAI 87 / $5.49B; Stripe
> 35 / $1.31B at 12/31/25. Pattern goldens A1–A6 unchanged.
>
> Then ROADMAP §Phase 5: lib/services/*; routes answer from the warehouse with a labeled EDGAR fallback;
> search over every issuer through identity_nodes/identity_edges, company_aliases and company_brands
> (forgiving match; candidates with evidence; "make this a company" writes the review files and
> re-resolves). "Chobani", "FHU", "FHUS", "Hub International" and "Open AI" must work; "OpenAir" never
> matches OpenAI by name. Fund X-Ray: private = company status. p95 < 200 ms (batch/cache per-fund lookups).
> Parity: existing tests pass with fixtures only changing; exports identical. New history tests: Anthropic
> from 2023-04-28, Stripe from 2019-12-31, Databricks from 2019-10-31. Keep the user's display rules: mark
> date + accession per fund, via_spv as "indirect", disclosed_exposure in the filing's words, exits as "no
> longer reported", per-class marks without a method label. Stop for the P5 sign-off; no push/PR/launchd
> without an explicit yes.

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
