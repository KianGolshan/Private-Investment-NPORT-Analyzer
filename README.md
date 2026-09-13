# Private Investment NPORT Analyzer

An internal tool for analyzing SEC NPORT-P filings to track and compare private investment valuations across institutional funds. Search by company name or ticker to see how different funds mark the same asset over time.

---

## What It Does

Institutional funds registered with the SEC are required to file NPORT-P reports disclosing their portfolio holdings quarterly. This tool queries the SEC EDGAR database in real time, parses the raw XML filings, and extracts price-per-share data for any security you search — letting you see how different funds value the same private company across reporting periods.

**Use cases:**
- Compare marks on private investments across funds (e.g., Anthropic, OpenAI, SpaceX)
- Track valuation trends over time
- Identify divergence in how funds price the same asset
- Export data for further analysis

It also includes a **Private Credit Analysis** mode that does the same thing
for privately-held companies held as loans by Business Development Companies
(BDCs), by parsing the Schedule of Investments tables in their 10-Q filings
instead of NPORT-P.

---

## Features

- **Single security search** — search by company name or ticker, set a filing limit, and get all matching holdings plotted on a price-per-share timeline
- **Batch search** — search up to 10 securities at once, each displayed as a separate section with its own chart
- **Summary stats** — latest price, price range, number of reporting funds, total data points, and date range shown at a glance
- **Interactive charts** — toggle individual data points on/off via checkboxes; chart updates live
- **Date filtering** — filter all results to a specific date range
- **Collapsible fund tables** — expand/collapse per-fund data; select all or none per fund
- **Export** — download results as CSV, Excel (`.xlsx`), or PDF (landscape with chart + data table); exports reflect whatever is currently checked/filtered on screen
- **Private Credit Analysis** — search any issuer name to find every BDC fund reporting it as a loan, and chart the fair-value mark (% of par) across funds and time

---

## Setup

### Prerequisites
- [Node.js](https://nodejs.org/) v20.18.1 or later
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

### Filtering

- **Date filter** — appears after a search completes; set a start/end date to narrow the visible data points and chart
- **Checkboxes** — uncheck individual rows to remove specific data points from the chart
- **All / None buttons** — select or deselect all rows for a given fund at once

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

---

## Project Structure

```
├── server.js          # Express API server
├── public/
│   └── index.html     # Single-page frontend (HTML + CSS + JS)
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

- **Parsed filing holdings** (`/api/parse-nport`, `/api/parse-10q`) are
  cached indefinitely, keyed by `(cik, accession, security)` /
  `(cik, accession, issuer, reportDate)` — a specific historical filing's
  content never changes.
- **Search-result listings** (`/api/search-nport`, `/api/search-10q`) are
  cached for 1 hour by default (override with `SEARCH_CACHE_TTL_MS` in
  `.env`), since new filings get added over time.
- Add `&refresh=1` to any of the four routes above to bypass the cache and
  force a fresh SEC fetch for that request.
- If the extraction logic in `extractHoldings()` / `extractCreditHoldings()`
  ever changes, bump `PARSE_VERSION` in `cache.js` so old cached results
  (parsed with the previous logic) are treated as misses instead of being
  served forever.

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `express` | HTTP server |
| `axios` | HTTP client for SEC EDGAR requests |
| `xml2js` | XML parsing for NPORT filing documents |
| `cheerio` | HTML table parsing for 10-Q Schedule of Investments |
| `better-sqlite3` | Server-side cache for parsed filings and search results (see below) |
| `cors` | Cross-origin headers |
| `dotenv` | Environment variable loading |
| [Chart.js](https://www.chartjs.org/) | Time-series charts (CDN) |
| [SheetJS](https://sheetjs.com/) | Excel export (CDN) |
| [jsPDF](https://github.com/parallax/jsPDF) + [jsPDF-AutoTable](https://github.com/simonbengtsson/jsPDF-AutoTable) | PDF export (CDN) |
