# Vantage v2 Roadmap

**Goal:** the same app, with far more capability. SEC-verified, refreshable, historically accurate
private-investment exposure and marks, sliced by **company → parent firm → fund → share class** over any
time horizon. Covers any private company you look up, plus a curated tracked list (180 private operating
companies after P4.5; the user decides its size). Evidence for every design choice is in [ARCHITECTURE.md](ARCHITECTURE.md),
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
          → P4.5 evidence-based company identity + unresolved-value report
            → P5a services, search over all issuers, company page (warehouse, read-only)
              → P5b fund pages, lists, exports; per-filing flows retired
                → P6 new analysis + UI
                  → P8 operations hardening
                    → P9 public deployment (live site: LinkedIn, personal website, portfolio)
              → P7 MCP server   (after P5a; parallel with P5b and P6)
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

**Checkpoint (2026-09-28, awaiting sign-off)**

- Built: `db/migrations/0003_canonical_views.sql`, `lib/analytics/asof.js` (`exposureAsOf`,
  `instrumentHistory`), `test/fixtures/warehouse/` (191 funds, 4,832 filings, 6,625 rows, 299 KB) and
  `test/analytics-asof.test.js` (18 tests). `parsers.js` exports `instrumentKeyOf` (same rule, now shared).
- A1, A2, A5, A6 reproduced exactly from `warehouse.db`. A3 and A4 corrected with EDGAR evidence (A3 is 9
  funds, same $8.46B; A4 is 82 / $6.23B). Offline and live golden tests pass.
- Same-day tie-break added to "latest filing wins": NPORT-P/A, then the higher accession. No golden moved.
- Decided (2026-09-28): (a) NULL-balance rows with a value count; (b) equity-type = `instrument_type` other
  than debt, as v1; (c) `S000000000` is treated as blank (`fundKeyOf`, migration 0004). Goldens unchanged.
- `instrument: 'debt'` throws: the warehouse stores no DBT rows.

---

## Phase 4: entities (companies, aliases, SPVs, managers, tracked list)

**Entry gate:** P3 checkpoint.

**Carried from P3:** store each filing's series LEI at ingest (bulk and EDGAR) and key blank-series
filings by it, so multi-series registrants without series IDs (Invesco BLDRS, GOLDEN-NUMBERS F19) stop
sharing a CIK key. Resolve the one series ID claimed by two unrelated funds (`S000097937`) the same way.
DATA-QUALITY trap 20.

**Tasks**

- Migration 0004 (_built as 0008–0010; 0004 became the placeholder-series fix in P3_):
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
- Managers: curated `data/review/managers.csv` mapping registrant CIK → parent firm, seeded from registrant
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

**Checkpoint (complete 2026-09-29)**

- Built:
  - Fund identity by series LEI (0005–0007).
  - N-CEN advisers (ADR 0007).
  - Entity tables (0008–0009) and listing evidence (0010).
  - Seed, curation, review-import, resolve and upkeep modules; refresh runs N-CEN and entity upkeep.
- Entity review finalized with filing evidence (`data/review/curation.json`) and imported: 739 companies,
  178 tracked, 529 firms. See STATUS "Phase 4 results".
- Success criteria met on the live warehouse:
  - Top companies reviewed.
  - Unresolved tracked exposure 0.46% (under 1%).
  - Every SPV mapping has a source: named SPVs cite the vehicle row; the curated one and the Fundrise ranges
    cite an accession.
- Deviations from the task list, each with its reason:
  - `manager_advisers` (by SEC file number) sits next to `manager_registrants`, because trusts mix advisers
    per series.
  - `disclosed_exposure` records range-only disclosures (trap 24).
  - `listing_evidence` exists because listed companies look private (trap 25).
  - `curation.json` keeps reviewed decisions across re-seeds.
  - Migrations run to 0010.
- Listing evidence covers the latest 4 quarters. A full 27-quarter backfill (for `public_since`) would push
  the warehouse (472 MB) past its 500 MB budget: prune or ask first.

---

## Phase 4.5: evidence-based company identity

**Why (found 2026-09-29, after P4):** FHU US Holdings (Chobani) — 13 funds, ~$359M at 2026-06-30 — was in
no company group. Fidelity holds it through per-fund holding LLCs named "<fund code> FHUS HOLDINGS LLC"
(BCGF, OTC, CONTSA…), Capital Group writes "FHU US HOLDINGS LLC", and only T. Rowe's title says "dba
Chobani", so the name cleaner saw 11 fragments, none held by 3 funds. Fidelity's latest filings hold ~$0.7B
in such per-fund LLCs across ~12 targets, none resolved. Patching name patterns one at a time keeps missing
cases; resolve identity from evidence and measure what is missed by dollars (DATA-QUALITY traps 31–33).

