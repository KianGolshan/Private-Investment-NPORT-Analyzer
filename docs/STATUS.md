# Vantage v2 Status

**Phase:** P6b (analyst workspace) **W0 foundations built, awaiting sign-off**, on branch `v2-p6b-workspace` (from
`v2-phase6`, whose P6 core also awaits sign-off).
**Last updated:** 2026-10-01. Earlier phases' results: [archive/STATUS-history.md](archive/STATUS-history.md).

## Phase tracker

- [x] P0–P5b: live fixes, warehouse, refresh, as-of, entities, identity, services, company and fund pages
      (signed off 2026-09-28..30; ROADMAP "Done")
- [ ] **P6: analysis views** (core built 2026-10-01; remaining items in ROADMAP §6)
- [ ] **P6b: analyst workspace** (plan approved 2026-10-01; W0 built; W1–W5 in ROADMAP §6b)
- [ ] P7: MCP server (open now; the services exist)
- [ ] P8: operations hardening (nightly job, backups, alerting, doctor)
- [ ] P9: public deployment (hosting to decide as ADR 0006)

## What the app answers now (all from the warehouse, every row with mark date and accession)

| View                         | Where                          | What                                                                                                   |
| ---------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Issuer: holders as of a date | company page (`/company/<id>`) | funds, value, % of fund (conviction), labels, "known as of", no longer reported, $0                    |
| Issuer: activity             | company page → Activity        | per fund filing: first reported, added, reduced, no longer reported, $0, mark moved (split-adjusted)   |
| Issuer: trend                | company page → Trend           | funds and value at every month end; entries, exits, mark-ups/downs per month                           |
| Security: share classes      | company page → Share classes   | every fund's per-share mark per class, spreads at one date, gaps within a filing, stale marks, history |
| Fund                         | Fund X-Ray, `/fund/<key>`      | private book (operating companies, fund interests, vehicles), compare, returns, changes by filing      |
| Manager                      | Firms tab, `/firm/<id>`        | book as of any date by company and fund, marks per class, 12 months of changes                         |
| Market                       | Market & What's New tab        | top private companies as of any date, by country, tracked dashboard, feed of new filings               |
| Exports                      | every view                     | CSV with mark date, accession and source (XLSX/PDF on the v1 views)                                    |

## P6b W0: the analyst workspace foundations (2026-10-01)

- **Plan approved by the user:** [plans/P6b-analyst-workspace.md](plans/P6b-analyst-workspace.md) (ROADMAP §6b).
  Decisions: Vite + Preact + TS, v1 under `/legacy`, power analyst first.
- **Built:**
  - `web/` (module map in ARCHITECTURE) with design tokens (light, dark, compact) and a shell with sidebar, top bar,
    freshness and a mobile bottom nav.
  - The URL-only scope (as of / range / filters; Back and Forward verified).
  - ⌘K search over companies, codenames and brands, firms and funds, ranked by match tier. "fidelity" opens the
    firm; "project debussy" opens Databricks; "chobani" opens FHU US Holdings.
  - Pages on today's routes: Market; Company (overview with a brush-to-range chart, holders, changes, marks and
    classes); Firms; Firm (by company, by fund, changes); Fund (changes, filings); Activity.
  - One DataTable (sort, filter, group, totals, virtualization, CSV/XLSX from the same columns) and one Chart
    (ECharts, lazy, themed from tokens).
- **Serving:**
  - `server.js` serves `web/dist` at `/` and the app routes, v1 at `/legacy`, and `/assets` as immutable.
  - An unbuilt checkout still serves v1 at `/`.
  - CI gets a `web` job (typecheck, lint, Vitest, build).
- **Deviation from the plan:** the table is our own component plus TanStack _virtual-core_, not TanStack Table. A
  focused component covered sort, group, totals and export with less code. It can be revisited if pivoting needs
  more.
- **Verified in the browser (built app, live warehouse):**
  - Anthropic as of 2026-03-31 = 72 funds / $5.94B (A1).
  - Capital Group book: Anthropic 9 funds / $8.46B (A3).
  - Stripe, Growth Fund of America changes 2025-11-30..2026-05-31: **+$212.4M mark moved** (all 7 classes $41.42 →
    $63.00) and **+$150.0M added** (CL B 1,123,404 → 3,504,356 sh at a flat $63.00). That is the W1 decomposition
    golden; it is still to be verified on raw EDGAR before it enters GOLDEN-NUMBERS.
  - Dark and light themes; phone width (375 px) with no page overflow; no console errors.
- **Bugs found while verifying and fixed:**
  - A route param named `ref` collided with Preact's `ref` (blank company page on a direct load).
  - Enter in ⌘K during a search opened a stale "recent" item (the handler read a lagging `q`).
  - Keys typed right after ⌘K were lost.
  - The fund filter applied on Changes was not shown as a chip.
  - Change rows listed every class (7 lines for one Stripe filing); unchanged classes now fold into one line per mark move.
  - Date cells wrapped; the page overflowed at phone width.
