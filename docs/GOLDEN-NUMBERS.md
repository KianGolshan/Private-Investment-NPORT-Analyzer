# Golden Numbers

Every figure here was verified against real SEC data on 2026-09-27. They become regression tests in
Phase 3 onward. When a number changes (e.g. an amendment is filed), re-verify it against EDGAR and update
this file in the same commit. **Never** edit a golden number without re-verifying it.

**How to re-verify one filing:**

```bash
curl -s -A "$SEC_USER_AGENT" "https://www.sec.gov/Archives/edgar/data/<CIK>/<ACCESSION-NO-DASHES>/primary_doc.xml" | grep -i -A14 "<issuer name>"
```

Use the numeric CIK without leading zeros in the URL path.

## Filing-level (raw EDGAR `primary_doc.xml`)

| #   | Fact                                                                                                                                                                            | Accession            | CIK     | Report date |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------- | ----------- |
| F1  | Growth Fund of America: Anthropic PBC CL G-1 PFD **$1,315,268,824.79** (5,075,585 sh) and CL F-1 PFD **$741,023,858.08** (2,859,590 sh). Bulk dataset matches exactly           | 0001193125-26-182055 | 44201   | 2026-02-28  |
| F2  | Growth Fund of America: Anthropic F-1 $1,684.3M + common $305.8M + G-1 $2,989.6M = **$4,979.7M** (all fair-value Level 3)                                                       | 0001193125-26-323081 | 44201   | 2026-05-31  |
| F3  | Fundamental Investors: Anthropic CL H-1 PFD **$1,016.7M** (first appearance)                                                                                                    | 0001193125-26-371278 | 39473   | 2026-06-30  |
| F4  | American Balanced Fund: Anthropic CL H-1 **$520.7M**                                                                                                                            | 0001193125-26-371283 | 4568    | 2026-06-30  |
| F5  | AMCAP Fund: Anthropic CL H-1 **$469.9M**                                                                                                                                        | 0001193125-26-323076 | 4405    | 2026-05-31  |
| F6  | New Economy Fund: Anthropic F-1 $204.4M + common $56.7M + G-1 $224.9M = **$486.1M**                                                                                             | 0001193125-26-323082 | 719608  | 2026-05-31  |
| F7  | Capital World Growth & Income: Anthropic CL H-1 **$46.8M**                                                                                                                      | 0001193125-26-323078 | 894005  | 2026-05-31  |
| F8  | Fidelity OTC Portfolio **holds** Stripe (Ser H PC PP $12.17M, Class B PP $3.54M)                                                                                                | 0000035402-25-002966 | 754510  | 2025-10-31  |
| F9  | Fidelity OTC Portfolio: **no Stripe row** (also none in 0000035402-26-004133, 2026-04-30)                                                                                       | 0000035402-26-002031 | 754510  | 2026-01-31  |
| F10 | KraneShares AI ETF reports ANTHROPIC, PBC SERIES E-1 PREFERRED at **fair-value Level 1** ($12.9M)                                                                               | 0002048251-26-007263 | n/a     | 2026-06-30  |
| F11 | Destiny Tech100: "Magnitude ANC III, LLC (economic exposure to Anthropic…)" **$235.7M**, `assetConditional` OTHER / "Special Purpose Vehicle"                                   | 0000894189-26-024246 | 1843974 | 2026-06-30  |
| F12 | Fundrise Innovation Fund: structured rows name only SPVs (SaxeCap Advisors VIII $128.2M, AI Access 12 $45.5M…). Attached text: "Anthropic PBC … Greater than 20%" of net assets | 0001867090-26-000109 | n/a     | 2026-06-30  |
| F13 | Databricks 3:1 split: T. Rowe Price Tax-Efficient Equity Ser H **3,712 sh @ $165.88** (2022-05-31, 0001752724-22-166570) → **11,136 sh @ $55.29** (2022-08-31)                  | 0001752724-22-239970 | n/a     | 2022-08-31  |
| F14 | KP Large Cap Equity Fund: last N-PORT report 2020-03-31, so inactive afterward                                                                                                  | 0001752724-20-110470 | n/a     | 2020-03-31  |

## Capital Group Stripe mark path (Growth Fund of America; all classes carry the same price)

| Report date | Price/share                      | Accession            |
| ----------- | -------------------------------- | -------------------- |
| 2025-02-28  | $33.73                           | 0001145549-25-027493 |
| 2025-05-31  | $33.73                           | 0001145549-25-048194 |
| 2025-08-31  | $35.50                           | 0001193125-25-251567 |
| 2025-11-30  | $41.42                           | 0001193125-26-027715 |
| 2026-02-28  | $63.00 (issuer now "STRIPE LLC") | 0001193125-26-182055 |

Capital Group funds together mark Stripe in 8 of 12 months (Feb, Mar, May, Jun, Aug, Sep, Nov, Dec),
because member funds are on two staggered calendars.

## Aggregates (computed with the as-of rules in DATA-QUALITY.md; equity-type rows only)

| #   | Metric                                                                                              | Value                                                                                             |
| --- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| A1  | Anthropic equity exposure as of 2026-03-31                                                          | **72 funds / $5.93B** (Capital Group $2.63B)                                                      |
| A2  | Anthropic equity exposure as of 2026-06-30 (bulk + post-cutoff filings)                             | **117 funds / $17.26B**                                                                           |
| A3  | Capital Group Anthropic as of 2026-06-30                                                            | **$8.46B across 8 funds** (F2–F7 + AFIS Growth Fund $873.6M + AFIS Asset Allocation $64.0M, 6/30) |
| A4  | Anthropic as of 2026-06-30 from **bulk only**, which is wrong because it misses post-cutoff filings | 83 funds / $6.29B                                                                                 |
| A5  | Stripe equity holders as of 2025-06-30 / 2025-12-31 / 2026-03-31 / 2026-06-30                       | **49 / 35 / 34 / 37** ($1.02B / $1.31B / $1.91B / $2.44B)                                         |
| A6  | Databricks equity as of 2026-06-30                                                                  | **120 funds / $6.22B**                                                                            |
| A7  | Stripe holders lost between the 2025Q2 and 2026Q1 calendar-quarter buckets                          | 16; 15 filed without Stripe, 1 stopped filing                                                     |

## Coverage and fidelity

| #   | Check                                                                                 | Result                                                                  |
| --- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| C1  | Bulk vs. EDGAR submissions, 80 random registrant CIKs, filings 2019-10-01..2026-06-30 | 7,046 filings, **0 missing**                                            |
| C2  | Bulk rows vs. the app's parser (`extractHoldings`), same accessions                   | **617 / 617 identical** (value, shares)                                 |
| C3  | Live app top-100 for 20 companies                                                     | 412 of 2,000 slots were duplicate accessions                            |
| C4  | Bulk publication dates                                                                | 2025Q3 11/18/2025 · 2025Q4 1/7/2026 · 2026Q1 4/6/2026 · 2026Q2 7/9/2026 |
| C5  | NPORT-P filed 2026-07-01..09-26 (full index)                                          | 11,697 (+125 NPORT-P/A)                                                 |
