# Triage of the outside review (2026-10-18) and fix plan

## Context

An outside reviewer read the public repo only (no warehouse, no `.env`, no live site) and graded Vantage B+. They
ran none of the data checks. This plan checks each finding against code at `main` 67ced97, measures it on real data,
runs the reproducibility test they could not, and proposes fixes in waves. Nothing has been changed.

Sources used: local warehouse **generation 34** (read-only, `sqlite3 -readonly` and `openWarehouseReadOnly`); the live
API at **generation 40** (build 67ced97, refreshed 2026-10-18 10:16 UTC, newest report 2026-09-30, newest private mark
2026-08-31); raw EDGAR `primary_doc.xml` through `scripts/verify-edgar.js` (its `rawHoldings`), all on 2026-10-18.

## Verdict

The review is mostly right on the code. But it gets the size of each risk backwards. **The live numbers are right:**
21 of 21 random live positions and both rebuilt totals match raw EDGAR to the cent. The Fund X-Ray fail-open is
real but small: $35.2M in 103 old filings, and only on X-Ray pages. The Firms footer double count is real but tiny:
$8.4M of $73.8B (0.011%).

Two problems matter more:

- **Hindsight dates.** "As of" quietly includes reports filed later. At 2026-06-30, $53.8B of the $62.2B
  operating-company value came from filings made after that day. Only $47.3B was public by then. About also words
  the rule as "latest _filing_ on or before that date", which is wrong.
- **Mixed share classes.** Mixed lots give wrong per-share marks on the live site. Skyhawk "Common" shows a $31.21
  median with a 50% spread, while every fund marks the common at $53.14. A near-$0 CVR is averaged in.

The review also missed one gap: Firms, firm pages and Explore count fund stakes, CLOs and reinsurance vehicles. Market
leaves those out. So the Firms page shows $73.8B where Market shows $63.2B, and the gap is not labeled. Using today's
company list and advisers for history is a known, measured choice (0.01% by adviser). That one is not a defect.

## Findings

