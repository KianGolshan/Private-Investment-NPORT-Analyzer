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
                    lib/services ──► Express API + UI   (read-only; ADR 0008)
                                  └► MCP server (stdio, read-only)
live EDGAR ─► listed companies and debt (labeled "live, not warehoused", ADR 0008)
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
company_brands(company_id, brand, source_accession)                            -- 'Chobani' for FHU US Holdings (P4.5)
identity_edges(a, b, kind, accession, confidence, detail, applied, conflict)    -- evidence graph, rebuilt after every refresh
identity_nodes(key, component, vehicle_target)                                  -- keys in multi-name components
company_redirects(old_id, old_name, new_id, reason, retired_at)                 -- retired ids (merged | dropped), P5a
unreviewed_entities(id, key, display_name, category, keys, names, ..., active)  -- every unclaimed component, P5a
-- holdings.entity_id: the unreviewed entity of a row no company claims (P5a)
search_names (FTS5 trigram: compact variants, name, kind, ref, detail)          -- search index, P5a
company_stats(company_id, current_funds, current_value_usd, as_of, funds_ever, first/last_mark_date)  -- P5a
filing_totals(accession, rows, value_usd, rows_listed, value_listed, rows_debt, value_debt,
              rows_l3_equity, value_l3_equity, rows_capital)   -- every row of the filing, before the keep rule (P5b)
capital_structure_rows(accession, row_key, issuer_key, …holdings columns)  -- debt beside a kept row of the same issuer (P5b)
fund_names(fund_key, cik, series_id, series_name, registrant, first/last_report_date, last_accession, filings)
fund_search (FTS5 words: every series and registrant name a fund filed under)  -- P5b
-- refresh_runs.kind: refresh | curation (the admin job takes the refresh lock, P5b)
position_facts(fund_key, company_id, accession, report_date, filing_date, next_report_date, prev_accession,
               prev_report_date, event, change, instrument_key, rekeyed_from, merged_keys, class_label, kind, unit,
               balance, prev_balance, value, prev_value, price, prev_price, split, position_effect, mark_effect,
               other_effect, pct_nav, …)   -- P6b W1 (0019): one row per activity leg of a fund in a private company;
                                           -- as of D = SUM(value) where report_date <= D < next_report_date, within
                                           -- 123 days; derived, rebuilt by every refresh and curation run
