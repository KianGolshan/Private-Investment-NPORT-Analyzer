# Vantage v2: the analyst workspace (UI and analysis plan)

## Context

P0–P5b and the P6 core are built. The warehouse has 355k N-PORT filings from 2019Q4 to 2026-09-30, 1.165M
private-candidate rows, 806 companies, 529 firms and 18.9k funds. Every row has a mark date and an accession. The
data is right, but the UI can't yet answer the user's two questions well:

1. **One private company in depth.** Search it by name and get consolidated data across every fund that holds it:
   price per share, market value and share count at one date or over any range back to 2019Q4. Narrow to one
   manager (Fidelity, Capital Group), one fund or one share class. See when each fund first bought, topped up,
   reduced or exited. Split each value change into **position (quantity) vs valuation (mark)**.
2. **Across funds and manager umbrellas.** See which periods each firm invested in, how its private book changed,
   how marks moved and which investments were added.

What blocks this today (from mapping the code):

- **The frontend shell can't host this kind of analysis.** It is one 4.6k-line global `app.js` plus `views.js` with
  `innerHTML` templates. There is no router (no Back button, a full reload on most links) and six separate search
  boxes. The company page is half v1, half v2. There are four copies of the date filter and 12 copies of the export
  functions. There is no dark mode and nothing filters across views.
- **The API has gaps.** Company endpoints take no firm, fund or class filter, and only some take a date range. No
  service decomposes a value change. No firm × period view exists: `firms()` is about 100 ms for **one** date, so
  computing 26 quarters on request would take seconds.

**Decisions made with the user:** a Vite + Preact + TypeScript frontend; a new shell, with v1 kept under "Legacy"
until each tab is replaced; a power-analyst-first design with clean, shareable URLs.

## Real-data checks already done (they decide the design)

- **The decomposition is supported.** Growth Fund of America, Stripe CL B (PHYSICAL), id ECS282034:
  - 2025-11-30 → 2026-02-28: 1,123,404 sh flat while the mark went $41.42 → $63.00. This is a pure mark effect,
    about +$24.2M.
  - 2026-02-28 → 2026-05-31: 1,123,404 → 3,504,356 sh at a flat $63.00. This is a pure add, 2,380,952 sh × $63 =
    +$150.0M.
  - Both still need to be verified on raw EDGAR (`primary_doc.xml`) before they become goldens.
- **Share-level data is broad.** 96% of rows carry a balance and 83% are in shares (NS), so most rows have a
  per-share price. 55% carry the filer's instrument id, which makes class series stable.
- **One company's full history is small.** The largest has 4,276 rows (Databricks 4,035; Anthropic 678). The whole
  history of one company can go to the browser once (about 50 KB gzipped) and be sliced there instantly by firm,
  fund, class and date.
- **One firm's full history is large.** Fidelity has 83.9k canonical rows (32.6k resolved to companies) and
  BlackRock 43k. Firm and cross-firm views therefore need server-side aggregation over a precomputed fact table.
- **Firm attribution is not dated.** It uses each fund's latest N-CEN. The ncen_advisers history (198k rows)
  could date it; this is a research task in W1.

## Design principles

1. **One scope, everywhere.** A global scope sits in the URL and every view honors it:
   - date mode: `asof=D` or `from=…&to=…`
   - firm, fund, class, kind (direct / indirect) and `knownAsOf`

   Every page is a permalink. Back and forward work.

2. **Entity pages plus a pivot.** Each company, firm, fund and class has its own page. One Explore pivot cuts across
   all of them. Every number drills down to the filing rows behind it.
3. **A bridge for every change.** Any value change over a range is shown as a reconciling waterfall:
   - start value
   - - first reported, + added (quantity), − reduced (quantity), − no longer reported
   - ± mark moved (price), ± value-only rows (no share count)
   - ± funds that started or stopped filing
   - = end value

   It must reconcile to the cent.

4. **Provenance on every number.** Each number shows its fund's mark date and links its accession. Mixed mark dates
   are visible, never hidden. Wording follows DATA-QUALITY: "first reported", "added", "reduced", "no longer
   reported", "reported at $0", "mark moved". Never a guessed cause.
5. **Group by identity, display by name** (trap 48): fund_key, company id, instrument key and firm id.
6. **Dense but calm** (an analyst tool):
   - tabular numerals, sticky headers, a density toggle
   - keyboard first: ⌘K, `/` to search, `g c` / `g f` to jump, `[` and `]` to step the date
   - light and dark themes from tokens; color-blind-safe palettes
   - every chart has a "view as table" twin and exports

