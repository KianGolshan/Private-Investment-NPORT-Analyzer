# Vantage

An internal tool for analyzing SEC NPORT-P filings to track and compare private investment valuations across institutional funds. Search by company name or ticker to see how different funds mark the same asset over time.

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
(BDCs), by parsing the Schedule of Investments tables in their 10-Q filings
instead of NPORT-P.

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
- **Private Credit Analysis** — search any issuer name to find every BDC fund reporting it as a loan, and chart the fair-value mark (% of par) across funds and time
- **Fund X-Ray** — search a fund/registrant name to pull its own NPORT-P filing in full and see its total private-equity exposure: $ value and % of NAV, broken down by instrument type (common/preferred/warrant/SPV) and country, with every private holding listed
- **Fund X-Ray period comparison** — compare a fund's private-equity book across two periods (one click for the prior quarter or prior year, or pick any two periods manually): new investments, exits, share-count changes, and a decomposition of the value change into "from price marks" vs. "from position sizing," plus notable mark-ups/mark-downs ranked by dollar impact
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

### Tests

```bash
npm test          # run the test suite (unit + integration, against real-filing fixtures)
npm run lint       # check code style
npm run format     # apply Prettier formatting
```

---

## Usage

### Single Security

1. Enter a company name (e.g., `Anthropic`, `OpenAI`, `SpaceX`) or ticker in the search box
2. Choose how many filings to process (25 / 50 / 100)
3. Click **Search NPORT Filings**
4. Results show a price-per-share trend chart and a table of holdings broken down by fund

### Batch Search

1. Switch to the **Batch Search** tab
2. Enter up to 10 securities, one per line
3. Click **Search All Securities**
4. Each security gets its own chart and fund breakdown

### Watchlist

1. Switch to the **Watchlist** tab and add issuer names you track repeatedly
2. Click **Run Watchlist Search** to run the same peer-comparison search as Batch Search against your full saved list (no 10-issuer cap)
3. The list is stored in your browser's local storage only — it isn't synced or shared

### Fund X-Ray