-- views
canonical_filings        -- one per (fund_key, report_date); latest filing_date wins
fund_filing_timeline     -- all canonical filings per fund
```

`fund_key = series_id`, else `'CIK'||cik` (the placeholder `S000000000` counts as blank). After every
ingest `lib/warehouse/fund-keys.js` applies curated overrides, joins a blank-series filing to the series
with its LEI, and keys registrants that file several series without IDs by `'CIK'||cik||':'||series_lei`
(DATA-QUALITY trap 20). Dates are stored as ISO `YYYY-MM-DD`; bulk
`DD-MON-YYYY` is converted at ingest.

## Company identity (P4.5)

Issuer keys (`issuerKeyOf`) are nodes. `lib/entities/identity.js` adds an edge only on filing evidence, strongest
first: the same issuer LEI (trusted when >= 2 filer families give it), the same instrument id in one filer family
(a corroborated rename, or two funds at the same mark on one date), the same share count across a name change,
the same marks in one filing at >= 2 prices, a title or "dba"/"formerly" naming the company, and normalized names
(spacing, abbreviations, per-fund holding-vehicle prefixes such as Fidelity's "CONTSA FHUS HOLDINGS LLC").
Companies are the connected components. A union that would join two trusted LEIs, a listed and a private
company, two curated companies, or a `curation.separate` pair is recorded as a conflict and not made. The seed
applies the candidate rule to whole components (>= 3 funds and $25M, or >= 2 funds and $50M for private
candidates); vehicles join as indirect; fund interests, CLOs, reinsurance accounts and SPV-named keys never
join by identity. Brands go to `company_brands`. `npm run entities:report` (and every refresh) ranks what
is still unresolved by component and category.

## As-of semantics

`exposureAsOf(company, D)`:

1. For each fund that ever held the company, take its **latest canonical filing on or before D**, whatever
   that filing contains.
2. No row for the company in that filing means the fund has **exited** (0).
3. No filing within 123 days before D means the fund is **inactive** (excluded).
4. Return the value, the per-fund **mark date** and the accession. A fund whose latest filing reports the
   company only at $0 is listed as `zeroValue`, not as an exit (trap 42).

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

- **Every write is a job** (`lib/warehouse/job.js`, ADR 0009). The refresh, ingests, N-CEN, the review import,
  "make this a company", backfills and the entity report all:
  1. take the job lock (`warehouse.db.lock` with an owner token, its process's start time and the boot time,
     heartbeat 30 s; taken over when its process is gone, when its pid now runs another process or the host
     rebooted (`job-state.holderGone`), or after 10 min without a heartbeat from another host; checked again before
     publishing);
  2. check the disk has room (a candidate plus 1 GiB, else fail before copying), remove candidates left by
     interrupted jobs, and copy the published generation to a candidate (SQLite backup API);
  3. run, then rebuild every derived table (`refresh.rebuildDerived`);
  4. validate (integrity, schema, row counts against the published generation, derived tables present);
  5. publish `generations/warehouse-<id>.db` (read-only on disk; the id from `generations/SEQUENCE`, never
     reused) by swapping the `warehouse.db` symlink: the commit point. A job given the reviewed files works on a
     staged copy, which is stored in the generation (`curation_snapshot`) and written back only after the publish.

  A failure publishes nothing. Every job has a time limit (3 h, `VANTAGE_JOB_TIMEOUT_MIN`): past it the job fails
  before the commit point, cleans up and releases the lock, and the CLI exits; a streamed bulk download fails
  after 60 s without data (P8 pre-flight). `warehouse.db.job.json` holds the last job's state, which
  `/api/freshness` reports as `job`; a `running` state whose process ended reads `interrupted` (top bar: "Last
  job interrupted"). `npm run doctor` checks freshness, ingest errors, row counts, unresolved value, the last
  job, the lock, disk room, leftover candidates and temp directories, and job processes (read-only; exits 1 on a
  failure). `npm run warehouse` lists the generations; `-- --rollback` republishes the previous contents as a new generation (`--to <id>` for any kept one), and
  `-- --sync-curation` writes the published curation snapshot back to `data/review`.

- **Nightly** (`npm run refresh`, `scripts/refresh.js` → `runJob('refresh', refreshIngest)`):
  1. Run as a job (above). The job lock replaces the old `refresh_runs` claim; a `refresh_runs` row still records
     the run in the generation it builds.
  2. List the SEC's published bulk quarters and load any not yet loaded, plus any loaded quarter the SEC has
     re-posted: a different size, or a new `Last-Modified` since the last check (trap 41; one HEAD per quarter,
     recorded in `bulk_source_checks`; the SEC sends no ETag). A quarter's archive must have its required
     columns, no empty tables, no rows outside its filings, and at least 90% of the last load's filings (F12).
     - Loading a quarter replaces the catch-up rows for every filing it covers (`INSERT OR REPLACE` on
       the accession cascades to holdings).
  3. Catch up on every NPORT-P / NPORT-P/A filed on or after the newest bulk filing date.
     - Filings already stored are skipped.
     - Earlier failures in `ingest_errors` are retried.
  4. Re-derive stored OTHER rows' instrument type under today's rule (trap 45, `lib/warehouse/reclassify.js`;
     a no-op unless the rule changed). Entity upkeep (fund advisers, company resolution), then the identity graph and the review queue
     (`reports/entities/unresolved.csv`, `conflicts.csv`; P4.5), then unreviewed entities, their row tags,
     `company_stats` and the search index (`lib/entities/entities.js`, P5a), then the fund list and fund-name
     index (`lib/warehouse/fund-names.js`, P5b), then the position facts (`lib/warehouse/position-facts.js`, P6b W1;
     2.6 s, 68k legs, ~31 MB; logged to `ingest_log` as kind `position-facts`; the review import rebuilds them too).
     Both ingest paths also write `filing_totals` and the
     capital-structure rows for every filing they load.
  5. Finish the `refresh_runs` row and publish. A catch-up filing that predates bulk coverage but isn't in bulk
     (expected 0), or catch-up and N-CEN failures, make the generation `partial` (published, labeled; the filings
     retry next run).
  6. Exit non-zero on any failure or partial run, so the scheduler can alert.
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
Check health with `npm run doctor` (exits 1 when the last job failed or was interrupted, or the disk has no
room for the next one), `npm run warehouse` (generations and the last job), `cat warehouse.db.jobs.log`,
`sqlite3 warehouse.db "select * from generation_meta order by id desc limit 5"` and `select * from ingest_errors`.

## Deployment (planned, Phase 9)

- **Shape:** one always-on container or VM with a persistent volume.
  - The Express app serves reads from `warehouse.db` (after P5, visitors never call the SEC).
  - A scheduled `npm run refresh` on the same machine writes to it.
  - Jobs build a candidate and publish a new generation file (ADR 0009); readers never see a half-built one.
- **Around it:**
  - Litestream replication to object storage, for backup and restore-on-boot.
  - A dead-man's-switch health check on the nightly refresh.
  - Cache-Control headers valid until the next refresh, with a CDN in front for traffic spikes.
- Details, gates and success criteria are in ROADMAP §Phase 9. The hosting provider gets its own ADR
  (0006) once chosen.

## Configuration

| Env var               | Default          | Purpose                                                        |
| --------------------- | ---------------- | -------------------------------------------------------------- |
| `SEC_USER_AGENT`      | required         | SEC fair-access identity                                       |
| `WAREHOUSE_DB_PATH`   | `./warehouse.db` | Warehouse file (git-ignored)                                   |
| `CACHE_DB_PATH`       | `./cache.db`     | Existing request cache                                         |
| `SEC_MIN_INTERVAL_MS` | 110              | Outbound pacing (≤10 req/s)                                    |
| `LIVE_SEC`            | unset            | Enables network tests                                          |
| `VANTAGE_ADMIN`       | unset            | `1` enables the local admin action "make this a company" (P5b) |

## Performance budgets

- Full backfill (27 quarters): ≤45 min.
- New bulk quarter: ≤3 min.
- First catch-up: ≤90 min.
- Nightly: ≤5 min.
- API and MCP p95: <200 ms.
- Warehouse size: ≤1 GB (raised from 600 MB on 2026-10-01 by Claude under the user's "fix everything"; growth is
  25–30 MB per bulk quarter and the only prunable tables were 9–34 MB; measured 364 MB at P1, 542.7 MB after P5b,
  544.0 MB on 2026-10-01, 574.7 MB with the P6b W1 position facts).

## Module map

Built in P1–P4.5 (later additions follow below, by wave):

```
lib/edgar.js                       fetchWithRetry, pace (moved from server.js; shared by server and jobs)
lib/warehouse/db.js                connection, migrations; openWarehouseReadOnly for readers (no create, no
                                   migrate, fails if the schema is behind)
