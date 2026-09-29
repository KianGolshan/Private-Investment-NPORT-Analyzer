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

**Amended 2026-09-28 (Phase 3):**

- "Latest filing wins" breaks same-day ties (515 groups in real data): an NPORT-P/A beats an NPORT-P, then
  the higher accession. The rule lives in the `canonical_filings` view (migration 0003).
- A fund counts only if a canonical filing on or before D held the company; a fund that first buys after
  D is not an "exit".
- Inactive means more than 123 days between the fund's latest report date and D (day 123 is active).
- `knownAsOf` limits every step, amendments included, to filings made on or before that date: "what was
  public then". Anthropic as of 2026-06-30 is 117 funds / $17.26B, but 82 / $6.23B as known on 2026-06-30.

## Consequences

- Numbers are reproducible and auditable. The UI must show mark dates, since "as of D" mixes them.
- Golden tests A1–A7 pin the behavior.
