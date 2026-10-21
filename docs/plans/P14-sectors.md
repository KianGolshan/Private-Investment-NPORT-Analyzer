# P14: Sectors, industries and themes — labels and trend analytics

## Context

Vantage answers "who holds which private company at what mark", but it cannot answer the questions an analyst asks first:
_how did AI companies' per-share marks move from Q1 to Q3 2026?_ and _how did fund holdings in biotech compare with AI
over the same period?_ For that, every company needs an industry label that stays accurate as new companies arrive.
Then the existing as-of, bridge and marks engines need to group by it.

Facts checked on generation 34 (read-only):

- **N-PORT has no industry field.** `holdings` holds names, ids, LEI, country, issuer type and asset category only.
  There is no sector, SIC or description anywhere in the schema. Labels must therefore come from our own classification,
  with evidence. This is a judgment we disclose, not an SEC-reported fact. That needs an ADR, because CLAUDE.md's
  "real SEC data only" rule covers numbers. Labels change no number; they only group numbers.
- Scope: the 197 reviewed companies are labeled first (W1). Then **the whole unreviewed queue** is brought to a final
  state under the same schema (W2b, next section). The first group is the **197 reviewed private operating companies,
  $64.1B**. That is what Market shows. 72 of them
  (≥ $100M) hold 91% of the value. Value is very concentrated: Anthropic alone is $18.2B. Every value-weighted sector
  number therefore also needs an equal-weighted (median) twin and an "excluding the largest" view.
- Fund interests, CLOs and insurance vehicles ($10.6B) get no sector ("not an operating company"). Unreviewed names
  ($29B) show as "not classified", and every view states its coverage.
- Taxonomy (your choice): **our own sector → industry (one per company, so totals add up) plus themes (many per
  company, overlap, never summed)**. This is the PitchBook industry + verticals model, with no GICS licence.

## Your question: does one AI step solve both labeling problems?

**Mostly yes. It should be one pipeline, but it cannot replace the person queue.** The open "name" problem from
`docs/plans/auto-admit-measurement.md` and industry labeling are the same task. Each needs a reader to look at an
evidence pack and decide what the name is. One Claude call per name can return all of it:

| Output                                                                                                                                  | Solves                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `entity_type`: operating company / fund interest / co-invest or SPV / real estate / CLO / insurance / listed security / claim / unclear | the 30% wrong rate of the broad auto-admit rule (fund stakes filed as common stock, e.g. TPG VII)                  |
| `display_name` (clean legal or brand name)                                                                                              | `ThreatLocker, Inc. - 2`, `NANOTRONICS … SERIES F-2 /`                                                             |
| `same_issuer`: do all raw names in the entity refer to one company?                                                                     | the Claris and Nanotronics/Cubefabs grouping errors (sends the name to a person; never merges or splits by itself) |
| sector, industry, themes, one-line description, evidence URLs, confidence                                                               | industry labels                                                                                                    |

What it **cannot** do:

- Name a deal code name the web doesn't know (CG Panther, Strider Topco). It must answer "unclear", and those names stay
  in the person queue.
- Change `status` (public/private). That keeps needing SEC/listing evidence (ADR 0003). The model's "listed" answer
  only routes the name to review.

Anything it labels shows as **"labeled automatically, not yet reviewed"** until confirmed. It is only turned on after it
passes the measured gates below.

## The whole unreviewed queue: same schema, one end state (your addition)

Goal: **every name in the dataset ends in a final, labeled state.** No name should sit in "unreviewed" with value
attached. Measured on generation 34 (`unreviewed_entities`, value > 0 now):

