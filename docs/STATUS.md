# Vantage v2 Status

**Phase:** P6b (analyst workspace) **W3 firm and fund pages built, awaiting sign-off**, on branch `v2-p6b-workspace`.
P6 core, W0, W1 and W2 were signed off by the user on 2026-10-01 (archive).
**Last updated:** 2026-10-01. Earlier results: [archive/STATUS-history.md](archive/STATUS-history.md).

## Phase tracker

- [x] P0–P5b: live fixes, warehouse, refresh, as-of, entities, identity, services, company and fund pages
      (signed off 2026-09-28..30; ROADMAP "Done")
- [x] P6 core: analysis views (signed off 2026-10-01; remaining items in ROADMAP §6)
- [ ] **P6b: analyst workspace**: W0–W2 signed off 2026-10-01; **W3 built 2026-10-01**; W4–W5 in ROADMAP §6b
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

## P6b W3: firm and fund pages (2026-10-01)

Shared pieces in `web/src/pages/book/` (module map in ARCHITECTURE); `pages/firm/` and `pages/fund/` replace the W0
pages. W2 was signed off ("continue").

- **Firm page:** Overview (the private book by company at each quarter or month end, companies and funds holding, the
  bridge for the range, position vs mark effect by quarter, a by-company table) · **Timeline** (a bar per company
  while any fund holds it, marks for first reported, added, reduced, no longer reported, $0; sort by first held or
  value) · **Book** (by company, by fund, a company × fund matrix) · **Marks vs others** · **Changes** (paged).
- **Fund page:** the same Overview, Timeline and Marks at fund scope, plus **Fund X-Ray ported from v1**: the private
  book at any filing (by kind, "private by", rows not private and why, debt beside equity, by country), **Compare**
  (prior filing or a year earlier, ±45 days, v1's rule) and **Returns** (mark-implied MOIC and IRR with v1's caveat;
  wording now "reduced" and "left the private book", never "sale"), plus changes and filings.
- **New services:** `analysis.marksVsOthers` (each class against other funds' median at the same mark date, from the
  facts; a test recomputes every row from stored rows) and paging for `firmChanges` (Fidelity's year: 4,093 events,
  5.3 MB → 649 KB per 500-event page, counts and totals over all; pages reassemble the full list, tested).
- **On screen (built app, live warehouse):**
  - **A3:** Capital Group book as of 2026-06-30: Anthropic 9 funds / $8.46B.
  - The timeline matches `firmChanges` (W1 test).
  - Fidelity's marks against others: 460 classes priced, 123 comparable at the same mark date (26 above, 42 within 0.5%,
    55 below). Canva CL A $1,270.63 vs $1,496.42–$1,646.14 agrees with F42.
  - GFA Compare (2026-05-31 vs 2026-02-28) shows Stripe CL B +2,380,952 sh, +$150.0M (F43).
  - Contrafund X-Ray agrees with F42 and F50.
- **New golden F50** (verified on EDGAR): Stripe Series I at 2026-06-30 is $51.00 at Morgan Stanley's Growth Portfolio
  against $63.00 at Fidelity and Capital Group and $63.43 at Franklin, as filed.
- **Found and fixed:** the timeline called a holding in a fund's first stored filing "first reported" (it now reads
  "held at the first stored filing"); changing the change type kept the old page.
- **Tests:** `npm test` 531 / 500 pass / 0 fail / 31 skipped (one run of three at load 16–20 had the flake below);
  web 18 / 18; lint, format and typecheck clean. **Bench** (load 26): firm marks 11.4 ms, fund marks 6, fund timeline
  10.6, firm changes page 9.4 p95; all 3,587 requests p95 26.4 ms.

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

- **Sign off P6b W3** (open `/firm/9`, `/firm/3?tab=marks`, `/fund/S000009228?tab=compare`). Next: W4, Explore pivot,
  Market movers and newly reported, Activity, Tracked & Watchlist, Compare.
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

> Resume Vantage v2 on branch `v2-p6b-workspace` (pushed). Read CLAUDE.md, docs/STATUS.md, docs/ROADMAP.md §6b,
> docs/plans/P6b-analyst-workspace.md (W4: cross-cutting), docs/DATA-QUALITY.md (traps 50–52, display rules) and
> docs/LESSONS.md.
>
> Setup and gates: `npm install`, `npm --prefix web install`, `npm run build:web`, `npm run refresh` (report 2026Q3,
> `ingest_errors`, size vs 1 GB), `npm test` (check the exit code), lint, format, `npm run test:web`. Start the app
> with preview_start (`nport-analyzer`).
>
> If W3 is signed off, start P6b W4: the Explore pivot (`/api/analysis/pivot`: rows firm/fund/company/class ×
> periods, every metric, a drill from any cell to its events), Market (movers: largest mark moves and net flows in a
> range; newly reported companies), Activity with the scope, Tracked & Watchlist (server-backed list), Compare (2–5
> companies, firms or classes). Exit check: pivot cells equal `exposureAsOf`, a drill lands on the right events.

## Log

- **2026-10-01 (latest):** W2 signed off. P6b W3 built: firm and fund pages (overview + bridge, timeline, book matrix,
  marks vs others, paged changes; Fund X-Ray, compare, returns ported); golden F50. Stopped for W3 sign-off.
- **2026-10-01:** W1 signed off. P6b W2 built: the company workbench (six tabs, position drawer), legs,
  rows and mark leadership services; goldens A1, F30, the Stripe path and F43 on screen; F49. Stopped for W2 sign-off.
- **2026-10-01:** P6b W1 built: attribution research (not adopted), position facts (0019), analysis service,
  scope filters, unified search, bench; Databricks, FHU and Ripple audits; traps 51 (across labels) and 52 fixed;
  goldens F43–F48. Stopped for W1 sign-off.
- **2026-10-01:** Anthropic and Canva audits and fixes (traps 50–51); P6b W0; P6 core; post-P5 fixes. Signed off by
  the user (archive).
- **2026-09-30:** Post-P5 review (findings), P5b signed off and merged (PR #4). Earlier: archive.
