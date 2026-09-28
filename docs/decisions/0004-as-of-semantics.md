# 0004: As-of semantics for exposure and holder counts

**Status:** accepted, 2026-09-27

## Context

Calendar-quarter buckets produced wrong numbers during research:

- Amendments were double-counted: Anthropic $6.41B instead of $5.93B.
- Blank series IDs merged distinct funds.
- Exited funds kept counting (23 Stripe funds).
- Dead funds persisted (KP Large Cap, last report 2020).

Funds report on staggered fiscal calendars, so no single date lines everyone up.

## Decision

`exposureAsOf(company, D)`:

1. Consider each fund's latest **canonical** filing (amendment wins) on or before D, **whatever it
   contains**.
2. No row for the company in that filing means exited (0).
3. No filing within 123 days before D means inactive (excluded).
4. Return per-fund value, **mark date** and accession.

`fund_key = series_id`, else `CIK` + cik.

## Consequences

- Numbers are reproducible and auditable. The UI must show mark dates, since "as of D" mixes them.
- Golden tests A1–A7 pin the behavior.