| Queue category   | Names | Value now |           ≥ $1M | What is usually in it                                                               | How it gets resolved                                                                                                             |
| ---------------- | ----: | --------: | --------------: | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| company          | 3,417 |   $29.11B | 1,630 ($28.81B) | private companies, plus vehicles, real estate, listed foreign stocks and code names | full classifier on every name                                                                                                    |
| linked + vehicle |    14 |    $0.60B |              12 | SPVs pointing at a company                                                          | full classifier, plus a link proposal                                                                                            |
| level12          | 2,400 |   $47.45B |           1,649 | mostly public securities; **some private companies filed at Level 1/2** (CLAUDE.md) | deterministic listing check first (ISIN/ticker/listing evidence); the classifier runs only on names with no listing evidence     |
| listed           | 2,030 |    $8.66B |             876 | public stocks                                                                       | deterministic. Confirmed as listed, no LLM call, unless a name has no exchange evidence                                          |
| fund             | 4,100 |  $344.35B |           3,148 | registered funds, money-market and ETF shares, and private-fund LP stakes           | deterministic for registered funds (issuer type `RF`, ticker, fund CIK); the classifier runs on `PF`-style stakes with no ticker |

**One schema for every name.** It is the same classifier output as reviewed companies: `entity_type`, `display_name`,
`same_issuer`, and sector/industry/themes when the name is an operating company.

**Every name ends in exactly one terminal state:**

| Terminal state                 | What the name becomes                                           |
| ------------------------------ | --------------------------------------------------------------- |
| operating company              | a company, `category=company`, with sector, industry and themes |
| fund interest                  | a company, `category=fund`                                      |
| CLO                            | a company, `category=clo`                                       |
| insurance vehicle              | a company, `category=insurance`                                 |
| real-estate vehicle            | a company, with the new category `real_estate`                  |
| claim / escrow / CVR           | a company, with the new category `claim`                        |
| listed security                | status public, only when listing evidence agrees                |
| registered fund / cash vehicle | no company; tagged "not a private holding"                      |
| needs a person                 | the person queue                                                |

How the queue reaches that state:

- **Reviewed and automatic stay separate.** Automatic results are written to the ledgers (`aliases.csv`,
  `industries.csv`) with `origin=auto`, a rule or prompt version, and evidence. Ids come from `company_ids.csv` and are
  never reused. A person's decision is never overwritten.
- **What still needs a person:**
  - `same_issuer = false` (grouping errors);
  - "unclear" code names;
  - a listed answer without listing evidence;
  - a proposed merge into an existing company. Merges apply automatically only with a deterministic match: same LEI,
    or the same instrument in a reviewed alias.
- **Who works the person queue:** I do, with evidence, ranked by value, in sessions (your standing "finalize reviews
  yourself" rule). Size estimate from the auto-admit samples: about 12–30% of the company queue, roughly 400–900
  names; measured in W0.
- **"Clean and final" has a measured gate.** Unresolved value ≥ $1M = **$0** and unresolved names under $1M are
  auto-classified. This becomes a `doctor`/Status metric ("unresolved value") and a job warning when it grows.
- **Effect on headline numbers.** Market's operating-company total will rise as names are admitted (auto-admit
  measured +$3.4B for the narrow tier alone; the full queue could add far more). Market shows the automatically added
  share as its own line, so the change is visible and not silent.
- **Cost control.** Deterministic triage runs first, so only roughly 5,000–6,000 of the ~12,000 names need a model call.
  W0 measures cost per name before the backfill. Nothing runs past the pilot without your OK.

## Design

### 1. Taxonomy (`data/review/taxonomy.json`, versioned; `docs/TAXONOMY.md` rubric)

- About 11 sectors and about 50 industries, written for venture and growth companies. Examples: Technology → AI models &
  labs, AI infrastructure & chips, Enterprise software, Cybersecurity, Semiconductors; Health care → Biotechnology,
  Medical devices, Health services; Financials → Fintech & payments, Insurance, Crypto & digital assets; Industrials →
  Defense & aerospace, Autonomy & robotics; Energy & climate; Consumer; Media & entertainment; Real estate; Materials &
  mining; Communications.
- Themes (multi-label): AI, Fintech, Defense tech, Climate, Crypto, Space, Robotics, Quantum, Biotech platforms.
  **"AI" is a theme with a written rule.** AI-native means the core product is a model or AI system, or the
  compute/chips for one. "Uses AI" does not count. This rule is what makes "AI companies" reproducible.
- Decision rules: classify a holdco by its operating business; a conglomerate by its largest segment; classify the
  company, not the security. Each industry gets a definition plus 2 real examples.
- Labels are **current classification applied to all history**. If a company pivots, its whole history moves. That is
  the index convention, and it avoids breaks in the series. The taxonomy version and the label digest go into every
  generation and export.