| #   | Finding                                                                                | Review | Verdict                                                                                                                                                                                                                                                                   | Evidence                                                                                                                                                                                                                                       | Real impact (measured)                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Mine                     |
| --- | -------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| 1   | Fund X-Ray counts an untagged non-debt row as a private operating company              | High   | **Real, new**                                                                                                                                                                                                                                                             | `lib/services/fund.js:203-204` fallback `isPrivate: true`; `lib/entities/entities.js:51-52` skips rows whose `keyOf` is blank, so they never get an `entity_id`. The comment "the refresh has not tagged this row yet" is false: it never will | Gen 34: **103 rows in 103 filings, 13 funds, $35,161,231.75**; all have blank issuer and title. Largest: Legal & General Commodity Strategy Fund, raw name and title "N/A", Level 1, 402,825.789 sh, **$7,601,322.64**, 6.8% of NAV (0001752724-24-299377, raw EDGAR checked). It feeds X-Ray, Period compare and Mark-implied returns only. Market, company, firm and Explore numbers are unaffected (they join reviewed companies). Rows with a name and neither id: **0**         | Medium                   |
| 2   | Market, firm and other cross views are mark-date hindsight, not "what was public then" | Medium | **Partly right**: a deliberate design (ADR 0004 "knownAsOf"; README "Values are as of each report date, not the filing date"), but the screens don't say it, and About says "latest filing on or before that date" (`web/src/pages/About.tsx` ~108)                       | `lib/services/market.js:37-45` has no filing-date cut; only company exposure takes `knownAsOf` (`lib/analytics/asof.js:241`, API only, no UI)                                                                                                  | Gen 34, operating companies. **2026-06-30:** 9,621 of 13,878 filings in force were filed after the date; $53.81B of $62.23B came from them; known by that day: $47.27B (−24%). **2025-12-31:** 9,434 of 13,523; $34.50B of $40.61B; known: $32.20B (−21%)                                                                                                                                                                                                                            | High (on-screen wording) |
| 3   | History uses today's company list and today's adviser                                  | Medium | **Known, disclosed** (`Basis.tsx` BASIS, DATA-QUALITY "History is read with today's curation" and "Firms are the current adviser", About)                                                                                                                                 | Measured before: adviser changes touch $0.05B of $640.6B (0.01%)                                                                                                                                                                               | None new. The design is sound for v1-style research. Keep it                                                                                                                                                                                                                                                                                                                                                                                                                         | Low                      |
| 4   | Firms footer adds up co-advised funds twice                                            | Medium | **Real, tiny**                                                                                                                                                                                                                                                            | `web/src/pages/Firms.tsx:62` sums shown firms; `lib/services/firm.js:6` gives a co-advised fund to both firms                                                                                                                                  | Live 2026-09-30: footer $73,836,658,181.96 vs unique $73,828,229,712.02 = **$8,428,469.94 (0.011%)**. Gen 34: 3 co-advised funds, mostly Vanguard High-Yield Corporate (Wellington and Vanguard)                                                                                                                                                                                                                                                                                     | Low                      |
| 5   | A generic class label pools different securities into one mark                         | Medium | **Real, new, and on screen**                                                                                                                                                                                                                                              | `lib/services/classes.js:55-70` averages a fund's lots; `severalMarks` is computed but no page shows it (`grep` in `web/src`: 0 hits); median, spread, leadership and marks-vs-others use the average                                          | Gen 34 at 2026-08-31: **44 of 1,150 class observations ($2.33B of $65.16B)**; 33 involve 2+ funds. Live: **Skyhawk Common 2026-05-31 median $31.21, spread 50.04%**, but raw rows are common PP 685,377 sh **$36,420,933.78** ($53.14) plus CVR 481,725 sh **$4.82** (0000035402-26-004656, raw EDGAR). Also: Commercial Barge Line "Warrant" mixes preferred warrants ($100.81) and common warrants ($0.625); World Labs "Series C" mixes Ser C Prime ($335.81) and Ser C ($313.57) | Medium                   |
| 6   | The time budget can't stop the first slow query                                        | Medium | **Known** (`lib/api/heavy.js:1-22`; STATUS Deferred "Performance": worker thread)                                                                                                                                                                                         | Live load test 2026-10-15: p95 48 ms at 100 users                                                                                                                                                                                              | None new                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Low                      |
| 7   | P8 30-night checkpoint still open                                                      | Medium | **Known, deferred on purpose** (STATUS phase tracker, "P8 remaining")                                                                                                                                                                                                     | Live since 2026-10-14; the last nightly was ok (`/readyz?report=1`, 2026-10-18); the first monthly run is 2026-11-03                                                                                                                           | 30 nights cannot exist yet (about 5 so far)                                                                                                                                                                                                                                                                                                                                                                                                                                          | Low                      |
| 8   | "Who filed each new mark first" / "First filed by" reads like SEC filing order         | Low    | **Real**                                                                                                                                                                                                                                                                  | `web/src/pages/company/Marks.tsx:200, 218` (the subtitle already says "by mark date, not filing date")                                                                                                                                         | Copy only                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Low                      |
| 9   | Old Level 3 wording in `parsers.js`                                                    | Low    | **Partly right**: the comment at `parsers.js:197-200` is stale, but `isPrivateHolding` only feeds `extractAllHoldings().isPrivate` (the old `buildFundXRay`, tests only) and `filing_totals`' labeled "v1 Level 3" figure. No production private-company decision uses it | `git grep`                                                                                                                                                                                                                                     | No number affected                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Low                      |
| 10  | STATUS is stale                                                                        | Docs   | **Real**                                                                                                                                                                                                                                                                  | `docs/STATUS.md:40` lists `/tracked` (now `/watchlist`); `:116` still says tab panels are deferred (done in close-out); the Suite and "Next session" lines date from P11                                                                       | Docs only                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Low                      |

## Reproducibility (run 2026-10-18; the reviewer could not run it)

- **Sample:** seeded random draw (seed 20261018) from the live `/api/market/top` (generation 40, 2026-09-30). It took
  12 random operating companies, then 20 positions from their live `/exposure` answers, at most 3 per company.
- **Newest month:** live, only **one** position carries a 2026-08 mark (Altice France, the only company with an
  August mark), so it was added as row 21. The newest month with many rows is 2026-07: 12 of the 21 rows. The "≥3
  from the newest month" rule cannot be met with August.
