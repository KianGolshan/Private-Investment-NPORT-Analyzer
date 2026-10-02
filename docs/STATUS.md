# Vantage v2 Status

**Phase:** P6b (analyst workspace): **W0–W3 signed off 2026-10-01; next W4 (cross-cutting)**, on branch
`v2-p6b-workspace` (pushed). P6 core signed off 2026-10-01. Wave results: [archive](archive/STATUS-history.md).
**Last updated:** 2026-10-01. Earlier results: [archive/STATUS-history.md](archive/STATUS-history.md).

## Phase tracker

- [x] P0–P5b: live fixes, warehouse, refresh, as-of, entities, identity, services, company and fund pages
      (signed off 2026-09-28..30; ROADMAP "Done")
- [x] P6 core: analysis views (signed off 2026-10-01; remaining items in ROADMAP §6)
- [ ] **P6b: analyst workspace**: W0–W3 signed off 2026-10-01; **W4 next**; W5 after (ROADMAP §6b)
- [ ] P7: MCP server (open now; the services exist)
- [ ] P8: operations hardening (nightly job, backups, alerting, doctor)
- [ ] P9: public deployment (hosting to decide as ADR 0006)

## What the app answers now (all from the warehouse, every row with mark date and accession)

| View                         | Where                                                | What                                                                                                                                                       |
| ---------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Issuer: holders as of a date | company page (`/company/<id>`)                       | funds, value, % of fund (conviction), labels, "known as of", no longer reported, $0                                                                        |
| Issuer: activity             | company page → Activity                              | per fund filing: first reported, added, reduced, no longer reported, $0, mark moved (split-adjusted)                                                       |
| Issuer: trend                | company page → Trend                                 | funds and value at every month end; entries, exits, mark-ups/downs per month                                                                               |
| Security: share classes      | company page → Share classes                         | every fund's per-share mark per class, spreads at one date, gaps within a filing, stale marks, history                                                     |
| Fund                         | Fund X-Ray, `/fund/<key>`                            | private book (operating companies, fund interests, vehicles), compare, returns, changes by filing                                                          |
| Manager                      | Firms tab, `/firm/<id>`                              | book as of any date by company and fund, marks per class, 12 months of changes                                                                             |
| Market                       | Market & What's New tab                              | top private companies as of any date, by country, tracked dashboard, feed of new filings                                                                   |
| Bridge (P6b W1)              | `/api/companies/<id>/bridge`, `/api/analysis/bridge` | start + first reported + added − reduced − no longer reported ± mark ± value only ± started/stopped filing = end, to the cent; any firm, fund, class, kind |
| Pivot and timeline (W1)      | `/api/analysis/pivot`, `/api/analysis/timeline`      | firm, fund, company or class × month, quarter or year: value, holders, flows, position and mark effects; a firm's or fund's spans and events per company   |
| Position history (W1)        | `/api/companies/<id>/positions/<fund>`               | one fund's legs at every filing: shares, mark, value, change, effects, re-keys and merged keys                                                             |
| Scope and search (W1)        | every company route; ⌘K                              | `?firm=&fund=&class=&kind=` on every company view; one ranked search over companies, names, firms, funds and classes                                       |
| Exports                      | every view                                           | CSV with mark date, accession and source (XLSX/PDF on the v1 views)                                                                                        |

## Where things stand (2026-10-01, end of session)

P6b W0–W3 are built and **signed off**; the next wave is **W4 (cross-cutting)**. Wave results are in the archive
(verbatim). What exists now, and where:

- **Data layer (W1):** `position_facts` (migration 0019; private companies only, rebuilt by refresh, review import and
  ingest) built from the one activity walk (`activity.walkPosition` → `diffPosition`, `rekeyed`, `movedWithinClass`,
  `leg`). `lib/services/analysis.js`: `bridge`, `pivot`, `timeline`, `positionHistory`, `legsAt`, `marksVsOthers`,
  `allFacts`/`marksByDate` (memoized per refresh). `lib/services/scope.js`: firm/fund/class/kind for rows and legs.
  Unreviewed names and listed stored rows get the same legs on demand (`factsOf` over their rows).
- **Company workbench (W2):** `web/src/pages/company/` (Overview, Holders, Positions, Changes, Marks & classes with mark
  leadership, Filings, `?pos=` drawer). Services `company.filingRows`, `marks.markLeadership`.
- **Firm and fund pages (W3):** `web/src/pages/book/` (BookOverview, Timeline, MarksVsOthers) shared by
  `pages/firm/` and `pages/fund/` (Fund X-Ray, Compare, Returns ported from v1). `ui/BridgeView.tsx` is the one
  bridge view. `firmChanges` is paged.
- **Still on v1 (`/legacy`):** Batch, Watchlist, Private Credit (deferred scope). W4 replaces Batch and Watchlist.

## Handoff: how to work on this project (read before W4)