## Information architecture

**Shell:**

- Top bar:
  - ⌘K command palette: one ranked search over companies, unreviewed names, funds, firms and share classes, with the
    match reason and `strong` (ROADMAP §6 item 3)
  - the scope bar (date mode plus filter chips)
  - the freshness indicator
- Left nav: Explore · Market · Activity · Tracked & Watchlist · Compare · Legacy

**Company workbench** `/company/:id-slug`. This is the centerpiece. The header shows status, aliases and brands,
holders, value, firms, first reported, last mark date, latest mark per class and a sparkline. Tabs:

| Tab                 | As of D                                                                                                                                                                                                      | Over a range                                                                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Overview**        | KPIs; value by firm (bar); holders by class                                                                                                                                                                  | Stacked value by firm, fund or class (switchable); a mark-per-share line per class with each firm's points; event markers on the timeline (first reported, added, reduced, exited); brush-zoom sets the range |
| **Holders**         | A grouped table firm → fund → class: shares, $/sh, value, % of fund, mark date, accession, and change since the prior filing (Δ shares, quantity effect, price effect). $0 and "no longer reported" sections | —                                                                                                                                                                                                             |
| **Positions grid**  | —                                                                                                                                                                                                            | A heatmap grid of fund (or firm) × mark date. The metric toggles between value, shares, $/sh and Δ. A click on a cell opens the filing row                                                                    |
| **Changes**         | —                                                                                                                                                                                                            | The **bridge waterfall** for the range plus an event ledger (filter by type), each event split into quantity and price effects. Per-period bars: new money vs mark effect                                     |
| **Marks & classes** | Each class's spread at one mark date; gaps within a filing; stale marks                                                                                                                                      | Split-adjusted per-share history per class, each firm's line plus the median; **mark leadership**: which firm moved first (ROADMAP §6 item 1)                                                                 |
| **Filings**         | The raw rows (title, id, units, level, accession)                                                                                                                                                            | The same rows in the range, exportable                                                                                                                                                                        |

A **position drawer** opens from any fund row. It shows one fund × company (× class) across its whole history:
shares, $/sh and value per filing, events, splits and links.

**Firm page** `/firm/:id`:

- Overview: book value over time, companies and funds holding, stacked by top companies; the bridge for the range.
- **Investment timeline:** a Gantt-style chart, one row per company. A bar runs while any of the firm's funds holds
  it. Dots mark first reported, added, reduced and exited. Sort by entry date or by value. This answers "which
  periods they invested".
- Book as of D: a company × fund matrix.
- Marks: the firm's marks per class against other firms' median (leader or laggard).
- Changes ledger; funds list.

**Fund page** `/fund/:key`:

- The same layout as the firm page at fund scope: overview, timeline, book, changes and bridge.
- X-Ray content moves here (private book by kind, compare, returns, capital structure).

**Explore (pivot)** `/explore`. This is the cross-cutting tool for need #2:

- rows: firm, fund, company, class or country
- columns: periods (month, quarter or year), keyed by mark date
- metric: value (as of the period end), holders, first reported (count and $), added $, reduced $, no longer
  reported $, net quantity flow, mark effect, median mark change
- filters: firm, company, tracked, kind, country
- output: a heatmap table with totals, a chart above it, and a drill from any cell to the event list; saved views
  through the URL

**Market:** top private companies as of D; **movers** (largest mark moves and largest net quantity flows in the
range); newly reported companies; by country.
**Activity:** the what's-new feed with a range and the scope filters.
**Tracked & Watchlist:** the dashboard plus a server-backed list of the user's own items (localStorage first).
**Compare:** 2–5 companies, firms or classes overlaid (replaces Batch).
**Legacy:** v1's index at `/legacy`, unchanged, including Private Credit (deferred scope).

**Period semantics (to be written into DATA-QUALITY display rules):**

- _Levels_ are always as of the period end (`exposureAsOf`).
- _Changes_ are dated by each fund's own mark date and summed over the window. Each change appears once, in its
  fund's filing.
- The UI labels this as "changes in filings with mark dates in Q2 2026". Mark dates are never relabeled to a
  quarter end.

## Engineering

### Backend (CommonJS, existing patterns)

