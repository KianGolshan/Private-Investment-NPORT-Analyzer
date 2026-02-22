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

---

## Features

- **Single security search** — search by company name or ticker, set a filing limit, and get all matching holdings plotted on a price-per-share timeline
- **Batch search** — search up to 10 securities at once, each displayed as a separate section with its own chart
- **Summary stats** — latest price, price range, number of reporting funds, total data points, and date range shown at a glance
- **Interactive charts** — toggle individual data points on/off via checkboxes; chart updates live
- **Date filtering** — filter all results to a specific date range
- **Collapsible fund tables** — expand/collapse per-fund data; select all or none per fund
- **Export** — download results as CSV, Excel (`.xlsx`), or PDF (landscape with chart + data table)

---

## Setup

### Prerequisites
- [Node.js](https://nodejs.org/) v18 or later
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

Filings are fetched in parallel batches of 5 with a 50ms delay between requests to stay within SEC rate limits (~10 req/sec).

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
| `/api/parse-nport?cik=&accession=&security=` | GET | Fetches and parses a single filing, returns matching holdings |

---

## SEC Data Notes

- NPORT-P filings are submitted quarterly; the most recent filing may be up to ~75 days behind the actual reporting period
- Not all funds file NPORT-P — only registered investment companies (mutual funds, ETFs, interval funds) are required to file; hedge funds and private funds generally do not
- Market values in NPORT filings are as of the report period end date, not the filing date
- Some filings may use non-standard XML structures; the parser handles multiple known variants but may miss edge cases

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `express` | HTTP server |
| `axios` | HTTP client for SEC EDGAR requests |
| `xml2js` | XML parsing for NPORT filing documents |
| `cors` | Cross-origin headers |
| `dotenv` | Environment variable loading |
| [Chart.js](https://www.chartjs.org/) | Time-series charts (CDN) |
| [SheetJS](https://sheetjs.com/) | Excel export (CDN) |
| [jsPDF](https://github.com/parallax/jsPDF) + [jsPDF-AutoTable](https://github.com/simonbengtsson/jsPDF-AutoTable) | PDF export (CDN) |
