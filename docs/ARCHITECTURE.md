# Vantage v2 Architecture

## Data sources (and why)

All figures below were measured against real SEC data on 2026-09-27. Decision records are in
[decisions/](decisions/).

| Source                                                                                            | Role                                                                     | Coverage                                                                                                                                                                          | Freshness                                                                                                                  | Cost                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SEC DERA N-PORT bulk datasets** (`/files/dera/data/form-n-port-data-sets/<yyyy>q<n>_nport.zip`) | History backbone                                                         | Every NPORT-P and NPORT-P/A since 2019Q4. For 80 random funds, EDGAR lists 7,046 filings; **0 missing**. Identical to the app's parser on 617 of 617 overlapping filings          | Filings through quarter-end, posted about 1–7 weeks later (2026Q2: 7/9/2026; 2026Q1: 4/6; 2025Q4: 1/7; 2025Q3: 11/18/2025) | 27 zips, 240–720 MB each, about 8 s download. About 35–180 s per quarter with the equity filter                                                                                         |
| **EDGAR form index (`full-index/<yyyy>/QTR<n>/form.idx`) + `primary_doc.xml`**                    | Catch-up for the current quarter                                         | Every filing, including exits, dead funds and SPVs                                                                                                                                | Same day                                                                                                                   | About 11.7k NPORT-P per quarter; `primary_doc` median 352 KB, max 15 MB. **Measured: 11,822 filings in 26.9 min (about 9/s, the SEC rate limit)**; a night with nothing new takes 1.1 s |
| **EDGAR full-text search (EFTS)**                                                                 | On-demand "anything new for X" check, and names not yet in the warehouse | Only filings containing the typed words. Capped at 1,000 hits per query; date-windowing avoids the cap (filed Jul 1–Sep 27, 2026: Anthropic 223, Databricks 259, Stripe 160 hits) | Same day                                                                                                                   | Cheap per name. **Cannot see exits or opaque SPVs**, so it isn't used as a backbone                                                                                                     |
| BDC 10-Q/10-K HTML                                                                                | Private Credit tab (unchanged)                                           | See README                                                                                                                                                                        | Same day                                                                                                                   | Per filing                                                                                                                                                                              |

Bulk dataset tables used: `SUBMISSION` (accession, filing date, form type, report date), `REGISTRANT` (CIK,
name, address), `FUND_REPORTED_INFO` (series ID and name, net assets), `FUND_REPORTED_HOLDING` (issuer
name, title, CUSIP, LEI, balance, unit, value in USD, % of NAV, asset category, issuer type, country,
restricted, fair-value level) and `IDENTIFIERS` (ISIN, ticker, other ID).

Keep rule (P1, ADR 0003): equity-type rows (EC, EP, OTHER, warrants) that are Level 3, restricted, or have
no check-digit-valid ISIN/CUSIP. Measured on the full backfill: 7–25k rows/quarter in 2019–2021 rising to
~70k in 2026, 1,086,310 rows in total, 364 MB. (Keeping every Level-3 row instead would store 1–2M
loan-dominated rows per quarter; keeping every equity row would add ~1.9M public-stock rows per quarter.)

## Pipeline

