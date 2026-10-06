# P6c: review remediation (staff review 2026-10-05, F01–F18)

## Context

W4 was signed off and W5 was paused while the user ran a separate check. That check is the staff review in
`~/Documents/Vantage-2-Staff-Engineering-Review-2026-10-05.md`. It lists 18 findings (F01–F18), release gates,
and per-file notes. It was written against `414265c` plus the uncommitted W4 tree, which is now commit `8c50fce`.
I checked the cited code on the current branch:

| Finding                                     | Verdict                                                                                                                                                         | Evidence I checked                                                                                                                                                                                                                                           |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F01 tooltip HTML                            | **Confirmed.** Cheap to fix, low real-world likelihood                                                                                                          | `Explore.tsx:137` interpolates `r.label` into the HTML string. Five formatter sites (Explore, Compare, firm/Book, company/Positions, book/Timeline) plus BridgeView. There is no escape helper in `web/src`. `server.js:34` sets `'unsafe-inline'` globally. |
| F02 stale browser cache                     | **Confirmed**                                                                                                                                                   | `web/src/api/client.ts:32` returns cached data with no revalidation. Any different `refreshId` replaces the stored one, even an older one.                                                                                                                   |
| F03 publication not atomic                  | **Confirmed**                                                                                                                                                   | `refresh.js:119–187` commits each phase separately. `memo.js` and `api/warehouse.js:79` key everything to the last run with status `'ok'`.                                                                                                                   |
| F04 writers bypass lock                     | **Confirmed**                                                                                                                                                   | `scripts/ingest-bulk.js` calls upkeep and facts but not `claimRun`, entities, search or stats. `backfill-filing-totals.js:59` checks the lock instead of claiming it.                                                                                        |
| F05 partial write-down shown as an exit     | **Confirmed. This is a real attribution bug**                                                                                                                   | `activity.js:35–36` filters out rows with `counts=false` before matching, so a class at $0 next to a positive class becomes a "no longer reported" leg with a position effect.                                                                               |
| F06 rows counted as funds                   | **Confirmed**                                                                                                                                                   | `marks.js:113`: `funds: ms.length` counts positions, not funds. Medians use one price per lot.                                                                                                                                                               |
| F07 disclosure leak past `knownAsOf`        | **Confirmed**                                                                                                                                                   | `company.js:125` filters by `report_date` only and never checks `filing_date`.                                                                                                                                                                               |
| F08 firm IDs reused                         | **Confirmed**                                                                                                                                                   | `review.js:276–289` keys managers by name and deletes unreferenced rows, so IDs can be reused.                                                                                                                                                               |
| F09 CSV formulas                            | **Confirmed**                                                                                                                                                   | `web/src/lib/export.ts:18` only quotes. Exception: the `data/review` CSVs are machine-read curation inputs, so they must **not** be neutralized.                                                                                                             |
| F10 request cost / binding                  | **Partly agree.** Binding and cheap bounds now; the capacity envelope belongs to P9                                                                             | `server.js:1160` calls `app.listen(PORT)` with no host. `sendJson` uses `gzipSync`.                                                                                                                                                                          |
| F11 operations proof                        | **Agree.** Already planned as P8                                                                                                                                | `STALE_RUN_MS` is a fixed 2-hour timeout with no heartbeat.                                                                                                                                                                                                  |
| F12 same-size republish, empty tables       | **Agree**                                                                                                                                                       | `refresh.js:31–43` detects a re-posted quarter by size only.                                                                                                                                                                                                 |
| F13 partial results look complete           | **Agree.** The palette part is now; the legacy part is small                                                                                                    | The `CommandPalette` catch turns an outage into "no results".                                                                                                                                                                                                |
| F14 not bitemporal                          | **Agree it is a limitation; disagree with building full bitemporality now.** I'd label the outputs and stamp the curation revision, and research `public_since` | —                                                                                                                                                                                                                                                            |
| F15 drawer mixes share classes              | **Confirmed**                                                                                                                                                   | `PositionDrawer.tsx:39–65` sums shares across classes.                                                                                                                                                                                                       |
| F16 capped activity feed                    | **Confirmed**                                                                                                                                                   | `market.js:90`: `limit = 3000`, and the KPIs are computed from the capped list.                                                                                                                                                                              |
| F17 test oracles share code with production | **Agree**                                                                                                                                                       | Bridge reconciliation passed despite F05.                                                                                                                                                                                                                    |
| F18 a11y and chart retry                    | **Agree (P3)**                                                                                                                                                  | `Chart.tsx:56` keeps polling with `requestAnimationFrame` after an import failure. Fold this into W5's a11y work.                                                                                                                                            |

