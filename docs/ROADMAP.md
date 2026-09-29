# Vantage v2 Roadmap

**Goal:** the same app, with far more capability. SEC-verified, refreshable, historically accurate
private-investment exposure and marks, sliced by **company → parent firm → fund → share class** over any
time horizon. Covers any private company you look up, plus a tracked list of about 250 major private
companies. Evidence for every design choice is in [ARCHITECTURE.md](ARCHITECTURE.md),
[DATA-QUALITY.md](DATA-QUALITY.md) and [GOLDEN-NUMBERS.md](GOLDEN-NUMBERS.md).

## How phases work

- Each phase has an **entry gate**, **tasks**, **tests**, **success criteria** and a **checkpoint**.
- A phase starts only when its entry gate is met. A failed success criterion **blocks** the next phase.
- **Checkpoint**, the same for every phase:
  1. `npm test`, `npm run lint` and `npm run format:check` are green.
  2. The phase's live checks pass (`LIVE_SEC=1`) where listed.
  3. [STATUS.md](STATUS.md) is updated: boxes ticked, measurements recorded, next prompt written.
  4. Commit on a branch, then get user sign-off before starting the next phase.
- Session prompts for each phase are in [SESSION-PROMPTS.md](SESSION-PROMPTS.md).
- Offline tests use **real-derived fixtures** only (real filings or real rows, trimmed). Anything that needs
  the network sits behind `LIVE_SEC=1`.

```
P0 live-app fixes
  → P1 warehouse + bulk history
    → P2 daily catch-up + refresh
      → P3 canonical views + as-of engine
        → P4 entities (companies, aliases, SPVs, managers, tracked list)
          → P5 service layer, parity migration
            → P6 new analysis + UI
            → P7 MCP server   (P6 and P7 can run in parallel)
              → P8 operations hardening
```

---

## Phase 0: live-app correctness fixes

**Entry gate:** none.
**Why:** measured on 20 companies, 21% of the 100-filing budget was spent on duplicate accessions (412 of
2,000 slots), and substring matching produced false hits (see [DATA-QUALITY.md §11](DATA-QUALITY.md)).

**Tasks**

- `server.js` `fetchEftsAllHits`: de-duplicate by `_source.adsh` (a filing yields one hit per document).
- Quote multi-word queries sent to EFTS ("Redwood Materials": 10,000+ hits unquoted vs. 2,469 quoted).
- `parsers.js` `extractHoldings`: match on word boundaries, not raw substrings. Keep exact ticker matches.
  Bump `PARSE_VERSION` so cached substring matches are discarded.
- _Added during P0 after real-data verification:_
  - Over the 1,000-hit cap, read newest-first date windows instead of a relevance-ranked slice. Before
    this, "the 100 most recent" skipped Epic Games filings from 2026-05-26.
  - For NPORT-P, keep only filings that matched in `primary_doc.xml`. Trust-wide attachments have no
    holding row: 328 of 328 real filings with a row had a `primary_doc.xml` hit, and 0 of 208
    attachment-only filings did.

**Tests**

- `test/parsers.test.js`: "Revolut" does not match REVOLUTION MEDICINES INC; "OpenAI" does not match
  OpenAir.com; "Anthropic" does not match Anthropics Technology Ltd.
- `test/edge-cases.test.js`:
  - two EFTS hits sharing one `adsh` produce one filing
  - phrase quoting
  - newest-first windows
  - window splitting
  - attachment-only filings dropped

**Success criteria**

- The Single Security top-100 holds 100 unique accessions.
- Zero false positives on the cases above.
- All existing tests pass unchanged.

---

## Phase 1: warehouse foundation and bulk history

**Entry gate:** P0 checkpoint signed off.

**Tasks**

- `lib/warehouse/db.js`: `better-sqlite3`, WAL, `WAREHOUSE_DB_PATH` (default `./warehouse.db`, git-ignored),
  migration runner over `db/migrations/NNNN_*.sql`.