```
bulk zips ──(ingest-bulk)──┐
                           ├─► warehouse.db: filings / holdings / ingest_log
daily index ─(ingest-delta)┘        │
                                    ▼
                    canonical views (canonical_filings, fund_filing_timeline)
                                    │
N-CEN (data sets + EDGAR) ─► advisers ─► fund_advisers ─► managers (reviewed CSV)
             entities (companies, aliases, spv_map, disclosed_exposure, tracked; reviewed CSV)
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
holdings(accession, row_key /* bulk HOLDING_ID | doc:<n> */, issuer_name, title, cusip, lei, other_id, other_id_desc, isin, ticker,
         balance, unit, currency, value_usd, pct_nav, asset_cat, asset_desc, issuer_type, country,
         restricted, fv_level, deriv_cat, instrument_type, company_id, via_spv,
         PRIMARY KEY (accession, row_key))
ingest_log(id, kind /* bulk | edgar */, quarter, source_url, zip_sha256, zip_bytes, filings, rows_read, rows_kept,
           started_at, finished_at, status, error)
ingest_errors(accession PK, cik, filing_date, form, error, attempts, last_attempt_at)   -- catch-up retry list
refresh_runs(id, started_at, finished_at, bulk_quarters_added, delta_since, delta_filings, delta_failures, status, error)
-- filings also carry series_lei, registrant_lei (P4)
fund_key_overrides(series_id, cik, fund_key, reason)          -- curated fund-identity corrections
listing_evidence(issuer_key, quarter, rows, filings, value_usd, sample_accession, sample_cusip)
companies(id, name UNIQUE, status /* private|public */, public_since, notes)
company_aliases(company_id, kind /* issuer_key|exact|regex */, pattern, via_spv, source)
spv_map(fund_key, holding_match, company_id, basis, source_accession)
disclosed_exposure(fund_key, report_date, company_id, basis, source_accession)  -- ranges, e.g. '>20%'
advisers(file_num PK, name, crd, lei)
ncen_filings(accession, cik, filing_date, source);  ncen_advisers(accession, cik, series_id, series_lei, file_num, role, filing_date)
fund_advisers(fund_key, file_num, role, source_accession, ncen_filing_date)     -- derived after each ingest
managers(id, name);  manager_advisers(manager_id, file_num);  manager_registrants(manager_id, cik)
tracked_companies(company_id, added_at, note)
-- views
canonical_filings        -- one per (fund_key, report_date); latest filing_date wins
fund_filing_timeline     -- all canonical filings per fund
```

`fund_key = series_id`, else `'CIK'||cik` (the placeholder `S000000000` counts as blank). After every
ingest `lib/warehouse/fund-keys.js` applies curated overrides, joins a blank-series filing to the series
with its LEI, and keys registrants that file several series without IDs by `'CIK'||cik||':'||series_lei`
(DATA-QUALITY trap 20). Dates are stored as ISO `YYYY-MM-DD`; bulk
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

- **Nightly** (`npm run refresh`, `lib/warehouse/refresh.js`):
  1. List the SEC's published bulk quarters and load any not yet loaded.
     - Loading a quarter replaces the catch-up rows for every filing it covers (`INSERT OR REPLACE` on
       the accession cascades to holdings).
  2. Catch up on every NPORT-P / NPORT-P/A filed on or after the newest bulk filing date.
     - Filings already stored are skipped.
     - Earlier failures in `ingest_errors` are retried.
  3. Write a `refresh_runs` row, with a warning if any catch-up filing predates bulk coverage but isn't
     in bulk (expected 0).
  4. Exit non-zero on any failure, so the scheduler can alert.
- Catch-up safeguards, each added after a real failure (DATA-QUALITY traps 17–19):
  - 60 s timeout, with network errors retried twice.
  - Truncated `primary_doc.xml` falls back to the full submission `.txt`.
  - The filing list is de-duplicated by accession.
- Every job exits. Nothing polls indefinitely.

**Scheduling on macOS (launchd).** This is not installed automatically. Save the following as
`~/Library/LaunchAgents/com.vantage.refresh.plist` and load it with
`launchctl load ~/Library/LaunchAgents/com.vantage.refresh.plist`. It runs daily at 06:15 local time. EDGAR
publishes the day's index overnight, and filings cluster about 60 days after each quarter-end.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.vantage.refresh</string>
  <key>WorkingDirectory</key><string>/path/to/repo</string>
  <key>ProgramArguments</key><array>
    <string>/usr/local/bin/npm</string><string>run</string><string>--silent</string><string>refresh</string>
  </array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>6</integer><key>Minute</key><integer>15</integer></dict>
  <key>StandardOutPath</key><string>/path/to/repo/logs/refresh.log</string>
  <key>StandardErrorPath</key><string>/path/to/repo/logs/refresh.log</string>