I would not act on the review's mentions of Postgres, microservices, or a full bitemporal curation history. They don't
fix the defects found and are out of proportion for a single-node research tool. The review's remark that STATUS and
ROADMAP are stale was true of its snapshot but has since been fixed in `cb965e4`.

**Outcome:** a new phase, **P6c (review remediation)**, inserted before W5 and run in the usual wave workflow
(build → verify on the live warehouse → push → stop for sign-off). P8 and P9 take over the operations and public-launch gaps.
Add P6c to ROADMAP and STATUS, and list every finding with its wave so none are dropped.

---

## R1: correctness and security fixes (F01, F02, F05, F06, F07, F09, F15, plus small parts of F13/F18)

Rule for this wave: **write a failing test first**, with an expected value computed by hand rather than by the
production helper (F17).

1. **F05 partial zero** (`lib/analytics/activity.js` `diffPosition`):
   - Match keys on the **full** row sets (counting and $0 rows), then classify each instrument separately.
   - A class that goes positive → $0 while still listed becomes a leg with `change: 'reported at $0'`,
     `positionEffect: 0`, `markEffect: -prevValue`, and its current balance kept. The whole-company zero branch keeps balances too.
   - Keep `movedWithinClass` and `rekeyed` on the counting rows, so traps 51 and 52 are not disturbed.
   - Before keeping the change, count real cases on the warehouse: a query for fund × company filings with a mix of $0
     and positive classes. Then **diff `position_facts` before and after on the whole warehouse** (LESSONS 36), and
     report the legs whose category moved.
   - Rebuild with `buildPositionFacts`. Re-check goldens F43–F53 that involve bridges or movers. If a number changes,
     re-verify it with `scripts/verify-edgar.js` and update `GOLDEN-NUMBERS.md` with a note.
   - Add the case to `DATA-QUALITY.md` as a new trap.
2. **F06 observation unit** (`lib/services/marks.js`, `firmMarks`, `analysis.marksVsOthers`, `compare`, `lib/analytics/peer.js`):
   - Define one observation as **fund × normalized class (`lib/services/classes.js`) × mark date**.
   - Combine a fund's lots as Σvalue / Σshares.
   - Count funds with `new Set(fundKey)`, and compute medians and spreads over the per-fund observations.
   - First, query how often lots inside one fund × class × date carry different prices, and report it.
   - Test: Anthropic 2026-06-30 Common must show 13 funds, and "Indirect via ANTHROPIC PBC" must show 1. Also a synthetic case of one fund with several lots, with the median worked out by hand.
3. **F07 disclosure cutoff** (`company.disclosedExposure`):
   - Pass `knownAsOf` and add `f.filing_date <= ?` before taking the max per fund.
   - A disclosure applies only while its fund is active under the `exposureAsOf` inactivity rule.
   - Return `filingDate`.
   - Test: cutoffs just before and just after `0001867090-26-000109` (filed 2026-08-28).
