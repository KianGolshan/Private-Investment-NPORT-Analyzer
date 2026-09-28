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

**Tests**

- `test/parsers.test.js`: "Revolut" does not match REVOLUTION MEDICINES INC; "OpenAI" does not match
  OpenAir.com; "Anthropic" does not match Anthropics Technology Ltd.
- `test/server.test.js`: two EFTS hits sharing one `adsh` produce one filing.

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
  - Stores holdings rows whose asset category is equity-type (EC, EP, OTHER, DE), including category and
    description from `assetConditional`, at **any** fair-value level.
  - One transaction per quarter; re-running a quarter replaces it.
  - `ingest_log` records quarter, zip checksum, rows read and kept, and duration.
  - Deletes the zip after a successful load. Exits non-zero on any error.
- Converts dates from `DD-MON-YYYY` to ISO `YYYY-MM-DD` at ingest.
- Real-derived fixture `test/fixtures/bulk/mini_nport.zip`: real TSV rows for Growth Fund of America
  (0001193125-26-182055) and Fidelity OTC (0000035402-25-002966, 0000035402-26-002031), plus their
  `primary_doc.xml` saved under `test/fixtures/`.

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

- All 27 quarters (2019Q4 onward) load in **≤45 min**, with the database **≤300 MB**.
- Every `ingest_log` row matches the zip's row counts.
- Fidelity check passes.

---

## Phase 2: daily catch-up and refresh

**Entry gate:** P1 checkpoint.
**Why:** bulk ends at the last quarter-end. Capital Group's 5/31 and 6/30/2026 Anthropic marks (filed
7/29 and 8/27) were visible to neither bulk nor the live app.

**Tasks**

- Move `fetchWithRetry` and `pace` out of `server.js` into `lib/edgar.js` (the server imports them; no
  behavior change).
- `scripts/ingest-delta.js` (`npm run ingest:delta`):
  - Reads EDGAR daily form indexes (`/Archives/edgar/daily-index/<yyyy>/QTR<n>/form.<yyyymmdd>.idx`) for
    NPORT-P and NPORT-P/A filed after the newest bulk `filing_date`.
  - Fetches each `primary_doc.xml` and parses it with `extractFundMeta` + `extractAllHoldings` +
    `classifyInstrument`.
  - Writes the same tables with `source='edgar'`. Resumable: skips accessions already stored.
- `scripts/refresh.js` (`npm run refresh`):
  1. If a new bulk quarter is posted, ingest it, then delete the `source='edgar'` rows for filings it covers.
  2. Run the daily catch-up.
  3. Write a `refresh_runs` summary row.
  4. Exit non-zero on failure.
- Scheduling: document a launchd/cron entry in [ARCHITECTURE.md](ARCHITECTURE.md#refresh-lifecycle).
  Optionally a scheduled task.

**Tests**

- Offline: a delta over a fixture daily index plus fixture XMLs; replacing a quarter keeps totals equal.
- `LIVE_SEC`: after the delta runs, the warehouse contains Growth Fund of America 0001193125-26-323081
  (5/31/2026) with Anthropic F-1, G-1 and common rows totaling **$4,979.7M**.

**Success criteria**

- First catch-up (about 11.7k filings) completes in **≤90 min**.
- Nightly run **≤5 min**.
- Replacing catch-up rows with bulk leaves every golden total unchanged.

---

## Phase 3: canonical views and as-of engine

**Entry gate:** P2 checkpoint.

**Tasks**

- Migration 0002, SQL views:
  - `canonical_filings`: one row per (`fund_key`, `report_date`); the latest `filing_date` wins, so
    amendments supersede. `fund_key = COALESCE(NULLIF(series_id,''), 'CIK'||cik)`.
  - `fund_filing_timeline`: all canonical filings per fund, whatever they contain.
- `lib/analytics/asof.js`: `exposureAsOf({ company, date, instrument: 'equity'|'debt'|'all' })`.
  1. For each fund that ever held the company, take its latest canonical filing on or before `date`.
  2. If that filing has no row for the company, the fund has exited (exposure 0).
  3. If the fund has no filing within 123 days before `date`, it is inactive and excluded.
  4. Return funds, value, and per-fund mark date and accession.
- `lib/analytics/splits.js`: the logic from `public/splits.js` as a shared module (the browser keeps
  working).

**Tests** (golden, from [GOLDEN-NUMBERS.md](GOLDEN-NUMBERS.md))

- Anthropic equity as of 2026-03-31 = **72 funds / $5.93B**.
- Anthropic equity as of 2026-06-30 = **117 / $17.26B** (Capital Group **$8.46B**).
- Stripe equity as of 2026-03-31 = **34 funds**.
- KP Large Cap Equity Fund is excluded as inactive.
- Databricks Series H 2022Q3 move ~$166 → ~$55 is flagged as a 3:1 split.

**Success criteria:** all golden tests pass offline, against a fixture warehouse built from the golden
accessions, and live.

---

## Phase 4: entities (companies, aliases, SPVs, managers, tracked list)

**Entry gate:** P3 checkpoint.

**Tasks**

- Migration 0003:
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