### 2. Storage (reuse the category path end to end)

- Migration `db/migrations/0023_industries.sql`: `sectors`, `industries`, `themes` (code, name, definition, version);
  `company_industry(company_id PK, industry_code, origin 'reviewed'|'auto', confidence, description, evidence,
model, prompt_version, labeled_at)`; `company_themes(company_id, theme_code, origin)`.
- Ledger `data/review/industries.csv` (company id + name as label, industry, themes, origin, confidence, evidence,
  note). It is keyed by **company id** (group by identity, display by name). It is staged, snapshotted and digested by
  `runJob` automatically (`lib/warehouse/job.js` `stageCuration`/`curationDigest`). It is read only through
  `lib/warehouse/curation.js` (enforced by `test/invariants.test.js`).
- Import: extend `lib/entities/review-import.js` / `review.js` (validation like `CATEGORIES` at `review.js:15,36`).
  Unknown codes, a label on a fund/clo/insurance company, or a retired id fail with file and line. Writers use one
  column list, as `ALIAS_COLUMNS` does (`seed.js:586`).
- Job validation (`job.js` `validate`, next to `untaggedRows`):
  - problem: a reviewed operating company ≥ $100M without an industry;
  - warning: unclassified operating value grows versus the published generation (baseline via `countsOf`).

### 3. Classifier (`lib/classify/`, `npm run classify`)

- **Evidence pack per name, from the warehouse (read-only):** raw names and titles, LEI, ISIN, country, issuer type,
  asset category, units, Level, holders and fund names, value, accessions. Optionally SEC data through `secGet`: the
  EDGAR company search, plus Form D `industryGroup` and SIC where a CIK exists. Form D is used here only as a
  cross-check on industry, never as a position source. W0 measures whether it is worth it.
- **Claude call (new names only, superseded by the 2026-10-20 call in the W0 results):**
  - model `claude-haiku-5-5`, the cheapest current model;
  - no web search by default;
  - structured output (a JSON schema with enums taken from taxonomy.json);
  - rubric and taxonomy in a cached system prefix;
  - `@anthropic-ai/sdk` in `lib/classify` only;
  - a hard nightly budget in cents; the run stops when the budget is reached.
- **Backfill:** no API. Done in session from the warehouse names, the reviewed ledgers and deterministic rules.
- **Reproducibility:** each answer is cached in `data/review/classify/` (JSONL), keyed by
  entity + evidence hash + prompt version + model. Re-runs read the cache, so a rebuild never calls the API. The job
  imports from the ledger, so the recorded input is the input used. A label changes only when the evidence, prompt or
  model changes, and then it goes through the eval again.
- **Application rules:**
  - sector/industry/themes are written as `origin=auto` only when confidence is high and the run is stable (two runs
    agree);
  - `entity_type`/`display_name` feed the auto-admit tier (A-US plus the model says "operating company" with high
    confidence plus `same_issuer`). This is gated separately and is the auto-admit wave, not this one;
  - everything else goes to the watch report's person queue, ranked by value, with the evidence pack and the model's
    answer side by side;
  - a person's decision always wins and is never overwritten (origin `reviewed`).

### 4. Accuracy protocol (gates; fail = narrow and re-measure)

- **Gold set:**
  - I label all 197 companies by hand from evidence, blind to the model;
  - add the 70 hand-classified names (op/wrong/unclear) from the auto-admit note;
  - add the 392 reviewed companies' known categories.
- **Gates on a held-out half of the gold set:**
  - sector ≥ 97%, industry ≥ 92%;
  - AI theme precision ≥ 95%, recall ≥ 90%;
  - `entity_type`: 0 fund, vehicle or listed names called "operating company";
  - on the auto-admit gate's fresh 40-name draw: ≥ 38/40.
- **Ongoing:**
  - disagreement with a Form D industry group sends the name to the queue;
  - `npm run monthly` re-audits a seeded random 20 auto labels by hand-check prompt;
  - the eval runs offline in `npm test` from recorded responses, so a prompt or model change cannot ship without
    re-scoring.

