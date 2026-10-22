# UI coverage: every view, chart, control and number

How the browser suite covers the analyst workspace, and how to run it on the full warehouse. Written 2026-10-21
after a sector chart looked wrong in use (its band ran a period behind its line) and no test noticed.

## The idea

Hand-written checks cover the cases someone thought of. This suite adds three layers that find cases by
themselves:

| Part | File                           | What it does                                                                                                                                                                                                                                                                                                                                                                       |
| ---- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A    | `web/e2e/coverage.spec.ts`     | **The route walk.** Every route below is opened, then every tab, every option of every button group, every option of every drop-down (the first five and the last of a long one) and every switch is clicked in turn. After each step the page and its charts are audited. ~560 page states on the full warehouse. Also: sorting, CSV exports, phone width, chart-vs-table checks. |
| B    | `web/e2e/interactions.spec.ts` | **The clicks a walk cannot make:** search (⌘K, Enter), an Explore cell's drill-down, the watchlist, Compare's picker, the as-of picker, paging, theme and density, the XLSX export, the date carried from one tab to the next, the sector index KPIs.                                                                                                                              |
| C    | `web/e2e/consistency.spec.ts`  | **Every view agrees with the others**, through the API the pages read, at the newest date and two earlier ones: Market = Σ sectors = Σ industries = each sector page; a company's value = its holdings = its Market row; a firm = Σ companies = Σ funds; bridges reconcile; the mark index chains; Explore rows add up.                                                            |
| —    | `web/e2e/audit.ts`             | The audit itself: what every page and chart must satisfy whatever the data.                                                                                                                                                                                                                                                                                                        |
| —    | `web/e2e/audit.spec.ts`        | The audit's own test: each rule flags the bad chart or text it is written for (the old band first) and passes a good one.                                                                                                                                                                                                                                                          |

The older specs stay: `app.spec.ts` (behaviour and security, F01–F18), `a11y.spec.ts` (axe, light and dark).

## What the audit checks on every page state

Charts are read from what ECharts draws (`ui/Chart.tsx` puts the instance on its element), not from a picture:

- every series has one point per period on its axis; every point is a number (no NaN, Infinity, text);
- periods are in order, none repeated, no quarter or month skipped;
- a stacked area never goes below zero and has no hole;
- a helper series that cannot be seen never shows in the tooltip (the old band);
- the legend names only series that are drawn;
- no point is invisible (alone, with no symbol); nothing at or below zero on a log axis;
- a chart is never empty or all zero (the page says why instead);
- the chart has a size.

Pages: no `NaN`, `undefined`, `Infinity` as a number, `[object Object]`, `Invalid Date`, `null` or a doubled sign
in the text; no sideways scrolling (desktop and 375 px); no console error; no API answer of 4xx/5xx other than 404.

## Routes walked

Market (Top, Movers, Newly reported; all holdings; tracked; by sector, industry, theme; as of a past date) ·
Company (every tab; the position drawer; as of a past date) · an unreviewed name · Firms (latest, past) · Firm (every
tab) · Fund (every tab) · What's new (one page and all) · Explore (default, company rows over a range) · Sectors
(each level, each tab, ranges) · a sector, an industry and a theme page (default and a range) · Compare (empty,
companies, firms, funds) · Watchlist (tracked, yours) · About · Status. Ids come from whichever warehouse the server
reads (`discover` in `audit.ts`), so the same suite runs on the golden fixture and on the full warehouse.

## Running it

```bash
npm run build:web && npm run test:e2e     # CI: the golden warehouse (web/e2e/server.cjs), every spec
```

On the full warehouse, where odd charts actually show (one heavy job; ask first on this Mac). Start the server with
no per-visitor limits (the walk is one visitor making thousands of requests), then run the specs against it:

```bash
HEAVY_RATE_LIMIT_PER_MIN=100000000 VISITOR_MS_PER_MIN=100000000 BUSY_VISITOR_MS=100000000 API_RATE_LIMIT_PER_MIN=100000000 PORT=3007 node server.js
```

```bash
cd web && E2E_BASE_URL=http://localhost:3007 npx playwright test e2e/coverage.spec.ts e2e/consistency.spec.ts e2e/interactions.spec.ts e2e/audit.spec.ts
```

## Found and fixed by the first run (2026-10-21)

| #   | Where                                                                                        | What was wrong                                                                                                                                                                                                                                                                     | Fix                                                                                                                       |
| --- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| U1  | Sector, industry and theme pages                                                             | The 25th–75th percentile band applied each period's spread to the index level _before_ it, so it ran a period behind the line (the line sat above the band, e.g. AI 2025Q3 120.4 vs a band top of 112.9), and its invisible lower edge showed in the tooltip as "25th percentile". | The band is gone from the chart; the table has 25th and 75th percentile columns (the period's spread of company changes). |
| U2  | Every chart                                                                                  | ECharts replaced the chart's label with its own description, which read gaps as "NaN" to screen readers.                                                                                                                                                                           | The description is the chart's label, its series and a pointer to the table.                                              |
| U3  | Market › Newly reported at 375 px                                                            | The hidden link text ("N-PORT filing on EDGAR…") escaped the table's scroll box: the page scrolled sideways by 105 px.                                                                                                                                                             | `.table-wrap` is the hidden text's containing block.                                                                      |
| U4  | Movers, Newly reported, Sectors over time, Explore, Compare, book overviews, company changes | A date picked on an as-of view (Market's Top tab) was silently dropped next door: the range views read the year(s) to the newest filing.                                                                                                                                           | One rule, `windowOf` (scope.ts): the range, or the years up to the as-of date, or up to the newest filing.                |
| U5  | Sector pages whose index starts late                                                         | The KPI said "since Jun 30, 2024" when the index is 100 at a later quarter (too few companies marked at the start, e.g. AI models & labs: 2024Q3).                                                                                                                                 | The KPIs date the index from the period where it is 100.                                                                  |
| U6  | Sectors › Per-share marks                                                                    | The chart draws 8 groups; with 10 sectors or 41 industries the rest were dropped without a word.                                                                                                                                                                                   | A line under the chart says so and points to the table.                                                                   |
| U7  | Movers with a sector filter; the index with fewer than 5 companies                           | An empty chart was drawn.                                                                                                                                                                                                                                                          | The page says why there is nothing to draw.                                                                               |
| U8  | KPI tiles (Market, Movers, firm pages)                                                       | A long name with no spaces in a "Largest" tile pushed the page sideways (198 px on a phone); found with the security test's hostile name.                                                                                                                                          | Tile text wraps inside the tile.                                                                                          |

Checked and left as they are (by design, with the reason): the per-month position grid is sparse because each fund
files once a quarter on its own calendar; a firm with a tiny book draws flat next to a large one in Compare
(Vanguard $9.6M vs Fidelity $18.9B, both real); Explore lists the top 1,000 company rows and says so.