4. **F01 tooltips**:
   - Add `escapeHtml` in `web/src/lib/format.ts` and use it for every interpolated string in the six formatter sites.
   - Give v2 its own strict CSP at `/` (no `'unsafe-inline'` in script-src; check that Vite's `index.html` has no inline script). Keep the permissive policy on `/legacy` only (`server.js:28–39`).
   - Add a Vitest test for each formatter fed a label like `<img src=x onerror=…>`.
5. **F02 freshness** (`web/src/api/client.ts`):
   - Revalidate `/api/freshness` outside the cache, on focus or visibility change and every 5 minutes.
   - When the generation changes, clear the cache and notify mounted `useApi` hooks through a subscriber set, so they refetch.
   - Ignore any response whose `refreshId` is lower than the current one.
   - Guard the success path against an aborted request.
   - Vitest: an incrementing stub, and responses arriving out of order.
6. **F09 CSV** (`web/src/lib/export.ts` `cell`, legacy `public/app.js` CSV):
   - Prefix `'` to **string** cells that start with `= + - @ \t \r`.
   - Leave real numbers alone, including negatives.
   - Keep XLSX cell types explicit.
   - Do not touch `lib/entities/csv.js`; record why in a comment.
7. **F15 drawer**: draw one per-share series per instrument (class), and split-adjust each lineage separately.
   Test with two classes whose proportions change.
8. **Small items in this wave**:
   - F13: the palette shows "search failed, retry" instead of an empty list.
   - F18: `Chart.tsx` stops polling and allows a retry when the import fails.
   - `XRay.tsx`: a missing NAV % shows "—", not 0.
   - `scripts/verify-edgar.js`: exit non-zero when nothing matches, and print rows inspected vs matched.

## R2: one writer and atomic publication (F03, F04, F08, F12; F11 lease)

**Design (recommended):** publish whole generation files and switch readers by a pointer.

- **`lib/warehouse/job.js` `runJob(kind, fn)`** becomes the only write path:
  1. Claim `claimRun`, with a **heartbeat** column refreshed during the job (this replaces the fixed `STALE_RUN_MS` timeout).
  2. Copy the published generation to `warehouse.candidate.db` using the better-sqlite3 `backup()` API.
  3. Run `fn` on the candidate, then the **whole derived chain** (`reclassifyStored` → `entityUpkeep` →
     `rebuildEntities` → `rebuildFundNames` → `buildPositionFacts`), factored out of `refresh.js` as
     `rebuildDerived(db)`.
  4. Validate (see below), checkpoint, and set `journal_mode=DELETE`.
  5. Rename to `generations/warehouse-<runId>.db` and atomically rewrite the `warehouse.current` pointer.
  6. Keep the previous generation for rollback.
- **Callers that move to `runJob`:** `refresh`, `ingest-bulk`, `ingest-delta`, `ingest-ncen`, the backfills,
  `review-aliases`, `make-company`, and the mutating part of `entities-report`. `entities-report` becomes read-only
  unless given `--rebuild`.
- **Readers:** `openWarehouseReadOnly` resolves the pointer. The `warehouseRouter` factory `stat`s the pointer on each
  request and reopens when it changes (better-sqlite3 is synchronous, so no request straddles the switch).
- **Versioning:** `refreshId`, ETag and memo are keyed to the **generation actually opened**. The `memo.js` premise
  becomes true by construction.
- **`/api/freshness`** reports job state (running or failed) separately from the data version.
- **Disk:** budget about 2× the warehouse plus the candidate (~1.8 GB). The 1 GB budget stays a limit per generation. Document this in ARCHITECTURE and ADR 0009.
- **F12 validation (in the candidate, before publishing):**
  - Required tables and headers in `tsv-zip.js`.
  - Each quarter's filing and holding counts within a band of the previous load. Outside it, quarantine and fail without publishing.
  - Re-post detection by `ETag`/`Last-Modified` + size, falling back to a hash after download. Record "no revision detected" separately from "verified identical".
- **F08 firm IDs:**
  - Migration `0020_manager_ids.sql` adds `manager_redirects`.
  - A `data/review/manager_ids.csv` ledger, built like `company_ids.csv`. `importManagers` reads and rewrites it, never deletes an id (it retires it with a successor), and treats a rename as a label change.
  - `web/src/lib/watchlist.ts` follows redirects and flags retired ids.
  - Seed the ledger from today's ids so existing URLs and watchlists keep working.
- **F14 (cheap part):** each generation stores the git hash of `data/review/*` and the rule versions in a new
  `generation_meta` table, and API responses carry it.
- **Tests:**
  - Kill the job after each phase: the published generation stays unchanged and coherent.
  - Two overlapping writers: the second fails.
  - Every CLI writer changes the version exactly once.
  - Same-size changed archive, and a valid but empty table, both quarantined.
  - Firm rename, remove and re-add, and a clean rebuild, all keep the ids.

## R3: product assurance (F13, F16, F17; temporal labels for F14)

- **Browser suite:** Playwright as a web dev dependency. Installing it downloads browsers, so ask before running
  the install. Run it against the built app over the fixture warehouse. It covers:
  - Tooltip XSS payloads produce no inserted elements; the served CSP header.
  - Freshness through a generation switch, without reloading the page.
  - CSV and XLSX contents.
  - Palette failure, drawer focus and Escape, and the main routes.
  - Add it to CI (`.github/workflows/test.yml`), pinning actions by SHA and setting least-privilege `permissions`.
- **F16:**
  - `market.feed` returns `total`, `breakdown` (counts by type over **all** matches) and a page or cursor.
  - `Activity.tsx` takes its KPIs from `breakdown`, pages the list, and labels the export scope.
  - The same rule applies to the Filings KPIs.
- **F13 legacy:** live routes in `server.js` carry `{partial, failedSources}`. Partial answers are not cached as complete, and the UI says so.
- **F17 oracle:** `test/fixtures/oracle/` holds about 30 raw rows reviewed by hand (picked by fund calendar, class,
  zero/exit, split, and amendment). Expected values are typed in from `verify-edgar` output, with no production helper.
  Assert exposure, the bridge category per leg, and fund counts and medians against it.
- **F14 labels:** firm, market and compare responses and their exports say they use "current curation and current
  adviser mapping". Public or retired watchlist subjects show their status instead of a zero.

## Then W5 (as planned) plus F18

Retire Batch and Watchlist to Compare and Tracked. Run axe and Lighthouse ≥ 90. Add the remaining F18 items: a
focus trap and return-to-trigger for the palette and drawer, and keyboard activation for clickable rows. Write the README v2 map.

## Moved into P8 and P9 (record in ROADMAP; not built in P6c)

- **P8 (F11, F10 local mode):**
  - `/healthz` (liveness) vs `/readyz` (pointer resolves, schema current, data age, job state).
  - Bind `127.0.0.1` unless `HOST` is set, and validate `trust proxy` against the configured mode.
  - Async gzip, and a memo limit by bytes.
  - Restore drill from a kept generation on a clean checkout.
  - Install the launchd job only after the user says yes.
  - Alerts on a failed or stuck job.
- **P9 (F10 capacity):**
  - Cold, warm and concurrent load test (p99, event-loop delay, RSS).
  - Bounds on pivot and drill ranges before any data is loaded into memory.
  - A shared SEC request budget across processes.
  - Gate the live routes in public mode.
- **Research item (F14), after W5:** check on real filings whether `public_since` can be filled from EDGAR
  (S-1/424B dates) for the 504 public companies. Report what the check finds before building anything, then fix the
  survivorship bias in historical market views.

## Critical files

`lib/analytics/activity.js`, `lib/services/{marks,company,firm,analysis,market,memo}.js`, `lib/analytics/peer.js`,
`lib/api/warehouse.js`, `lib/warehouse/{refresh,db,bulk-source,bulk-ingest,tsv-zip,position-facts}.js`, new
`lib/warehouse/job.js`, `lib/entities/review.js`, `scripts/*` (writers, `verify-edgar.js`), `server.js`,
`web/src/api/client.ts`, `web/src/lib/{export,format,watchlist}.ts`, `web/src/ui/{Chart,CommandPalette}.tsx`, the five
formatter pages plus `BridgeView.tsx`, `PositionDrawer.tsx`, `Activity.tsx`, `db/migrations/0020_*`, docs (ROADMAP,
STATUS, DATA-QUALITY, GOLDEN-NUMBERS, ARCHITECTURE, a new ADR 0009 for generations).

## Verification (each wave)

- Gates: `npm test`, `npm run test:web`, `npm run lint`, `npm run lint:web`, `npm run format:check`, `npm run build:web`, and from R3 on the browser suite. `npm run test:live` at the end of each wave.
- R1:
  - Each fixed finding has a test that fails on `8c50fce` and passes after the fix.
  - Warehouse-wide `position_facts` diff reported.
  - Goldens re-verified with `verify-edgar.js`.
  - Browser walk on the live warehouse (`preview_start nport-analyzer`): tooltips, drawer per-class lines, Anthropic class counts, light, dark and 375 px.
- R2:
  - Run `npm run refresh` through `runJob`, killing it mid-run once: the old generation keeps serving and `refreshId` is unchanged; after a clean run it changes once.
  - `npm run bench` p95 < 200 ms after the reopen logic.
  - Firm URLs from before the change still resolve.
- R3:
  - Browser suite green in CI.
  - Activity totals match a direct SQL count over more than 3,000 events.
- Update STATUS (phase tracker, log, next prompt) and ROADMAP at each stop, and stop for sign-off.