### 5. Analytics (`lib/analytics/sectors.js`, `lib/services/sectors.js`; reuse, no new counting rule)

- **Holdings by sector as of a date:** `topCompanies` rows (`lib/services/market.js:82`, with `known`/"Filed by" and
  categories) grouped by industry → sector. Invariant: Σ sectors + not classified = Market total, to the cent.
- **Over time and flows:**
  - add `sector`, `industry` and `theme` to `PIVOT_ROWS` / `rowKeyOf` / `keyIn` / `rowLabels`
    (`lib/services/analysis.js:256-289,780`) and a `sectors` filter beside `categories` (`:345`). `accumulate`
    (`:148`) already groups by any key; drill works unchanged;
  - a sector bridge is `bridge` with a filter: start + from positions + from marks + other = end.
  - This answers "biotech vs AI". **From positions** is the closest honest proxy for money in or out (shares first
    reported, added, reduced, no longer reported, at the prior mark); **from marks** is revaluation. Wording stays "held
    by funds", never "invested" or "bought".
- **Per-share mark index (new): matched pairs, chain-linked.** This is the repeat-sales method, so new companies at high
  prices cannot inflate it.
  - For each `position_facts` leg with a prior mark from the **same fund and class**, at most ~100 days apart (a one-step
    change; longer gaps are counted and left out), the split-neutral return is `mark_effect / prev_value`. Lots with
    several marks are left out (`classes.markStats` `mixedFunds`, trap 65).
  - Company return = the median across its funds. A sector's period return comes as an **equal-weight median of
    companies** (the "typical AI company" answer) **and** a value-weighted figure (Σ mark effect / start value, equal to
    the bridge).
  - Chain to an index (=100 at the window start), bucketed by **mark date** (staggered calendars).
  - Each period shows companies, legs, the share of unchanged (stale) marks, p25/p75 and coverage. A partial period is
    flagged: the newest private mark is Jul 31, so Q3 2026 is partial today.
- **Company table per sector:** first and last mark in the window, change, funds, mark dates. Every number links to
  its legs and accessions.

### 6. Web (`web/src`; ECharts via `ui/Chart.tsx` with a `DataTable` twin each)

- `/sectors`: an as-of table (sectors expand to industries; tabs for themes) with value, share, companies, funds,
  firms, and the period change split into from positions and from marks. A stacked-area chart by quarter. An index
  chart comparing up to 5 sectors/themes. Coverage line and "not classified" row.
- `/sector/<code>`, `/theme/<code>`: KPIs, bridge, index, companies table, movers, newly reported, top firms.
- Sector filter (`useParam('sector')`) on Market, Movers, Newly reported, Activity, Explore; Explore rows
  sector/industry/theme. Compare accepts sectors. Firm and fund pages get a "sector mix". The company header gets a
  sector chip with a "labeled automatically" badge when it applies.
- Glossary terms, About "How sectors are assigned". Exports carry taxonomy version, label origin and confidence.
- `lib/api/warehouse.js` routes (`listParam` for `?sector=`); `lib/api/pages.js` entries; `types.ts`.

## Waves (each: build, verify, push a PR, stop for sign-off)