**Entry gate:** P4 complete.

**Tasks**

- **Identity graph.** Raw names (issuer key + exact raw strings) are nodes; an edge joins two nodes only on
  filing evidence, each edge stored with its kind, source accession and confidence:
  1. the same issuer LEI (`holdings.lei`; present on 15% of Level-3 rows, 35% of their value);
  2. the same fund keeping the same filer instrument id, or the same share count in the same class, across a
     name change (Oura, Anduril Engineering, Superhuman);
  3. the same filing giving two names the same per-unit mark on the same date (Project Debussy = Databricks);
  4. a title that names the company, including "dba" and "formerly" wording (Douyin → ByteDance, FHU US →
     Chobani);
  5. normalized-name matches, including stripped per-fund prefixes ("BCGF FHUS" → "FHUS") and spacing
     variants ("FHUS" ≈ "FHU US", "OPEN AI" = "OPENAI").
     Companies are the connected components. Guardrails: generic ids ("SEDOL", "Internal identifier") and
     merger chains (Windstream → Uniti → New Windstream) never make edges; a component that would join two
     different LEIs, a listed and a private company, or two curated companies is flagged, not merged.
- **Thresholds after linking:** the ≥3 funds / ≥$25M candidate rule applies to components, so fragmented
  companies (FHU) qualify.
- **Vehicles as their own type:** SPVs, per-fund holding LLCs, blockers and fund stakes link to a company as
  indirect (`via_spv`) only when their name or a filing says what they hold; opaque ones ("BCGF VETERINARY
  HOLDINGS", "TB2 HLDG") go to the review list with their dollar size, never guessed.
- **Brand aliases:** a company is the issuer that was invested in, with brands as aliases ("FHU US Holdings",
  alias "Chobani"), so either name finds it.
- **Unresolved-value report** (`npm run entities:report`): private-candidate value not resolved to any
  company, across all holdings (not only tracked), grouped by component and ranked by dollars, plus
  flagged conflicts and opaque vehicles. It is the review queue after every refresh.
- Re-run the seed with the graph, finalize with evidence (FHU US Holdings / Chobani and the Fidelity
  vehicles among them), record decisions in `curation.json`, import, and re-measure.

**Tests**

- FHU US Holdings resolves as one company with alias Chobani: Capital Group (AMCAP, Fundamental Investors),
  T. Rowe Large-Cap Growth and the Fidelity per-fund LLCs (indirect), 13 funds at 2026-06-30 (GOLDEN F29).
- LEI edge: the T. Rowe FHU row (LEI 549300ISVDMZ91KNTR38) joins its component.
- Same-mark edge: Project Debussy joins Databricks (F25); instrument-id edges: Oura, Anduril (F26, F27).
- Guardrails: Windstream/Uniti stay separate; OpenAir stays separate from OpenAI; a forced conflict is
  flagged.
- Every P4 test and golden number still holds (companyId goldens, Databricks 59 raw strings → 1 company).

**Success criteria**

- Unresolved private-candidate value, ranked, has no single unresolved component above an agreed size
  (propose $50M) that is not an opaque vehicle on the review list.
- Tracked-company unresolved exposure stays under 1%.
- Every edge and every curated decision cites an accession.

**Checkpoint (signed off 2026-09-30)**

- Built: `lib/entities/identity.js` (edges + guarded components), `lib/entities/report.js` and
  `npm run entities:report` (review queue, also run by every refresh), migration 0011 (`identity_edges`,
  `identity_nodes`, `company_brands`), seed integration (component-level candidate rule, vehicles as
  indirect, brands), `test/identity.test.js` on a new real-data fixture (`test/fixtures/identity/`).
- Threshold agreed with the user (2026-09-30): **>= $50M held by >= 2 funds**. A name held by 2 funds is a
  candidate from $50M (an entity, tracked only from 3 funds).
- Results on the live warehouse: FHU US Holdings = 13 funds / $359.0M at 2026-06-30 (brand Chobani, Fidelity
  LLCs indirect); nothing >= $50M in 2+ funds unresolved except 3 opaque Fidelity vehicles on the review list
  (no filing states their holdings); tracked unresolved 0.21%; every edge except pure spelling edges and every
  curation decision cites an accession.
- Found on real data: BlackRock's look-alike labels for Anthropic and OpenAI (F31, F32; merged with the user's
  approval), Ramp's unmatched Coatue rows (F33), reused position ids, wrong LEIs and merger chains
  (DATA-QUALITY traps 35–39). Anthropic by company at 6/30 is 117 / $17.295B; pattern goldens unchanged.