- **Coverage:** 10 companies (Epic Games, Celonis, Taalas, Versa Networks, Applied Intuition, Wasabi, Tonian, Valsoft,
  Lyte AI, Altice France) and 6 firms (Fidelity, T. Rowe Price, BlackRock, Brighthouse, First Pacific, American Beacon).
- **Result: 21 / 21 PASS.** Each row matched title, share count, value to the cent and report date in raw
  `primary_doc.xml`. Accessions:
  - 0001193125-26-366525, 0001410368-26-087644, 0000035402-26-006114, 0002071691-26-023083
  - 0000035402-26-006132, 0001099263-26-009611, 0001099263-26-010105, 0000035402-26-005568
  - 0000035402-26-005490, 0000035402-26-004618, 0000035402-26-006122, 0000035402-26-006160
  - 0001099263-26-010119, 0000035402-26-006151, 0001410368-26-085681, 0000035402-26-006276
  - 0002071691-26-019783, 0000035402-26-006148, 0000035402-26-006186, 0000035402-26-006298
  - 0001410368-26-105017
- **Company at a date:** Wasabi (116) as of 2026-09-30. Rebuilt from raw: 10 of 10 positions in 4 filings,
  **$54,955,503.33**, the same as live, diff $0.00. No raw Wasabi row was left out.
- **Firm book:** ARK Invest (58) as of 2026-09-30. Rebuilt from raw: 40 of 40 positions in 4 filings, **$678,529,720.46**,
  the same as live, diff $0.00. The filings: 0000940400-26-036464, -037955, -037945, -037958. No raw row naming a book
  company was left out.
- **Limit of the check:** which filing is in force for a fund came from Vantage's own filing list, not from EDGAR.

## Gaps the review missed

1. **Firms, firm pages and Explore count every category; Market counts operating companies.** Live 2026-09-30:
   - $10,584,052,677.60 (14.3% of the Firms footer) is fund interests ($8.38B), insurance vehicles ($1.75B) and CLOs
     ($0.46B);
   - the Firms page calls it "Private value". About says these are "listed apart from operating companies";
   - code: `lib/services/firm.js` `bookRows` and `analysis.pivot` take no category, while Market asks for `company`.
     The P10 call said "API default every category" but did not cover these screens.
2. **About states the as-of rule wrongly.** It says "latest filing on or before that date"; the glossary says
   "report", which is right (Finding 2).
3. **A $0 or near-$0 lot drags a fund's class mark** (the Skyhawk CVR). This is part of Finding 5, but worse than a
   spread: it changes the median itself.
4. **A wrong code comment** (`fund.js:202`) hid Finding 1. The row is never tagged, not "not tagged yet".

## Plan in waves

One branch and one PR per wave; the user merges. Gates for every wave: `npm test` (`--test-concurrency=2`),
`npm run lint`, `npm run format:check`, `npm run test:web`, `npm run lint:web`, `npm run build:web`. e2e runs in
CI on the PR. Each wave also needs an adversarial pass with its counterexamples committed as tests, and STATUS
updated. Any new number shown goes to GOLDEN-NUMBERS after a raw-EDGAR check.

### W1: Correctness guardrails and copy (small; branch `v2-review3-w1`)

Scope:

- **Fund X-Ray fails closed.** In `statusOf`, a row with no company and no entity becomes not private, with the
  reason "no issuer name in the filing (not classified)". It shows under "not private" with its value, never in
  `privateValueUSD`. Fix the comment.
- **Publish check** (`lib/warehouse/job.js` `validate`):
  - a problem (the job fails) when a row with a name has neither `company_id` nor `entity_id` (0 today);
  - a warning when the number of blank-name rows grows against the published generation (103 today).
- **Firms footer.** It shows the firm count only. Above the table, a line from the same `/api/firms` answer says
  "$X held by N funds; a fund with two advisers counts for both firms" (new `uniqueValue`, `uniqueFunds` in
  `firm.firms`). Each firm row keeps full attribution.
- **Marks wording** (`Marks.tsx`): the card becomes "Who first reported each new mark (by mark date)" and the
  column "First reported by". The subtitle stays.