| Wave                           | Scope                                                                                                                                                                                                                                                                                                   | Exit gate                                                                                                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **W0** measure                 | Draft TAXONOMY.md and the AI rule. Hand-label the 197 companies. Check Form D/SIC coverage on EDGAR (paced). Classifier pilot on 60 gold names. Report cost per name, accuracy, negatives                                                                                                               | gates in §4 met on the pilot, or the taxonomy or prompt fixed                                                                                                                                              |
| **W1** labels in the warehouse | ADR 0010 (labels are disclosed judgments), migration 0023, ledger + import + validation, the 197 reviewed labels, company header chip                                                                                                                                                                   | `npm test` + invariants; every company ≥ $100M labeled                                                                                                                                                     |
| **W2** classifier              | `lib/classify`, evidence packs, cache, batch backfill, offline eval in `npm test`, watch-report queue (name + industry). Nothing auto-applied to unreviewed names                                                                                                                                       | eval gates on the held-out half                                                                                                                                                                            |
| **W2b** full queue             | Deterministic triage of level12/listed/fund. Classifier backfill (Batches) over every remaining unreviewed name. Migration for categories `real_estate` and `claim`. Apply `origin=auto` results under the gates. I work the person queue to zero above $1M. "Unresolved value" metric in doctor/Status | unresolved value ≥ $1M = $0; a fresh 40-name audit of auto results ≥ 38/40 and no fund/vehicle/listed name called an operating company; Market/Firms/Explore = `exposureAsOf` with auto companies included |
| **W3** analytics               | sector totals, pivot rows, sector bridge, mark index, services + API                                                                                                                                                                                                                                    | Σ sectors = Market at 3 dates; bridge reconciles to the cent; index hand-checked on Anthropic/Databricks/Stripe legs (golden fixture), with new GOLDEN-NUMBERS from raw EDGAR                              |
| **W4** web                     | `/sectors`, `/sector`, `/theme`, filters, Explore, Compare, exports, glossary, About                                                                                                                                                                                                                    | browser light/dark at 1280 and 375 px, e2e, no console errors                                                                                                                                              |
| **W5** future filings          | nightly classify for new companies (server API key: your step), "labeled automatically" + undo, doctor/Status coverage metric, monthly audit, alert when unclassified value > threshold                                                                                                                 | one unattended nightly that labels a new company end to end                                                                                                                                                |
| **W6** close-out               | adversarial pass (pivots, mislabels, empty sectors, a theme on 0 companies, partial quarter), DATA-QUALITY traps, LESSONS, STATUS, CHANGELOG                                                                                                                                                            | all gates green                                                                                                                                                                                            |

W2b absorbs the auto-admit plan (`docs/plans/auto-admit-measurement.md`). Its narrow A-US rule becomes one input next to
the classifier, and its 38/40 gate applies to every automatic admit.

## Verification

- `npm test`, `npm run lint`, `npm run format:check`, `npm run test:web`, `npm run build:web`, `npm run test:e2e`.
- Invariant tests:
  - Σ sector totals = Market `topCompanies` total = `exposureAsOf` sums;
  - Explore sector rows sum to the total row (industries) and are flagged as non-additive (themes);
  - sector bridge start/end = `exposureAsOf` at each quarter end;
  - changing `industries.csv` changes the curation digest and the answer;
  - a label import with an unknown code fails;
  - fund/clo/insurance never carry a sector.
- Real-data checks: a sector index step hand-computed from raw `primary_doc.xml` marks (`scripts/verify-edgar.js`) for
  one AI and one biotech company, added to GOLDEN-NUMBERS. The worked answers to your two example questions are shown
  on live data with coverage and partial-period flags.
- One heavy job at a time, in the foreground; I ask before any refresh, e2e or LIVE run, and before spending on the
  API beyond the W0 pilot.

## W0 results (2026-10-20, generation 34, read-only; EDGAR through the paced `secGet`)

Files: [p14/taxonomy.json](p14/taxonomy.json) (draft 1: 9 sectors, 39 industries, 8 themes, each with a definition and
real examples) and [p14/gold-labels.csv](p14/gold-labels.csv) (the 197 reviewed operating companies, with confidence and
notes). The scratch scripts sit in the session notes, not the repo.

**1. Form D is not a usable industry source (negative finding).** For each company, a full-text search on EDGAR
(`efts.sec.gov`, form D, exact name), then the newest matching Form D's `industryGroupType` from its `primary_doc.xml`:

- **95 of 197 companies** match a Form D, and they hold only **34.3% of value**. Anthropic, OpenAI, Waymo, ByteDance,
  Anduril and Revolut have none.
- The groups are coarse: "Other Technology" for 43 companies, "Other" for 21.
- Name matching collides. Nuro matched a 2015 "Nuro" filed as Biotechnology. Bluejay Therapeutics is filed as "Other
  Technology". GrubMarket is filed as "Restaurants".
- **Call:** Form D is dropped as a cross-check. A Form D filed under the company's own CIK can be shown as evidence;
  it is never used to decide a label. SIC codes are empty for Form D-only filers (`sics: []` in every hit).

**2. Draft labels for the 197 companies.**

