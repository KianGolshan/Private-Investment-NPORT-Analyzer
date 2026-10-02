# Vantage v2 Status

**Phase:** P6b (analyst workspace) **W2 company workbench built, awaiting sign-off**, on branch `v2-p6b-workspace`.
P6 core, W0 and W1 were signed off by the user on 2026-10-01 (archive).
**Last updated:** 2026-10-01. Earlier results: [archive/STATUS-history.md](archive/STATUS-history.md).

## Phase tracker

- [x] P0–P5b: live fixes, warehouse, refresh, as-of, entities, identity, services, company and fund pages
      (signed off 2026-09-28..30; ROADMAP "Done")
- [x] P6 core: analysis views (signed off 2026-10-01; remaining items in ROADMAP §6)
- [ ] **P6b: analyst workspace**: W0 and W1 signed off 2026-10-01; **W2 built 2026-10-01**; W3–W5 in ROADMAP §6b
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

## P6b W2: the company workbench (2026-10-01)

Built on the W1 routes, every tab asking the server within the scope (`scope.scopeParams`; nothing filters on the
client any more). `web/src/pages/company/` replaces `pages/Company.tsx` (module map in ARCHITECTURE).

- **Header:** status, brands, funds and value now with a sparkline, firms holding, funds ever, the latest
  per-share mark of the three largest classes with its mark date.
- **Overview:** value by firm, fund or class at each quarter or month end (the pivot), funds holding, the slider
  sets the range; a table of each row's start and end value with position and mark effects. Anthropic all funds:
  $0 → $18.16B, of which **+$9.61B mark**, the same as the Anthropic audit's independent decomposition.
- **Holders:** as of any date, grouped by firm or fund, and each fund's change since its own prior filing (Δ shares,
  position Δ, mark Δ; new service `analysis.legsAt`, whose values sum to `exposureAsOf`, tested).
- **Positions:** a fund × mark-month heatmap (value, shares, $/share, Δ value); a cell opens the drawer.
- **Changes:** the bridge as a waterfall and a step table ("reconciles to the cent"), position vs mark effect by
  quarter, and the ledger for the same window (mark dates after `from` through `to`).
- **Marks & classes:** per-firm lines over the low–high band, spreads, gaps within one filing, stale marks, and
  **mark leadership** (new `marks.markLeadership`; checked on real data before it was built: e.g. Anthropic Series
  G $589.01 first filed by Fidelity 2026-05-31, then BlackRock and T. Rowe +30 days, Franklin +61). It always
  compares every firm; each adopter shows its previous mark date (staggered calendars).
- **Filings:** the stored rows as filed (titles, filer ids, units, balance, value, FV level), new `company.filingRows`.
- **Position drawer** (`?pos=<fund>`, a permalink): every leg at every filing, value bars and a split-adjusted
  per-share line (the Databricks 2022 3:1 split no longer reads as a crash), Esc closes.
- **Goldens on screen** (built app, live warehouse): **A1** Anthropic 2026-03-31 = 72 / $5.94B; **F30** Fidelity
  Advisor Growth Opportunities Series D $622.94 (+5.76%); the **Capital Group Stripe path** $33.73 → $35.50 →
  $41.42 → $63.00; **F43** $407.7M + $150.0M added + $212.4M mark = $770.1M. New golden **F49** (leadership: Stripe
  $63.00 first filed by Capital Group and Fidelity on 2026-02-28, T. Rowe +31 days), verified on EDGAR.
- **Found while verifying and fixed:** leadership under a firm filter saw one firm and showed nothing (it now reads
  every firm); the drawer's per-share line was not split-adjusted; drawer rows said "unchanged" where the mark moved.
- **Checks:** no console errors; dark theme; 375 px with no page overflow (tabs and tables scroll in place).
- **Tests:** `npm test` 529 / 498 pass / 0 fail / 31 skipped (new: legs = `exposureAsOf` filtered or not, rows =
  canonical rows and the F43 row, leadership F49); web 18 / 18 (scope → API params); lint, format, typecheck clean.
- **Bench** (warm pass, load 14.5 from other work on the machine): legs 1.5 ms, company pivot 2.4, leadership 66.5,
  rows 86.9 (630 KB for Databricks), history 52.4 p95; all 3,523 requests p95 59.8 ms. Cold first requests over
  150 ms: the firm list and top list (one each, then cached) and Fidelity's firm changes (927 ms, 5.3 MB: W3 pages it).

## Measurements

