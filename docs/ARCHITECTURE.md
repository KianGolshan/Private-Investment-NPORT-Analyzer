# Vantage v2 Architecture

## Data sources (and why)

All figures below were measured against real SEC data on 2026-09-27. Decision records are in
[decisions/](decisions/).

| Source                                                                                            | Role                                                                     | Coverage                                                                                                                                                                          | Freshness                                                                                                                  | Cost                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SEC DERA N-PORT bulk datasets** (`/files/dera/data/form-n-port-data-sets/<yyyy>q<n>_nport.zip`) | History backbone                                                         | Every NPORT-P and NPORT-P/A since 2019Q4. For 80 random funds, EDGAR lists 7,046 filings; **0 missing**. Identical to the app's parser on 617 of 617 overlapping filings          | Filings through quarter-end, posted about 1–7 weeks later (2026Q2: 7/9/2026; 2026Q1: 4/6; 2025Q4: 1/7; 2025Q3: 11/18/2025) | 27 zips, 240–720 MB each, about 8 s download. About 35–180 s per quarter with the equity filter                                                                            |
| **EDGAR daily form index + `primary_doc.xml`**                                                    | Catch-up for the current quarter                                         | Every filing, including exits, dead funds and SPVs                                                                                                                                | Same day                                                                                                                   | About 11.7k NPORT-P per quarter; `primary_doc` median 352 KB, max 15 MB, 0.29 s each. About 1 hour once per quarter of backlog, then about 130 filings (about 1 min) a day |
| **EDGAR full-text search (EFTS)**                                                                 | On-demand "anything new for X" check, and names not yet in the warehouse | Only filings containing the typed words. Capped at 1,000 hits per query; date-windowing avoids the cap (filed Jul 1–Sep 27, 2026: Anthropic 223, Databricks 259, Stripe 160 hits) | Same day                                                                                                                   | Cheap per name. **Cannot see exits or opaque SPVs**, so it isn't used as a backbone                                                                                        |
| BDC 10-Q/10-K HTML                                                                                | Private Credit tab (unchanged)                                           | See README                                                                                                                                                                        | Same day                                                                                                                   | Per filing                                                                                                                                                                 |

Bulk dataset tables used: `SUBMISSION` (accession, filing date, form type, report date), `REGISTRANT` (CIK,
name, address), `FUND_REPORTED_INFO` (series ID and name, net assets), `FUND_REPORTED_HOLDING` (issuer
name, title, CUSIP, LEI, balance, unit, value in USD, % of NAV, asset category, issuer type, country,
restricted, fair-value level) and `IDENTIFIERS` (ISIN, ticker, other ID).

Size note: keeping _every_ Level-3 row stores 1–2M rows per quarter, mostly loans, which bloats the database
to 4.8 GB by 14 quarters. Keeping equity-type rows at any level stores about 7–25k rows per quarter, about
150 MB for all history.

## Pipeline

```
bulk zips ──(ingest-bulk)──┐
                           ├─► warehouse.db: filings / holdings / ingest_log
daily index ─(ingest-delta)┘        │
                                    ▼
                    canonical views (canonical_filings, fund_filing_timeline)
                                    │
             entities (companies, aliases, spv_map, managers, tracked)
                                    │
                 lib/analytics (asof, marks, splits, peer)
                                    │
                    lib/services ──► Express API + UI
                                  └► MCP server (stdio)
EFTS keyword search ─► on-demand check (labeled "live, not yet warehoused")
```

## Schema

Target schema, built through migrations in P1–P4.