1. **Migration `0019_position_facts.sql`.** One row per canonical filing × fund_key × subject (company_id or
   entity_id) × instrument_key. Columns:
   - report and filing dates, accession
   - balance, unit, value, price, split factor, class label, kind, firm_id
   - the previous point (date, balance, price, value)
   - event type and leg type
   - `qty_effect`, `price_effect`, `other_effect`
   - plus synthesized "no longer reported" rows at the exit filing

   It is built by refresh after entity upkeep, in one transaction, and logged.
   - **Quantity effect:** `(bal − prevBal·f) × prevPrice/f`. **Price effect:** `bal × (price − prevPrice/f)`.
     Here f is the split factor (`public/splits.js`).
   - Units and value-only rows go to `other_effect`.
   - **Reuse, don't re-implement:** first refactor the leg logic in `lib/analytics/activity.js` (lines 67–104 and
     162–177) into one exported `legsOf()` that both `companyActivity` and the fact builder use.
   - Measure size and build time on the real warehouse before committing (LESSONS 5). Estimated 60–90 MB against
     the 1 GB budget.

2. **`lib/services/analysis.js`.**
   - `bridge(scope, from, to)`
   - `pivot({rows, cols, metric, filters, from, to})`
   - `companyCube(id, scope)`: every row for one company in compact columnar JSON
   - `positionHistory(fundKey, subject, instrumentKey)`
   - `timeline(firm|fund)`
   - Each is memoized per refresh through `lib/services/memo.js`.
3. **Scope filters on the existing company routes.** Add `firm`, `fund`, `class`, `from` and `to` to exposure,
   history, activity, trend, classes and marks. Apply them after `companyRows` (`lib/analytics/asof.js:139`).
   Firms map through `fundFirms().byFirm` (`lib/services/firm.js:15`). Classes match by `classOf(instrumentLabel)`
   (`lib/services/marks.js:18`).
4. **Unified search.** `/api/search?kinds=company,entity,fund,firm,class` merges `lib/services/search.js`, the fund
   index (`lib/services/fund.js`) and firms. It keeps `strong`.
5. **New routes** in `lib/api/warehouse.js`: `/api/analysis/{bridge,pivot,timeline}`, `/api/companies/:id/cube`
   and `/api/positions/:fundKey/:subject`. Same envelope: `source`, `refreshId`, ETag and gzip.
6. **Research task (report findings either way):** dated firm attribution from the ncen_advisers history. Count the
   funds whose adviser changed and the value affected. Adopt it only if material; otherwise label the attribution
   "current adviser".

### Frontend (`web/`, Vite + Preact + TS, ESM)

- **Stack:**
  - `preact-iso` (router, lazy routes) and `@preact/signals` (state)
  - TanStack Table and Virtual (headless, sortable, grouped, virtualized)
  - **Apache ECharts**, imported modularly. One library covers time series with dataZoom brush, stacked area,
    heatmaps, waterfalls (stacked bars), Gantt-style bars and markers, plus dark themes and ARIA.
  - SheetJS lazy-loaded for XLSX.
