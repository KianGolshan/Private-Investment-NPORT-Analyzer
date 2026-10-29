# N-CSR / N-CSRS research (2026-10-28)

Question: can the funds' shareholder reports (N-CSR annual, N-CSRS semiannual) add to Vantage what N-PORT cannot,
in particular **investment cost**? Checked against two real filings. Status: research, then a read-only pilot (results at the end); nothing is stored in the warehouse.

## Filings read

| Manager       | Filing                                                         | Period     | Accession            |
| ------------- | -------------------------------------------------------------- | ---------- | -------------------- |
| Fidelity      | N-CSRS, Fidelity Mt. Vernon Street Trust (CIK 707823), 7 funds | 2026-05-31 | 0000707823-26-000042 |
| Capital Group | N-CSRS, The Growth Fund of America (CIK 44201)                 | 2026-02-28 | 0001193125-26-195253 |

Matching N-PORT in the warehouse: Fidelity Growth Company Fund (S000007119) 0000035402-26-004656; Growth Fund of
America (S000009228) 0001193125-26-182055.

## What N-CSR discloses that N-PORT does not

1. **Cost and acquisition date for every restricted (private) holding** (Reg. S-X 12-12 footnote).
   - Fidelity: "Additional information on each restricted holding": security, acquisition date or date range, acquisition
     cost in dollars. Growth Company Fund: 234 rows, total cost $1,889,000,686; restricted value $5,236,869,962 (5.3% of
     net assets).
   - Capital Group: "Restricted securities": security, acquisition date(s), cost, value, % of net assets, in thousands.
     GFA total cost $3,487,933k, value $4,885,723k (1.49%).
2. **Level 3 valuation inputs** per asset type: technique, unobservable input, range, weighted average, direction.
   - GFA preferreds ($3,783,913k): transaction price, 25% discount for uncertainty, EV/Sales 8.9x–21.0x (wtd 18.9x),
     EV/Gross Profit 11.3x, DLOM 13%.
   - Fidelity Series Growth Company Fund common stocks ($85.6M): EV/Revenue 1.5–31.1 (wtd 7.1), discount rate,
     Black-Scholes volatility 60%–110%, etc.
   - These are per fund and asset type, **not per company**.
3. **Level 3 roll-forward**: beginning value, purchases, sales, realized and unrealized gain, transfers, ending value.
   GFA six months to 2026-02-28: purchases $2,091,771k, sales $(289,623)k, realized $55,690k, unrealized
   $1,074,911k, ending $4,852,235k. Fidelity Growth Company: convertible preferreds bought $194.7M, sold $(399.6)M,
   transfers out of Level 3 $(470.0)M.
4. **Affiliated issuers table** (Capital Group): per issuer, value at start, additions, reductions, realized, unrealized,
   value at end, income (dollars, not shares).
5. Other: lock-up / market-standoff footnotes (Fidelity: $186.8M), related-fund (cross) trades, unfunded commitments,
   restricted total as % of net assets.

## Verified against our N-PORT data (same fund, same date)

Values and share counts match exactly, so N-CSR rows can be joined to our positions by (series, report date, shares,
value), not by name.

| Holding (fund)                 | N-PORT shares | N-PORT value | N-CSR cost   | Acquired       | Cost / share | Mark / share |
| ------------------------------ | ------------- | ------------ | ------------ | -------------- | ------------ | ------------ |
| Anthropic Series D (Fid. GCO)  | 235,150       | $146,484,341 | $7,055,558   | 5/31/2024      | $30.00       | $622.94      |
| Anthropic Series F (Fid. GCO)  | 66,600        | $39,228,066  | $9,388,443   | 8/18/2025      | $140.97      | $589.01      |
| Anthropic Series H (Fid. GCO)  | 9,700         | $5,713,397   | $5,713,392   | 5/28/2026      | $589.01      | $589.01      |
| Databricks Series J (Fid. GCO) | 130,663       | $24,825,970  | $12,086,328  | 12/17/2024     | $92.50       | $190.00      |
| Oura Series E (Fid. GCO)       | 1,920,845     | $110,813,548 | $102,899,667 | 9/24/2025      | $53.57       | $57.69       |
| Anthropic Class F (GFA)        | 2,859,590     | $741,024k    | $403,109k    | 8/29/2025      | $140.97      | $259.14      |
| Anthropic Class G-1 (GFA)      | 5,075,585     | $1,315,269k  | $1,315,269k  | 1/27–2/12/2026 | $259.14      | $259.14      |
| Databricks Series J (GFA)      | 2,241,043     | $399,242k    | $207,296k    | 12/17/2024     | $92.50       | $178.15      |
| OpenAI Class A-2 (GFA)         | 945,843       | $617,919k    | $177,682k    | 10/28/2025     | $187.86      | $653.30      |
| Epic Games (GFA)               | 84,249        | $44,420k     | $74,560k     | 3/29/2021      | $885.00      | $527.25      |

