# Vantage

An internal tool for analyzing SEC NPORT-P filings to track and compare private investment valuations across institutional funds. Search by company name or ticker to see how different funds mark the same asset over time.

> **Vantage v2** answers from an SEC-verified local warehouse: complete N-PORT history since 2019Q4, a refresh from
> EDGAR, an as-of engine (amendments, exits, dead funds, $0 positions handled), companies resolved from filing
> evidence, parent firms from Form N-CEN, and a tracked list of 180 private companies. Analyze it by:
>
> - **Issuer** (company page): holders as of any date with each fund's mark date, % of fund and filing; activity
>   per fund filing (first reported, added, reduced, no longer reported, reported at $0, mark moved, split-adjusted);
>   monthly trend of holders and value.
> - **Security** (share classes): every fund's per-share mark per class, spreads at one mark date, gaps within a
>   filing, stale marks, per-class mark history.
> - **Fund** (Fund X-Ray, `/fund/<key>`): private book split into operating companies, fund interests and vehicles;
>   period compare, mark-implied returns, changes filing by filing.
> - **Manager** (Firms, `/firm/<id>`): a firm's book as of any date, its marks per class, its position changes.
> - **Market** (Market & What's New): top private companies as of any date, by country, the tracked dashboard, and a
>   feed of changes in newly filed reports. Every view exports CSV with mark date, accession and source.
>
> Listed companies and debt come from live EDGAR, labeled; a listed company's private-era marks open on request.
> Some sections below still describe v1's live flow.
>
> - Plan: [docs/ROADMAP.md](docs/ROADMAP.md) · Progress: [docs/STATUS.md](docs/STATUS.md) · Design:
>   [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · Data rules: [docs/DATA-QUALITY.md](docs/DATA-QUALITY.md) ·
>   Verified figures: [docs/GOLDEN-NUMBERS.md](docs/GOLDEN-NUMBERS.md) · Decisions: [docs/decisions/](docs/decisions/)
>   · How we work: [docs/LESSONS.md](docs/LESSONS.md), [CLAUDE.md](CLAUDE.md) · History: [docs/archive/](docs/archive/)
>
> **Known limits, measured on real data:**
>
> - The live path (listed companies, debt, names the warehouse cannot match) parses at most the newest 250
>   matching filings (25–250, selectable). Private companies, funds and firms come from the warehouse with no limit.
> - A fund's "private" book follows the company's reviewed status, not its fair-value level (the Level-3 figure is
>   shown beside it). Loans a filer reports as "other" (merchant cash advances, personal loans…) count as debt.
> - Filings arrive about 60 days after each report date, so the newest month is always partial.

---

## What It Does

Institutional funds registered with the SEC are required to file NPORT-P reports disclosing their portfolio holdings quarterly. Vantage queries the SEC EDGAR database in real time, parses the raw XML filings, and extracts price-per-share data for any security you search — letting you see how different funds value the same private company across reporting periods.

**Use cases:**
- Compare marks on private investments across funds (e.g., Anthropic, OpenAI, SpaceX)
- Track valuation trends over time
- Identify divergence in how funds price the same asset
- Export data for further analysis

It also includes a **Private Credit Analysis** mode that does the same thing
for privately-held companies held as loans by Business Development Companies
(BDCs), by parsing the Schedule of Investments tables in their 10-Q and 10-K
filings instead of NPORT-P (the 10-K carries the fiscal year-end marks that no
10-Q reports).

A third mode, **Fund X-Ray**, flips the question around: instead of searching
for a company and finding which funds hold it, you search for a *fund* and
see its total private-equity book — every Level 3 (fair-value-hierarchy)
equity, warrant, or SPV holding in its most recent NPORT-P filing, broken
down by dollar exposure, % of net assets, instrument type, and geography.
It can also compare that book across two periods (quarter-over-quarter or
year-over-year): new investments, exits, share-count and price-mark changes
per position, and a breakdown of how much of the fund's value change came
from marking existing positions up/down versus buying more or selling some
down.

---

## Features

- **Single security search** — search by company name or ticker, set a filing limit, and get all matching holdings plotted on a price-per-share timeline
- **Batch search** — search up to 10 securities at once, each displayed as a separate section with its own chart
- **Watchlist** — save issuers you track repeatedly (stored in your browser only) and re-run the full list in one click, with no per-search cap
- **Basket Leaderboard** — a sortable rollup above Batch Search/Watchlist results ranking every name by peer-mark dispersion and filing age, so a multi-name review surfaces its most contested and stalest marks first instead of reading N separate sections in order
- **Private Credit Analysis** — search any issuer name to find every BDC fund reporting it as a loan, and chart the fair-value mark (% of par) across funds and time, from both 10-Qs and 10-Ks (so fiscal year-end marks aren't missing)
- **Fund X-Ray** — search a fund/registrant name to pull its own NPORT-P filing in full and see its total private-equity exposure: $ value and % of NAV, broken down by instrument type (common/preferred/warrant/SPV) and country, with every private holding listed
- **Fund X-Ray period comparison** — compare a fund's private-equity book across two periods (one click for the prior quarter or prior year, or pick any two periods manually): new investments, exits, share-count changes, and a decomposition of the value change into "from price marks" vs. "from position sizing," plus notable mark-ups/mark-downs ranked by dollar impact
- **Fund X-Ray capital structure** — issuers a fund holds through several instruments at once (e.g. preferred + warrant + term loan) are rolled up per issuer, senior-first, with debt share and weighted coupon
- **Fund X-Ray mark-implied returns** — a return history per private position built from the fund's own last filings: proxy cost per lot (entry and add-ons, costed at the fund's mark), partial sales, exits, conversion chaining, MOIC and IRR. These are proxies — NPORT-P never reports what a fund paid — and the UI says so and flags positions held before the oldest filing
- **Mark analytics** — on Single Security/Batch/Watchlist: each fund's mark change vs its own earlier filing, an outlier badge when a fund's mark sits far from same-class peers (robust MAD-based, only against peers with comparable-date marks), a collapsible "repricing episodes" ledger showing who marked first (funds have different fiscal calendars, so marks are never blended into one fitted line), and a Mark Velocity column in the Basket Leaderboard
- **Fund X-Ray for multi-series trusts** — a trust like Fidelity Advisor Series I or American Funds Insurance Series files one NPORT-P per fund series under a single CIK, so its filing list interleaves dozens of different funds. Search by the trust's name and pick the exact fund from a **Fund** list (discovered by reading each recent filing's header), and periods, comparisons and returns stay inside that one fund
- **Stock-split handling** — NPORT-P never reports corporate actions, so a split reads as a purchase and a markdown. Units changing by a clean ratio while price moves the opposite way at roughly constant value (real: SpaceX SPVs 5-for-1, Perplexity/Discord/Runway 10-for-1, Motive 1-for-3) is recognized and excluded from the returns lots, the price/position-sizing decomposition, mark velocity, outlier flags and the repricing ledger
- **Summary stats** — latest price, price range, number of reporting funds, total data points, and date range shown at a glance
- **Interactive charts** — toggle individual data points on/off via checkboxes; chart updates live
- **Reference line** — plot your own price or mark (a cost basis, ask price, or benchmark) against peer data and see the divergence from the peer median
- **Date and class filtering** — narrow results to a date range, or isolate a specific share class/tranche via one-click chips or free-text matching
- **Collapsible fund tables** — expand/collapse per-fund data; select all or none per fund
- **Source links** — every data point links back to its originating filing on EDGAR
- **Export** — download results as CSV, Excel (`.xlsx`), or PDF (landscape with chart + data table); exports reflect whatever is currently checked/filtered on screen

---

## Setup

### Prerequisites
- [Node.js](https://nodejs.org/) v22 or later (required by `better-sqlite3`)
- npm

### Install

```bash
git clone https://github.com/KianGolshan/Private-Investment-NPORT-Analyzer.git
cd Private-Investment-NPORT-Analyzer
npm install
npm --prefix web install      # the analyst workspace (Vite + Preact + TypeScript)
npm run build:web             # builds web/dist, which the server serves at /
```

### Configure

The SEC requires a `User-Agent` header identifying who is making requests to EDGAR. Copy the example env file and fill in your details:

```bash
cp .env.example .env
```

Edit `.env`:

```
SEC_USER_AGENT=Your Name your.email@example.com
PORT=3002
```

> The SEC's [fair access policy](https://www.sec.gov/developer) asks that automated requests include a valid name and email. Requests without a proper User-Agent may be rate-limited or blocked.

### Run

```bash
npm start
```

Then open [http://localhost:3002](http://localhost:3002) in your browser.

For development with auto-reload:

```bash
npm run dev
```

The analyst workspace (`web/`) is served at `/` once built (`npm run build:web`); v1's tabbed page stays at
`/legacy`. Without a build, `/` serves v1 as before. To work on the workspace with hot reload, run the server and
`npm run dev:web` (Vite on port 5173, proxying `/api` to the server; set `VANTAGE_API` if it is not on port 3000).
Workspace checks: `npm run test:web` (typecheck and Vitest) and `npm run lint:web`.

### Build and refresh the data warehouse (Vantage v2)

The v2 warehouse loads the SEC's quarterly N-PORT bulk datasets (2019Q4 onward) into a local
`warehouse.db`. It's a separate file from `cache.db`, and git-ignored. The app reads it read-only (Phase 5,
see [docs/ROADMAP.md](docs/ROADMAP.md)).

```bash
npm run ingest:bulk -- --all
```

That loads every quarter, which took about 14 minutes on 2026-09-28. After that, `--missing` loads only
quarters not yet loaded, and `--quarter 2026q2` reloads a single quarter. Each quarter loads in one
transaction and is logged in `ingest_log`. A failed run exits non-zero and changes nothing for that quarter.

Bulk data ends at the last quarter-end, so recent filings come from EDGAR directly:

```bash
npm run ingest:delta   # every N-PORT filed after the newest bulk quarter
npm run refresh        # nightly job: new or re-posted bulk quarters, catch-up, N-CEN, entity upkeep
```

The first catch-up after a full backfill took 27 minutes (11,822 filings at the SEC's rate limit). A
routine refresh takes 20 seconds to 2 minutes, and only one runs at a time. Both commands can be
interrupted and resumed. Filings that fail are listed in `ingest_errors` and retried on the next run. To
run the refresh nightly, use the launchd or cron entry in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#refresh-lifecycle).

Companies, aliases and parent firms are human-reviewed files in `data/review/`:

```bash
npm run ingest:ncen       # N-CEN advisers (parent firms)
npm run seed:entities     # suggest data/review/{aliases,managers}.csv (--force to overwrite)
npm run review:aliases    # import the reviewed files and re-resolve holdings
npm run entities:report   # the review queue: unresolved value by company, conflicts (reports/entities/)
```

### Tests

```bash
npm test          # run the test suite (unit + integration, against real-filing fixtures)
npm run lint       # check code style
npm run format     # apply Prettier formatting
```

```bash
npm run test:live  # opt-in: real SEC, real filings, real UI → backend → EDGAR (a few minutes)
```

The suite has several layers, each testing something the others structurally
can't reach:

- `test/parsers.test.js` / `test/analytics.test.js` — pure NPORT-P
  extraction, classification, capital-structure and mark-implied-return
  logic against real filing fixtures in `test/fixtures/` (plus hand-computed
  synthetic period sequences), with no network or server involved.
- `test/server.test.js` / `test/cache.test.js` / `test/edge-cases.test.js` —
  the Express routes and SQLite cache, with SEC calls intercepted via
  `nock`; edge-case suite covers degenerate inputs, cache-key normalization,
  parameter validation, static-file exposure and response hygiene.
- `test/app-*.test.js` — the browser-side code (every tab: Single Security,
  Batch, Watchlist, Private Credit, Fund X-Ray, mark analytics, escaping
  regressions) runs the real `public/index.html` + `public/app.js` in a
  `jsdom` window via `test/helpers/loadApp.js` (fake Chart.js, `fetch`
  mocked per test via `test/helpers/fakes.js`) — this is the layer that
  exercises what actually ends up on screen.
- `test/real-data.test.js` / `test/credit-real.test.js` — offline, but every
  input is a REAL value or filing captured from EDGAR (stock splits, dummy
  CUSIPs, "N/A" issuer names, multi-series trusts, and six-plus real BDC
  10-Q layouts). These are the regression tests for bugs only real data
  exposed.
- `test/prod-startup.test.js` — real child processes: production refuses to
  start without a user agent, X-Forwarded-For handling, rate limits, legacy
  cache files.
- `test/live-e2e.test.js` / `test/live-popular.test.js` — skipped unless
  `LIVE_SEC=1` (`npm run test:live`, several minutes). Nothing mocked: the
  real UI → Express app → real SEC on popular names (Anthropic, OpenAI,
  SpaceX, Databricks, Stripe-era funds, Anaplan/Kaseya/Pluralsight/Medallia/
  Finastra borrowers), asserting invariants recomputed independently from
  the rows on screen, real historical events (splits), every Top Funds
  shortlist name, and multi-series trusts.

---

## Usage

### Single Security

1. Enter a company name (e.g., `Anthropic`, `OpenAI`, `SpaceX`) or ticker in the search box
2. Choose how many filings to process (25 / 50 / 100 / 250) — the **most recent** matching filings are kept
3. Click **Search NPORT Filings**
4. Results show a price-per-share trend chart and a table of holdings broken down by fund. If EDGAR matched more filings than you chose to parse, the result message says so ("Parsed the 50 most recent of 837 matching filings") — a capped run never passes for complete coverage

### Batch Search

1. Switch to the **Batch Search** tab
2. Enter up to 10 securities, one per line
3. Click **Search All Securities**
4. A **Basket Leaderboard** appears above the per-security results (see below), followed by each security's own chart and fund breakdown

### Watchlist

1. Switch to the **Watchlist** tab and add issuer names you track repeatedly
2. Click **Run Watchlist Search** to run the same peer-comparison search as Batch Search — leaderboard included — against your full saved list (no 10-issuer cap)
3. The list is stored in your browser's local storage only — it isn't synced or shared. Searches NPORT-P (mutual fund) holdings only; Private Credit/BDC issuers aren't tracked here, since BDC 10-Q/10-K filings use a separate search

### Basket Leaderboard

Batch Search and Watchlist both roll their results up into one sortable
table before the per-security detail: for each name, its most recent mark,
the range and **dispersion** across every reporting fund's own latest mark
(`(max − min) / median`, as a %), fund count, and **age** (days since that
most recent filing). Click any column to sort, or click a name to jump to
its section below.

Dispersion answers the actual cross-basket question a valuation review
needs — which names do institutional holders disagree on most right now —
and deliberately uses only each fund's single most recent mark, not every
mark it's ever filed: pooling across time would conflate one fund's price
*drift* over several quarters with genuine cross-fund *disagreement*, which
is a different (and less useful) signal. Age flags marks that are old enough
to be worth a second look before relying on them — NPORT-P is filed up to
60 days after quarter-end, so a mark past ~90-180 days is running behind a
normal filing cadence.

### Fund X-Ray

1. Switch to the **Fund X-Ray** tab. Either pick a fund from the **Top Funds** dropdown — a curated shortlist of well-known funds, grouped by manager (see [Top Funds dropdown](#fund-x-rays-top-funds-dropdown) below) — to autofill and search with no typing, or enter a fund/registrant name yourself (e.g., `SmallCap World Fund`, `REX ETF Trust`) in the search box — this looks the fund up by name on EDGAR directly (not full-text search), so it finds the fund's own filings rather than other funds that merely mention it
2. If the name matches more than one registrant, every match's filings appear together in the **Reporting Period** dropdown, labeled by fund name, so you can pick the exact one you meant (capped at the first 5 candidate registrants — a message tells you how many more weren't shown if your search was that ambiguous, e.g. a bare "Fidelity")
3. Results show the fund's total private-equity $ exposure, % of net assets, an instrument-type breakdown (common/preferred/warrant/SPV), a country breakdown, and every private holding found (company, shares, price/share, $ value, % of NAV, fair value level) — not just a preview; export to CSV, Excel, or PDF for the same data plus higher-precision per-share pricing
4. A holding counts as private equity only if it's flagged **Fair Value Level 3** (valued with unobservable inputs — no real market for it) **and** is an equity-type instrument. Bonds and loans are excluded even at Level 3 (they're creditor claims, not equity stakes), and a "restricted security" flag alone doesn't qualify a holding either — a foreign-ownership-restricted but still publicly-traded stock (Level 2) is a real public company, not a private one
5. To compare periods, use the **Compare To** dropdown next to Reporting Period, or click **vs Prior Quarter** / **vs Prior Year (YoY)** to auto-pick the nearest matching filing (YoY matches within ±45 days of exactly one year back; if nothing qualifies, you're told so rather than silently comparing against the wrong quarter)
6. The comparison view leads with the analysis — aggregate value/holdings/issuer deltas, a price-marks-vs-position-sizing breakdown of the value change, and Key Insights cards (securities added/dropped, positions increased/reduced, notable mark-ups/mark-downs ranked by $ impact) — followed by each period's own full breakdown (Most Recent Period, then Prior Period) and a full position-by-position detail table, each independently exportable to CSV, Excel, or PDF

### Filtering

- **Date filter** — appears after a search completes; set a start/end date to narrow the visible data points and chart
- **Class filter** — click a chip to toggle one share class/tranche everywhere in a section, or type into the filter box to fuzzy-match across naming conventions
- **Reference line** — enter a price (Single Security, or per-security on Batch/Watchlist) or mark (Private Credit) to plot it as a dashed benchmark line and see its percentage divergence from the peer median. On Batch/Watchlist each security gets its own reference input, since one shared $ figure wouldn't mean anything across different companies
- **Checkboxes** — uncheck individual rows to remove specific data points from the chart (and from CSV/Excel/PDF exports) — available on Single Security, Batch, Watchlist, and Private Credit
- **All / None buttons** — select or deselect all rows for a given fund at once

### Fund X-Ray's "Top Funds" dropdown

The **Top Funds** dropdown on the Fund X-Ray tab is a curated, static list
of well-known fund/registrant names, grouped by manager (e.g. "Capital
Group (American Funds)" → SmallCap World Fund, Growth Fund of America, New
Economy Fund, ...) — defined directly in `public/app.js`
(`TOP_FUND_GROUPS`). Every name in it was resolved to a real EDGAR
registrant with genuine Level-3-equity (private-company) holdings, verified
live at the time the list was written — not a blind guess.

It is deliberately **not** a pre-built index of $ figures or verified
filing histories. Picking a fund just fills in the "Fund / Registrant Name"
box and runs `searchFundXray()` — the exact same live search
(`/api/search-fund` → `/api/fund-xray`) that typing a name and clicking
Search already does. There's no offline build step, no generated data file,
and nothing that can go stale: every selection is a fresh EDGAR lookup, the
same as Single Security and Batch Search already are. A listed fund can
still turn out to show little or no private exposure on a given quarter —
that's a live result, not a bug, exactly like it would be if you'd typed
the name in yourself.

To add a fund to the dropdown, add its name under the right manager (or a
new one) in `TOP_FUND_GROUPS` in `public/app.js` — no rebuild, no script,
no server change needed.

### Exporting

After a search, use the export buttons at the bottom of the results — every tab (Single Security, Batch, Watchlist, Private Credit, Fund X-Ray, and Fund X-Ray's period comparison) offers CSV, Excel, and PDF. All three formats reflect exactly what's checked/filtered on screen, not the raw unfiltered result set.

| Format | Contents |
|--------|----------|
| CSV | Flat file of all holdings |
| Excel | Single security: one sheet. Batch: one sheet per security + combined sheet. Private Credit / Fund X-Ray: one sheet |
| PDF | Landscape; chart image (where applicable) + full data table |

---

## How It Works

1. **Search** — queries `https://efts.sec.gov/LATEST/search-index` for NPORT-P filings matching the search term. EDGAR returns at most 100 hits per request, so the server pages through them (up to `EFTS_MAX_HITS`, default 1,000) — reading only the first page used to silently drop most matches on popular names (Anthropic alone has 800+)
2. **Parse** — fetches `primary_doc.xml` from each filing's EDGAR archive path and parses the XML
3. **Extract** — walks the investment holdings in the XML, matches by name/ticker, and pulls shares, market value (USD), currency, and exchange rate
4. **Price calculation** — `price per share = market value (USD) / shares`. For non-USD holdings with an exchange rate provided, the local-currency price is also computed as `price (USD) × exchange rate`
5. **Display** — the most recent N filings (your Max Filings choice) are parsed; results are grouped by fund, deduplicated by `(reportDate, shares)`, and rendered with Chart.js

Every outbound SEC request is paced process-wide (one every
`SEC_MIN_INTERVAL_MS`, default 110 ms) to stay within SEC's ~10 req/sec
fair-access guidance. Throttled responses (`429`/`503`) are retried patiently
with exponential backoff, honoring `Retry-After`; transient `500`/`502`/`504`
get two retries. Any filing that still fails to fetch/parse is reported to you
as a failure count rather than being silently dropped.

**Private Credit mode** works the same way but against BDC 10-Q and 10-K filings:

1. Full-text search EDGAR for 10-Q and 10-K filings mentioning the issuer (every page of hits, as above), keeping
   only filers whose Investment Company Act file number starts with `814-`
   (the SEC's own BDC designation — no hard-coded fund list needed)
2. Pull each identified BDC's complete 10-Q and 10-K filing history from the EDGAR
   submissions API, to fill in older quarters the full-text search index may
   have missed
3. Fetch each filing's primary HTML document and heuristically locate its
   Schedule of Investments table (column headers vary a lot between filers)
4. Extract principal, cost, and fair value per tranche, and compute
   `fair value mark = fair value / principal × 100`

**Fund X-Ray mode** works against the same NPORT-P filings, but resolves and reads them differently:

1. Resolves the fund name to its registrant CIK via EDGAR's company-name lookup (`browse-edgar?action=getcompany`) — not full-text search, which matches filing *content* and would mostly surface unrelated funds-of-funds that merely mention the fund as one of their own holdings
2. Pulls that CIK's complete NPORT-P filing history via the EDGAR submissions API (cached for an hour, same TTL as other search results below), paginating into older filing pages when a filing-heavy multi-series trust's "recent" submissions block (capped across *all* its form types, not just NPORT-P) would otherwise truncate the history
3. Fetches the selected filing's `primary_doc.xml` and parses **every** holding in it — unlike Single Security/Batch, which only extract holdings matching a search term
4. Classifies each holding as private equity if it's Fair Value Level 3 **and** an equity-type instrument (common/preferred stock, warrant, or indirect/SPV vehicle); debt is excluded outright regardless of its fair-value level, and a restricted-security flag alone never qualifies a holding
5. Aggregates the private book into $ exposure, % of net assets, instrument-type mix, and country mix
6. For a period comparison, matches the same private investment across two filings by CUSIP (preferred, since it's a stable cross-period identifier) or, failing that, by normalized issuer name + security title (title is kept because share-class distinctions, e.g. Series A vs. Series B preferred, are economically different positions) — then decomposes each continuing position's value change into a price-mark effect (`shares(prior) × (price(current) − price(prior))`) and a position-sizing effect (`price(current) × (shares(current) − shares(prior))`), which sum exactly to the position's total value delta with no residual

---

## Project Structure

```
├── server.js          # Express API server and routes
├── parsers.js          # NPORT-P / 10-Q / 10-K XML and HTML extraction logic
├── cache.js            # SQLite-backed cache for parsed filings and search results
├── public/
│   ├── index.html     # Single-page frontend (HTML + CSS; CDN scripts SRI-pinned)
│   ├── app.js          # Frontend logic (search, company and fund pages, charts, export)
│   ├── views.js        # Analysis views: activity, trend, share classes, market, feed, firms
│   └── splits.js       # Stock-split detection, shared by browser and server
├── test/               # Unit, integration, jsdom UI and opt-in live tests, with real-filing fixtures
├── lib/warehouse/      # v2 warehouse: migrations, bulk and EDGAR ingest, refresh, fund identity
├── lib/entities/       # companies, aliases, identity graph, review import, managers
├── lib/analytics/      # as-of engine, position changes, peer statistics
├── lib/services/       # company, fund, firm, market, marks, search, dashboard (shared by server and MCP)
├── lib/api/            # read-only warehouse routes; local admin route
├── db/migrations/      # Numbered SQL migrations for warehouse.db
├── scripts/            # CLI jobs (ingest-bulk.js, ingest-delta.js, refresh.js)
├── docs/               # v2 roadmap, status, architecture, data-quality rules, golden numbers, ADRs
├── CLAUDE.md           # Standing rules for contributors and AI coding sessions
├── .github/workflows/  # CI: tests on Node 22/24, lint, format check
├── eslint.config.js    # Lint config (Prettier handles formatting)
├── package.json
├── .env.example       # Environment variable template
└── .gitignore
```

### API Routes

The warehouse routes (`/api/search`, `/api/companies/…`, `/api/entities/…`, `/api/funds/…`, `/api/firms/…`,
`/api/market/…`, `/api/feed`, `/api/freshness`) are listed in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#warehouse-api-read-only-libapiwarehousejs). The live-path routes:

| Route | Method | Description |
|-------|--------|-------------|
| `/api/config` | GET | Returns whether `SEC_USER_AGENT` is configured |
| `/api/search-nport?security=` | GET | Searches EDGAR for NPORT-P filings matching the query |
| `/api/parse-nport?cik=&accession=&security=` | GET | Fetches and parses a single NPORT-P filing, returns matching holdings |
| `/api/search-10q?issuer=&maxPerFund=` | GET | Finds BDC funds (814- file number) reporting the issuer, plus each fund's full 10-Q **and 10-K** history (each filing carries its `form`) |
| `/api/parse-10q?cik=&accession=&issuer=&reportDate=` | GET | Fetches a single 10-Q or 10-K (the route name predates 10-K support), parses its Schedule of Investments table for the issuer |
| `/api/search-fund?fund=` | GET | Resolves a fund/registrant name to its EDGAR CIK(s) via company-name lookup, then returns each match's full NPORT-P filing history |
| `/api/fund-xray?cik=&accession=` | GET | Fetches and parses one NPORT-P filing in full, returns the fund's private-equity exposure breakdown |
| `/api/fund-xray-compare?cik=&currentAccession=&priorAccession=` | GET | Fetches two of the same fund's filings and diffs their private-equity books: new/exited positions, per-position share/value/price-per-share deltas, and a price-marks-vs-position-sizing value decomposition |
| `/api/fund-xray-returns?cik=&accessions=a,b,c` | GET | Mark-implied return history across 2–12 of one fund's filings: proxy-cost lots, add-ons, partial sales, split and conversion handling, MOIC/IRR per position and in total |
| `/api/fund-series?cik=` | GET | For a trust that files per fund series, lists its funds (read from recent filing headers); `multiSeries:false` for a single fund |
| `/api/fund-series-filings?cik=&seriesId=` | GET | One fund series' own NPORT-P history via EDGAR's series-level feed, with report dates joined from the registrant |

`cik` must be up to 10 digits and accession numbers 18 digits (dashes
allowed); anything else is a `400` before any SEC request is made. Errors from
SEC requests come back as a short summary (`SEC request failed (HTTP 404)`),
not raw HTTP-client detail.

### Security

- **Security headers** on every response: a Content-Security-Policy that only
  allows scripts from this server and the two CDNs below and only lets page
  code call this server's own API, plus `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer`.
- **CDN scripts are pinned with Subresource Integrity** (`integrity=` hashes in
  `public/index.html`), so an altered CDN file is refused by the browser. When
  bumping a version, recompute its hash with
  `curl -s URL | openssl dgst -sha384 -binary | openssl base64 -A`.
- **Rate limits**: `API_RATE_LIMIT_PER_MIN` (default 1,500) per visitor on all
  `/api/*` routes, and a separate `REFRESH_RATE_LIMIT_PER_MIN` (default 30) on
  requests that force a cache bypass (see Caching below).

---

## SEC Data Notes

- NPORT-P filings are submitted quarterly; the most recent filing may be up to ~75 days behind the actual reporting period
- Each fund publishes one NPORT-P per *fiscal* quarter. Month-1 and month-2 reports are filed but not made public. Fund calendars are staggered: within Capital Group, some funds report Feb/May/Aug/Nov and others Mar/Jun/Sep/Dec. Marks from different funds therefore rarely share a date, so compare them with each fund's report date in view
- Not all funds file NPORT-P — only registered investment companies (mutual funds, ETFs, interval funds) are required to file; hedge funds and private funds generally do not
- Market values in NPORT filings are as of the report period end date, not the filing date
- Some filings may use non-standard XML structures; the parser handles multiple known variants but may miss edge cases

---

## Caching

The same 70+ issuers tend to get re-checked repeatedly (especially via
Watchlist "run all"), so results are cached server-side in a local SQLite
file (`cache.db`, gitignored, created automatically on first run):

- **Parsed filing holdings** (`/api/parse-nport`, `/api/parse-10q`,
  `/api/fund-xray`) are cached indefinitely, keyed by `(cik, accession,
  security)` / `(cik, accession, issuer, reportDate)` / `(cik, accession)`
  — a specific historical filing's content never changes.
- **Search-result listings** (`/api/search-nport`, `/api/search-10q`,
  `/api/search-fund`, and a fund's own NPORT-P filing history used
  internally by Fund X-Ray) are cached for 1 hour by default (override with
  `SEARCH_CACHE_TTL_MS` in `.env`), since new filings get added over time.
- Add `&refresh=1` (or `&refresh=true`; no other value counts) to any
  cached route to bypass the cache and force a fresh SEC fetch for that
  request. Forced refreshes have their own per-visitor budget
  (`REFRESH_RATE_LIMIT_PER_MIN`, default 30/min), since they're the one way a
  visitor can push this server's shared SEC traffic. `/api/fund-xray-compare`
  and `/api/fund-xray-returns` have no cache entry of their own — they reuse
  `/api/fund-xray`'s cached logic per filing, so `&refresh=1` there refetches
  every filing involved.
- If the extraction logic in `extractHoldings()` / `extractCreditHoldings()`
  / `extractAllHoldings()` ever changes, bump `PARSE_VERSION` in `cache.js`
  so old cached results (parsed with the previous logic) are treated as
  misses instead of being served forever. Rows from older versions are
  deleted automatically at start-up, since they can never be read again.

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `express` | HTTP server |
| `axios` | HTTP client for SEC EDGAR requests |
| `xml2js` | XML parsing for NPORT filing documents |
| `cheerio` | HTML table parsing for 10-Q/10-K Schedule of Investments |
| `better-sqlite3` | Server-side cache for parsed filings and search results (see [Caching](#caching)), and the v2 warehouse |
| `yauzl` | Streams tables out of SEC bulk-dataset zips without unzipping to disk |
| `express-rate-limit` | Rate limiting on API routes |
| `dotenv` | Environment variable loading |
| [Chart.js](https://www.chartjs.org/) 4.5 | Time-series charts (jsDelivr, SRI-pinned) |
| [SheetJS](https://sheetjs.com/) 0.20.3 | Excel export (SheetJS's own CDN — it no longer publishes to npm/cdnjs, whose 0.18.5 has open advisories; SRI-pinned) |
| [jsPDF](https://github.com/parallax/jsPDF) 4.2 + [jsPDF-AutoTable](https://github.com/simonbengtsson/jsPDF-AutoTable) 5.0 | PDF export (jsDelivr, SRI-pinned) |

Dev tooling: `eslint` + `prettier` for linting/formatting, `nodemon` for auto-reload, `nock` + `supertest` for testing the server against mocked HTTP, `jsdom` for running the actual frontend (`public/app.js`) in tests.