lib/warehouse/bulk-source.js       published-quarter list, verified zip download
lib/warehouse/bulk-ingest.js       one bulk quarter -> filings + private-candidate holdings (keep rule)
lib/warehouse/listing-evidence.js  per issuer: filings pricing it at Level 1 with a valid ISIN/CUSIP (dropped rows)
lib/warehouse/tsv-zip.js           streaming TSV reader over the DERA zip
lib/warehouse/identifiers.js       ISIN / CUSIP check digits, fundKeyOf
lib/warehouse/keep-rule.js         the ingest keep rule (isEquityType, isPrivateCandidate), both paths
lib/warehouse/values.js            field cleaning (text, num), both paths
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
lib/entities/names.js              shared name helpers (rawName, issuer key, generic and fund-like names)
lib/entities/identity.js           P4.5 identity graph: evidence edges (LEI, instrument id, share count, same mark,
                                   title/dba, normalized names, per-fund vehicles) -> guarded components
lib/entities/report.js             stores the graph; unresolved private value ranked by component (review queue)
scripts/ingest-bulk.js, ingest-delta.js, refresh.js, ingest-ncen.js
scripts/seed-entities.js, review-aliases.js, entities-report.js, backfill-leis.js, backfill-listing-evidence.js
data/review/{aliases,managers,disclosed_exposure}.csv, curation.json   reviewed entity decisions (imported;
                                   curation.json also holds curated statuses, e.g. SpaceX public)
