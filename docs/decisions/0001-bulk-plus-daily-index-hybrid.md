# 0001: Bulk datasets for history + EDGAR daily index for the current quarter

**Status:** accepted, 2026-09-27

## Context

The live app finds filings through EDGAR full-text search and parses only the 100 most recent. Measured on
20 private companies:

- History reached back only 2–14 months.
- Full-text search returned at most 1,000 hits, containing as few as 38% of a company's filings
  (Databricks).
- Filings made 7/1–8/27/2026 were invisible to it, including $4.98B of Growth Fund of America's Anthropic
  position.

## Decision

- **History:** SEC DERA N-PORT bulk datasets (2019Q4 onward).
  - Complete: 0 of 7,046 filings missing across 80 random funds.
  - Identical to the app's parser: 617 of 617 filings.
  - Cheap: about 25–35 min backfill, about 150 MB.
- **Current quarter:** EDGAR's form index, with each `primary_doc.xml` parsed by the app's own parser.
  - _As built:_ the quarterly `full-index/…/form.idx`, 45 MB, about 2 s.
  - Complete, including exits and SPVs.
  - About 1 hour once per quarter of backlog, then about 1 minute a day.
- When the next bulk quarter posts (about 1–7 weeks after quarter end), it replaces that quarter's
  catch-up rows.

## Consequences

- Every question is answered from one local store in milliseconds. The SEC rate limit only affects refresh
  jobs.
- The warehouse trails EDGAR by the index's own lag plus one nightly run. The SEC updates the full index
  nightly and rebuilds the quarterly indexes weekly, with corrections and deletions, so a filing made today is
  not listed until the index catches up (amended P6d, staff full-stack review R12).
- The catch-up finds missing accessions. A filing that fails is retried on every run (up to 5 attempts) even
  after the window moves past it. A bulk re-post (trap 41) is reloaded. Since P8 W3, `npm run reconcile` (monthly,
  `npm run monthly`) compares every quarter's EDGAR index with the stored filings in both directions and re-fetches a
  rotating sample, reporting deletions, missing filings and same-accession changes (never applied without a job).
  Measured 2026-10-07: 0 deletions in 355,007 filings, 0 of 300 re-fetches changed, and 117 reports filed as NT
  NPORT-P that the catch-up had skipped (trap 59, fixed).
