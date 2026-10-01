# Vantage v2 Status

**Phase:** P6b (analyst workspace) **W1 data layer built, awaiting sign-off**, on branch `v2-p6b-workspace`. P6 core
and P6b W0 (with the audit fixes) were signed off by the user on 2026-10-01.
**Last updated:** 2026-10-01. Earlier results: [archive/STATUS-history.md](archive/STATUS-history.md).

## Phase tracker

- [x] P0–P5b: live fixes, warehouse, refresh, as-of, entities, identity, services, company and fund pages
      (signed off 2026-09-28..30; ROADMAP "Done")
- [x] P6 core: analysis views (signed off 2026-10-01; remaining items in ROADMAP §6)
- [ ] **P6b: analyst workspace**: W0 signed off 2026-10-01; **W1 built 2026-10-01**; W2–W5 in ROADMAP §6b
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

## P6b W1: the data layer (2026-10-01)

Setup gates at session start, all green: refresh #16 (no 2026Q3 bulk yet, 0 new filings, `ingest_errors` 0, 544.0
MB); `npm test` 505 / 474 pass / 0 fail / 31 skipped (exit 0); lint, format, `test:web` 15 / 15; LIVE 31 / 31.

1. **Dated firm attribution (research): not adopted.** Matching every N-CEN, 1,476 funds show a different adviser
   set over time; 119 of them hold private companies. Real firm-to-firm changes (Altegris → iCapital, Pioneer → Amundi
   → Victory, Credit Suisse → UBS, MML → Barings → Cliffwater, Eaton Vance → Morgan Stanley) touch **16 filings,
   $0.05B of $640.6B** of private-company value filed since 2019 (0.01%); counting retired adviser entities not in
   `managers.csv` too, 121 filings, $0.28B (0.04%). Firms stay the current adviser, and the answers say so
   (`attribution: 'current adviser (latest N-CEN)'`; DATA-QUALITY display rules).
2. **`position_facts` (migration 0019), measured before it was written:**
   - private companies only: 66,825 rows → **68,285 legs, 31 MB, built in 2.6–3.8 s** (load 1.5–2); warehouse **574.7
     MB** of 1 GB.
   - every subject (unreviewed names and listed companies' stored rows too) would be 1.05M legs and **497 MB** (over
     budget), so those subjects get the same legs on demand from their own rows (`factsOf`).
   - Built only from the activity walk: `companyActivity`'s per-fund loop is now `activity.walkPosition`, and the
     builder runs it with `diffPosition`, `rekeyed` and `leg`. Unchanged legs and exit legs are kept, with each
     fund's next filing date, so the as-of rule reads straight off the table.
   - Rebuilt by refresh (after the fund names), by the review import and by both ingest scripts; logged to `ingest_log`
     (`position-facts`); a failed build rolls back (tested).
   - Found by the table's primary key: lots of one instrument were separate legs in "first reported", "no longer
     reported", "$0" and first-filing events (sums were right). Every branch now merges lots.
3. **`lib/services/analysis.js`:** `bridge`, `pivot` (firm, fund, company or class × month, quarter or year: value
   and holders at each period end, every flow, position and mark effect), `timeline` (firm or fund: spans held, value
   now, events by mark date), `positionHistory`; **scope filters** (`lib/services/scope.js`: firm, fund, class, kind)
   on every company route; **unified search** (`/api/search?kinds=…`: companies, unreviewed names, firms, funds and
   share classes; "anthropic series g" opens the class, "fidelity" the firm); ⌘K makes one call. Routes in
   ARCHITECTURE.
4. **Tests and equality on the real warehouse:**
   - All **304 private companies × 28 quarter windows (8,512 bridges)**: start and end equal `exposureSeries` in funds
     and value, worst residual **$0.000003**; the table's legs equal an on-the-fly walk of each company's rows, leg for
     leg; every `companyActivity` event equals its legs (type, value change, position, mark).
   - Firm pivot = `firms()` in all 1,710 firm × quarter cells (2024Q1–2026Q2); company pivot in a firm = `firmBook`.
   - Offline: `test/analysis.test.js` (18) and 3 new trap tests in `test/activity-rekey.test.js`; the timeline's
     events equal `firmChanges` by type; filtered exposure, activity, trend and classes equal post-filters.
   - **Bench** (`npm run bench`, now with every P6 and W1 route, the 12 largest firms with Fidelity first; load 1.9):
     every route's p95 under 200 ms. Warm: bridge 0.5, bridge `?kind` 13.1, positions 0.7, firm bridge 10.5, firm
     timeline 20.8, firm pivot 15.1, market pivots 41.9, unified search 39, exposure `?firm` 6.6, activity `?firm` 9.4,
     firm changes 153.3 (Fidelity) ms; all 2,803 requests p95 15.9 ms.