public/splits.js, public/fund-groups.js   shared by the browser and Node (split detection; v1's firm list)
```

Built in P5a:

```
lib/entities/entities.js           unreviewed entities, holdings.entity_id, company_stats, the search index
lib/services/search.js             ranked search with match reasons (exact, normalized, prefix, substring, similar)
lib/services/company.js            exposure with display labels, history, stable-id lookup, routing (sourceFor)
lib/api/warehouse.js               read-only warehouse routes (/api/search, /api/companies, /api/entities, /api/freshness)
                                   (+ /api/funds in P5b)
lib/warehouse/keep-rule.js         + classifyStored: classifyInstrument over stored fields (ingest and services)
scripts/bench.js                   npm run bench
data/review/company_ids.csv        the stable company id ledger
```

Built in P5b:

```
lib/warehouse/filing-totals.js     per-filing totals over every row (one collector, both ingest paths)
lib/warehouse/capital-structure.js debt rows kept beside a private-candidate row of the same issuer
lib/warehouse/totals-backfill.js   one-off backfill of both (scripts/backfill-filing-totals.js)
lib/warehouse/fund-names.js        fund list + word index, rebuilt by refresh and the ingest scripts
lib/services/fund.js               fund search, canonical filings, X-Ray / compare / returns on the warehouse
lib/analytics/peer.js              velocity, outliers, ledger, leaderboard (UMD; the browser loads /peer.js)
lib/entities/review-import.js      the review import (npm run review:aliases and the admin job)
lib/entities/make-company.js       "make this a company": review files + import, run as a warehouse job
lib/warehouse/job.js               runJob: the one write path (lock, candidate, derived rebuild, validate, publish)
lib/warehouse/job-state.js         job file paths, the last job's state (read by /api/freshness), process identity
lib/warehouse/doctor.js            npm run doctor: read-only health checks (scripts/doctor.js)
lib/api/admin.js                   POST /api/admin/companies (VANTAGE_ADMIN=1, local only; runs scripts/make-company.js)
```

Built in P6 (2026-10-01):

```
lib/warehouse/reclassify.js        re-derives stored OTHER rows' instrument type each refresh (trap 45)
lib/analytics/asof.js              + exposureSeries (as-of at many dates, one read), monthEnds, keepCanonical,
                                   privateRowsOf
lib/analytics/activity.js          position changes per fund filing: companyActivity (a company in every fund),
                                   fundChanges (a fund, a firm's funds, or every filing made since a date)
lib/services/errors.js             ServiceError and shared input checks
lib/services/memo.js               whole-warehouse answers kept until the next refresh run
lib/services/market.js             top private companies as of D, by country, the what's-new feed
lib/services/firm.js               firms (N-CEN adviser, registrant fallback), firm book, firm marks, firm changes
lib/services/marks.js              share classes as of D, per-class mark history, stale marks
lib/services/dashboard.js          the tracked-list dashboard
public/views.js                    company Activity / Trend / Share classes; Market & What's New; Firms
```

Built in P6b W0 (2026-10-01), the analyst workspace (`web/`, Vite + Preact + TypeScript, ESM; its own
`package.json`; built into `web/dist`, which `server.js` serves at `/` and the app routes, with v1 at `/legacy`):

```
web/src/app.tsx                    shell: sidebar, top bar (⌘K, freshness, theme, density), mobile nav, routes (preact-iso)
web/src/api/{client,types}.ts      one fetch path: cache per refresh id, abort on change (useApi); response types
web/src/scope/{scope.ts,ScopeBar}  the URL-only scope (asof | from..to, firm, fund, class, kind); Back/Forward work
web/src/ui/DataTable.tsx           sort, filter, group, totals, row virtualization (TanStack virtual-core), CSV/XLSX
                                   from the same column definitions
web/src/ui/Chart.tsx, echarts.ts   ECharts (modular, lazy chunk), colors from the CSS tokens (theme.ts), redraws on theme
web/src/ui/CommandPalette.tsx      one search: companies and unreviewed names (/api/search), firms, funds; ranked by match
web/src/ui/ChangesTable.tsx        position changes worded as filed (first reported, added, reduced, no longer reported…)
web/src/lib/{format,export,prefs}  formatting (one copy), exports (SheetJS lazy), theme/density preferences
web/src/pages/                     Market, Company (overview, holders, changes, marks), Firms, Firm, Fund, Activity
web/src/styles/{tokens,base}.css   design tokens (light, dark, compact) and shared components
```

Built in P6b W1 (2026-10-01), the analysis data layer:

```
lib/analytics/activity.js          + walkPosition (the one per-fund walk behind companyActivity and the facts),
                                   movedWithinClass (trap 52), rekeyed across labels (trap 51)
lib/warehouse/position-facts.js    builds position_facts from the walk (factsOf: also any one subject's rows on demand)
lib/services/scope.js              firm / fund / class / kind filters: one predicate for rows, one for fact legs
lib/services/analysis.js           bridge, pivot (firm|fund|company|class × month|quarter|year), timeline (firm|fund),
                                   positionHistory; private companies from the table, other subjects and class/kind
                                   filters by walking the subject's rows (same legs; a test holds them equal)
lib/services/search.js             + unifiedSearch: companies, unreviewed names, firms, funds, share classes
web/src/ui/CommandPalette.tsx      one call to the unified search
```

Built in P6b W2 (2026-10-01), the company workbench (`web/src/pages/company/`, replacing `pages/Company.tsx`):

```
index.tsx           header (status, brands, holders, value + sparkline, firms, latest mark by class), tabs, drawer
Overview.tsx        value by firm | fund | class at each month or quarter end (pivot), funds holding, brush = range
Holders.tsx         holders as of D within the scope, each fund's change since its prior filing (/legs), grouping
Positions.tsx       fund × mark-month heatmap: value, shares, $/share, Δ value; a cell opens the drawer
Changes.tsx         the bridge (waterfall + steps), position vs mark effect by quarter, the ledger
Marks.tsx           per-firm marks over the band, spreads, gaps within a filing, stale marks, mark leadership
Filings.tsx         the stored rows behind every number, as filed
PositionDrawer.tsx  ?pos=<fund>: one fund's legs at every filing; split-adjusted per-share line
shared.tsx          filter pickers from the unfiltered answer, kind badge, the view props
```

Services added: `analysis.legsAt`, `company.filingRows`, `marks.markLeadership`. Every tab sends the scope to the
server (`scope.scopeParams`); nothing filters on the client.

Built in P6b W3 (2026-10-01), firm and fund pages (`web/src/pages/firm/`, `pages/fund/`, shared `pages/book/`,
replacing `pages/Firm.tsx` and `pages/Fund.tsx`):

```
book/BookOverview.tsx   private book by company at each period end (pivot), companies and funds holding, the bridge
                        for the range and position vs mark effect by quarter, a by-company table
book/Timeline.tsx       investment timeline: a bar per company while held, event marks (/api/analysis/timeline)
book/MarksVsOthers.tsx  each class against other funds' median at the same mark date (/api/analysis/marks)
firm/index.tsx          Overview · Timeline · Book (by company, by fund, company × fund matrix) · Marks · Changes
firm/Changes.tsx        the paged ledger (500 per page, type filter; counts and totals over all)
fund/index.tsx          Overview · X-Ray · Compare · Returns · Timeline · Marks · Changes · Filings
fund/XRay.tsx           Fund X-Ray from v1: private book at any filing, compare (prior / a year earlier), returns
ui/BridgeView.tsx       the bridge waterfall, steps and period effects (company, firm and fund pages)
```

Services added: `analysis.marksVsOthers` (+ `marksByDate`, warmed at start); `firm.firmChanges` paged.

Built in P6b W4 (2026-10-05), the cross-cutting pages:

```
Explore.tsx             /explore: pivot rows (firm, fund, company, class) × month | quarter | year, every metric,
                        heatmap + table with totals; any cell drills to its legs (?dk=<row key or _>&dp=<period>)
market/Movers.tsx       Market ?view=movers: largest mark effects and net position flows over a range
market/NewlyReported.tsx  Market ?view=new: companies whose first stored holding falls in the range
Activity.tsx            the feed by filing date with the scope's firm and fund filters (FirmPicker)
Tracked.tsx             /tracked: the viewer's watchlist (lib/watchlist.ts, localStorage; v1 import) and the
                        tracked-company dashboard
Compare.tsx             /compare: 2–5 companies, firms, funds or classes; value per period, effects, median marks
scope/FirmPicker.tsx    adds a firm to the scope; scope.useSetParams sets several URL params in one step
ui/bits.tsx WatchButton ☆ Watch on company, firm and fund page heads
```

Services added (`lib/services/analysis.js`): `drill` (the legs behind one pivot cell; they sum to it), `movers`,
`newlyReported`, `watchlist`, `compare`; `pivot` takes `keys` and `tracked`; `market.feed` takes `funds`.

Added in P6c and W5 (2026-10-05/06):

```
lib/warehouse/job.js, job-state.js   runJob, the one write path; generations, lock, validation (ADR 0009)
lib/services/classes.js fundMarks    one mark observation per fund x class x date (F06)
web/src/api/client.ts   generation revalidation (focus, visibility, 5 min); views refetch on a new generation
web/src/ui/useDialog.ts focus trap, Escape, focus back to the trigger (palette, position drawer)
web/src/ui/Basis.tsx    how cross-company views read history (today's curation and advisers); Basis export column
web/src/pages/company/markLines.ts   per-class, per-lineage split-adjusted marks for the position drawer
web/src/lib/export.ts csvText        spreadsheet-formula-safe CSV text; format.ts escapeHtml for chart tooltips
web/e2e/                Playwright suite (app.spec.ts, a11y.spec.ts with axe) on the golden warehouse
test/oracle.test.js     raw-EDGAR oracle (test/fixtures/oracle, scripts/verify-edgar.js rawHoldings)
public/ (v1, /legacy)   only Private Credit Analysis is shown; the retired tabs link to their replacements
```

ECharts loads after the page's load event, when the browser is idle (`ui/Chart.tsx`): the text and tables paint first.

Planned: `mcp-server.js` (P7) over the same services.

## Warehouse API (read-only, `lib/api/warehouse.js`)

Every answer carries `source`, `refreshId` (the published generation it was read from, ADR 0009) and mark dates;
JSON over 2 KB is gzipped; the ETag is generation id + build. `/api/freshness` adds `generation` (published at,
curation and code revisions) and `job` (the last job's state). A retired firm id answers 301 to its successor or 410
(`manager_ids.csv`). A listed company answers its views only with `?stored=1`, labeled (trap 49).

```
/api/freshness                                   bulk quarter, newest filing and report dates, refresh time
/api/search?q=[&kinds=company,entity,firm,fund,class]   ranked matches with match reason; `strong` on the one that
                                                 may open; with kinds, one list over all of them (P6b W1)
/api/companies/:id[/exposure|/history|/activity|/trend|/classes|/marks|/stale|/feed.xml]
/api/companies/:id/bridge?from=&to=              start, first reported, added, reduced, no longer reported, mark,
                                                 value only, started / stopped filing, end; reconciled to the cent
/api/companies/:id/positions/:fundKey[?instrument=]   one fund's legs at every filing
/api/companies/:id/legs?date=                    each fund's legs in force at D (its change since its prior filing)
/api/companies/:id/rows?from=&to=                the stored rows as filed (canonical filings; at most 20,000)
/api/companies/:id/leadership[?instrument=]      per class: who first filed each new per-share level, lags
  every company view takes ?firm=&fund=&class=&kind= (lists: repeated or comma-separated) and echoes `scope`
/api/entities/:issuerKey[/…same views]           unreviewed names; a resolved key answers 301
/api/market/top?date=&tracked=1                  private companies as of D
/api/market/countries?date=   /api/market/tracked?date=   /api/feed?since=&until=&all=1
/api/firms?date=&q=   /api/firms/:id?date=   /api/firms/:id/marks/:companyId
/api/firms/:id/changes?since=&until=&types=&company=&limit=&offset=   paged (default 500, at most 2,000)
/api/funds?q=   /api/funds/:key[/xray|/compare|/returns|/changes]
/api/analysis/bridge?from=&to=[&company=|&entity=][&firm=&fund=&class=&kind=]   (class, kind need a subject)
/api/analysis/pivot?rows=firm|fund|company|class&period=month|quarter|year&from=&to=&limit=[&company=…&firm=…]
/api/analysis/timeline?firm=|fund=               per company: spans held, value now, events by mark date
/api/analysis/marks?firm=|fund=[&date=]          each class held vs other funds' median at the same mark date
/api/analysis/drill?rows=&key=&metric=&from=&to=[&tracked=1&firm=&fund=&company=]   the legs behind one pivot
                                                 cell (no key = the total row), grouped by filing; 200 largest
/api/analysis/compare?rows=company|firm|fund|class&key=…&key=…&period=&from=&to=   2 to 5 keys (class: id:label)
/api/market/movers?from=&to=&tracked=1&limit=    mark effect and net position flow per company, top each way
/api/market/new?from=&to=                        companies first reported (first stored holding) in the window
/api/watchlist?company=&firm=&fund=&date=        each item now and a year earlier, the year's effects (≤100 each)
  /api/feed takes ?firm=&fund= (echoed as `filters`); /api/analysis/pivot takes ?tracked=1
```