1. Switch to the **Fund X-Ray** tab. Either pick a fund from the **Top Funds** dropdown — a curated shortlist of well-known funds, grouped by manager (see [Top Funds dropdown](#fund-x-rays-top-funds-dropdown) below) — to autofill and search with no typing, or enter a fund/registrant name yourself (e.g., `SmallCap World Fund`, `REX ETF Trust`) in the search box — this looks the fund up by name on EDGAR directly (not full-text search), so it finds the fund's own filings rather than other funds that merely mention it
2. If the name matches more than one registrant, every match's filings appear together in the **Reporting Period** dropdown, labeled by fund name, so you can pick the exact one you meant
3. Results show the fund's total private-equity $ exposure, % of net assets, an instrument-type breakdown (common/preferred/warrant/SPV), a country breakdown, and every private holding found (company, shares, price/share, $ value, % of NAV, fair value level) — not just a preview; export CSV for the same data plus higher-precision per-share pricing
4. A holding counts as private equity only if it's flagged **Fair Value Level 3** (valued with unobservable inputs — no real market for it) **and** is an equity-type instrument. Bonds and loans are excluded even at Level 3 (they're creditor claims, not equity stakes), and a "restricted security" flag alone doesn't qualify a holding either — a foreign-ownership-restricted but still publicly-traded stock (Level 2) is a real public company, not a private one
5. To compare periods, use the **Compare To** dropdown next to Reporting Period, or click **vs Prior Quarter** / **vs Prior Year (YoY)** to auto-pick the nearest matching filing (YoY matches within ±45 days of exactly one year back; if nothing qualifies, you're told so rather than silently comparing against the wrong quarter)
6. The comparison view leads with the analysis — aggregate value/holdings/issuer deltas, a price-marks-vs-position-sizing breakdown of the value change, and Key Insights cards (securities added/dropped, positions increased/reduced, notable mark-ups/mark-downs ranked by $ impact) — followed by each period's own full breakdown (Most Recent Period, then Prior Period) and a full position-by-position detail table, each independently exportable to CSV

### Filtering

- **Date filter** — appears after a search completes; set a start/end date to narrow the visible data points and chart
- **Class filter** — click a chip to toggle one share class/tranche everywhere in a section, or type into the filter box to fuzzy-match across naming conventions
- **Reference line** — enter a price (Single Security) or mark (Private Credit) to plot it as a dashed benchmark line and see its percentage divergence from the peer median
- **Checkboxes** — uncheck individual rows to remove specific data points from the chart
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

After a search, use the export buttons at the bottom of the results:

| Format | Contents |
|--------|----------|
| CSV | Flat file of all holdings |
| Excel | Single security: one sheet. Batch: one sheet per security + combined sheet |
| PDF | Landscape; chart image + full data table per security |

---

## How It Works

1. **Search** — queries `https://efts.sec.gov/LATEST/search-index` for NPORT-P filings matching the search term
2. **Parse** — fetches `primary_doc.xml` from each filing's EDGAR archive path and parses the XML
3. **Extract** — walks the investment holdings in the XML, matches by name/ticker, and pulls shares, market value (USD), currency, and exchange rate
4. **Price calculation** — `price per share = market value (USD) / shares`. For non-USD holdings with an exchange rate provided, the local-currency price is also computed as `price (USD) × exchange rate`
5. **Display** — results are grouped by fund, deduplicated by `(reportDate, shares)`, and rendered with Chart.js

Filings are fetched in parallel batches with a short delay between batches to
stay within SEC's ~10 req/sec fair-access guidance; requests that hit a `429`
are retried with exponential backoff server-side, and any filing that still
fails to fetch/parse is reported to you as a failure count rather than being
silently dropped.

**Private Credit mode** works the same way but against 10-Q filings:

1. Full-text search EDGAR for 10-Q filings mentioning the issuer, keeping
   only filers whose Investment Company Act file number starts with `814-`
   (the SEC's own BDC designation — no hard-coded fund list needed)
2. Pull each identified BDC's complete 10-Q filing history from the EDGAR
   submissions API, to fill in older quarters the full-text search index may
   have missed
3. Fetch each 10-Q's primary HTML document and heuristically locate its
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
├── parsers.js          # NPORT-P / 10-Q XML and HTML extraction logic
├── cache.js            # SQLite-backed cache for parsed filings and search results
├── public/
│   ├── index.html     # Single-page frontend (HTML + CSS)
│   └── app.js          # Frontend logic (search, rendering, charts, export)
├── test/               # Unit and integration tests, with real-filing fixtures
├── package.json
├── .env.example       # Environment variable template
└── .gitignore
```

### API Routes

| Route | Method | Description |
|-------|--------|-------------|
| `/api/config` | GET | Returns whether `SEC_USER_AGENT` is configured |
| `/api/search-nport?security=` | GET | Searches EDGAR for NPORT-P filings matching the query |
| `/api/parse-nport?cik=&accession=&security=` | GET | Fetches and parses a single NPORT-P filing, returns matching holdings |
| `/api/search-10q?issuer=&maxPerFund=` | GET | Finds BDC funds (814- file number) reporting the issuer, plus each fund's full 10-Q history |
| `/api/parse-10q?cik=&accession=&issuer=&reportDate=` | GET | Fetches a single 10-Q, parses its Schedule of Investments table for the issuer |
| `/api/search-fund?fund=` | GET | Resolves a fund/registrant name to its EDGAR CIK(s) via company-name lookup, then returns each match's full NPORT-P filing history |
| `/api/fund-xray?cik=&accession=` | GET | Fetches and parses one NPORT-P filing in full, returns the fund's private-equity exposure breakdown |
| `/api/fund-xray-compare?cik=&currentAccession=&priorAccession=` | GET | Fetches two of the same fund's filings and diffs their private-equity books: new/exited positions, per-position share/value/price-per-share deltas, and a price-marks-vs-position-sizing value decomposition |

---

## SEC Data Notes

- NPORT-P filings are submitted quarterly; the most recent filing may be up to ~75 days behind the actual reporting period
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
- Add `&refresh=1` to any of the seven routes above to bypass the cache and
  force a fresh SEC fetch for that request. `/api/fund-xray-compare` has no
  cache entry of its own — it just calls `/api/fund-xray`'s cached logic
  twice and diffs the results, so `&refresh=1` there forces a fresh fetch of
  both filings.
- If the extraction logic in `extractHoldings()` / `extractCreditHoldings()`
  / `extractAllHoldings()` ever changes, bump `PARSE_VERSION` in `cache.js`
  so old cached results (parsed with the previous logic) are treated as
  misses instead of being served forever.

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `express` | HTTP server |
| `axios` | HTTP client for SEC EDGAR requests |
| `xml2js` | XML parsing for NPORT filing documents |
| `cheerio` | HTML table parsing for 10-Q Schedule of Investments |
| `better-sqlite3` | Server-side cache for parsed filings and search results (see below) |
| `express-rate-limit` | Rate limiting on API routes |
| `dotenv` | Environment variable loading |
| [Chart.js](https://www.chartjs.org/) | Time-series charts (CDN) |
| [SheetJS](https://sheetjs.com/) | Excel export (CDN) |
| [jsPDF](https://github.com/parallax/jsPDF) + [jsPDF-AutoTable](https://github.com/simonbengtsson/jsPDF-AutoTable) | PDF export (CDN) |

Dev tooling: `eslint` + `prettier` for linting/formatting, `nodemon` for auto-reload, `nock` + `supertest` for testing against mocked/real HTTP.
