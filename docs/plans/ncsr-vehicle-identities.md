# Proposal: identities of Fidelity holding vehicles, from N-CSR (2026-10-28)

**Status: proposal only.** Nothing here is in `data/review/` or the warehouse (the user's instruction: nothing into
the live database or app yet). Applying it is one review import (`npm run review:aliases`) after the user agrees.

## Why

Fidelity files some private holdings in N-PORT under per-fund holding vehicles with code names ("GROWTHCO TB
HOLDINGS LLC", "CONT TC HOLDINGS LLC"). No N-PORT names the company inside, so the warehouse keeps them as
unreviewed entities and they count toward no company (archive: "Fidelity opaque vehicles … no filing names their
targets; search again if Fidelity's N-CSR text becomes searchable").

The fund's own N-CSR prints the company behind each line. The join is by the numbers, not the name: the same fund,
the same report date, the same shares and the same value (or N-CSR lines that add up to the vehicle's shares and
value). That is the filer's own evidence, by the rule "the filers' own identifiers beat name similarity"
(LESSONS 15, 16).

## The vehicles (N-CSR cost pilot sample, 2020–2026)

| Entity | N-PORT name(s)                                         | N-CSR names it                                     | Evidence (latest report)                                                                                                                              | Seen in             | Value now (latest marks) |
| ------ | ------------------------------------------------------ | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------ |
| 44241  | CONT / CONTK / FSOIFD / FANIFA VETERINARY HOLDINGS LLC | Veterinary Emergency Group LLC (Class A)           | Series Opportunistic Insights 2026-06-30: N-CSR 80,233 sh, $7,853,206 = N-PORT 80,233 sh, $7,853,206.04 (0000024238-26-000058 / 0000035402-26-005490) | 10 reports, 4 funds | $257.7M                  |
| 51611  | GROWTHCO / FSGRWCO AB HOLDINGS LLC                     | Adimab LLC                                         | Series Growth Company 2023-11-30: 762,787 sh, $18,215,354 = N-PORT $18,215,353.56 (0000707823-24-000033 / 0001752724-24-011850)                       | 6 reports, 2 funds  | $97.6M                   |
| 52908  | GRWTHCOK AB2 HOLDINGS LLC                              | Adimab LLC                                         | Growth Company K6 2023-11-30: 196,899 sh, $4,701,948 = N-PORT $4,701,948.12 (0000707823-24-000033 / 0001752724-24-011798)                             | 6 reports, 1 fund   | $3.3M                    |
| 50615  | CONT / CONTK / FSOIFD / FANIFA TC HOLDINGS LLC         | Tulco LLC                                          | Series Opportunistic Insights 2026-06-30: 7,549 sh, $2,930,144 = N-PORT $2,930,144.35 (0000024238-26-000058 / 0000035402-26-005490)                   | 12 reports, 4 funds | $76.5M                   |
| 52855  | GROWTHCO TB HOLDINGS LLC                               | Tory Burch LLC (Class A + Class B)                 | Growth Company 2026-05-31: 950,844 + 324,840 sh, $31,092,599 + $10,622,261 = N-PORT 1,275,683.805 sh, $41,714,860.42 (F66)                            | 12 reports, 1 fund  | $47.7M                   |
| 44239  | FSGRWCO TB2 HLDG LLC (now BCGF TB2 HLDG LLC)           | Tory Burch LLC (Class A)                           | Series Growth Company 2026-05-31: 248,840 sh, $7,900,670 = N-PORT $7,900,670 (0000707823-26-000042 / 0000035402-26-004699)                            | 12 reports, 1 fund  | $22.7M                   |
| 44237  | GROWTHCO / FSGRWCO MP HOLDINGS LLC                     | MOD Super Fast Pizza Holdings LLC (Series 3, 4, 5) | Growth Company 2024-05-31: three series add up to N-PORT 82,137 sh, $10,033,034.55 (0000707823-24-000076 / 0001752724-24-166798)                      | 7 reports, 2 funds  | $0 (exited 2024)         |
| 44236  | GROWTHCO / FSGRWCO / GRWTHCOK CB HOLDINGS LLC          | Cibus Corp. (Series C + …)                         | Series Growth Company 2023-05-31: lines add up to N-PORT 2,311,010 sh, $4,622,020 (0000707823-23-000068 / 0001752724-23-163341)                       | 6 reports, 3 funds  | $0                       |
| 52856  | GROWTHCO / FSGRWCO WU HOLDINGS LLC                     | Wheels Up Partners LLC / Holdings LLC              | Growth Company 2021-05-31: lines add up to N-PORT 12,825,647 sh, $50,148,279.77 (0001379491-21-003390 / 0001752724-21-152564)                         | 2 reports, 2 funds  | $0                       |
| 48702  | FANIFB / MILM WM HLDGS LLC                             | WME Entertainment Parent, LLC (Class A)            | Advisor New Insights 2020-12-31: 13,803,650 sh, $20,567k = N-PORT $20,567,438.50 (0001379491-21-000592 / 0001752724-21-030971)                        | 2 reports, 2 funds  | $0                       |
| 42015  | ALLSTAR CO-INVEST BLOCKER LP                           | New Academy Holding Co. LLC (unit)                 | New Millennium 2020-11-30: 66,000 sh, $6,204k = N-PORT 66,000 sh, $6,204,000 (0001379491-21-000156 / 0001752724-21-004645)                            | 1 report, 1 fund    | $0                       |

The four vehicles with holdings today carry **$505.5M** at their latest marks (2026-07-31 or 2026-08-31) that Vantage counts toward no company.

## Proposed decisions (for the user to approve)

1. **Tory Burch** already exists (company 117). Link entities 52855 and 44239 to it (Class A and Class B).
2. **Veterinary Emergency Group, Adimab, Tulco**: not yet companies. Make each a company (new ids from the ledger),
   with an industry decision (ADR 0010), and link 44241; 51611 + 52908; 50615.
3. **MOD Super Fast Pizza, Cibus, Wheels Up, WME (Endeavor), New Academy**: history only (no value today). Link for
   history; Cibus and Wheels Up went public, so link only their private-era rows. WME is Endeavor (company 62) only
   if the user agrees the filer's "WME Entertainment Parent, LLC" is that company; the filing alone does not say so.
4. Each link records the N-CSR and N-PORT accessions above as evidence.

## Not vehicles (also found, no action proposed here)

- **N-PORT rows with no issuer name** (T. Rowe Price files the title only): N-CSR names 120+ of them (ServiceTitan,
  Tempus Labs, Saluda Medical, Ring Therapeutics, Themis Solutions/Clio, Maplebear/Instacart). The existing review
  queue already resolves most by title; the N-CSR name is a second source.
- **Renames and SPAC mergers** seen as a different name at the same numbers: FOG Pharma = Parabilis Medicines (T. Rowe
  Price Health Sciences 2025-12-31); Flame Acquisition = Sable Offshore; Social Capital Hedosophia V = SoFi; Vesper
  Healthcare = Beauty Health; Kensington Capital = QuantumScape. These are listed or merged companies.