| Metric                         | Budget | Latest                                                                                    |
| ------------------------------ | ------ | ----------------------------------------------------------------------------------------- |
| Warehouse size                 | ≤1 GB  | **574.7 MB** (2026-10-01; position facts 31 MB; ~25–30 MB per bulk quarter)               |
| Nightly refresh                | ≤5 min | 0.7 min (#18, nothing new; position facts 2.6 s)                                          |
| API p95, all routes (load 1.9) | <200ms | 15.9 ms over 2,803 requests; slowest firm changes (Fidelity) 153 ms, market pivots 42 ms  |
| Suite                          | green  | 526 tests, 495 pass, 0 fail, 31 skipped; web 17 / 17; LIVE 31 / 31; lint and format clean |
| Full backfill / first catch-up | —      | 13.6 min / 26.9 min (P1, P2)                                                              |

Cold first requests are slower (disk); the server warms tracked exposure, the market list, firms, the dashboard and
the position facts at start.

## Warehouse state (refresh #18, 2026-10-01)

Schema at migration 0019. 354,999 N-PORT filings (bulk 2019Q4–2026Q2 + catch-up through filings of 2026-09-30),
1.165M private-candidate rows, 806 companies (304 private), 180 tracked, 529 firms, 18,852 funds, 71,833 unreviewed
entities, 68,285 position-fact legs. `ingest_errors` empty. 2026Q3 bulk not posted yet.

## Open decisions (user)

- **Sign off P6b W2** (open `/company/1-anthropic`, `/company/5-stripe?tab=changes`, any fund row's ⧉). Next: W3,
  firm and fund pages (overview, investment timeline, book matrix, marks vs median, changes, bridge; X-Ray ported).
- **Overrule or keep** two calls made under "v1 is the guidepost": trap 52 (a coded class moved to other keys is one
  position; segregated lines are the class) and dated firm attribution not adopted (0.01% of value).
- **Install the nightly refresh** (launchd entry in ARCHITECTURE §Refresh lifecycle)? Not installed; until then run
  `npm run refresh` at session start. P8's 30-day unattended run cannot start before it.
- Earlier calls still open to overrule: trap 45 (loans filed as OTHER are debt) and the 1 GB budget.
- **PR:** `v2-phase6` and `v2-p6b-workspace` are pushed; no PR opened yet. Open one when you say so.
- **Global git identity** is "Test User <test@test.com>" (`git config --global`); this repo sets its own.

## Known issues

- `test/edge-cases.test.js` "cik/accession are validated…" failed once under heavy load and passed in every rerun
  (timing-sensitive, like the v1 429-retry test).
- Fidelity's opaque per-fund vehicles (~$0.6B) stay on the review list (no filing names their targets).
- `public/splits.js` knows ratios 2–100 from a fixed list; a 60:1 share exchange (Nscale 2026-05-31) reads as a class
  change, not a split.

## Next session

> Resume Vantage v2 on branch `v2-p6b-workspace` (pushed). Read CLAUDE.md, docs/STATUS.md, docs/ROADMAP.md §6b,
> docs/plans/P6b-analyst-workspace.md (W3: firm and fund pages), docs/DATA-QUALITY.md (traps 50–52, display rules)
> and docs/LESSONS.md.
>
> Setup and gates: `npm install`, `npm --prefix web install`, `npm run build:web`, `npm run refresh` (report 2026Q3,
> `ingest_errors`, size vs 1 GB), `npm test` (check the exit code), lint, format, `npm run test:web`. Start the app
> with preview_start (`nport-analyzer`).
>
> If W2 is signed off, start P6b W3 on the W1 routes (`/api/analysis/timeline`, pivot with `firm=`/`fund=`, bridge):
> firm and fund overview, the investment timeline, book matrix, marks vs median, changes (page the raw ledger:
> Fidelity's is 5.3 MB a year), bridge; port Fund X-Ray to the fund page. Exit check: A3 (9 / $8.46B) on screen and
> the timeline equal to `firmChanges`.

## Log

- **2026-10-01 (latest):** W1 signed off. P6b W2 built: the company workbench (six tabs, position drawer), legs,
  rows and mark leadership services; goldens A1, F30, the Stripe path and F43 on screen; F49. Stopped for W2 sign-off.
- **2026-10-01:** P6b W1 built: attribution research (not adopted), position facts (0019), analysis service,
  scope filters, unified search, bench; Databricks, FHU and Ripple audits; traps 51 (across labels) and 52 fixed;
  goldens F43–F48. Stopped for W1 sign-off.
- **2026-10-01:** Anthropic and Canva audits and fixes (traps 50–51); P6b W0; P6 core; post-P5 fixes. Signed off by
  the user (archive).
- **2026-09-30:** Post-P5 review (findings), P5b signed off and merged (PR #4). Earlier: archive.