- Deviations: guardrail test "OpenAir stays separate" became "the name rule never joins OpenAir and OpenAI;
  filer evidence does" (user decision 2026-09-30). The Windstream/Uniti chain is real id evidence, stopped by
  the listed-vs-private guard.

---

## Phase 5: the app reads the warehouse (split into 5a and 5b)

**Why the plan changed (pre-P5 review and planning, 2026-09-30; STATUS "Phase 5 planning").** The first P5
plan ("full parity; routes answer from the warehouse and fall back for names never seen; update fixtures,
not assertions") did not survive a check against the code and the live warehouse:

- The warehouse stores private-candidate equity only (ADR 0003). v1's Single Security also shows debt and
  any listed name. All 502 public companies have a few restricted/PIPE rows, so "seen by the warehouse" would
  return a small slice (Pfizer: 1,079 filings price it at Level 1 in 2026q2 alone, F24).
- v1 aggregates in the browser: EFTS hits capped at 50 filings (250 at most), one `/api/parse-nport` call
  per filing, then `groupAndDedupe` on (date, shares, instrumentKey). An amendment with the same share count
  keeps whichever copy sorts first; one with a different count is counted twice; exits are invisible.
  Keeping v1's assertions would ship v1's math on v2 data.
- Speed on the live warehouse: one company 7 ms warm (p95 over the 180 tracked) but 230–570 ms cold; all 180
  tracked 0.4 s warm, 1.7–4 s cold; a name pattern 2.7 s.
- Company ids survive renames but are assigned by SQLite at import and live in no reviewed file: a fresh
  warehouse renumbers them, and a merged or dropped company's id disappears.
- Fund X-Ray needs the whole fund book (total and public holding counts, % of holdings value, debt tranches
  in the capital structure), which the warehouse does not store.
- 846k stored rows have no company and `holdings` has no issuer-key column, so an "unreviewed name" answer
  would take the 2.7 s regex path.
- Size: 513 MB of 600 MB; P5's additions plus the 2026Q3 bulk quarter (~25 MB) land near 580 MB.

**Decisions (user, 2026-09-30; ADR 0008):**

1. **Parity scope.** Route by company status: private companies from the warehouse; listed companies and
   debt from live EDGAR, labeled "live, not warehoused". "Full parity" means every v1 view keeps working;
   numbers change only where v1 was wrong. A status change goes to the review queue; it never silently
   switches the source.
2. **API shape.** New `/api/search`, `/api/companies/…` and `/api/funds/…` endpoints over `lib/services`; the
   app calls them; v1's per-filing routes stay only as a compatibility layer. An app-test assertion may
   change only where v1's number was wrong, each change justified against GOLDEN-NUMBERS in the commit.
3. **Identifiers.** Stable company ids, written to the reviewed files so a rebuild reproduces them; a merged
   or dropped id redirects to its successor. URLs are `/company/<id>-<slug>` (the id decides; the slug is
   cosmetic). MCP tools take an id or a name and return ids.
4. **Lists.** One curated tracked list (no schema change). Viewer watchlists stay in the browser and store
   company ids. Named lists, if wanted later, are an additive table.
5. **Split.** 5a = services, read-only warehouse access, search over every issuer, speed, and the company
   page (Single Security on the warehouse). 5b = Fund X-Ray, Batch, Watchlist, exports, and retiring the
   per-filing flows. P7 may start after 5a.
6. **"Make this a company"** is local and admin-only (an env flag, localhost only). The server stays
   read-only: the action runs the review import as a job under the refresh lock. The deployed-app path is
   decided before P9.
7. **Unreviewed names** are searchable and answerable, labeled "unreviewed" with their category.
8. **Size.** Prune before adding; hard gate ≤600 MB; if pruning is not enough, stop and ask.
9. **Changes to the first recommendation (user, 2026-09-30):** Fund X-Ray's full-book fields are stored per
   filing at ingest, not fetched live (5b); precompute only what a measurement shows is needed (5a).

### Phase 5a: services, search and the company page

**Entry gate:** P4.5 signed off (2026-09-30), this plan signed off, `npm run refresh` ok at session start.

**Tasks** (in this order; each ends green)

1. **Size first.** Measure every index with `dbstat`; drop only indexes no query uses (prove it with
   `EXPLAIN QUERY PLAN` over every prepared statement in `lib/`; `filings_source`, 7.7 MiB, is the first
   candidate). Record before/after in STATUS. The ≤600 MB gate applies after every later task.
2. **Stable company ids** (migration 0012). The importer reads and writes an `id` for every company in the
   reviewed files (`data/review/aliases.csv` gains an `id` column, or a `company_ids.csv`; pick the smaller
   diff), assigns the next free id only to a new company, and never reuses one. `company_redirects(old_id,
new_id, reason, source)` records merges and drops (from `curation.json`). A fresh warehouse built from the
   files reproduces every id.
3. **Entities for every issuer** (migration 0013). `entities(id, kind company|unreviewed, company_id,
issuer_key, display_name, category, status, funds, value_usd, last_mark_date)`, rebuilt by refresh from
   companies plus the identity components and single issuer keys that no company claims; and
   `holdings.entity_id` (indexed; ~15–20 MiB, measured like `holdings_company`). Unreviewed entities are
   addressed by their issuer key in URLs, never by their number (components can change between refreshes).
   `exposureAsOf` gains `{ entityId }` next to `companyId` and `pattern`.
4. **Search index** (same migration or 0014): an FTS5 `trigram` table over company names, aliases, brands,
   issuer keys and example raw names, each row pointing at an entity, rebuilt at refresh. The query
   normalizer is the name cleaner's (`lib/entities/names.js`): case, punctuation and spacing ("FHUS" ≈
   "FHU US", "Open AI" = "OpenAI"), per-fund vehicle prefixes, and abbreviation pairs (INTL ↔
   INTERNATIONAL, HLDGS ↔ HOLDINGS). Ranking: exact name/alias/brand → normalized → substring (trigram) →
   a bounded edit distance, only for queries of 6+ characters and never across a `curation.separate` pair.
   Every result returns its **match reason** (name, alias with its source, brand, substring, similar
   spelling) and evidence (funds, value, latest mark date, example raw names, reviewed or not).