**Cross-manager check:** single-date lots give the same entry price at both firms: Anthropic Series F $140.97;
Databricks Series J $92.50, Series K $150.00, Series L $190.00. That is a reproducible round-price signal.

Not SpaceX: Fidelity still lists Space Exploration Technologies in its restricted table (lock-up). It is public for us
and is left out of every example.

## Machine readability and access (negative findings included)

- **XBRL does not help.** Both filings' iXBRL covers only Item 1 (the tailored shareholder report: expense ratio, net
  assets, sector %, top holdings). No holding, cost, Level 3 or restricted fact is tagged (0 hits). Consistent with
  XBRL being rejected as a primary source.
- **No SEC bulk data set** for N-CSR financial statements. Access is per filing: EDGAR full-index (2026 Q3: 571 N-CSR,
  1,337 N-CSRS) or the submissions API, then the primary HTML document through `secGet`.
- **Scope is small:** 621 registrants (862 series) hold reviewed private companies in one quarter. About 1,250
  filings a year; about 8,500 back to 2019Q4. Documents are large (GFA 4 MB, Fidelity 9.8 MB) but we keep only parsed
  rows (a few thousand per period, well inside the 1 GB budget).
- **Coverage:** Fidelity + Capital Group hold about $28.6B of the $73.5B private value reported for Mar–May 2026
  report dates (about 39%), so two parsers cover a large share.
- **Format varies by family.** Fidelity: dollars, one filing for 7 funds (needs section → series mapping by fund
  name), table at the end of each schedule. Capital Group: thousands, cost and value side by side, and N-PORT custody
  legs merged (Stripe Class B: N-PORT 70,774k + 1,924k = N-CSR 72,698k). Other families (T. Rowe Price, Baron, Morgan
  Stanley, ARK) are **not yet checked**.

## Limits to state in the product

- Semiannual only: two of each fund's four public dates (the same dates as its N-PORT, so the join is clean).
- Cost is per security row, blended across lots when a date range is shown; an exact entry price per share only for
  single-date lots.
- Cost is the fund's own cost: it can be a secondary purchase or an in-kind transfer (e.g., K6 funds), not a round
  price. Show it as "cost reported by the fund", never as the company's round price unless two or more funds agree.
- Level 3 inputs and roll-forwards are per fund and asset type, never per company. Realized gains are aggregates, so
  exits stay "no longer reported".
- "Private" still means the `companies` table, not "restricted" or "Level 3" (Level 3 at Fidelity GCO is well below
  its restricted total).

## Mapping into Vantage

- `ncsr_filings` (accession, cik, period end, form, source) → each fund section to `series_id` (by fund name against
  `fund_names`, checked with net assets against the N-PORT `filings.net_assets`).
- `cost_basis` (ncsr accession, source row, series_id, report_date, instrument_key, company_id, first and last
  acquisition date, cost, N-CSR value, matched N-PORT accession): matched on series, date, shares and value; a row
  that does not match exactly goes to the review queue, never guessed.
- `level3_inputs` and `level3_rollforward` per (series, report_date, asset type).
- All writes through `runJob`, a numbered migration, new numbers in `GOLDEN-NUMBERS.md` with both accessions.

## Use cases N-PORT and current analysis cannot answer

1. **Cost vs. mark per position**: unrealized multiple on cost, per class, fund, firm and company (e.g., GFA OpenAI
   A-2 at 3.5x cost; Epic Games at 0.60x).
2. **Entry price ledger per class**: cost per share from single-date lots, confirmed when two or more funds agree;
   "mark vs. entry" on the company page.
3. **True first purchase date**: acquisition dates reach back before our 2019Q4 history (Adimab 2014, Tory Burch 2015)
   and give holding periods and vintage charts.
