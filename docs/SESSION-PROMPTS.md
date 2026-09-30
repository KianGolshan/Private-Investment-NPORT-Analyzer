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

### Next session: Phase 4.5, then Phase 5 (written 2026-09-29)

> Resume Vantage v2 at Phase 4.5 (evidence-based company identity + unresolved-value report). Start
> Phase 5 only after my sign-off on P4.5.
>
> **State.**
>
> - Branch `v2-plan-and-phase0`, pushed; no PR; not merged to main. P0–P4 are complete.
> - The P4 entity lists are finalized (`data/review/curation.json`) and imported into `warehouse.db`:
>   - 739 companies (257 private, 482 public), 178 tracked, 2,173 aliases, 529 firms
>   - 305,914 holdings rows resolved; unresolved tracked exposure 0.46%
> - `warehouse.db` (git-ignored) is 472 MB of a 500 MB budget, migrations through 0010.
> - The app still runs on live EDGAR (v1 + P0 fixes); Phase 5 moves it onto the warehouse.
> - **Why P4.5 exists:** FHU US Holdings (Chobani) — 13 funds, ~$359M at 2026-06-30 (GOLDEN F29) — is in no
>   company group. Fidelity holds it through per-fund LLCs ("BCGF FHUS HOLDINGS LLC", "CONTSA FHUS…"),
>   Capital Group writes "FHU US HOLDINGS LLC", and only T. Rowe's title says "dba Chobani" (with issuer
>   LEI 549300ISVDMZ91KNTR38). The name cleaner saw 11 fragments, none held by 3 funds. Fidelity's per-fund
>   LLCs hold ~$0.7B across ~12 targets, all unresolved (traps 31–33).
>
> **Read first, in order:**
>
> 1. CLAUDE.md
> 2. docs/STATUS.md (Phase 4 results, Open decisions, Warehouse state)
> 3. docs/LESSONS.md (all 23)
> 4. docs/ROADMAP.md §Phase 4.5, §Phase 5, and the P6/P8 additions (class mark comparison, entity editing,
>    watch reports)
> 5. docs/DATA-QUALITY.md, all traps (1–34)
> 6. docs/GOLDEN-NUMBERS.md
> 7. ADRs 0003, 0004, 0007; docs/ARCHITECTURE.md
> 8. lib/entities/{seed,resolve,review,managers,upkeep}.js and data/review/curation.json
>
> **Step 0: refresh and health check.**
>
> - Run `npm run refresh` in the foreground and report what it loaded. The 2026Q3 bulk file may be posted:
>   refresh loads it, adds 2026q3 listing evidence, re-keys funds, and re-resolves.
> - Confirm `ingest_errors` is empty and the run is `ok`, and check `du -h warehouse.db` against the budget.
> - Run `npm test`, `npm run lint`, `npm run format:check` and
>   `LIVE_SEC=1 node --test --test-name-pattern="LIVE: (as-of golden|reviewed entities)" test/live-warehouse.test.js`.
> - Expected goldens:
>   - by pattern: A1 72/$5.93B, A2 117/$17.26B, A5 49/35/34/37, A6 120/$6.22B;
>   - by company: Anthropic 117/$17.26B at 6/30; Stripe 35/$1.31B at 12/31/25; Databricks 120/$6.23B at
>     6/30 (F25).
>     Verify any move on EDGAR; never tune code.
>
> **Phase 4.5 tasks (ROADMAP §Phase 4.5).**
>
> - **Identity graph** (`lib/entities/identity.js`). Nodes are raw names and issuer keys. Edges need filing
>   evidence and carry their kind, accession and confidence:
>   1. same issuer LEI;
>   2. same fund keeping the same filer instrument id, or the same share count in the same class, across a
>      name change;
>   3. same filing, same per-unit mark on the same date (Project Debussy);
>   4. titles naming the company, including "dba"/"formerly";
>   5. normalized names, including stripped per-fund prefixes and spacing variants.
>      Companies are the connected components. Guardrails: no edges from generic ids ("SEDOL", "Internal
>      identifier") or merger chains (Windstream → Uniti); flag components that join two LEIs, a listed and a
>      private company, or two curated companies.
> - Apply the ≥3 funds / ≥$25M candidate rule after linking.
> - **Vehicles** are their own type: link as indirect (`via_spv`) only with name or filing evidence;
>   opaque ones go to the review list by dollar size.
> - **Brand aliases:** company = the issuer invested in; brands ("Chobani") are aliases.
> - **`npm run entities:report`:** unresolved private-candidate value across all holdings, ranked by dollars,
>   plus conflicts and opaque vehicles. It becomes the review queue after every refresh.
> - Re-seed with the graph (it must keep honoring `curation.json`). Finalize with filing evidence yourself —
>   FHU US Holdings / Chobani and the Fidelity vehicles first — record decisions in `curation.json`, then
>   run `npm run review:aliases` and re-measure. Verify new numbers on EDGAR and add them to GOLDEN-NUMBERS.
> - Tests (real data): the ROADMAP §Phase 4.5 list — FHU as one company with alias Chobani (13 funds at
>   6/30); the LEI edge; the Project Debussy, Oura and Anduril edges; guardrails (Windstream/Uniti,
>   OpenAir/OpenAI, a forced conflict); every P4 test and golden still holds.
> - Success: no unresolved component above the proposed $50M (confirm the threshold with me) that is not an
>   opaque vehicle on the review list; tracked unresolved under 1%; every edge and decision cites an
>   accession. Stop for my P4.5 sign-off.
>
> **Then Phase 5 (after sign-off), per ROADMAP §Phase 5:**
>
> - `lib/services/*`, with routes answering from the warehouse and a labeled EDGAR fallback.
> - **Search over every issuer** through the graph: forgiving match, candidates with evidence, and a "make
>   this a company" action. "Chobani", "FHU", "FHUS" and "Open AI" must work; OpenAir stays separate.
> - Fund X-Ray: "private" = company status.
> - Batch or cache the per-fund lookups (176–454 ms cold today) toward p95 < 200 ms.
> - Parity: existing tests pass (fixtures only change), identical exports.
> - New history tests: Anthropic from 2023-04-28, Stripe from 2019-12-31, Databricks from 2019-10-31.
>
> Keep P6 items (class mark comparison, entity editing in the app) and P8 items (nightly watch reports)
> for their phases.
>
> **My requirements.**
>
> - v1 is the guidepost: same screens, complete and correct answers.
> - Off-list companies stay fully analyzable.
> - Always show mark dates and accessions.
> - Label via_spv value "indirect".
> - Show `disclosed_exposure` as the filing's words.
> - Show exits as "no longer reported".
> - Show per-class marks, but never label a valuation method (F30).
> - Finalize curation yourself with evidence; don't park it for me.
>
> **Settled decisions (don't reopen):**
>
> - Row rule: equity-type means `instrument_type` other than debt; value > 0; NULL balance counts.
> - `instrument: 'debt'` throws.
> - Canonical filing: the latest filing date wins; same-day tie goes to NPORT-P/A, then the higher accession.
> - Inactive after 123 days; `knownAsOf` = filings made by that date.
> - fund_key rules as built.
> - Managers from N-CEN by SEC file number; firm = the brand in the adviser's name, no ownership assumed.
> - Status: curated evidence, then lock-up/PIPE, then listing evidence (best of 4 quarters), then Level-3
>   share.
> - Merges only on filer evidence, recorded in `curation.json`.
> - Fundrise is a disclosed range.
>
> **Open decisions (ask me):**
>
> - the P4.5 $50M threshold;
> - named tracked lists vs. one;
> - alerts on new marks;
> - the nightly launchd job;
> - a PR or merge to main.
>
> **How we work.**
>
> - Real SEC data only; verify on raw EDGAR and add to GOLDEN-NUMBERS with accessions. SpaceX is public.
> - Foreground batches under 10 minutes with a one-line status; no orphan loops.
> - Never edit an applied migration; edit scripts read before writing; zsh doesn't word-split unquoted
>   variables; SEC dates DD-MON-YYYY (`bulkDateToIso`); every SEC call through `fetchWithRetry`.
> - `seed:entities` needs `--force`. Watch the 500 MB budget.
> - Test hand-written search patterns against the raw strings before trusting a total (lesson 23).
> - If the auto-mode classifier fails twice in a row, stop and report the resume point.
>
> **Gates.** Stop for my sign-off at the P4.5 and P5 checkpoints. Don't push, open a PR, or install launchd
> without my explicit yes. Finish each phase with the suite, lint and format green; docs updated (STATUS,
> ROADMAP, GOLDEN-NUMBERS, DATA-QUALITY, LESSONS, ARCHITECTURE as needed); and a commit.

### Next session: Phase 5 (written 2026-09-30, after P4.5 sign-off)

> Resume Vantage v2 at Phase 5 (service layer, parity, search over every issuer). P0–P4.5 are complete
> (P4.5 built 2026-09-30; confirm the user signed it off). Read CLAUDE.md, docs/STATUS.md (Phase 4.5
> results, Open decisions), docs/LESSONS.md (all 27), docs/ROADMAP.md §Phase 5 and the P6/P8 items,
> docs/DATA-QUALITY.md (traps 1–39), docs/GOLDEN-NUMBERS.md (F29–F33), docs/ARCHITECTURE.md §Company identity.
>
> Step 0: `npm run refresh` in the foreground (it loads 2026Q3 bulk if posted and rewrites the review queue
> in reports/entities/); check `ingest_errors`, the size budget (513 MB after P4.5: ask the user before it
> grows), and that the queue shows nothing over the threshold (>= $50M, 2+ funds) except the 3 opaque Fidelity
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
