# Could Vantage admit new private companies automatically? (measurement, 2026-10-19)

Measured, nothing built. Sources: local warehouse **generation 34** (read-only through `openWarehouseReadOnly`,
newest report 2026-08-31, as-of cutoff 2026-04-30 under the 123-day rule); raw EDGAR `primary_doc.xml` through
`node scripts/verify-edgar.js`, run on 2026-10-19. The scratch scripts (`features.js`, `rule.js`, `tier.js`,
`impact.js`) and the hand labels (`classes.json`) are in the session notes folder, not the repo.

## Answer in one paragraph

**Not for everything, yes for a narrow slice.** A broad rule built from what the warehouse already knows admits
706 names ($8.92B), but only **23 of 40** random admits (58%) are operating private companies. **12 of 40 (30%) are
clearly wrong:** fund stakes, co-invest and syndication vehicles, real-estate SPVs, listed foreign stocks and a
milestone claim. A narrow tier (a company-type legal name such as Inc., Corp., Ltd. or AG; no LLC, LP, HoldCo,
TopCo or Parent; no ISIN) got **28 of 30** right on a fresh random sample. The only miss in that sample was a
grouping error, and one name was unclear. Restricting the tier to US issuers removes both, leaving 273 names worth
**$3.42B**. Many are well-known companies the reviewed list does not have yet: Neuralink, Ripple, Vercel, Motive,
Deepgram, Postman, Reflection AI, Mercor, Chaos Industries, ThreatLocker. **Recommendation:** auto-admit only that
tier, label each admit "added automatically", list each night's additions with a one-click undo, and keep a person
for everything else.

## 1. The population and the candidate rule

Unreviewed names in category `company` held now (each active fund's latest canonical filing): **3,416 names,
$29.20B.** That is $0.11B more than `unreviewed_entities.current_value_usd` ($29.09B), because this count includes
every current row of the entity. 1,786 of those names are under $1M and together hold only $0.30B.

**Broad rule (R)**: admit an entity when it already sits in category `company` (no listing evidence, no FUND_LIKE
or pooled-vehicle name, no link to a reviewed company, at least 10% Level 3) and all of the following hold:

| Check                    | Admit only when                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| value floor              | at least $1M held now                                                                                                                                                                                                                                                                                                                                                                    |
| fair value               | at least 90% of the value is Level 3                                                                                                                                                                                                                                                                                                                                                     |
| issuer key               | not every key is `GENERIC_KEY`                                                                                                                                                                                                                                                                                                                                                           |
| issuer type              | every row is `CORP` (`PF`, `RF`, `OTHER` and `MUN` are excluded)                                                                                                                                                                                                                                                                                                                         |
| asset description        | no `other_asset` that mentions a fund, CLO, limited partnership, LP, SPV, vehicle, real estate, co-invest or primary/secondary                                                                                                                                                                                                                                                           |
| units                    | under 50% of the value in `PA` and under 50% in `OU`                                                                                                                                                                                                                                                                                                                                     |
| instrument               | at least one row is equity or a derivative (not only debt or indirect)                                                                                                                                                                                                                                                                                                                   |
| names (raw, title, key)  | none of: JV, LuxCo, S.à r.l., property, realty, REIT, apartments, infrastructure, toll road, investment(s), investors, capital, asset(s), finance, trust, fund, account, sidecar, royalty, escrow, litigation, CVR, contingent, claim, liquidating, SPAC, feeder, reinsurance, RE, syndicate, co-invest, credit, lending, income, opportunities, partnership, portfolio, segregated cell |
| infrastructure fund tags | no "Asset (Operator)" label held by an infrastructure, real-asset or renewable fund (the Brookfield style)                                                                                                                                                                                                                                                                               |

The identity graph adds nothing beyond the category. `company` already means no curated, public or listed key in
the component.

| Outcome                         |   Names |  Value now |
| ------------------------------- | ------: | ---------: |
| **admitted by R**               | **706** | **$8.92B** |
| left out, under $1M             |   1,786 |      $0.30 |
| left out, $1M and over          |     924 |     $19.98 |
| ...first reason: PF/RF issuer   |     406 |      $8.79 |
| ...vehicle or real-estate words |     137 |      $3.43 |
| ...mostly units (OU)            |      35 |      $3.25 |
| ...issuer type not CORP         |     119 |      $1.78 |
| ...fund-like asset description  |     117 |      $1.51 |
| ...under 90% Level 3            |      75 |      $0.92 |
| ...other                        |      35 |      $0.30 |

254 of the 706 are held by two or more funds. Under today's watch bar ($50M and two or more funds) the count is 0.

The largest names left out are the right exclusions or need a person: Fundrise real-estate JVs ($984M), Partners
Group's `PG Investment Company 18 S.à r.l.`, `Green DC LuxCo` and `Orbiter Investment` vehicles, Brookfield
Infrastructure Income Fund's asset labels (Isagen, FirstEnergy Transmission, Westinghouse, Colonial, Neoen: filed as
`PF`, no direct equity row), and Partners Group's `OU` LP stakes such as `Icebox Parent LP` and `Idera Parent LP`.

