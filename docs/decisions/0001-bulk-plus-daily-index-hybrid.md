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
- The warehouse always trails EDGAR by at most one nightly run.