- **Layers:**
  - `web/src/api/`: a typed client with response types mirroring the services, an AbortController per request
    (fixes today's stale-response races) and a cache keyed by URL + refreshId.
  - `web/src/scope/`: the URL ⇄ scope signal (single source of truth) and the date, range and firm/fund/class
    pickers.
  - `web/src/ui/`: DataTable (one column definition drives the table, CSV/XLSX export and the "view as table" twin),
    Chart wrapper, KPI, Badge, MarkDate, AccessionLink, Drawer, Tabs and CommandPalette.
  - `web/src/pages/`: company, firm, fund, explore, market, activity, tracked, compare.
- **Design tokens** live in `web/src/styles/tokens.css` (color, type, space, radius, density; light and dark),
  extended from today's navy and gold palette. The chart theme is built from the same tokens.
- **Serving:** Express serves `web/dist` with the SPA fallback for `/company/*`, `/firm/*`, `/fund/*`, `/explore`
  and so on, and the v1 page at `/legacy`. Dev runs the Vite proxy to Express. The CSP gets tighter, since there
  are no CDN scripts.
- **Budgets:**
  - initial JS ≤ 180 KB gzipped; charts and XLSX in lazy chunks
  - API p95 < 200 ms, with the new routes in `npm run bench`
  - interaction to updated view < 100 ms on the company cube

### Tests and goldens

- **Backend (`node --test`, golden fixture):**
  - The bridge reconciles to the cent, and its start and end equal `exposureAsOf` (LESSONS 26).
  - Pivot value cells equal `exposureAsOf` and `firmBook`.
  - The fact table's events equal `companyActivity`.
  - Scope filters equal a post-filter of the unfiltered answer.
  - Edges: $0 rows (trap 42), units (trap 40), splits (F13: no add, no mark move), amendments, inactive funds,
    trap 48.
- **New goldens, after verifying on raw EDGAR:** the Growth Fund of America Stripe decomposition, both steps, into
  GOLDEN-NUMBERS with accessions.
- **Frontend:**
  - Vitest + @testing-library/preact for components and the scope ⇄ URL round trip.
  - Playwright smoke tests against Express on the golden fixture: search → company → filter Capital Group → range
    → bridge totals match the API; firm timeline; explore drill; the Back button.
  - axe a11y checks in Playwright.
- The v1 jsdom suite stays for `/legacy`.
- CI adds `web` build, typecheck, lint, Vitest and Playwright.

## Delivery (a new ROADMAP section "P6b analyst workspace"; each wave ends at a checkpoint and the user's sign-off)

| Wave                   | Scope                                                                                                                                                                                        | Exit check                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **W0 Foundations**     | Scaffold `web/`, tokens and themes, shell, router, scope/URL model, API client, DataTable, Chart, export, ⌘K on the current `/api/search`, Express serving plus `/legacy`, CI                | Shell routes to existing data; Back works; lint, types and tests green                   |
| **W1 Data**            | `legsOf` refactor, migration 0019 and its builder in refresh (measured), `analysis.js`, scope filters, unified search, new routes in bench, the attribution research, goldens                | Equality tests vs `exposureAsOf`; bridge reconciles; p95 < 200 ms; size within budget    |
| **W2 Company**         | Workbench: all six tabs, position drawer, mark leadership                                                                                                                                    | Golden walkthrough on screen (A1, F30, the Capital Group Stripe path, the decomposition) |
| **W3 Firm & Fund**     | Overview, investment timeline, book matrix, marks vs median, changes, bridge; X-Ray ported to the fund page                                                                                  | Firm A3 (9 / $8.46B) on screen; timeline matches `firmChanges`                           |
| **W4 Cross-cutting**   | Explore pivot, Market (movers, newly reported), Activity, Tracked & Watchlist, Compare                                                                                                       | Pivot cells equal `exposureAsOf`; drill lands on the right events                        |
| **W5 Retire & polish** | Move Batch and Watchlist users to Compare and Watchlist; keep only Private Credit in Legacy; a11y audit, perf pass, docs (ARCHITECTURE module map, DATA-QUALITY period rule, README, STATUS) | Lighthouse ≥ 90 on perf and a11y; LIVE suite green                                       |

## Critical files

- Backend:
  - `lib/analytics/activity.js` (refactor to `legsOf`), `lib/analytics/asof.js` (scope filter, reuse
    `exposureSeries` and `privateRowsOf`)
  - `lib/services/{firm,marks,search,fund,market,memo}.js`
  - new `lib/services/analysis.js` and `lib/warehouse/position-facts.js`
  - `lib/warehouse/refresh.js` (build step), `db/migrations/0019_position_facts.sql`
  - `lib/api/warehouse.js`, `server.js` (static serving and the `/legacy` route), `scripts/bench.js`
- Shared: `public/splits.js` (splits) and `parsers.js` `instrumentKeyOf` (class identity). Reuse both; don't copy
  them.
- Frontend: the new `web/` tree; `public/index.html`, `app.js` and `views.js` stay as `/legacy` until W5.
- Docs: ROADMAP (P6b), ARCHITECTURE (module map and API), DATA-QUALITY (period semantics), GOLDEN-NUMBERS and
  STATUS.

## Verification (each wave)

- `npm test` (check the exit code), `npm run lint`, `npm run format:check`; `npm --prefix web run typecheck test
build`; Playwright smoke on the golden fixture.
- `npm run bench` on the live warehouse, with the load average recorded.
- `npm run test:live` at each checkpoint.
- Start the app with `preview_start`. Walk the goldens in the browser:
  - Anthropic as of 2026-03-31 = 72 funds / $5.93B
  - filter to Capital Group → the Stripe path $33.73 → $63.00
  - the bridge for 2025-11-30..2026-05-31 shows the +$150.0M add and the mark effect
  - the Fidelity firm timeline
  - an explore drill

  Then screenshot the result, in light and dark mode and at phone width.

- Each new number goes into GOLDEN-NUMBERS with its accession after a raw-EDGAR check.