5. **Services** (`lib/services/`, pure functions over a db handle, shared by the server and P7):
   - `search.js`: the ranked candidates above.
   - `company.js`: `exposure(id, date, { knownAsOf })` (funds with mark date and accession, `indirect`,
     `zeroValue` as "reported at $0", exits as "no longer reported", `disclosedExposure` in the filing's
     words), `history(id)` (every canonical report date from the first filing, per fund and class,
     split-flagged via `public/splits.js`, `pricePerShare` for share rows and `pricePerUnit` otherwise).
   - `source.js`: the routing rule (private → warehouse; listed or debt → live EDGAR, labeled).
6. **Server** opens the warehouse once with `openWarehouseReadOnly`. If it is missing or behind, warehouse
   routes answer 503 with the reason and the live routes keep working. New routes: `/api/search?q=`,
   `/api/companies/:id`, `/api/companies/:id/exposure?date=&knownAsOf=`, `/api/companies/:id/history`,
   `/api/entities/by-key/:issuerKey/…` (unreviewed), `/api/freshness`. Every response carries `source`
   (`warehouse` | `live`), `refreshId` (the latest `refresh_runs.id`, also the ETag) and mark dates. A
   redirected id answers 301 to its successor.
7. **Speed, measured before optimized.** `npm run bench` replays a fixed set of real requests (the 180
   tracked companies at the latest date, the search cases below, the three history companies) against the
   live warehouse, cold (after a refresh) and warm, and prints p50/p95/max per route. Then: warm the page
   cache at server start (one pass over the tracked list); precompute only what still misses 200 ms (the
   expected one: tracked companies at the latest date, a table written by refresh).
8. **Company page** replaces Single Security's results: one search box with typeahead (candidates with
   evidence and match reason), `/company/<id>-<slug>` permalinks, holders as of a date (mark date and
   accession per fund; labels "indirect", "reported at $0", "no longer reported", "unreviewed"), the full
   history chart and table from the warehouse, and v1's debt section and listed names from the live path
   with the "live, not warehoused" label. Old `?security=` links resolve through search.

**Tests**

- **History:** the company page for Anthropic starts at 2023-04-28, Stripe at 2019-12-31, Databricks at
  2019-10-31 (checked on the live warehouse 2026-09-30).
