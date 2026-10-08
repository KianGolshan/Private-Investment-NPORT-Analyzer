# Session Prompts

Paste one at the start of a session. Prompts for finished phases are in
[archive/SESSION-PROMPTS-done.md](archive/SESSION-PROMPTS-done.md).

**Every prompt implies:** follow `CLAUDE.md` (every warehouse write is a job, ADR 0009); work on a branch; check
`npm test`'s exit code, not a pipe's; run `npm run build:web` then `npm run test:e2e` when the workspace changes; stop
at the checkpoint for sign-off; update `docs/STATUS.md` before ending.

### Resume (any phase)

> Resume Vantage v2. Read CLAUDE.md, docs/STATUS.md and the current phase in docs/ROADMAP.md. Run `npm run refresh`
> and report what it loaded. Summarize where we are and the open decisions, then continue. Do not start the next phase
> without my sign-off.

### Phase 6: remaining views

> Resume Vantage v2 Phase 6 on a new branch off `main`. Read CLAUDE.md, docs/STATUS.md, docs/ROADMAP.md §6, docs/DATA-QUALITY.md
> and docs/LESSONS.md. `npm run refresh` first; npm test (exit code), lint, format, `npm run test:live`. Then the
> "Remaining" items in order, each checked on real filings first, each view's numbers held equal to exposureAsOf where
> they overlap (LESSONS 32), new numbers verified on raw EDGAR into GOLDEN-NUMBERS. Measure p95 and the worst case.
> Stop for sign-off.

### Phase 7: MCP server

> Vantage v2 Phase 7. Read CLAUDE.md, docs/STATUS.md, ADR 0008, ADR 0009 and docs/ROADMAP.md §Phase 7. Build mcp-server.js
> (stdio) over lib/services and lib/analytics (search, company exposure/history/activity/classes, fund, firm, market,
> feed), opening the warehouse with openWarehouseReadOnly. Tools take an id or a name and return ids, mark dates and
> accessions. Answers carry the generation they were read from (`db.generationOf`) and the basis (today's curation),
> and the server reopens on a new generation like the web router. Tests return golden numbers. Document
> `claude mcp add` in README.

### Phase 8: operations (resume after the 2026-10-08 pause)

> Vantage v2 Phase 8, resumed on a new branch off `main` (W1–W3 signed off and merged). Read CLAUDE.md, docs/STATUS.md
> ("Decisions waiting on the user" and "Deferred") and docs/ROADMAP.md §Phase 8. Get my answers to the open
> decisions first (refresh, launchd, backup location). Then take the P8 items under
> "Deferred" in the order I choose; W4 research checks real filings before building anything. Install launchd jobs
> only with my explicit yes.

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
> - backups of the published generations (ADR 0009) with a restore drill
> - Cache-Control plus CDN
> - secrets in the host's store
> - CI deploy
>
> Run the Phase 9 tests (restore drill, zero SEC calls under load, golden numbers on staging). Stop for my
> sign-off before production, the custom domain, or anything public.

### Ad-hoc research (no building)

> Vantage research only. Do not build. Follow CLAUDE.md's data rules: pull real SEC data, verify against
> raw EDGAR, and report findings, including negative ones, with accessions. Question: <…>