- **About:** "latest report on or before that date (a report filed later still counts)".
- **`parsers.js`:** rename `isPrivateHolding` to `isLevel3Holding`, rewrite the stale comment, keep behavior.
- **STATUS:** route table `/watchlist`, the W3 "deferred" line marked "done in close-out", Suite and Next session
  lines.

Files: `lib/services/fund.js`, `lib/services/firm.js`, `lib/warehouse/job.js`, `parsers.js`, `web/src/pages/Firms.tsx`,
`web/src/pages/company/Marks.tsx`, `web/src/pages/About.tsx`, `web/src/api/types.ts`, docs.

Tests (counterexamples first):

- `test/fund.test.js`: a blank-name equity row is in `notPrivate` with the reason and is not in `privateValueUSD`
  or `privateByKind`. Neighbours:
  - a blank row at $0, a blank derivative, a blank debt row (stays in the capital structure);
  - a named unreviewed row with a non-private category;
  - `compare()` and `returns()` across a filing with a blank row;
  - first, middle and newest filing.
- `test/job.test.js`: a named untagged row fails validation; blank rows only warn and only when they grow; an empty
  or header-only warehouse passes. Keep the post-commit fault sweep green.
- `test/invariants.test.js`: no `isPrivate: true` fallback in `statusOf`; no `lib/services` or `lib/analytics` file
  imports the Level 3 helper.
- `test/views.test.js` (or `analysis.test.js`): one co-advised fund with one holding. Each firm gets the full value;
  `uniqueValue` counts it once; a firm with no co-advised fund gives `uniqueValue` equal to the sum.
- Web (Vitest): the Firms note reads from the response; the Marks labels say "reported" and never "filed".
- GOLDEN-NUMBERS **F60**: the L&G "N/A" row (0001752724-24-299377, $7,601,322.64, Level 1).

Success: no X-Ray answer counts a row Vantage cannot name. The 103 rows move to "not private", and X-Ray private
totals fall by exactly their value (a before and after diff over all 103 filings). No other view's number changes:
a diff of Market top, Firms and firm books at three dates is identical.

Browser: Fund X-Ray for S000080264 at 0001752724-24-299377; Firms; Company Marks (Anthropic). Light, dark and
375 px; no overflow; console clean.

### W2: Mark comparability (branch `v2-review3-w2`)

Scope:

- In `markStats`, a fund whose lots carry different marks (over 0.1%) is left out of median, low, high and spread,
  and is counted as `mixedFunds`.
- The same rule in every consumer: `marks.classesAsOf`, `staleMarks` and `markLeadership`
  (`marks.js:112, 167, 175`); `firm.js:234`; `analysis.marksVsOthers` (`analysis.js:958-960`); Compare (`:730`).
  One definition (LESSONS 26).
- The Marks page shows "N funds report several marks under this label; not in the spread", with their rows one
  click away.
- Measured first, not built blind: a CVR as its own class (`classOfRow`) and warrants of different series kept
  apart. The class feeds trap 52's within-class rule, so keep this only if a warehouse-wide `position_facts` diff
  shows nothing but the expected legs (LESSONS 36). Otherwise it goes to STATUS Deferred with the diff.

Files: `lib/services/classes.js`, `marks.js`, `firm.js`, `analysis.js`, `web/src/pages/company/Marks.tsx`, the firm
and fund Marks views, `web/src/api/types.ts`.

Tests:

- The Skyhawk shape (common $53.14 + CVR $0.00001): the fund is left out, and the median equals the clean funds.
- Two lots at the same mark stay in, and so do lots within 0.1%.
- Every fund mixed: no spread and no leadership, said as such.
- Commercial Barge warrants and World Labs Ser C Prime shapes.
- Preferred vs common are never pooled. Trap 63 is still a restatement.
- Leadership and marks-vs-others agree with `classesAsOf` on one fixture.
- A before and after list of the 44 observations at 2026-08-31.
- GOLDEN-NUMBERS **F61**: Skyhawk (0000035402-26-004656).

Success: no shown median or spread mixes marks within one fund. Live Skyhawk Common 2026-05-31 reads from clean
funds only.

