# 0007: Managers (parent firms) from Form N-CEN advisers

**Status:** accepted, 2026-09-28 (Phase 4)

## Context

Firm analytics ("Capital Group's Anthropic marks") need each fund's parent firm. v1 grouped funds by a
curated list of registrant _names_ (`TOP_FUND_GROUPS` in `public/app.js`). Registrant names don't identify
the adviser, some trusts (Tidal, EA Series Trust) have a different adviser per series, and name matching
is unsafe ("ACR Alpine Capital Research" vs "Capital Research").

Checked on real filings before adopting (DATA-QUALITY open question):

- Form N-CEN names each series' investment adviser and sub-advisers, with SEC file number (801-…), CRD
  and LEI. All seven Capital Group registrants name Capital Research and Management Company (801-8055).
- The SEC's quarterly N-CEN data sets cover 2018 Q3 onward, but 2025 Q4 lacks 97 of 598 filings (F21).
- Coverage: 17,841 of 18,828 warehouse funds, **99.64%** of 2026 private-holding value (C16).
- One firm files through several adviser entities (BlackRock Fund Advisors, BlackRock Advisors, LLC).

## Decision

- Store every N-CEN adviser row as filed (`ncen_advisers`), from the data sets plus an EDGAR top-up for
  every N-CEN the data sets lack (checked each refresh).
- Key advisers by **SEC file number** (else CRD, else name, for a few foreign sub-advisers).
- Each fund's advisers come from its latest N-CEN (`fund_advisers`, rebuilt after every ingest).
- Adviser → parent firm is a human-reviewed file (`data/review/managers.csv`), seeded from v1's firm
  groups where they overlap and from name stems otherwise. Funds with no N-CEN (new or internally
  managed) map by registrant CIK.
- Form ADV stays rejected as a primary source (CLAUDE.md); N-CEN is a fund filing and is not.

## Consequences

- Firm membership is reproducible from filings; renames and new funds follow automatically.
- The adviser → firm step remains curated (~550 advisers hold private positions; the top 150 carry 97%).
- A fund that changes adviser moves firms at its next N-CEN (yearly), not at the change date.
