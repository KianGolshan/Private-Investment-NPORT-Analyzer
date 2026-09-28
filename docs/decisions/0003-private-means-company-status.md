# 0003: "Private" is a company status, not fair-value Level 3

**Status:** accepted, 2026-09-27

## Context

Fund X-Ray treats fair-value Level 3 as "private." Real filings break that:

- KraneShares reports Anthropic Series E-1 preferred at **Level 1**.
- Innovation Access Fund reports its Anthropic position at Level 1/2.
- Level 3 also sweeps in written-off Russian equities, CVRs and defunct issuers.
- Companies go public over time (e.g. SpaceX).

## Decision

- Keep equity-type rows at **any** fair-value level.
- Privacy is a property of the company: `companies.status` (`private` | `public`, with `public_since`),
  curated in P4.
- Fair-value level stays available as a column for analysis, not as the gate.

## Consequences

- Needs a curated company table: the tracked ~250 plus anything a user looks up.
- Exposure totals include real positions that a Level-3 filter would drop.