## 2. Precision, checked by hand

Each name below was read from its raw rows: names, titles, ids, Level, units, asset category, country and holders.
Labels: **op** = operating private company; **wrong** = fund stake, vehicle, real estate, listed, a claim, or a
grouping error; **unclear** = the rows do not say what the company is (usually a code-named holdco).

### Rule R, top 20 by value ($2.27B)

12 op, 1 wrong, 7 unclear. By value: 58% op, 38% unclear, 5% wrong.

- **op:** Plymouth Rock ($407M, Central Securities 0002071691-26-021149), Unit4, ThreatLocker, EnfraGen, Climeworks,
  Chaos Industries, Monzo, Confluent Health, Reflection AI, Banyan Software, San Cristobal Mining, Mercor.
- **wrong:** `PG DELTA HOLDCO LLC` ($106M) is a Partners Group holding vehicle (0001410368-26-090305).
- **unclear (code names):** Encore Holdings LP, Starfish Intermediate, Strider Topco, SIH RP HoldCo, YOUR.WORLD
  HOLDCO B.V., NEW GIVING ACQUISITION, CG PANTHER. Each is probably one portfolio company behind a deal code name. The
  money may be right, but the name tells a reader nothing.

### Rule R, random 40 (seeded draw from the 686 below the top 20, $423M)

**23 op (58%), 12 wrong (30%), 5 unclear (12%).** By value: 59% op, 15% wrong, 26% unclear. A 95% interval for the
wrong rate is about 16–44%.

| Wrong | Name                                 | What it is                                                        | Accession            |
| ----- | ------------------------------------ | ----------------------------------------------------------------- | -------------------- |
| fund  | (715)TPG VII                         | TPG Partners VII, L.P., filed as `NS`, `EC`, `CORP`, Level 3      | 0001410368-26-090305 |
| veh.  | VESTAR C.P. RAINFOREST LP            | sponsor vehicle                                                   | 0001410368-26-089936 |
| veh.  | ZEPHYR SYNDICATION L.P.              | syndication vehicle                                               | 0001410368-26-090305 |
| veh.  | WCI BXC INV HOLDINGS, LP             | investment holding vehicle                                        | 0001410368-26-089936 |
| veh.  | CVI Thompson Holdings, LLC           | CarVal holding vehicle                                            | 0001410368-26-085828 |
| RE    | OHA SFR MEMBER II, LLC               | single-family-rental member LLC                                   | 0001410368-26-085322 |
| RE    | NW HOUSTON, LLC                      | property LLC, Thirdline Real Estate Income Fund                   | 0001193125-26-370270 |
| RE    | Old Courthouse Owner LLC             | property-owner LLC, same fund                                     | 0001193125-26-370270 |
| list  | Seohee Construction Co Ltd           | KOSDAQ stock, ISIN KR7035890003, held by 7 DFA funds at Level 3   | 0001410368-26-098331 |
| list  | Allcargo Worldwide / Allcargo Global | Indian listed stock (SEDOL BTRD8P5), Vanguard and WisdomTree ETFs | 0000052848-26-000890 |
| list  | AuMega Metals Ltd.                   | ASX miner, Franklin Gold and Precious Metals Fund                 | 0002071691-26-023258 |
| claim | AMOLYT MILESTONE                     | acquisition milestone payment                                     | 0001410368-26-088534 |

Op: Mosyle, Lumin Digital, After Services, CityBrewing Topco, ASAPP, Poolside, Impossible Foods, Cardurion,
Contentsquare, AEYE Health, Quell Therapeutics, Learneo (Course Hero), Radiant Industries, Rasa Technologies, Panos
Holdings, PCI Pharma Services, Different Technologies, Kela Technologies, Alchemy Insights, Cornerstone Chemical,
Roofstock, Lucra, Temporal Technologies. Unclear: CElegans Labs, Integrity Labs, Project Link Vero Fiber, Aquarian
Peninsula Holdings, Inclusive Language Services.