- **Goldens through the API and on screen** (jsdom): Anthropic 6/30/2026 117 / $17.295B by company (F31) and
  3/31/2026 72 / $5.945B; Stripe 49 / 35 / 34 / 37 (A5); Databricks 120 / $6.233B (F25); FHU US Holdings
  13 / $359.0M (F29); OpenAI 87 / $5.490B (F32); `knownAsOf` 6/30 Anthropic 82 / $6.23B (A4); American High
  Income Trust's Mesquite row shown as "reported at $0" (F34); Growth Fund of America F2 $4,979.7M with its
  accession.
- **Search** (each asserts the match reason, on a real-data fixture extended from `test/fixtures/identity/`):
  "Chobani" (brand), "FHU", "FHUS", "fhu us holdings" → FHU US Holdings; "Open AI" → OpenAI (normalized);
  "Databrick" → Databricks (substring); "Hub International" → Hockey Parent Holdings (its brand is stored as
  "HUB INTL": abbreviation pair). "OpenAir" returns OpenAI **only** through the curated alias `OPENAIR`
  (reason "alias", source F32); with that alias removed from the fixture it does not return OpenAI, and the
  similar-spelling rule never joins OPENAIR and OPENAI. A name held by no company returns an "unreviewed"
  entity with its category, and its exposure equals the pattern answer for the same rows.
- **Routing:** a listed company (Pfizer, F24) answers from the live path with the label, never with the
  warehouse's restricted rows alone; a debt request never reads the warehouse.
- **Ids:** a warehouse built from the reviewed files reproduces every id; a merged id answers 301; a rename
  keeps the id (existing test).
- **Read-only:** the server never opens the warehouse writable; a missing or behind warehouse gives 503 on
  warehouse routes and live routes still pass.
- **v1 tests:** every `test/app-*.test.js` and `test/server.test.js` passes. An assertion changes only where
  v1 was wrong, with the golden that proves it named in the commit.

**Success criteria**

- p95 < 200 ms on every warehouse route in `npm run bench`, warm and after a refresh (cold numbers recorded).
- Every golden above appears through the API and on screen, with mark dates and accessions.
- `warehouse.db` ≤ 600 MB; `npm run refresh` stays ≤ 5 min with the new rebuild steps.
- No visitor request to a warehouse route makes an SEC call (checked in tests with a failing fetch).

**Out of scope for 5a:** Fund X-Ray, Batch, Watchlist and exports (5b); new analysis (P6); the private-credit
tab (unchanged); any change to the keep rule.

### Phase 5b: funds, lists, exports, and retiring the per-filing flows

**Entry gate:** 5a signed off.

**Tasks**

1. **Per-filing totals stored at ingest** (migration). `filing_totals(accession, rows, value_usd,
rows_listed, value_listed, rows_debt, value_debt, …)` computed from **all** rows of the filing before the
   keep rule, in both ingest paths (bulk and EDGAR XML, parity-tested like LESSONS 6). Backfill: re-read the
   27 bulk quarters (~14 min) and re-fetch the catch-up filings (~14k, ~26 min at the SEC rate), foreground,
   resumable, timed batches.
2. **Capital-structure rows: measure, then decide.** X-Ray's capital structure needs the debt tranches of
   issuers that also have a private equity row in the same filing. Measure that row count and size on one
   bulk quarter first (LESSONS 5). Adopt a narrow keep-rule extension only within the size gate and with the
   user's yes (ADR 0003 amendment); otherwise that one panel stays live, labeled.
3. **Fund page (Fund X-Ray on the warehouse)**, keyed by `fund_key`: private = company status (unreviewed
   private candidates shown and labeled), totals and % of NAV from `filing_totals` and `filings.net_assets`,
   quarter-over-quarter compare and mark-implied returns across the fund's canonical filings (amendments
   win; exits shown). Replaces `/api/search-fund`, `/api/fund-series*` and `/api/fund-xray*` in the app.
4. **Batch → compare companies; Watchlist → my list.** Both call the company services. Watchlist entries are
   company ids in `localStorage`; existing name entries are resolved once through search, and any the user
   has not confirmed stay visible as "unmatched".
5. **Peer analytics** (`computeMarkVelocity`, `computeOutlierFlags`, `computeLeaderboardRows`) move to
   `lib/analytics/peer.js`, shared by the browser and Node like `public/splits.js`.
6. **Exports** (CSV, XLSX, PDF) come from the same service data, with mark date, accession and source columns.
7. **Retire the per-filing flows:** the app no longer calls `/api/search-nport` + `/api/parse-nport` for
   private companies; those routes stay as a compatibility layer (and for the live path).
