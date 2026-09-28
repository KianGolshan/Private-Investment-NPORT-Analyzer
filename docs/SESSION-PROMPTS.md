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

> Vantage v2 Phase 3. Read CLAUDE.md, docs/DATA-QUALITY.md (traps 1–5, 9) and docs/ROADMAP.md §Phase 3.
> Add canonical_filings and fund_filing_timeline views, lib/analytics/asof.js and the shared split module.
> Golden tests: A1, A2, A3, A5, F13, F14. All must pass before sign-off.

### Phase 4: entities and tracked list

> Vantage v2 Phase 4. Read CLAUDE.md, docs/DATA-QUALITY.md (traps 7, 8, 10, 13, Open questions) and
> docs/ROADMAP.md §Phase 4. Build the companies/aliases/spv_map/managers/tracked tables, seed-entities and
> review-aliases scripts. Investigate N-CEN for manager mapping with real filings and report findings before
> adopting it. Produce the review CSV for the top ~250 and stop for my review.

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

### Ad-hoc research (no building)

> Vantage research only. Do not build. Follow CLAUDE.md's data rules: pull real SEC data, verify against
> raw EDGAR, and report findings, including negative ones, with accessions. Question: <…>
