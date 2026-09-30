# 0003: "Private" is a company status, not fair-value Level 3

**Status:** accepted, 2026-09-27

## Context

Fund X-Ray treats fair-value Level 3 as "private." Real filings break that:

- KraneShares reports Anthropic Series E-1 preferred at **Level 1**.
- Innovation Access Fund reports its Anthropic position at Level 1/2.
- Level 3 also sweeps in written-off Russian equities, CVRs and defunct issuers.
- Companies go public over time (e.g. SpaceX).

## Decision

- Privacy is a property of the company: `companies.status` (`private` | `public`, with `public_since`),
  curated in P4.
- Fair-value level stays available as a column for analysis, not as the gate.
- **Ingest keep rule (amended 2026-09-28, P1, measured on 2026Q2):**
  - Store equity-type rows (EC, EP, OTHER, warrants) that are **Level 3, restricted, or have no
    check-digit-valid ISIN/CUSIP**.
  - Placeholder rows with neither a balance nor a value are skipped.
  - Why not "any fair-value level": that would also store about 1.9M public-stock rows per quarter.
  - Tickers are never treated as proof a holding is public. They are free text:
    - KraneShares' Anthropic row carries "1892140D".
    - Innovation Access Fund's ISIN is "N/A".
  - Result on 2026Q2: 70.5k of 5.35M rows kept, including all 1,613 rows naming the 20 tracked companies.

## Consequences

- Needs a curated company table: the tracked ~250 plus anything a user looks up.
- Exposure totals include real positions that a Level-3 filter would drop.
- The warehouse is about 2× the Level-3-only size (364 MB for 2019Q4–2026Q2) because of these rows.
- A private company that a filer reports at Level 1/2 **with** a valid ISIN/CUSIP and no restriction flag
  would be missed. None of the 1,613 tracked-company rows did this. Re-check this in P4 with the full
  alias table.

**Amended 2026-09-30 (Phase 5b, user's yes after measurement):**

- Fund X-Ray's capital structure needs the debt of issuers a fund holds privately. A debt row the keep rule
  drops is stored in `capital_structure_rows` (migration 0016, never in `holdings`) when its issuer key
  (`issuerKeyOf`) equals that of a kept, non-debt row in the same filing: v1's `buildIssuerCapitalStructure`
  grouping. Measured on 2026q2 before adopting: 1,855 of 3.02M debt rows, $7.88B, 420 filings (anchor: private
  company 508 rows / $3.51B, listed 157 / $1.43B, unreviewed only 1,190 / $2.94B), ~0.46 MB per quarter.
- Every filing also stores totals over all its rows (`filing_totals`, migration 0015): total, listed equity,
  debt, and v1's Level-3 non-debt figure, so the fund page has its denominators without the dropped rows.