5. **Audits (warehouse vs API vs UI vs raw EDGAR, independent SQL as-of at every quarter end):**
   - **Databricks** (4,035 rows, 135 funds, 2019-10-31 → 2026-07-31): as-of equal at all 27 quarter ends (e.g. 120 /
     $6.2325B at 2026-06-30); 1,508 events sum exactly; splits (2022 3:1) and re-keys handled; no stale marks.
     **Found and fixed:**
     - Trap 52: Fidelity moved Series G–L into "PC PP-SEGREGATED LINE" rows (2026-05-31, three funds; Stripe too). Same
       shares, mark $179.70 → $190.00, but it read "added and reduced across classes" with the mark move booked as
       position. Now a class whose keys change is measured per class (F44: Select Technology +$5,080,773.70, all
       mark). Guards found by diffing the facts warehouse-wide: a 60:1 Nscale share exchange (would have moved $1.35B)
       and a Redwood key relabeled Series C → D stay per key. Net effect: 68 events in 20 companies, at most $3.1M
       each.
     - Trap 51 across labels: Coatue's 433,333 units moved through three ids and labels (F45); The Pre-IPO and Growth
       Fund's LP interest likewise. Now one continuing position.
     - Verified F46: T. Rowe Blue Chip Growth +$111,484,910 mark (largest), VY T. Rowe Diversified Mid Cap Growth
       $10,660,162.50 no longer reported (largest exit).
   - **FHU US Holdings / Chobani** (SPV-heavy: 35 of 44 rows through Fidelity's per-fund LLCs): as-of equal at every
     quarter end since 2025-10-31 (13 / $359.0M at 2026-06-30). Marks move opposite ways by firm: AMCAP −7.7%,
     Contrafund +6.0% (F47). T. Rowe Large-Cap Growth is stale at $4,456.35 since 2025-12-31. Nothing to fix.
   - **Ripple Labs** (unreviewed name, 6 funds since 2020): as-of equal at all 26 quarter ends with holdings; no
     look-alikes. On 2026-06-30 one class (common) is marked $300.00 / $131.37 / $105.51 by three filers (F48).
     Known edge, left as is: a 2021 Common → Preferred flip of the same 42,000 sh with a −40% value change reads as
     position −$0.91M, because pairing across classes on share count alone is too weak.
   - In the browser (built app): ⌘K "anthropic series g" → the class as best match → Holders filtered to 35 funds /
     $899.1M; Databricks › Changes › Select Technology shows 2026-05-31 "mark moved, shares unchanged, $179.70 →
     $190.00", position $0. No console errors.
6. **Goldens:** F43 (the Growth Fund of America Stripe bridge, the W1 decomposition: +$212,419,557.74 mark,
   +$149,999,976 added, to the cent) and F44–F48, all verified on raw EDGAR.

**Not done in W1 (by design or deferred):** `companyCube` (W2 decides with the workbench whether the browser needs it);
firm changes since 2019 compute in 0.35–0.8 s but are **15.6 MB** for Fidelity, so the facts-backed timeline and pivot
answer that question (20 ms, 124 KB) and W3 pages the raw ledger; the W0 company page still filters on the client and
its Overview ignores a class filter (W2 switches it to the server scope).

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

- **Sign off P6b W1** (data layer). Next: W2, the company workbench on these routes.
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
> docs/plans/P6b-analyst-workspace.md (W2), docs/DATA-QUALITY.md (traps 50–52, display rules: bridge, scope, firms)
> and docs/LESSONS.md.
>
> Setup and gates: `npm install`, `npm --prefix web install`, `npm run build:web`, `npm run refresh` (report 2026Q3,
> `ingest_errors`, size vs 1 GB), `npm test` (check the exit code), lint, format, `npm run test:web`. Start the app
> with preview_start (`nport-analyzer`).
>
> If W1 is signed off, start P6b W2 (the company workbench): overview, holders, positions grid, changes + bridge, marks
> & classes + mark leadership, filings, position drawer, all on the W1 routes with the server-side scope (the W0 page
> filters on the client and its Overview ignores a class). Exit check on screen: A1, F30, the Capital Group Stripe
> path and F43.

## Log

- **2026-10-01 (latest):** P6b W1 built: attribution research (not adopted), position facts (0019), analysis service,
  scope filters, unified search, bench; Databricks, FHU and Ripple audits; traps 51 (across labels) and 52 fixed;
  goldens F43–F48. Stopped for W1 sign-off.
- **2026-10-01:** Anthropic and Canva audits and fixes (traps 50–51); P6b W0; P6 core; post-P5 fixes. Signed off by
  the user (archive).
- **2026-09-30:** Post-P5 review (findings), P5b signed off and merged (PR #4). Earlier: archive.