- Migration 0001: `filings`, `holdings`, `ingest_log` (schema in [ARCHITECTURE.md](ARCHITECTURE.md#schema)).
- `scripts/ingest-bulk.js` (`npm run ingest:bulk -- [--quarter 2026q2 | --all]`):
  - Downloads `https://www.sec.gov/files/dera/data/form-n-port-data-sets/<q>_nport.zip`.
  - Streams it with `yauzl` (new dependency). No full unzip to disk.
  - Joins `SUBMISSION` + `REGISTRANT` + `FUND_REPORTED_INFO`. Stores **all filings**.
  - Stores **private-candidate** holdings: equity-type rows (EC, EP, OTHER, and warrants) that are Level 3,
    restricted, or have no check-digit-valid ISIN/CUSIP. Rows with neither a balance nor a value are
    skipped, as `extractAllHoldings` does.
    - _Changed from "any fair-value level" after measuring:_ keeping every level would store about 1.9M
      public-stock rows per quarter.
    - On 2026Q2 the rule keeps 70.5k of 5.35M rows, including all 1,613 rows for the 20 tracked
      companies, among them Level-1/2 private rows with junk identifiers. See ADR 0003.
  - One transaction per quarter; re-running a quarter replaces it.
  - `ingest_log` records quarter, zip checksum, rows read and kept, and duration.
  - Deletes the zip after a successful load. Exits non-zero on any error.
- Converts dates from `DD-MON-YYYY` to ISO `YYYY-MM-DD` at ingest.
- Real-derived fixture `test/fixtures/bulk/`: 7 real 2026Q2 filings, rebuilt by
  `test/fixtures/bulk/build-fixture.js`. It covers:
  - Growth Fund of America (F1)
  - Fidelity OTC
  - KraneShares (Level 1, junk ticker)
  - Innovation Access Fund (Level 2, ISIN "N/A")
  - Destiny Tech100 (SPVs)
  - a filing with warrants
  - a CAD-denominated holding

  Each filing's rows and trimmed `primary_doc.xml` are included.

**Tests**

- `test/warehouse-ingest.test.js` (offline):
  - The fixture ingests.
  - Re-ingest is idempotent.
  - Rows equal `extractAllHoldings(primary_doc.xml)` for the same accessions (value, balance, title,
    fair-value level, instrument type).
  - Dates are ISO.
- `LIVE_SEC`:
  - For 20 random registrant CIKs, the warehouse filing list equals EDGAR submissions inside the bulk window.
  - Baseline measured this session: 0 of 7,046 missing.

**Success criteria**

- All 27 quarters (2019Q4 onward) load in **≤45 min**, with the database **≤500 MB**.
  - _Revised from 300 MB:_ keeping Level-1/2 private rows with junk identifiers costs about 2× the
    Level-3-only size.
  - **Measured: 13.6 min, 364 MB.**
- Every `ingest_log` row matches the zip's row counts. **Measured: 27 of 27 quarters `ok`.**
- Fidelity check passes. **Measured: 106 rows equal `extractAllHoldings` field by field; live check found
  0 of 2,905 EDGAR filings missing across 20 random registrants.**
- _Corrected in P2:_ the "May–Sep 2019 gap" noted here was wrong. The KP Large Cap filing dated
  2019-05-29 is an **NPORT-EX** (HTML exhibit), and EDGAR's own index lists zero NPORT-P filings before
  2019-10-22. Bulk coverage is complete from the first public NPORT-P.

---

## Phase 2: daily catch-up and refresh

**Entry gate:** P1 checkpoint.
**Why:** bulk ends at the last quarter-end. Capital Group's 5/31 and 6/30/2026 Anthropic marks (filed
7/29 and 8/27) were visible to neither bulk nor the live app.

**Tasks**

- Move `fetchWithRetry` and `pace` out of `server.js` into `lib/edgar.js` (the server imports them; no
  behavior change).
- `scripts/ingest-delta.js` (`npm run ingest:delta`):
  - Reads EDGAR's quarterly form index (`/Archives/edgar/full-index/<yyyy>/QTR<n>/form.idx`) for
    NPORT-P and NPORT-P/A filed on or after the newest bulk `filing_date`.
    - _Built:_ the quarterly index (45 MB, about 2 s) instead of per-day files. It's simpler and can't
      miss a day.
    - One entry per accession, since the index lists a filing once per filer.
  - Fetches each `primary_doc.xml` (4 at a time, paced) and parses it with `extractFundMeta` +
    `extractAllHoldings` + `classifyInstrument`. The same keep rule as bulk applies (`isPrivateCandidate`).
  - Writes the same tables with `source='edgar'`, in batches of 25 per transaction.
    - Resumable: skips accessions already stored.
    - Failures go to `ingest_errors` and are retried next run.
  - _Added after real runs:_
    - Network stalls and resets are retried (2 s, then 8 s) with a 60 s timeout.
    - A `primary_doc.xml` that EDGAR serves truncated falls back to the full submission `.txt`
      (DATA-QUALITY trap 17).
- `scripts/refresh.js` (`npm run refresh`):
  1. If a new bulk quarter is posted, ingest it, then delete the `source='edgar'` rows for filings it covers.
  2. Run the daily catch-up.
  3. Write a `refresh_runs` summary row.
  4. Exit non-zero on failure.
- Scheduling: document a launchd/cron entry in [ARCHITECTURE.md](ARCHITECTURE.md#refresh-lifecycle).
  Optionally a scheduled task.

**Tests**

- Offline (`test/warehouse-delta.test.js`, 9 tests), using real index lines and XML:
  - index parsing
  - 21-field parity with bulk rows
  - resumability
  - failure then retry
  - network retry
  - truncated-XML fallback
  - bulk replacement with totals unchanged
  - a full refresh run
- `LIVE_SEC`: after the delta runs, the warehouse contains Growth Fund of America 0001193125-26-323081
  (5/31/2026) with Anthropic F-1, G-1 and common rows totaling **$4,979.7M**.

**Success criteria**

- First catch-up (about 11.7k filings) completes in **≤90 min**.
  - **Measured: 11,822 filings in 26.9 min, about 9 filings/s (the SEC rate limit).**
  - 5 failures on the first pass; all loaded on retry.
- Nightly run **≤5 min**. **Measured: 1.1 s with nothing new**; a typical day of about 130 filings takes
  about 20 s.
- Replacing catch-up rows with bulk leaves every golden total unchanged. **Measured offline: row count and
  value sum identical.**
- **Golden F2–F7 are in the warehouse** from the catch-up, exact to $0.1M (e.g. Growth Fund of America 5/31
  $4,979.7M).

---

## Phase 3: canonical views and as-of engine

**Entry gate:** P2 checkpoint (signed off 2026-09-28).

**Before you start (learned in P0–P2, read this)**

- **Companies don't exist yet** (that's P4). Until then, P3 identifies a company by a case-insensitive name
  pattern over `holdings.issuer_name` and `holdings.title`. The golden aggregates were computed in research
  with exactly these patterns:
  - Anthropic `\banthropic\b`
  - Databricks `\bdatabricks\b`
  - Stripe `\bstripe,? (inc|llc)\b|^stripe\b`

  Make `company` accept `{ pattern }` now and `{ companyId }` in P4.

- **Research method behind A1–A7** (a Python prototype on scratch data; not yet reproduced from
  `warehouse.db`):
  - Rows: `asset_cat IN (EC, EP, OTHER, DE)` **and** `value_usd > 0` **and** `balance > 0`.
  - Fund key: series ID, else CIK.
  - One canonical filing per (fund, report date), latest filing date wins.
  - As of D: the fund's latest canonical filing with `report_date <= D`, whatever it contains. No row
    means exited; no filing within 123 days means inactive.
  - The first as-of attempt missed exits and dead funds, and the first catch-up script mis-read
    `assetConditional`. Both were fixed before these numbers were recorded.
- **Reproduce the golden numbers from `warehouse.db` with that exact method first. Then change rules
  deliberately.** Two known differences to decide on explicitly, not silently:
  - (a) The warehouse keeps rows with a NULL balance but a real value. These are SPV interests reported
    with balance "N/A", e.g. the Destiny Tech100 Brex SPV. The research method dropped them.
  - (b) The warehouse's `instrument_type` (from `classifyInstrument`) separates equity, indirect,
    derivative and debt more precisely than `asset_cat`.

  If a golden number moves, find the rows that moved it, verify on EDGAR, and update GOLDEN-NUMBERS with
  the reason. Never tune code to hit a number.

- **"As of D" means report date ≤ D, using everything filed since.** The $17.26B Anthropic figure for 6/30
  includes 6/30 reports filed as late as 8/27.
  - Also support `knownAsOf` (filing date ≤ D): "what was public on D".
  - Always return each fund's mark date and accession.
- **Offline golden tests need a fixture warehouse.** The live `warehouse.db` is 385 MB and git-ignored.
  - Write `test/fixtures/warehouse/build-fixture.js`. It exports, from the real `warehouse.db`, every
    filing of every fund that ever held the golden companies, plus those companies' holding rows, into a
    small SQLite fixture.
  - Record the source run date in the fixture.
- **Splits:** `public/splits.js` `detectSplit(prev, cur)` is already a shared module; `parsers.js` requires
  it. Reuse it; don't copy it.
- **Useful checks:** `sqlite3 warehouse.db` shows row counts by `source`, `ingest_errors` (should be
  empty) and `refresh_runs`. Run `npm run refresh` first so the data is current.

**Tasks**

- Migration 0003, SQL views:
  - `canonical_filings`: one row per (`fund_key`, `report_date`); the latest `filing_date` wins, so
    amendments supersede. `fund_key = COALESCE(NULLIF(series_id,''), 'CIK'||cik)`.
  - `fund_filing_timeline`: all canonical filings per fund, whatever they contain.
- `lib/analytics/asof.js`: `exposureAsOf({ company, date, instrument: 'equity'|'debt'|'all' })`.
  1. For each fund that ever held the company, take its latest canonical filing on or before `date`.
  2. If that filing has no row for the company, the fund has exited (exposure 0).
  3. If the fund has no filing within 123 days before `date`, it is inactive and excluded.
  4. Return funds, value, and per-fund mark date and accession.
- Split handling via the existing `public/splits.js` `detectSplit`, applied along each (fund, instrument)
  series keyed by `other_id`, else CUSIP, else title, as `instrumentKey` does.
- `test/fixtures/warehouse/`: a real-derived fixture warehouse and its builder (see "Before you start").

**Tests** (golden, from [GOLDEN-NUMBERS.md](GOLDEN-NUMBERS.md))

- Anthropic equity as of 2026-03-31 = **72 funds / $5.93B**.
- Anthropic equity as of 2026-06-30 = **117 / $17.26B** (Capital Group **$8.46B**).
- Stripe equity as of 2025-06-30 / 2025-12-31 / 2026-03-31 / 2026-06-30 = **49 / 35 / 34 / 37 funds** (A5).
- Databricks equity as of 2026-06-30 = **120 funds / $6.22B** (A6).
- KP Large Cap Equity Fund is excluded as inactive after 2020-09-30 (F14).
- Databricks Series H 2022Q3 move is flagged as a 3:1 split (F13: T. Rowe Tax-Efficient 3,712 sh @ $165.88
  → 11,136 sh @ $55.29).
- `knownAsOf` changes the answer: Anthropic with filing date ≤ 2026-06-30 must exclude F2–F7, since those
  were filed in July and August.

**Success criteria:** all golden tests pass offline, against a fixture warehouse built from the golden
accessions, and live.

---

## Phase 4: entities (companies, aliases, SPVs, managers, tracked list)

**Entry gate:** P3 checkpoint.

**Tasks**

- Migration 0004:
  - `companies(id, name, status, public_since, notes)`
  - `company_aliases(company_id, pattern, kind: exact|issuer_key|regex)`
  - `spv_map(fund_key, holding_match, company_id, basis, source_accession)`
  - `managers(id, name)` and `manager_registrants(manager_id, cik)`
  - `tracked_companies(company_id, added_at, note)`
- Set `holdings.company_id` and `via_spv` through the alias map. Re-run after every ingest.
- `scripts/seed-entities.js`:
  - Clusters issuer names with `issuerKeyOf`.
  - Ranks candidates by distinct funds × dollars × quarters present.
  - Filters noise: sanctioned Russian issuers written to zero, `CONTRA …` CVRs, zero-value rows.
  - Emits `data/review/aliases.csv`.
- `scripts/review-aliases.js`: imports the reviewed CSV (human in the loop).
- Managers: curated `data/managers.csv` mapping registrant CIK → parent firm, seeded from registrant
  name/address.
  - **Investigate N-CEN adviser data with real filings first** ([DATA-QUALITY.md](DATA-QUALITY.md#open-questions)).
    Adopt it only if verified.
- Tracked list: seed about 250 from the ranking (2026Q1 baseline: 236 raw name strings with ≥3 funds and
  ≥$25M before alias collapse). Editable in the UI (P6) and CSV.

**Tests**

- Databricks' 59 raw issuer strings resolve to 1 company.
- "STRIPE INC" and "STRIPE LLC" are one company.
- Douyin → ByteDance.
- "Magnitude ANC III, LLC (economic exposure to Anthropic…)" → Anthropic, `via_spv`.
- Fundrise Innovation Fund SPVs are mapped with a cited source accession.
- The Capital Group manager includes CIKs 44201, 719608, 4405, 39473, 4568, 894005 and 729528.
- SpaceX `status='public'`.

**Success criteria**

- The top ~250 are reviewed.
- Under 1% of tracked-company exposure sits in unresolved aliases.
- Every SPV mapping has a source.

---

## Phase 5: service layer and parity migration

**Entry gate:** P4 checkpoint.

**Tasks**

- `lib/services/{search,company,fund,manager,marks,peer}.js`. Move peer analytics (outliers, velocity,
  repricing episodes) from `public/app.js` into `peer.js`.
- Existing routes (`/api/search-nport`, `/api/parse-nport`, `/api/search-fund`, `/api/fund-xray*`,
  `/api/fund-series*`) answer from the warehouse. They fall back to live EDGAR for names the warehouse has
  never seen, and label that source.
- Fund X-Ray: "private" = company status (not Level 3 only), keyed by `fund_key`.

**Tests**

- Every existing `test/app-*.test.js` and `test/server.test.js` passes; update only fixtures, not assertions.
- New: Single Security for Anthropic returns history from 2023, and Stripe and Databricks from 2019.

**Success criteria**

- Full feature parity.
- API p95 **<200 ms** on warehouse-backed routes.
- No regressions in the exports (CSV, XLSX, PDF).

---

## Phase 6: new analysis and UI

**Entry gate:** P5 checkpoint.

**Tasks**

- **Exposure as of any date:** company → parent firm → fund → share class. Each fund's mark date and
  accession are visible.
- **Marks at every report date:** firm, fund and class, split-adjusted. The firm line is the median across
  the firm's funds per report month. Show family lead/lag. Example: Capital Group Stripe marks in 8 of 12
  months.
- **Holder changes:** entered and "no longer reported" per period, never a guessed cause.
- **Tracked-list dashboard:** the ~250, sortable by exposure, holder change, mark velocity, dispersion and
  staleness. Add or remove companies.
- **Top private companies** for any date.
- Cuts by horizon, manager and fund. CSV/XLSX export of every view.
- A freshness banner: last bulk quarter and last catch-up run.

**Tests:** jsdom app tests for each view. Golden numbers must appear on screen, e.g. Capital Group
Stripe marks $33.73 → $35.50 → $41.42 → $63.00.

**Success criteria:** every chart point links to its source accession, and every view reproduces its golden
numbers.

---

## Phase 7: MCP server

**Entry gate:** P5 checkpoint (can run in parallel with P6).

**Tasks:** `mcp-server.js` (stdio, `@modelcontextprotocol/sdk`) over `lib/services`. Tools:

- `find_company`
- `exposure_asof`
- `company_marks`
- `manager_exposure`
- `holder_changes`
- `top_private`
- `fund_private_book`
- `tracked_list`

**Tests:** tool calls return golden numbers; compact JSON; errors are typed.

**Success criteria:** p95 **<200 ms**. Documented setup (`claude mcp add …`) in README.

---

## Phase 8: operations hardening

**Entry gate:** P6 checkpoint.

**Tasks**

- Nightly `warehouse.db` backup with rotation.
- Refresh failure alerting.
- A monthly `LIVE_SEC` regression run that re-verifies GOLDEN-NUMBERS.
- `npm run doctor`: reports freshness, row counts, unresolved aliases and orphan processes.

**Success criteria:** 30 days of unattended nightly refreshes with no gaps; the monthly regression is green.