</dict></plist>
```

Linux/cron equivalent: `15 6 * * * cd /path/to/repo && npm run --silent refresh >> logs/refresh.log 2>&1`.
Check health with `sqlite3 warehouse.db "select * from refresh_runs order by id desc limit 5"` and
`select * from ingest_errors`.

## Deployment (planned, Phase 9)

- **Shape:** one always-on container or VM with a persistent volume.
  - The Express app serves reads from `warehouse.db` (after P5, visitors never call the SEC).
  - A scheduled `npm run refresh` on the same machine writes to it.
  - WAL mode keeps reads non-blocking during refresh.
- **Around it:**
  - Litestream replication to object storage, for backup and restore-on-boot.
  - A dead-man's-switch health check on the nightly refresh.
  - Cache-Control headers valid until the next refresh, with a CDN in front for traffic spikes.
- Details, gates and success criteria are in ROADMAP §Phase 9. The hosting provider gets its own ADR
  (0006) once chosen.

## Configuration

| Env var                 | Default          | Purpose                                     |
| ----------------------- | ---------------- | ------------------------------------------- |
| `SEC_USER_AGENT`        | required         | SEC fair-access identity                    |
| `WAREHOUSE_DB_PATH`     | `./warehouse.db` | Warehouse file (git-ignored)                |
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
- Warehouse size: ≤500 MB (measured 364 MB for 2019Q4–2026Q2).

## Module map

Built so far (P1–P4):

```
lib/edgar.js                       fetchWithRetry, pace (moved from server.js; shared by server and jobs)
lib/warehouse/db.js                connection, migrations
lib/warehouse/bulk-source.js       published-quarter list, verified zip download
lib/warehouse/bulk-ingest.js       one bulk quarter -> filings + private-candidate holdings (keep rule)
lib/warehouse/listing-evidence.js  per issuer: filings pricing it at Level 1 with a valid ISIN/CUSIP (dropped rows)
lib/warehouse/tsv-zip.js           streaming TSV reader over the DERA zip
lib/warehouse/identifiers.js       ISIN / CUSIP check digits, fundKeyOf
lib/warehouse/fund-keys.js         fund-identity rules after each ingest (overrides, series LEI)
lib/warehouse/lei-backfill.js      one-off series/registrant LEI backfill
lib/warehouse/edgar-rows.js        one primary_doc.xml -> the same rows, via the app's parser
lib/warehouse/delta.js             EDGAR form-index catch-up (resumable, retries, .txt fallback)
lib/warehouse/ncen.js              N-CEN advisers: data sets + EDGAR top-up
lib/warehouse/refresh.js           nightly: bulk quarters, catch-up, N-CEN, entity upkeep
lib/analytics/asof.js              exposureAsOf, instrumentHistory (splits via public/splits.js)
lib/entities/seed.js               review-file suggestions (companies, aliases, SPVs, status, managers)
lib/entities/review.js, csv.js     import of the reviewed CSVs (transactional, fails loudly)
lib/entities/resolve.js            holdings.company_id / via_spv from the aliases
lib/entities/managers.js           fund_advisers from the latest N-CEN
lib/entities/upkeep.js             fund advisers + company resolution after any ingest
scripts/ingest-bulk.js, ingest-delta.js, refresh.js, ingest-ncen.js
scripts/seed-entities.js, review-aliases.js, backfill-leis.js, backfill-listing-evidence.js
data/review/{aliases,managers,disclosed_exposure}.csv, curation.json   reviewed entity decisions (imported)
```

Planned:

```
lib/analytics/peer.js   outliers, velocity, repricing (from public/app.js)
lib/services/*.js       search, company, fund, manager, marks
mcp-server.js
```