- **Working with the user.** The user signs off each wave ("sign off", or "continue" = sign-off and build the next).
  Build the whole wave, verify it in the browser on the live warehouse, update docs, commit and push to
  `v2-p6b-workspace`, then stop for sign-off. Recommend, don't survey; decide delegated questions by v1 behavior and
  v2 goals and list the call under Open decisions. No PR, merge to main, launchd job or global config without an
  explicit yes.
- **Real data only.** Check any new metric's definition on real rows _before_ building it (mark leadership and marks
  vs others were prototyped on Anthropic, Stripe, Databricks and Canva first). Every new number shown as a finding
  goes to GOLDEN-NUMBERS after a raw-EDGAR check: `node scripts/verify-edgar.js <cik> <pattern> <accession>…`
  (needs `SEC_USER_AGENT` from `.env`; paced client). Last golden: **F50**.
- **One definition, held equal by tests.** New answers must equal `exposureAsOf` / `companyActivity` / `firmBook`
  where they overlap (see `test/analysis.test.js` for the pattern: real fixture rows, recomputation from stored rows).
  The bridge reconciles to the cent. Pivot value cells equal `exposureAsOf` — W4's exit check.
- **Words as filed:** first reported, added, reduced, no longer reported, reported at $0, mark moved, "held at the first
  stored filing", "first filed" (leadership). Never sale, bought, led. Compare marks only at the same mark date
  (staggered calendars); show "no other fund that date" rather than stretching a rule.
- **Rules that bite (DATA-QUALITY):** trap 50 (one class across EC/EP), 51 (re-keys incl. relabels), 52 (segregated
  lines = one class; guards: 4× mark move, keys present in both filings). A rule that merges identities gets a
  warehouse-wide diff against the previous build before it is kept (LESSONS 36).
- **Frontend patterns:** pages read the scope from the URL (`useScope`, `useParam`) and send it to the server
  (`scopeParams`); never filter on the client. Every chart has a table twin and CSV/XLSX export. Mark dates link
  their accession (`FilingRef`). Build with `npm run build:web` before `preview_start` (`nport-analyzer`, port 3000).
  Check light/dark, 375 px width and the console.
- **Performance:** add every new route to `scripts/bench.js` (p95 < 200 ms; record the load average — this machine
  often runs at load 15–25 from other work). Bound payloads (page large lists; Fidelity is the worst case, firm id 3).
- **Gotchas:** the shell blocks `rm` on a `$VAR` path (use `"${S:?}"` or a literal path); scratch scripts go in the
  session scratchpad; ids worth knowing: companies Anthropic 1, Databricks 2, Stripe 5, Canva 6, FHU 741; firms
  BlackRock 1, Fidelity 3, T. Rowe 8, Capital Group 9; Growth Fund of America `S000009228`, Contrafund `S000006037`.
- **W4 scope** (ROADMAP §6b, plan doc): Explore pivot (`/explore`: rows × periods, every metric, drill from a cell
  to its events — the pivot API exists; a drill route listing the legs behind a cell is the missing piece), Market
  (movers: largest mark moves and net position flows in a range; newly reported companies), Activity with the scope,
  Tracked & Watchlist (server-backed list; localStorage first per the plan), Compare (2–5 companies, firms or
  classes overlaid; replaces Batch).

## Measurements

