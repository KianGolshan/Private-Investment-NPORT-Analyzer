# 0011: N-CSR as a second source: cost, dates and names, never a mark

**Status:** accepted, 2026-11-05 (P15). The user approved the plan after the N-CSR research and big sample
([plans/ncsr-research.md](../plans/ncsr-research.md), PR #41) and set the admission rule: "ensure only 100%
validatable data is allowed to be ingested and joined. If there are concerns or discrepancies, just do not include
it. Not everything in the app currently will be able to get a cost basis."

## Context

N-PORT gives each fund's holdings and marks, never what the fund paid or when it bought. The funds' semiannual and
annual reports (N-CSR, N-CSRS) print, for every restricted holding, the acquisition date(s) and cost (Reg. S-X
12-12). Checked on real filings: 82 of 98 filings read (2020–2026, Fidelity, Capital Group, T. Rowe Price, Morgan
Stanley); 95% of equity cost joins to an N-PORT row of the same fund and date by shares and value; where two
families bought the same company on the same date, 38 of 40 agree on the price.

The same reports also differ from N-PORT in ways that must not leak into the app: Fidelity values 181 holdings
differently in its N-CSR than in its same-date N-PORT; names repeat; holding vehicles hide the company; splits
change the per-share cost; some reports are page images.

## Decision

1. **N-CSR adds cost, acquisition dates and evidence; it never changes a holding, a mark, a total or the as-of
   rule.** N-PORT stays the only source of positions and marks. No existing table, view or answer changes; a test
   compares every pre-existing table and a snapshot of every answer for Anthropic, Databricks and Anduril (and
   every fund and firm that held them) before and after.
2. **Admission rule: a cost is admitted only when it validates completely; any doubt, it is left out.** All of:
   - the fund report parsed with no error and passed every self-check against the filing's own totals (a count
     note excludes the whole fund report);
   - the line joins the canonical N-PORT filing of the same series and report date, `exact` or as custody legs,
     with the same shares to the share and the value within the printed unit's rounding (≤ $1 in dollar tables,
     ≤ $500 in thousands tables);
   - one meaning only: not paired by order, not ambiguous, not a holding vehicle, not a value conflict, not debt,
     not below the printed unit, not a zero or blank cost;
   - the joined row is a share row of a reviewed company of category `company`.
     Refused lines are kept with their reason for the report and never shown.
3. **Entry prices:** only for single-date lots; split-adjusted only with an unambiguous recorded split, else the
   adjusted price is left out. A **confirmed round price** needs single-date lots at 2+ firms agreeing within
   0.5% on the same date and class.
4. **Wording:** "cost reported by the fund (N-CSR, period end)"; "confirmed round price" only under rule 3.
5. **Families are reviewed:** a registrant is read only when listed in `data/review/ncsr_families.csv` with a
   parser for its layout. A filing that fails is quarantined (stored with its error, no rows) and retried; an
   image-only report is recorded as unreadable.
6. **Holding vehicles named by N-CSR are review suggestions,** applied only through the review import
   (`aliases.csv`, `via_spv`), never by the ingest.

## Amendment, 2026-11-06: lines set apart

The rule "any doubt, leave it out" applies to the line in doubt. A Fidelity fund report whose self-checks fail only
because of **named lines** no longer refuses its other lines, when the filing's own totals prove those lines out:

- a name printed a different number of times among the schedule's marked rows and in the cost table (DNA Script:
  two schedule rows, one cost line, Growth Company 2022–2025): that name is set apart;
- the marked rows exceed the stated restricted total by **exactly** the value of one row or of two rows, and no
  other row or pair fits (Chobani and Trade Republic, bought Oct and Dec 2025, marked restricted but outside the
  stated total, Blue Chip Growth 2026-01-31): those names are set apart.

At most three names. With them taken out of the schedule, the cost table and the stated total, the rest of the
report must pass every check outright. A shortfall (the stated total holds a row the parse did not read), a gap two
pairings explain, or more names still refuse the whole report. A set-apart line is never admitted (refused `set
apart`). The check list stored with the report records the names, why, and the failures before (`lines set apart`).
Real cases and counterexamples: `test/ncsr.test.js`, `test/ncsr-ingest.test.js`.

## Consequences

- Many holdings have no cost; the app shows "—" and a coverage share wherever a total appears. No cost totals in
  Market or Sectors.
- A family's layout change stops that family's new rows (fail closed) until its parser is updated with a fixture.
- Storage grows by tens of MB (budget 1 GB). The backfill reads about 1,000 filings once, as a job.