- **Tests:** `npm test` 497 / 466 pass / 0 fail / 31 skipped (new: workspace at `/`, v1 at `/legacy`); `web` Vitest
  15 / 15 (scope ⇄ URL round trip, formatting, CSV, DataTable sort/filter/group, search ranking, folded change rows); lint, format and
  typecheck clean. LIVE suite not rerun (no SEC-facing change).

## Anthropic end-to-end audit (2026-10-01, after W0)

- **Data is consistent at every level checked:**
  - 678 rows, 405 filings, 124 funds, 2023-04-28 → 2026-07-31. No Anthropic-named row sits outside the company.
  - At all 15 quarter ends from 2023Q1 to 2026Q3, an independent SQL as-of equals `/exposure`, `/market/top` and
    `/trend` in every count: funds, value, $0, no longer reported, inactive. Examples: 2026-03-31 = 72 / $5.9446B
    (A1); 2026-06-30 = 117 / $17.2948B.
  - Per-share prices cluster at each mark date ($140.97 → $259.14 → $589.01, and Fidelity's Series D at $622.94).
  - No fund's share count ever fell (274 consecutive pairs, 113 increases = 112 "added" + 1 mixed). "First
    reported" + "held at the first stored filing" = 124 = funds ever.
- **Verified on raw EDGAR:** F39 and F40 (GOLDEN-NUMBERS).
- **Decomposition (prototype of W1 `legsOf`; reconciles to the cent on all 392 events):** Anthropic's $18.23B of
  reported change = new funds $4.58B + new classes $3.98B + added shares $0.06B + **mark moves $9.61B**. The $0.25B
  gap to the $17.97B as-of total is funds that stopped filing (the bridge's planned bucket).
  - Example: Growth Fund of America's "added" +$2.92B (2026-05-31) is $0.31B position and $2.62B mark (F39). The
    W0 table shows it as "added", so W1's split is needed before Δ value reads right.
- **Fixed now:**
  - "% of fund" showed 100× (pctNav is already a percent; GFA's G-1 read 82.83%, now 0.83%).
  - A firm chip showed on Holders but did not filter. Holders and Changes now filter by firm through the
    `firmsOfFund` definition. The API adds `firms` to holders and changes and `classLabel` to positions. Filtered
    holders equal the firm book (Capital Group 9 / $8.4582B, Fidelity 45 / $3.9816B at 2026-06-30; test in
    `views.test.js`).
  - The disclosed-exposure fields were misnamed (blank).
  - Totals ignored the filter box.
  - A page could show the previous URL's data while loading.
  - Chips showed for filters a view does not apply.
- **Open, decided into W1:**
  1. **One class, two labels by filer category:** Series G filed EC ("Common G": BlackRock, 8 funds, $115M) vs EP
     ("Preferred G": Fidelity, 33 funds, $764M), at the same $589.01. Likewise F-1 (Franklin) and G-1 (NY Life).
     The class views split them. Proposed trap 50: merge to "Series X" when a company's EC and EP rows share a
     series code and the same price at the same mark date from ≥ 2 filer families. Keys stay apart (trap 47).
  2. **"Indirect" has three meanings:** a named SPV (`via_spv`; badge, kind filter, market column); a fund-interest
     row (`instrument_type` indirect: Coatue's "private fund" $1.49B and BlackRock "Pooled Investment Fund
     Interests"); and the class label "Indirect via X". Coatue is marked at exactly Anthropic's per-share price yet
     labeled "Indirect via ANTHROPIC" and treated as direct. Proposal: one kind field (direct | named SPV | fund
     interest) shown and filtered the same everywhere.
  3. The class mark chart's median across firms at nearby mark dates zig-zags (Common, Nov–Dec 2025: BlackRock
     $203.36 vs Fidelity $140.96). W2 draws per-firm lines with the low–high band.
  4. Firm changes since 2019 take 2.1 s for Fidelity (12.9k events): W1's `position_facts` covers it.

## Post-P5 review and this session (2026-10-01)

- **Review findings, all fixed** (archive has the review): funds sharing a name merged on the company page (trap 48);
  listed companies' private-era history unreachable (trap 49, now `?stored=1`, labeled); a lone weak search match
  opened by itself (search now marks `strong`); `review:aliases` skipped the lock; a failed make-company left the
  warehouse half-applied; resolved unreviewed keys did not redirect; X-Ray's private book mixed fund interests; no
  gzip; docs drift; CI ran twice; merged branches; `npm audit` (now 0).
- **Decided by Claude under "fix everything" (user can overrule):** trap 45, loans filed as OTHER are debt by the
  filer's own wording (71,043 rows, $22.8B, 349 filings; goldens unchanged; C26); size budget raised to **1 GB**.
- **Found while building and fixed:** common and preferred under one title merged (trap 47, F37); class and firm
  marks counted amended filings (now canonical only); a class label's 12-month median compared different securities
  across OpenAI's restructuring (the dashboard now uses each fund's own split-adjusted series).
- **Verified on raw EDGAR:** F37 (Nuveen Winslow EC/EP rows), F38 (Blue Owl's 26,201 loan rows by wording).
- **Goldens through the new views** (`test/views.test.js`, `test/app-views.test.js`): F8/F9 exit; Capital Group Stripe
  $33.73 → $35.50 → $41.42 → $63.00 and 8 of 12 months; F13 split not an add; A1/A2 via the trend; F30 +5.76%; A3
  9 / $8.46B two ways; A5 via the dashboard; F2 in the feed; every top company = `exposureAsOf`.
- **Docs:** archived (verbatim) STATUS history, ROADMAP P0–P5, the full DATA-QUALITY traps, LESSONS stories and old
  prompts to `docs/archive/`; session-start reading cut from ~175 KB to ~45 KB.

## Measurements

| Metric                         | Budget | Latest                                                                                                |
| ------------------------------ | ------ | ----------------------------------------------------------------------------------------------------- |
| Warehouse size                 | ≤1 GB  | **544.0 MB** (2026-10-01; ~25–30 MB per bulk quarter)                                                 |
| Nightly refresh                | ≤5 min | 0.7 min (#15, nothing new; reclassify adds ~4 s)                                                      |
| API p95, new routes (load ~4)  | <200ms | activity 28, trend 11, classes 9, marks 5, firm 11, firm changes 138, top 118, feed 192, firms 103 ms |
| API p95, P5 routes             | <200ms | all routes 19.7 ms (P5b bench)                                                                        |
| Suite                          | green  | 496 tests, 465 pass, 0 fail, 31 skipped; `npm run test:live` 31 / 31; lint and format clean           |
| Full backfill / first catch-up | —      | 13.6 min / 26.9 min (P1, P2)                                                                          |

Cold first requests are slower (disk); the server warms tracked exposure, the market list, firms and the dashboard
at start (dashboard ~4.5 s cold).

## Warehouse state (refresh #15, 2026-10-01)

Schema at migration 0018. 354,999 N-PORT filings (bulk 2019Q4–2026Q2 + catch-up through filings of 2026-09-30),
1.165M private-candidate rows (74k now debt by trap 45), 806 companies (304 private), 180 tracked, 529 firms,
18,852 funds, 71,833 unreviewed entities. `ingest_errors` empty. 2026Q3 bulk not posted yet (loads on the next
refresh once it is).

## Open decisions (user)

- **Sign off P6's core and P6b W0** (open the app at `/`, v1 at `/legacy`), then W1 (data: position facts, bridge,
  pivot, scope filters).
- **Install the nightly refresh** (launchd entry in ARCHITECTURE §Refresh lifecycle)? Not installed; until then run
  `npm run refresh` at session start. P8's 30-day unattended run cannot start before it.
- **Overrule or keep** the two decisions above (trap 45 rule, 1 GB budget).
- **Global git identity** is "Test User <test@test.com>" (`git config --global`); this repo sets its own. Fix with
  `git config --global user.name …` if wanted (not changed: system config).
- **Push and PR:** `v2-phase6` is committed locally; push it and open a PR when you say so.
- Balance-0 rows (trap 43) count under the P3 precedent; tracked-list size is yours to change.

## Known issues

- `test/edge-cases.test.js` "cik/accession are validated…" failed once in a full run under heavy machine load and
  passed in every rerun (3/3 alone, 2/2 full); like the v1 429-retry test, timing-sensitive.
- Fidelity's opaque per-fund vehicles (~$0.6B) stay on the review list (no filing names their targets).

## Next session

> Resume Vantage v2. Read CLAUDE.md, docs/STATUS.md, docs/ROADMAP.md §6b, docs/plans/P6b-analyst-workspace.md,
> docs/DATA-QUALITY.md, docs/LESSONS.md. `npm run refresh` first (report the 2026Q3 bulk, `ingest_errors`, size vs
> 1 GB). `npm --prefix web install` if needed. Gates: npm test (check the exit code), lint, format, `npm run
test:web`, `npm run build:web`. Then P6b W1 after the user signs off W0: verify the Stripe decomposition on raw
> EDGAR first, refactor `legsOf`, measure `position_facts` on the real warehouse before the migration.

## Log

- **2026-10-01 (later):** P6b planned with the user and approved; W0 built and verified in the browser on branch
  `v2-p6b-workspace`. Stopped for W0 sign-off.
- **2026-10-01:** Post-P5 fixes, trap 45/47 rules, the P6 analysis views (issuer, security, fund, manager, market,
  feed, dashboard), docs archived and shortened, merged branches deleted. Stopped for P6 sign-off.
- **2026-09-30:** Post-P5 review (findings), P5b signed off and merged (PR #4). Earlier: archive.
