# Vantage v2 Status

**Phase:** P6b W0–W4 signed off (W4 2026-10-05). **P6c (review remediation) inserted before W5**: the user's
separate check was a staff engineering review (F01–F18); plan approved 2026-10-05. **R1 built 2026-10-05, stopped for
sign-off; R2 (publication) next.** Branch `v2-p6b-workspace` (pushed). P6 core signed off 2026-10-01. Wave results: [archive](archive/STATUS-history.md).
**Last updated:** 2026-10-05. Earlier results: [archive/STATUS-history.md](archive/STATUS-history.md).

## Phase tracker

- [x] P0–P5b: live fixes, warehouse, refresh, as-of, entities, identity, services, company and fund pages
      (signed off 2026-09-28..30; ROADMAP "Done")
- [x] P6 core: analysis views (signed off 2026-10-01; remaining items in ROADMAP §6)
- [ ] **P6b: analyst workspace**: W0–W4 signed off (2026-10-01, W4 2026-10-05); **W5 next** (ROADMAP §6b)
- [ ] **P6c: review remediation** (R1 correctness/security → R2 publication → R3 assurance), then W5
      ([plan](plans/P6c-review-remediation.md))
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
| Explore (W4)                 | `/explore`, `/api/analysis/drill`                    | pivot rows × periods, every metric, heatmap + table; any cell drills to the legs behind it (they sum to the cell)                                          |
| Market movers, new (W4)      | Market → Movers, Newly reported                      | largest mark effects and net position flows over a range; companies first reported in a range                                                              |
| Activity, Watchlist (W4)     | `/activity`, `/tracked`                              | the feed with firm and fund filters; your watchlist (this browser) now vs a year earlier; the tracked dashboard                                            |
| Compare (W4)                 | `/compare`                                           | 2–5 companies, firms, funds or classes: value per period, position and mark effects, median per-share marks (replaces v1 Batch)                            |
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
- **Cross-cutting (W4, signed off 2026-10-05):** `web/src/pages/{Explore,Tracked,Compare}.tsx`, `pages/market/`
  (Movers, NewlyReported), Activity with the scope; services `analysis.{drill,movers,newlyReported,watchlist,compare}`;
  routes `/api/analysis/{drill,compare}`, `/api/market/{movers,new}`, `/api/watchlist`; tests
  `test/workspace-w4.test.js` (pivot = `exposureAsOf` for every private company; every drill's legs = its cell;
  drill events = `companyActivity`; movers = bridge) and `web/test/watchlist.test.ts`.
- **Still on v1 (`/legacy`):** Batch, Watchlist, Private Credit (deferred scope). W4 built their replacements
  (Compare, Tracked & Watchlist with a v1 import); W5 retires the v1 tabs.

## Handoff: how to work on this project (read before W4)

- **Working with the user.** The user signs off each wave ("sign off", or "continue" = sign-off and build the next).
  Build the whole wave, verify it in the browser on the live warehouse, update docs, commit and push to
  `v2-p6b-workspace`, then stop for sign-off. Recommend, don't survey; decide delegated questions by v1 behavior and
  v2 goals and list the call under Open decisions. No PR, merge to main, launchd job or global config without an
  explicit yes.
- **Real data only.** Check any new metric's definition on real rows _before_ building it (mark leadership and marks
  vs others were prototyped on Anthropic, Stripe, Databricks and Canva first). Every new number shown as a finding
  goes to GOLDEN-NUMBERS after a raw-EDGAR check: `node scripts/verify-edgar.js <cik> <pattern> <accession>…`
  (needs `SEC_USER_AGENT` from `.env`; paced client). Last golden: **F53**.
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
- **W5 scope** (ROADMAP §6b): move Batch and Watchlist users to Compare and Watchlist; only Private Credit stays
  in Legacy; a11y audit, perf pass (Lighthouse ≥ 90), docs (README, module map), LIVE suite green.

## Measurements