8. **"Make this a company"** (admin only): writes the decision to `data/review/` and runs the review import
   as a job under the refresh lock; the page then shows the new company with its id.

**Tests**

- X-Ray goldens: a fund's private book equals `exposureAsOf` for its companies at that filing; the totals
  in `filing_totals` equal `extractAllHoldings` on the same real XML (the 7 fixture filings); amendments
  replace, never add (F16).
- Compare/returns across real canonical filings; an exited position is "no longer reported".
- Watchlist migration: names → ids on a real-name list, with unmatched names kept.
- Exports: every column v1 exported is still there with the same meaning; values differ only where 5a showed
  v1 was wrong. PDF/XLSX render in jsdom.
- The admin action refuses without the flag or from a non-local address, and refuses while a refresh runs.

**Success criteria**

- Every v1 view works on warehouse data (private) or the labeled live path (listed, debt).
- p95 < 200 ms on the new fund routes; no SEC call from any warehouse route.
- `warehouse.db` ≤ 600 MB after the backfill.

**Out of scope for 5b:** firm pages and new analysis (P6); the deployed curation path (before P9).

---

## Phase 6: new analysis and UI

**Entry gate:** P5b checkpoint.

**Shape (decided 2026-09-30):** the app is organized around **company, fund and firm pages** that link to
each other, with one search box (P5a) and permalinks, instead of v1's input tabs. Every new view is a page
section or a cut of these pages. Field coverage checked on the live warehouse 2026-09-30: `pct_nav` on 100%
of tracked-company rows, `country` on 99.3%, `filings.net_assets` on 100% of filings; filings arrive about
58 days after the report date, and 3,884 arrived in the last 7 days.

**Tasks**

- **Firm page** (N-CEN advisers → `managers`, ADR 0007): the firm's private book across its funds as of any
  date, and its marks per company.
- **Exposure as of any date:** company → parent firm → fund → share class, with a **date slider** and a
  "what was public on that day" toggle (`knownAsOf`). Each fund's mark date and accession are visible.
- **Marks at every report date:** firm, fund and class, split-adjusted. The firm line is the median across
  the firm's funds per report month. Show family lead/lag. Example: Capital Group Stripe marks in 8 of 12
  months.
- **Holder changes:** entered and "no longer reported" per period, never a guessed cause.
- **What's new feed** (site-wide and per company): marks filed since a date, with mark-ups and mark-downs
  (per-share or per-unit change and the prior mark's date), new holders, funds no longer reporting, and
  positions reported at $0. Every item shows its mark date, filing date and accession. An RSS/Atom feed per
  company (no accounts needed).
- **Conviction:** each holder's position as % of its net assets (`pct_nav`), sortable next to dollars.
- **Mark disagreement:** for one company and one mark date, the spread of per-share marks across funds and
  firms, and which firm moved first across report dates. Same-date comparisons only; different dates are
  shown apart.
- **Stale marks:** funds carrying an unchanged per-share mark for N+ report dates while other holders moved.
- **Class mark comparison:** normalized class labels (starting from v1's `parseEquityLabel`), then per
  company and date: every class's per-share mark by fund and firm, the within-filing gaps between classes and
  cross-firm gaps on the same mark date. Real example: Capital Group marks all Anthropic classes at $589.01
  (5/31 and 6/30/2026) while Fidelity marks Series D 5.76% above Series E–H in every filing (GOLDEN F30).
  Show prices, gaps, ratios and dates only: filings don't state the valuation method (e.g. OPM vs. fully
  diluted), so the app never labels one. Warn when comparing different mark dates or vehicle units whose
  conversion to company shares isn't disclosed (Fidelity's per-fund LLC units vs. FHU units).
- **Indirect exposure view:** who holds a company through SPVs and vehicles (named SPVs, Fidelity per-fund
  LLCs), and ranges a filing discloses without naming vehicles (Fundrise, `disclosed_exposure`) in the
  filing's words, never converted to dollars.
- **Geography:** private exposure by the issuer country the filings report.
- **Tracked-list dashboard:** the tracked list (180 after P4.5), sortable by exposure, holder change, mark
  velocity, dispersion and staleness.
- **Top private companies** for any date.
- **Entity editing** stays admin-only and local (ADR 0008): rename, merge (with evidence), track/untrack,
  through the same job as "make this a company" (P5b), writing the review files. One tracked list; named
  lists only if the user asks later (an additive table).