| Metric                         | Budget | Latest                                                                                         |
| ------------------------------ | ------ | ---------------------------------------------------------------------------------------------- |
| Warehouse size                 | ≤1 GB  | **574.7 MB** (2026-10-01; position facts 31 MB; ~25–30 MB per bulk quarter)                    |
| Nightly refresh                | ≤5 min | 0.7 min (#18, nothing new; position facts 2.6 s)                                               |
| API p95, all routes (load 1.9) | <200ms | 15.9 ms over 2,803 requests; slowest firm changes (Fidelity) 153 ms, market pivots 42 ms       |
| Suite                          | green  | 531 tests, 500 pass, 0 fail, 31 skipped; web 18 / 18; LIVE 31 / 31 (W1); lint and format clean |
| Full backfill / first catch-up | —      | 13.6 min / 26.9 min (P1, P2)                                                                   |

Cold first requests are slower (disk); the server warms tracked exposure, the market list, firms, the dashboard and
the position facts at start.

## Warehouse state (refresh #18, 2026-10-01)

Schema at migration 0019. 354,999 N-PORT filings (bulk 2019Q4–2026Q2 + catch-up through filings of 2026-09-30),
1.165M private-candidate rows, 806 companies (304 private), 180 tracked, 529 firms, 18,852 funds, 71,833 unreviewed
entities, 68,285 position-fact legs. `ingest_errors` empty. 2026Q3 bulk not posted yet.

## Open decisions (user)

- **W4 next** (no decision pending to start it). The warm-up flake task (chip "Stop server warm-up from blocking past
  keep-alive") can run in parallel.
- **Overrule or keep** two calls made under "v1 is the guidepost": trap 52 (a coded class moved to other keys is one
  position; segregated lines are the class) and dated firm attribution not adopted (0.01% of value).
- **Install the nightly refresh** (launchd entry in ARCHITECTURE §Refresh lifecycle)? Not installed; until then run
  `npm run refresh` at session start. P8's 30-day unattended run cannot start before it.
- Earlier calls still open to overrule: trap 45 (loans filed as OTHER are debt) and the 1 GB budget.
- **PR:** `v2-phase6` and `v2-p6b-workspace` are pushed; no PR opened yet. Open one when you say so.
- **Global git identity** is "Test User <test@test.com>" (`git config --global`); this repo sets its own.

## Known issues

- `test/prod-startup.test.js` "behind a proxy" failed with ECONNRESET in 2 of 3 full runs at load average 16–20
  (passes alone, passed at the W2 commit once). Likely the start-up warm-up blocking the event loop past the 5 s
  keep-alive timeout (the dashboard step, ~4.5 s cold). Flagged as its own task; not changed in W3.
- `test/analysis.test.js` unified search failed once in a parallel run and never in 12 reruns (not reproduced).
- `test/edge-cases.test.js` "cik/accession are validated…" failed once under heavy load and passed in every rerun
  (timing-sensitive, like the v1 429-retry test).
- Fidelity's opaque per-fund vehicles (~$0.6B) stay on the review list (no filing names their targets).
- `public/splits.js` knows ratios 2–100 from a fixed list; a 60:1 share exchange (Nscale 2026-05-31) reads as a class
  change, not a split.

## Next session

> Resume Vantage v2 on branch `v2-p6b-workspace` (pushed). P6b W0–W3 are signed off; build **W4 (cross-cutting)**.
> Read CLAUDE.md, then docs/STATUS.md in full ("Where things stand" and "Handoff" first), docs/ROADMAP.md §6b,
> docs/plans/P6b-analyst-workspace.md (Explore pivot, Market, Activity, Tracked & Watchlist, Compare),
> docs/DATA-QUALITY.md (traps 50–52 and the display rules: bridge, scope, mark leadership, marks vs others, timeline)
> and docs/LESSONS.md.
>
> Setup and gates first, stop and report if any fail: `npm install`, `npm --prefix web install`, `npm run build:web`,
> `npm run refresh` (report 2026Q3 bulk, `ingest_errors`, size vs 1 GB), `npm test` (check the exit code; two known
> flakes are in Known issues), `npm run lint`, `npm run format:check`, `npm run test:web`, `npm run lint:web`, and the
> full `npm run test:live`.
>
> W4, in order: (1) Explore pivot at `/explore` on `/api/analysis/pivot` (rows firm, fund, company or class × month,
> quarter or year; every metric; heatmap + table; saved views in the URL) with a drill from any cell to the events
> and legs behind it (new route; test that a drill's legs sum to the cell). (2) Market: movers (largest mark moves and
> net position flows over a range) and newly reported companies, each checked on real data before it is built.
> (3) Activity with the scope. (4) Tracked & Watchlist. (5) Compare: 2–5 companies, firms or classes overlaid,
> replacing v1's Batch. Exit check: pivot cells equal `exposureAsOf`; a drill lands on the right events. Verify new
> numbers with `node scripts/verify-edgar.js` and add them to GOLDEN-NUMBERS (next is F51). Walk it in the browser
> (light, dark, 375 px), bench every new route, update STATUS/ROADMAP/ARCHITECTURE, commit and push, and stop for W4
> sign-off.

## Log

- **2026-10-01 (end):** W3 signed off by the user. Handoff written (STATUS "Handoff"); `scripts/verify-edgar.js`
  added for raw-EDGAR checks.
- **2026-10-01:** W2 signed off. P6b W3 built: firm and fund pages (overview + bridge, timeline, book matrix,
  marks vs others, paged changes; Fund X-Ray, compare, returns ported); golden F50. Stopped for W3 sign-off.
- **2026-10-01:** W1 signed off. P6b W2 built: the company workbench (six tabs, position drawer), legs,
  rows and mark leadership services; goldens A1, F30, the Stripe path and F43 on screen; F49. Stopped for W2 sign-off.
- **2026-10-01:** P6b W1 built: attribution research (not adopted), position facts (0019), analysis service,
  scope filters, unified search, bench; Databricks, FHU and Ripple audits; traps 51 (across labels) and 52 fixed;
  goldens F43–F48. Stopped for W1 sign-off.
- **2026-10-01:** Anthropic and Canva audits and fixes (traps 50–51); P6b W0; P6 core; post-P5 fixes. Signed off by
  the user (archive).
- **2026-09-30:** Post-P5 review (findings), P5b signed off and merged (PR #4). Earlier: archive.