| Metric                         | Budget | Latest                                                                                             |
| ------------------------------ | ------ | -------------------------------------------------------------------------------------------------- |
| Warehouse size                 | ≤1 GB  | **574.7 MB** (2026-10-02, refresh #19; position facts 31 MB; ~25–30 MB per bulk quarter)           |
| Nightly refresh                | ≤5 min | 0.7 min (#19, nothing new; position facts 3.6 s)                                                   |
| API p95, all routes (load 3–7) | <200ms | 29.8 ms over 3,805 requests (W4); new routes ≤ 70 ms (compare firms 64, drill total 36, movers 14) |
| Suite                          | green  | 541 tests, 510 pass, 0 fail, 31 skipped; web 21 / 21; LIVE 31 / 31 (W4 start); lint, format clean  |
| Full backfill / first catch-up | —      | 13.6 min / 26.9 min (P1, P2)                                                                       |

Cold first requests are slower (disk); the server warms tracked exposure, the market list, firms, the dashboard and
the position facts at start.

## Warehouse state (refresh #19 + review import, 2026-10-02)

Schema at migration 0019. 354,999 N-PORT filings (bulk 2019Q4–2026Q2 + catch-up through filings of 2026-09-30),
1.165M private-candidate rows, 806 companies (302 private: two registered VIP funds moved to public, see Log), 180 tracked, 529 firms, 18,852 funds, 71,833 unreviewed
entities, 68,277 position-fact legs. `ingest_errors` empty. 2026Q3 bulk not posted yet.

## Open decisions (user)

- **P6c R1 calls (open to overrule):**
  - _Mark observation unit (F06):_ one observation per fund × class × mark date at its lots' value / shares. Medians,
    low, high and fund counts are across funds. `severalMarks` counts funds whose own lots differ by more than 0.1%:
    115 of 4,332 observations at 2026-06-30, e.g. Kardium "Preferred" lots at $0.52, $0.85 and $1.07 in one fund.
    The per-row list still shows every lot. Firm marks now use the shared class labels (`classOfRow`) like every other view.
  - _$0 classes (F05):_ "reported at $0" keeps the shares, and the write-down is mark. A share cut at the same filing is
    position at the prior mark. "Reported above $0 again" is mark. A row with no share count stays "value only", as for
    any LP interest.
  - _Disclosed ranges (F07):_ under the as-of rule. Filed by `knownAsOf`, the fund's latest canonical filing, and
    within 123 days.
  - _CSV (F09):_ text starting with `= + - @`, a tab or a CR gets a leading apostrophe unless it is a plain number. The
    `data/review` curation CSVs are not neutralized (the import reads them back).

- **W5 is next, paused:** the user signed off W4 and is running a different check in a new session before W5 starts.
  Ask what that check found before building W5. Calls made in W4 under "v1 is the guidepost", still open to overrule: the watchlist lives in this browser (localStorage, per the plan; no server account); Compare keeps
  v1 Batch's spread (dispersion) and mark age but not its per-fund charts (the company page has them); Market
  movers rank dollars (mark effect, net position flow), not percent (a percent of a start value misleads for a
  company first reported in the window: Anthropic $0.29B → $18.16B).
- **Curation call made (finalize-reviews rule):** "LVIP ClearBridge Appreciation Fund - Standard" (id 235) and
  "Franklin Gold And Precious Metals Vip Fund" (id 256) were reviewed `private`; both are registered series that file
  N-PORT themselves (S000101700, S000101726), like the JNL funds already `public`. Set to `public` (aliases.csv);
  they no longer show as "newly reported" companies. Overrule if you disagree.
- The warm-up flake task (chip "Stop server warm-up from blocking past keep-alive") can run in parallel.
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
  change, not a split. Likewise a non-split share exchange reads as "added" plus "mark moved": Mesquite Energy
  (shares ×2.41, $205.76 → $15.45, Fidelity 2026-04-30; F52) is Market's largest mark move down (−$801.4M) with a
  +$561.2M position flow. The bridge still reconciles; the split between the two legs follows the rule (shares at
  the prior mark), not a reorganization price no filing states.
- Explore's firm picker lists every firm holding private value (~170), including small advisers with terse N-CEN
  names ("Portfolio", "Boston"); labels come from `managers.csv`.

## Next session

> Resume Vantage v2 on branch `v2-p6b-workspace`. P6c R1 (staff review correctness/security) is built and waiting for
> sign-off. On "continue", build **R2 (publication)** per docs/plans/P6c-review-remediation.md: `lib/warehouse/job.js`
> `runJob` as the only write path (claim with heartbeat, candidate copy, `rebuildDerived`, validate, generation file +
> pointer, keep the previous), readers reopen on a pointer change, `refreshId`/memo keyed to the opened generation,
> F12 source validation and re-post detection, F08 manager id ledger (migration 0020, `data/review/manager_ids.csv`),
> `generation_meta` (curation revision). Read CLAUDE.md, docs/STATUS.md (Open decisions: R1 calls),
> docs/ROADMAP.md §6c, docs/DATA-QUALITY.md (trap 53) and docs/LESSONS.md first. Gates as in the plan's Verification
> section; stop for R2 sign-off. W5 follows P6c.

## Log

- **2026-10-05 (P6c R1):** Correctness and security wave of the staff review, each fix with a failing-first test
  worked by hand:
  - **F05:** `activity.diffPosition` matches instrument keys on every row. Warehouse-wide diff vs HEAD: 117 legs
    changed, $18.1M moved out of position effects (Ares CLO, KKR European V, Octagon 42, Ascent, Cineworld). No
    golden changed; trap 53.
  - **F06:** `classes.fundMarks`/`markStats` in marks, firm marks, pivot marks and marks vs others. Anthropic
    2026-06-30 Common reads 13 funds (was 14) and the PBC line 1 (was 2).
  - **F07:** disclosure obeys `knownAsOf` plus the as-of rule.
  - **F01:** `escapeHtml` in all six tooltip formatters, a source-scan guard, and a strict v2 CSP
    (`script-src 'self'`); `unsafe-inline` only on `/legacy`.
  - **F02:** the client revalidates freshness on focus, on visibility change and every 5 minutes; mounted views
    refetch on a newer generation, and an older one is never cached.
  - **F09:** CSV formula text, v2 and v1.
  - **F15:** the drawer draws one mark line per class, each split-adjusted on its own. This also fixed the drawer
    chart collapsing to 1px in its flex column.
  - **Smaller items:** the palette shows search failure with a Retry (no more false "no match"); a chart import
    failure stops polling and offers a Retry; XRay shows "not reported" instead of 0%; `verify-edgar` fails closed
    and prints matched/inspected.
  - **Gates:** refresh #21 (8 filings, 0 failed, facts rebuilt, 576.9 MB, `ingest_errors` 0). `npm test` 547 tests:
    516 pass, 0 fail, 31 skipped. Web 37/37. LIVE 31/31. Lint and format clean.
  - **Browser:** live warehouse walk (drawer per-class lines, Explore tooltip, CSP with no console errors, 375 px light).

- **2026-10-05 (later):** The user's separate check was a staff engineering review
  (`~/Documents/Vantage-2-Staff-Engineering-Review-2026-10-05.md`). Every cited code path was checked on `8c50fce`:
  F01, F02, F03, F04, F05, F06, F07, F08, F09, F15 and F16 confirmed. Plan approved: phase P6c (R1–R3) before W5;
  F10/F11 to P8/P9. Full bitemporal curation and a Postgres move were not adopted.

- **2026-10-05 (end):** W4 signed off by the user ("continue"). W5 paused at the user's request for a separate check
  in a new session; no W5 work started.

- **2026-10-05:** P6b W4 built: Explore pivot with cell drill (`/explore`, `/api/analysis/drill`), Market movers and
  newly reported, Activity with firm and fund filters, Tracked & Watchlist (localStorage, v1 import, Watch buttons),
  Compare (2–5, replaces Batch). Exit check held by tests: pivot value cells = `exposureAsOf` for every private
  company at every quarter end; all 768 live drill cells (4 row kinds × 12 metrics × 4 rows + total × 4 quarters)
  equal their pivot cells; drill events = `companyActivity` events. Goldens F51–F53. Two VIP funds set `public`.
  Gates green at start (refresh #19, LIVE 31/31). Stopped for W4 sign-off.

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