- Cuts by horizon, manager and fund. CSV/XLSX export of every view, with mark date, accession and source.
- A freshness banner: last bulk quarter, last catch-up run, and the partial quarter still being filed.

**Not built (filings don't support it):** company valuations (no total share counts), reasons for exits,
valuation methods. Any new metric is checked on real filings first (CLAUDE.md).

**Tests:** jsdom app tests for each view. Golden numbers must appear on screen, e.g. Capital Group
Stripe marks $33.73 → $35.50 → $41.42 → $63.00; F30's $589.01 vs $622.94 and the 5.76% gap; F34 in the
feed as "reported at $0"; F8/F9 (Fidelity OTC's Stripe) as "no longer reported" at 2026-01-31; A3 Capital
Group 9 funds / $8.46B on the firm page; conviction equals `pct_nav` from the filing for a golden row.

**Success criteria:** every chart point and feed item links to its source accession; every view reproduces
its golden numbers; p95 < 200 ms on the new routes.

---

## Phase 7: MCP server

**Entry gate:** P5a checkpoint (can run in parallel with P5b and P6).

**Tasks:** `mcp-server.js` (stdio, `@modelcontextprotocol/sdk`) over `lib/services`, opening the warehouse
with `openWarehouseReadOnly`. Tools take a company id or a name (resolved through search, returning the
candidates with their match reason when ambiguous) and always return ids (ADR 0008). Answers carry
`source`, `refreshId`, mark dates and accessions, and the same labels as the app ("indirect", "reported at
$0", "no longer reported", "unreviewed"). Listed companies and debt return a typed "not warehoused" error
rather than a live SEC call. Tools (the fund and firm tools arrive when P5b and P6 build their services):

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
- **Nightly watch reports** after each refresh (suggestions only, never auto-applied):
  - unresolved private value, ranked (the P4.5 report);
  - rename / codename evidence: new same-instrument-id, same-share-count or same-mark links;
  - status changes: new post-IPO lock-up, PIPE or listing evidence (likely IPOs), and delistings;
  - new companies and vehicles crossing the candidate threshold;
  - company status changes (private ↔ listed) for review: a status change moves a company between the
    warehouse and the live path (ADR 0008), so it is never applied without review.
- **Research tasks (check real filings first; build nothing unless the data holds, and report negative
  findings):**
  - _Last private mark vs. first listed price_ for companies that went public. `companies.public_since` is
    empty for all 502 listed companies (2026-09-30), and the keep rule drops post-listing rows, so this needs
    a listing date and price source from filings.
  - _Fund type_ (ETF, open-end, closed-end, interval) from N-CEN, to show which holders are retail-accessible
    vehicles. Only advisers are loaded from N-CEN today; check the field's coverage in the data sets and on
    EDGAR (trap 21) before adopting.

**Success criteria:** 30 days of unattended nightly refreshes with no gaps; the monthly regression is green.

---

## Phase 9: public deployment

**Goal:** a public, always-current Vantage at a stable URL (e.g. `vantage.<your-domain>`), fit to share on
LinkedIn, a personal website and a resume. It refreshes itself nightly from the SEC with no manual steps.

**Entry gate:**

- P5a and P5b checkpoints (hard requirement): visitors must never trigger SEC requests.
  - Today every search calls EDGAR live under one shared `SEC_USER_AGENT` and SEC's ~10 req/s fair-access
    limit.
  - A traffic spike would get the server throttled or blocked, and the demo would look broken.
  - After P5, private companies and fund pages answer from the warehouse. What stays live by design (ADR
    0008): listed companies, debt, the keyword search (ADR 0005) and, if 5b did not store them, X-Ray's
    capital-structure tranches. Publicly these are **off** or behind their own low limit, labeled.
- P8 checkpoint: backups, refresh alerting and `npm run doctor` exist.
- P6 freshness banner exists.
- **Deployed curation path decided** (ADR 0008 left it open): the container never writes git-tracked
  files and the public site has no admin actions. Recommended at that time: curation stays local; the
  reviewed files ship with each deploy and the server's refresh re-imports them.
- **Company ids survive a rebuild** (P5a): the fallback "full ingest on the server" must reproduce every
  public URL.
- A private staging deploy may start once P5b is signed off. Public launch waits for P6 and P8.

**Decision to confirm with the user first (record as ADR 0006):** hosting provider.

- **Recommended: one always-on container or VM with a persistent volume.** Options: Fly.io, Railway,
  Render, or a small Hetzner/DigitalOcean VPS.
  - The existing Node + SQLite code runs unchanged.
  - The web app and the nightly job share one `warehouse.db`. WAL mode lets visitors read while the
    refresh writes.
- **Not serverless** (e.g. Vercel functions). There's no writable persistent disk for a 500 MB+ SQLite
  file.
- **Hosted database** (Postgres, Neon, Turso) only if multi-user scale demands it. ADR 0002 notes the
  schema ports cleanly.
- Sizing from measured numbers:
  - 1–2 GB RAM: loading a bulk quarter peaked at 670 MB RSS.
  - A volume of at least 5 GB: the warehouse is 513 MB (2026-09-30) and growing about 25 MB per quarter, plus WAL and
    temporary zips of about 700 MB each.
- Verify current pricing and limits at decision time; don't rely on remembered prices.

**Tasks**

- **Container:**
  - A `Dockerfile` (Node ≥22, `npm ci --omit=dev`, non-root user, `WAREHOUSE_DB_PATH` on the volume).
  - A `/healthz` route that reports app status and warehouse freshness (newest filing date, last
    `refresh_runs` status).
- **Scheduled refresh:** `npm run refresh` daily at about 06:15, via the platform's scheduler or a cron
  (e.g. supercronic) inside the container.
  - It must run on the machine that owns the volume.
  - A lock (e.g. a `refresh_runs` row with status `running` younger than 2 h) prevents overlapping runs.
- **Alerting:** after each refresh, ping a dead-man's-switch URL (e.g. healthchecks.io) on success, and
  send a fail signal on non-zero exit. A missed or failed night emails the owner.
- **Backups:** continuous SQLite replication with Litestream to object storage (Cloudflare R2 or S3).
  - On boot, restore from the replica if the volume is empty.
  - Document the restore drill.
- **First data load:** restore from the Litestream replica, or upload a local `warehouse.db` snapshot.
  Fall back to a full `ingest:bulk -- --all` plus `ingest:delta` on the server (about 14 + 27 min).
- **Secrets and config:**
  - `SEC_USER_AGENT` (contains the owner's email) lives only in the host's secret store, never in the
    public repo.
  - `NODE_ENV=production`: the app already refuses to start without a real UA, and trusts one proxy hop
    for rate limiting.
- **Traffic spikes:**
  - Warehouse-backed API responses carry `Cache-Control` until the next scheduled refresh, with the
    `refreshId` as ETag (P5a), so a CDN serves repeats and a refresh invalidates them.
  - The per-company RSS feeds (P6) are cached the same way.
  - A CDN (e.g. Cloudflare) sits in front of the site.
  - Existing per-visitor rate limits stay on.
  - The on-demand live EDGAR check (ADR 0005) stays behind its own low limit, or is disabled publicly.
- **Presentation:**
  - Custom domain and HTTPS.
  - The freshness banner ("Data as of … · refreshed …").
  - An "About the data" page: SEC sources, the completeness check (0 of 2,905 filings missing), golden
    numbers, the nightly refresh and known limits.
  - Open Graph and preview tags for LinkedIn link cards.
- **Deploy pipeline:** GitHub Actions runs `npm test`, lint and format on the PR, then deploys `main` to
  the host. Staging first, then production.

**Tests**

- The container builds and boots locally against a fixture warehouse. `/healthz` returns freshness from
  `refresh_runs`.
- **Refresh in the deployed environment:** a manual trigger on staging loads new filings and pings the
  health check; a forced failure raises the alert.
- **Restore drill:** delete the staging volume, redeploy, and confirm Litestream restores the warehouse.
  Golden numbers A1–A6 still match.
- **Load:** a burst of cached page and API requests (e.g. 50 concurrent) makes **zero** outbound SEC
  requests (check the logs) and meets the P5 latency budget.
- **Security:**
  - No secrets in the image or repo.
  - Production refuses to start without `SEC_USER_AGENT`.
  - Security headers and CSP are still present.

**Success criteria**

- The public URL serves warehouse data with the freshness banner.
- 14 consecutive unattended nightly refreshes on production with no gaps and no manual steps. A failed
  night alerts within 24 h.
- A restore from backup is proven on staging in ≤30 min.
- No visitor request causes an SEC call. Page and API p95 <200 ms under the load test.
- Golden numbers on the live site match GOLDEN-NUMBERS.

**Rollback:** keep the previous image tag deployable. The warehouse is independent of app deploys (it
lives on the volume and in the replica), so rolling back the app never touches data.