| Confidence | Companies |   Value | Share of value |
| ---------- | --------: | ------: | -------------: |
| high       |       168 | $61.23B |          95.5% |
| medium     |        15 |  $1.66B |           2.6% |
| unclear    |        14 |  $1.21B |           1.9% |

- Value by sector: Technology $39.68B, Financials $7.15B, Industrials $6.95B, Consumer $3.14B, Health care $1.81B,
  Communications $1.50B, Energy $1.02B, Materials $1.02B, Real estate $0.62B.
- The AI theme covers 40 companies, **$38.98B (61%)**. That is why each sector figure needs a median twin.
- The unclear names are deal code names or vehicles that web search cannot identify: Mustang Express ($442M), FEH,
  Illuminated, MYT, Energy Technologies, Ascent CNR, Nexus Apex, Recovery Solutions, PG Polaris TopCo. **The
  classifier must be allowed to say "unclear", and these names stay with a person.**
- Category errors inside the reviewed list: Acr III LSC, HIG Intermediate and SCRS Intermediate (holding vehicles),
  Legacy Gateway JV (real estate JV), Aestas Management (an SPV manager), and Tonian Holdings (a Form D pooled
  investment fund). All are `category=company` today; W1 moves them, with evidence.
- **Independence caveat:** these labels were drafted by Claude in a session, and the W2 classifier is also Claude. They
  are not independent raters. Before W1 sign-off, a person checks the 15 medium names plus a seeded random 20 of the
  high-confidence ones.

**3. Can the example questions be answered?** Matched mark pairs (same fund and class, prior mark ≤ 100 days
earlier, no split) by report date in 2026, with the draft labels. These are exploratory figures, not published; W3
builds the real index.

| Quarter             | AI: companies / legs / unchanged | Biotech: companies / legs / unchanged |
| ------------------- | -------------------------------- | ------------------------------------- |
| Q1 2026             | 36 / 1,209 / 15%                 | 10 / 139 / 47%                        |
| Q2 2026             | 38 / 1,428 / 21%                 | 10 / 143 / 13%                        |
| Q3 2026 (to Jul 31) | 34 / 385 / 25%                   | **4 / 14** / 0%                       |

- AI is well covered.
- Biotech is thin: 10 companies a quarter and 4 in the partial Q3, so a "biotech index" would rest on a handful of
  marks. **The index gets a minimum: at least 5 companies and 20 legs in a period, otherwise it shows "too few
  comparable marks".**
- The newest private mark in generation 34 is 2026-07-31. Q3 2026 is partial until the September reports arrive.

**4. Classifier pilot (stopped by the user after 56 of 62 names; ~$2.70 spent, Opus 5.5).**

Scored offline against the draft labels:

- entity type: 42 of 48 right;
- sector: 35 of 36, and industry 35 of 36, on operating companies;
- AI theme: 10 true positives, 1 false positive (Kobold Metals), 0 misses;
- the Claris grouping error was caught (`same_issuer = false`);
- TPG VII was called a fund interest, and the three listed foreign stocks were called listed.

Every wrong answer was on a vehicle or holdco, and **every one was marked medium or low confidence**:

- PG Delta HoldCo and Acr III LSC were called operating companies;
- Sidewalk Infrastructure Partners was called a vehicle;
- OHA SFR was called a vehicle rather than real estate.

"Apply only high-confidence answers" would have made no wrong call in this sample. The model also matched Ascent CNR
to Ascent Resources (high confidence), which is a possible duplicate company id for W1 to check against the raw rows.

**Cost:**

- ~$0.02 per known company, ~$0.07 when it searches the web;
- the rulebook prefix (9.4k tokens) is cached after the first call.

**The user's call (2026-10-20): no paid API for the backfill.**

- The 197 reviewed companies and the whole unreviewed queue are labeled **in session**, from the warehouse names, the
  reviewed ledgers and deterministic rules. The order is: listed identifiers, issuer type, vehicle and real-estate name
  rules, then my review by value.
- Only names that first appear in new filings go to the **cheapest current model (Haiku 5.5)**:
  - no web search unless the user enables it;
  - a hard nightly budget in cents;
  - only high-confidence answers are applied;
  - everything else goes to the person queue.
- §3's Opus/Batches backfill is withdrawn.