4. **Flows of the private book**: Level 3 purchases and sales in dollars, to check our position vs. mark bridge.
5. **How each family marks**: discounts and multiples by fund over time, on the fund and firm pages.
6. **Deal participation**: which funds bought the same round at the same price on the same date (Databricks J at
   $92.50, 12/17/2024, at both Fidelity and Capital Group).

## Pilot results (2026-10-28)

Built read-only: `lib/ncsr/` (HTML reader, Fidelity and Capital Group parsers, the N-PORT join),
`scripts/ncsr-pilot.js` (report in `reports/ncsr/`), `test/ncsr.test.js` on real trimmed filings
(`test/fixtures/ncsr/`, rebuilt by its builder). Nothing is stored in the warehouse. Golden numbers F64–F68.

**Scope:** 4 registrants (Fidelity Mt. Vernon Street Trust, Fidelity Contrafund, Growth Fund of America, SMALLCAP
World), latest 2 reports each: 8 filings, 24 fund reports, 2,110 cost rows.

**Parse:** every fund passes its self-checks against the filing's own totals: the rows marked restricted in the
schedule equal the cost-table rows in number, and their values add up to the stated restricted total (Capital
Group: the cost rows also add up to the Total row). A misread or dropped row fails the run.

**Join to N-PORT (same series, same report date, by shares and value, never by name):**

| Family        | Cost rows | Equity rows | Joined        | Equity cost joined |
| ------------- | --------- | ----------- | ------------- | ------------------ |
| Fidelity      | 1,945     | 1,876       | 1,710 (91.2%) | $11.35B of $12.28B |
| Capital Group | 165       | 160         | 151 (94.4%)   | $6.76B of $7.48B   |

All rows: exact 1,852, legs 5, combined 4, value differs 94, ambiguous 76, debt 74, none 5. Joined rows reach 146
private companies with 1,577 single-date entry prices.

**What the unjoined rows are (each one listed in the report):**

- **Value differs (94, all Fidelity):** same fund, same date, same shares, another value. Parabilis Medicines Series
  F: N-PORT $11,734,528 vs N-CSRS $30,700,801 (F67). 11 holdings in each Growth Company fund, 2–4 in each
  Contrafund fund. The N-CSRS was filed the day before the N-PORT. The filings do not say why; Vantage keeps
  N-PORT's value and would show the N-CSR's as a second, labeled figure.
- **Ambiguous (76):** a name printed twice in the cost table (Adimab LLC, Kardium Series D-6, escrow lines), so which
  cost goes with which schedule row is not proven; or two N-PORT rows with the same shares and value (Element
  Biosciences Series D and D1). Not guessed.
- **Debt (74):** convertible notes and bonds; the warehouse keeps equity-type rows only.
- **None (5):** four restricted lots of listed companies (Galaxy Digital, GPGI, Sable Offshore, USA Rare Earth: part
  of a public position) and one holding N-PORT lacks: Growth Fund of America's N-CSR for 2025-08-31 lists Anthropic
  Class F ($403.1M, bought 8/29/2025); its N-PORT for that date has no Anthropic row (F68).

**New findings from the pilot:**

1. **Opaque holding vehicles are named.** N-CSR rows add up exactly to Fidelity's vehicles: GROWTHCO TB HOLDINGS LLC
   = Tory Burch Class A + B (F66), the AB2 HOLDINGS lines = Adimab, TC HOLDINGS LLC = Tulco LLC, VETERINARY HOLDINGS
   LLC = Veterinary Emergency Group. These were open on the review list ("no filing names their targets").
2. **One N-CSR line can be many N-PORT lines and the reverse:** Stripe Class B = PHYSICAL + DRS legs; Tubulis
   "rights" = 11 CVR lines; Tory Burch A + B = one vehicle.
3. **Capital Group's thousands** sit up to $999 from N-PORT's dollars (not plain rounding), so they join within one
   unit.
4. **Fidelity's cost table has no value column:** the value comes from the schedule row of the same name, so
   duplicate names stay ambiguous.

## Recommended next step

1. Add the four holding-vehicle identities (finding 1) to the review data with the N-CSR accessions as evidence.
2. Check three more families (T. Rowe Price, Baron, Morgan Stanley) for the same table before deciding on a backfill.
3. If kept: a migration (`ncsr_filings`, `cost_basis`), a `runJob` ingest of the joined rows, and the company page's
   entry price per class.