Browser: Company Marks for Skyhawk (103), World Labs (96), Anthropic. Firm marks for Fidelity. Light, dark and
375 px; the badge wraps.

### W3: Say what "as of" includes, and a "known by" option where it is cheap (branch `v2-review3-w3`; scope per question 1)

Scope:

- **Copy on every as-of screen:** the AsOf picker, BasisNote, the glossary and export metadata. The text: "As of a
  date counts each fund's latest report on or before it, including reports filed later." Recommended whatever the
  answer to question 1.
- **If the user wants point-in-time:** an optional `knownAsOf` on `activeFilings` (`market.js`). Canonical choice
  then uses only filings made by that date. It feeds `/api/market/top`, `/api/firms` and `/api/firms/:id`, with a
  "Known by this date" switch on Market and Firms that lives in the URL.
- Explore, bridge and pivot stay hindsight: `position_facts` is built on the full filing chain, so a known-by
  bridge is its own project. Their screens say so.

Files: `lib/services/market.js`, `firm.js`, `lib/api/warehouse.js`, `web/src/scope/*`, `ui/Basis.tsx`, `AsOfPicker`,
`lib/glossary.ts`, `Market.tsx`, `Firms.tsx`, ADR 0004 amendment.

Tests:

- A report with mark date D filed after D is in hindsight at D and out of known-by D.
- An amendment filed after K: the original stays in force under known-by K.
- The 123-day edge in both modes; a $0 row is still "reported"; an empty result.
- Market top per company equals `exposureAsOf({knownAsOf})` for every company at two dates. Firm book equals the
  same rows.
- The URL round-trips; exports state the mode.
- No `knownAsOf` gives byte-identical answers to today's (golden A-tests unchanged).
- GOLDEN: re-verify the ADR's Anthropic 2026-06-30 pair (117 / $17.26B vs 82 / $6.23B) and check the largest
  known-by contributor on raw EDGAR before showing any market-wide known-by number.

Browser: Market and Firms with the switch on, off and cleared, plus Back/Forward. Light, dark and 375 px.

### W4: Category on Firms, firm pages and Explore (branch `v2-review3-w4`; per question 4)

Scope: the same category switch as Market. With the recommended default, operating companies:

- Firms, the firm book, firm timeline and matrix, and the Explore pivot and drill take `categories`;
- `?show=all` restores everything;
- each screen and export says which.

Tests:

- the firm book for category company equals Market top's rows for that firm's funds;
- the pivot cell equals `exposureAsOf` filtered to category;
- `?show=all` equals today's numbers;
- a firm holding only fund interests reads $0, with that said.

Success: Market, Firms and Explore give the same total for the same date and category.

Browser: Firms, firm 11 (Pantheon, mostly fund interests), Explore. Light, dark and 375 px.

### Not planned (known, with a reason)

- Point-in-time company status and adviser history: measured at 0.01% for advisers. `public_since` research is
  P8 W4.
- Cold-path performance tests and worker threads: the live p95 is 48 ms; already in STATUS Deferred.
- The P8 checkpoint: it closes on evidence (30 nights by about 2026-11-13, the monthly run on 2026-11-03), not on code.

## Questions only you can answer (each with my recommendation)

1. **What does "as of" promise: hindsight or "what was public then"?** Recommend: keep hindsight as the default,
   since it is the better picture of value at each mark date and v1 read it that way. Say it on every screen (W3).
   Add "Known by" on Market and Firms only, and leave Explore and the bridge hindsight for now.
2. **A fund with two advisers: full value to each firm?** Recommend yes on each firm's page, and the Firms total
   counts each fund once (W1). It moves $8.4M today.
3. **How strict on generic share classes?** Recommend: leave a fund out of the spread, median and leadership when
   its own lots under one label carry different marks. Show its rows with a note (W2). Coverage drops on 44 of 1,150
   observations.
4. **New: should Firms and Explore default to operating companies, like Market?** Recommend yes, with the same
   "show all" switch (W4). Today's Firms value then falls by $10.58B (14%) and matches Market.

Recommended order: W1 → W2 → W3 → W4. W1 and W2 can be built now. W3 and W4 wait on questions 1 and 4.