```sql
filings(accession PK, fund_key, cik, series_id, registrant, series_name, report_date, filing_date,
        form, net_assets, total_assets, source /* 'bulk:2026q2' | 'edgar' */)
holdings(accession, row_no, issuer_name, title, cusip, lei, other_id, other_id_desc, isin, ticker,
         balance, unit, currency, value_usd, pct_nav, asset_cat, asset_desc, issuer_type, country,
         restricted, fv_level, deriv_cat, instrument_type, company_id, via_spv,
         PRIMARY KEY (accession, row_no))
ingest_log(id, kind, quarter, checksum, rows_read, rows_kept, filings, started_at, finished_at, status)
refresh_runs(id, started_at, finished_at, bulk_quarters_added, delta_filings, status, error)
companies(id, name, status /* private|public */, public_since, notes)
company_aliases(company_id, pattern, kind)
spv_map(fund_key, holding_match, company_id, basis, source_accession)
managers(id, name);  manager_registrants(manager_id, cik)
tracked_companies(company_id, added_at, note)
-- views
canonical_filings        -- one per (fund_key, report_date); latest filing_date wins
fund_filing_timeline     -- all canonical filings per fund
```

`fund_key = COALESCE(NULLIF(series_id,''), 'CIK'||cik)`. Dates are stored as ISO `YYYY-MM-DD`; bulk
`DD-MON-YYYY` is converted at ingest.

## As-of semantics

`exposureAsOf(company, D)`:

1. For each fund that ever held the company, take its **latest canonical filing on or before D**, whatever
   that filing contains.
2. No row for the company in that filing means the fund has **exited** (0).
3. No filing within 123 days before D means the fund is **inactive** (excluded).
4. Return the value, the per-fund **mark date** and the accession.

Fund calendars are staggered, so "as of D" mixes mark dates. The UI always shows them.

## Mark series (firm / fund / class)

- Every canonical filing keeps its own report date. There is no quarterly bucketing.
- A **class** series is keyed by (`fund_key`, `other_id`), falling back in the same order as `instrumentKey`.
- A **fund** series follows one fund's classes over time.
- A **firm** series is the median across the manager's funds for each report month. Because member funds
  are on staggered calendars, a firm can have marks in up to 12 months a year. Capital Group's Stripe line
  has 8 of 12 (Feb, Mar, May, Jun, Aug, Sep, Nov, Dec).
- Split normalization runs before any series, median or return.

## Refresh lifecycle

- **Nightly** (`npm run refresh`, via launchd/cron):
  1. Check for a new bulk quarter. If one is posted, ingest it and drop the `source='edgar'` rows it
     supersedes.
  2. Run the daily catch-up since the newest stored filing date.
  3. Write a `refresh_runs` row.
  4. Exit non-zero on failure.
- Example crontab: `15 6 * * * cd /path/to/repo && npm run refresh >> logs/refresh.log 2>&1`.
- Every job exits. Nothing polls indefinitely.

## Configuration

| Env var                 | Default          | Purpose                                     |
| ----------------------- | ---------------- | ------------------------------------------- |
| `SEC_USER_AGENT`        | required         | SEC fair-access identity                    |
| `WAREHOUSE_DB_PATH`     | `./warehouse.db` | Warehouse file (git-ignored) (planned)      |
| `CACHE_DB_PATH`         | `./cache.db`     | Existing request cache                      |
| `SEC_MIN_INTERVAL_MS`   | 110              | Outbound pacing (≤10 req/s)                 |
| `REFRESH_INACTIVE_DAYS` | 123              | Inactive-fund threshold for as-of (planned) |
| `LIVE_SEC`              | unset            | Enables network tests                       |

## Performance budgets

- Full backfill (27 quarters): ≤45 min.
- New bulk quarter: ≤3 min.
- First catch-up: ≤90 min.
- Nightly: ≤5 min.
- API and MCP p95: <200 ms.
- Warehouse size: ≤300 MB.

## Module map (target)

```
lib/edgar.js            fetchWithRetry, pace, daily-index reader   (from server.js)
lib/warehouse/db.js     connection, migrations
lib/analytics/asof.js   exposureAsOf
lib/analytics/splits.js shared split detection (from public/splits.js)
lib/analytics/peer.js   outliers, velocity, repricing (from public/app.js)
lib/services/*.js       search, company, fund, manager, marks
scripts/ingest-bulk.js, ingest-delta.js, refresh.js, seed-entities.js, review-aliases.js
db/migrations/NNNN_*.sql
mcp-server.js
```