### The narrow tier (A), then a fresh random 30

The misses follow a clear pattern. Nine of the twelve wrong names are LLCs, LPs or code-named holdcos, and two of
the three listed stocks carry an ISIN. **Tier A** is rule R plus three conditions:

- a raw name or title has a company suffix: `INC`, `INCORPORATED`, `CORP`, `CORPORATION`, `LTD`, `LIMITED`, `AG`,
  `SA`, `SAS`, `NV`, `BV`, `PLC`, `GMBH`, `OY`, `AB` or `PBC`;
- no raw name or title contains `LLC`, `LP`, `L.P.`, `LLLP`, `HOLDCO`, `TOPCO`, `INTERMEDIATE`, `PARENT`,
  `ACQUISITION`, `MIDCO`, `BIDCO`, `MILESTONE` or `PROJECT`;
- no row has an ISIN.

Tier A holds 340 names ($4.42B). Because the tier was designed after seeing the first sample, I measured it on a
**fresh seeded draw of 30 tier-A names not seen before**:

**28 op (93%), 1 wrong, 1 unclear.** Wilson 95% lower bound for op: about 79%.

- **wrong:** `Claris Ventures SGR SPA` (0002071691-26-020322). The entity merges three issuers on the shared word
  "CLARIS": Claris Biotherapeutics (US), Claris Lifesciences (India) and an Italian VC manager. This is a grouping
  error (traps 26, 58, 62), not a rule error, and auto-admit would carry it into Market.
- **unclear:** Tintina Mines Ltd. (Canada, held by Franklin Gold funds). It may be listed.
- **op:** Deepgram, Breeze Aviation, Blockdaemon, Postman, Leader Bancorp, SecurityScorecard, Motive, T-Knife,
  Numab, REK, Zepto, Ripple, Vercel, Umoja, IntelyCare, Lumeris, Brain Corp, Endeavor BioMedicines, Goop, Atticus
  Labs, Dental Care Alliance, Dexmate, Skild AI, ADARx, Radiant Biotherapeutics, Neuralink, RealSelf, Hark Labs.

Both tier-A misses, plus AuMega from the first sample, are non-US. **Tier A-US** (every current row's country is
US) holds **273 names, $3.42B**, 108 of them held by two or more funds. 26 of the fresh 30 fall in it, and all 26
are op. The US-only guard was chosen after the fresh sample, so the build wave must confirm it on another fresh
draw (see the gate below).

### Raw EDGAR spot-checks (10 of 10 match the warehouse)

`verify-edgar.js` printed the same name, title, units, balance and value as the stored rows for these names:
Plymouth Rock ($407,401,192, 0002071691-26-021149); Unit4 ($214,259,156.90 EP plus a $0 EC row,
0001410368-26-090305); PG Delta HoldCo ($105,661,653.52, same filing); (715)TPG VII ($4,215,500.11, filed as
`NS`/`EC` with the title "TPG Partners VII, L.P.", same filing); Seohee Construction ($26,102.68 in this DFA filing,
0001410368-26-098331); AMOLYT MILESTONE ($2,524,209.56, 0001410368-26-088534); OHA SFR Member II ($6,387,321.11 plus
a $0 row, 0001410368-26-085322); Allcargo ($10,755.15, SEDOL BTRD8P5, 0000052848-26-000890); AuMega Metals (four rows,
0002071691-26-023258); Vestar C.P. Rainforest ($15,195,511.97, 0001410368-26-089936). The misclassifications are
therefore in what the filers report, not in our ingest. **The filer's own fields cannot be trusted to mark a
fund stake.** TPG Partners VII is filed exactly like common stock.

## 3. What Market's operating-company total would become

Market's own query (`topCompanies`, `categories: ['company']`, its `COUNTS` filter) on generation 34, with the
admitted entities' rows added:

| Date       | Market now (192 cos) | + rule R                | + tier A                    | + tier A-US                 |
| ---------- | -------------------- | ----------------------- | --------------------------- | --------------------------- |
| 2026-08-31 | $64.10B              | $73.02B (+$8.92B, +14%) | about $68.5B (+$4.42B, +7%) | about $67.5B (+$3.42B, +5%) |

