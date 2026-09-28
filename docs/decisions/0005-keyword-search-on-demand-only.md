# 0005: Keyword (full-text) search is an on-demand tool, not the data backbone

**Status:** accepted, 2026-09-27

## Context

We considered expanding EDGAR full-text search: more pages, quoted phrases, date windows. Date-windowing
avoids the 1,000-hit cap (filings made Jul 1–Sep 27, 2026: Anthropic 223, Databricks 259, Stripe 160 hits),
and its recall matched bulk for Anthropic. But:

- It only returns filings that mention the words, so **exits are invisible**. A fund that sold never
  mentions the name again.
- **Opaque SPVs are invisible.** Fundrise's structured rows never say "Anthropic."
- Aliases need separate queries (Douyin vs. ByteDance).
- Across 250 companies it re-downloads the same large trust filings many times.
- 30–60% of hits were trust-wide attachments with no matching structured row.

## Decision

Keep full-text search (fixed per P0: de-dupe by accession, quoted phrases, word-boundary matching) for:

- "anything filed in the last N days mentioning X"
- names not yet in the warehouse, labeled as live and not yet warehoused

## Consequences

The warehouse (ADR 0001) is the single source of truth for exposure, marks and holder changes.