Live is **$63.24B at 2026-09-30** (generation 40). The same shares would put it at about **$72B under R**, about
**$67.6B under A** and about **$66.6B under A-US**. Those are estimates; the generations differ. Under R, the wrong
names would land in the operating-company total as companies. From the samples, about 15% of the admitted value is
in errors and about 26–38% is in unclear code names. The errors are, in order of dollars: sponsor and co-invest
vehicles, then real-estate SPVs, then fund LP stakes. Listed foreign stocks and claims are many names but small
money. Under A-US, the measured error is about 0 of 26 (an upper bound near 13%). The remaining risk is grouping
errors such as Claris, plus raw display names (`ThreatLocker, Inc. - 2`, `NANOTRONICS IMAGING, INC. PREFERRED SERIES
F-2 /`). Nanotronics also merges `CUBEFABS, INC.`, a second grouping error found while reading the top of the list.

## 4. Recommendation (for sign-off)

**Auto-admit tier A-US only. Send everything else to the person queue, ranked by value.**

1. **Rule:** rule R plus the three tier-A conditions, plus "every current row's country is US", as written above.
   Admitted names become companies with `category = 'company'`, `status = 'private'`, and a new
   `origin = 'auto'` with the rule version and date.
2. **Label:** every page and export says "added automatically, not yet reviewed" for such a company. Market keeps
   one total and shows the auto-added share as a separate line, so a reader can see how much of the total comes
   from them.
3. **Nightly list:** the watch report lists the night's auto-admits: name, funds, value, accession and the rule
   checks it passed. Each has a one-click **Undo**, which writes a curation drop (`data/review`) and runs as a job.
   An undone name never comes back automatically. Ids come from `company_ids.csv` and are never reused (ADR 0008).
4. **Stays with a person:** non-US names, LLC/LP/holdco/code names, ISIN holders, anything under 90% Level 3,
   `OU` or `PF` rows, infrastructure asset labels, and any entity whose raw names disagree (see the gate below).
   That queue is about 430 names over $1M ($5.5B) from R alone, plus the 924 names R leaves out ($19.98B).
5. **Not feasible:** auto-admitting the broad rule. A 30% wrong rate would put vehicles, real estate and fund
   stakes into Market, which is exactly what the review exists to stop (traps 60–61).

**Gate before turning it on (the build wave's first task):** draw 40 new random A-US admits from the live
warehouse and classify them by hand, as in this note. Turn on only if at least 38 are op and none is a fund
stake, vehicle or listed stock. Otherwise narrow the rule and draw again.

### What a build wave needs

- **Code:** an `autoAdmit(ctx)` step in the curation and derived rebuild, after `identityUpkeep`, using
  `componentCategory` and the row features. It runs inside `runJob`, writes `origin = 'auto'` companies and
  aliases, and its results are recorded in the generation's curation digest. Migration `00NN` adds
  `companies.origin` and `companies.auto_rule`. The name cleaner removes `- 2`, `/`, share-class words and
  `(Series ...)` from display names, using the same logic as `classes.classOfRow`. Grouping guard: refuse an entity
  whose raw names reduce to two or more distinct legal names (the Claris and Nanotronics/Cubefabs case); it goes to
  the person queue instead.
- **Tests:**
  - every rule check flips one fixture from admit to queue (real-data fixtures: TPG VII, OHA SFR, Seohee, AuMega,
    AMOLYT, Claris, Vercel, Neuralink);
  - undo is permanent across rebuilds;
  - ids are stable;
  - Market, Firms and Explore totals equal `exposureAsOf` with auto companies included;
  - the label and the export metadata come from the same response;
  - the curation digest changes when the rule version changes;
  - `invariants.test.js` covers "no auto company is listed or fund-category".
- **Docs:** ADR 00NN (auto-admit and its gate), a DATA-QUALITY trap for "fund stakes filed as common stock" (the TPG
  VII row), CLAUDE.md's "private means the companies table" rule extended to `origin`, About and method text on
  automatic additions, GOLDEN-NUMBERS entries for two auto-admitted companies, and LESSONS (measure precision on a
  fresh sample, not the design sample).

## Side findings (not in scope, for a person)

- Well-known private companies are missing from the reviewed list: Neuralink, Ripple, Vercel, Motive, Deepgram,
  Postman, Zepto, Mercor, Reflection AI, ThreatLocker, Chaos Industries, Monzo, Plymouth Rock ($407M) and Unit4
  ($214M). Each is one fund, or under $50M, so the watch bar never shows them.
- `companies` holds `KKR Global Infrastructure Investors IV SCSp` and `DigitalBridge AI Infrastructure B` as
  category `company` with status `public`. They are fund interests; the status keeps them out of Market, but the
  category is wrong.
