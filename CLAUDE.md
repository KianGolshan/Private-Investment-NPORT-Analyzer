# CLAUDE.md: standing rules for Vantage

Vantage tracks **private-investment exposure and valuation marks** reported by SEC-registered funds (N-PORT-P),
plus BDC private-credit marks (10-Q/10-K). We are building **Vantage v2**, an SEC-verified warehouse with
history back to 2019Q4, automatic refresh, as-of exposure, and firm/fund/class mark analytics.

## Start every session here

1. Read `docs/STATUS.md` to find the current phase, the last checkpoint and open decisions.
2. Read the matching phase in `docs/ROADMAP.md`: entry gate, tasks, tests, success criteria.
3. Skim `docs/DATA-QUALITY.md` before touching any ingest or aggregation code, and `docs/LESSONS.md` for how
   we work (verification, long jobs, sign-off).
4. Before ending the session, update `docs/STATUS.md` (what changed, test results, next prompt).

## Non-negotiable data rules

- **Real SEC data only.** Never fabricate, assume, or "illustrate" with made-up values. Every proposed
  metric or data source must first be checked against real filings, and the result (including negative
  findings) reported.
- **Every number we publish must be reproducible.** Any new number must be verified against raw EDGAR
  (`primary_doc.xml` or the submissions API) and added to `docs/GOLDEN-NUMBERS.md` with its accession(s).
- **SpaceX is public.** Never use it as a private-company example.
- **Fund calendars are staggered.** Each fund publishes one N-PORT per _fiscal_ quarter: some funds report
  Jan/Apr/Jul/Oct, others Feb/May/Aug/Nov or Mar/Jun/Sep/Dec. Month-1 and month-2 reports are not public.
  Never assume aligned dates. Always show each fund's mark date.
- **Aggregates go through the canonical views only** (`canonical_filings`, `exposure_asof`); see
  `docs/DATA-QUALITY.md` for amendments, blank series IDs, exits, dead funds, debt vs. equity, SPVs and
  splits.
- **"Private" means the company's status** (the `companies` table), not fair-value Level 3 alone. Real
  filers label private holdings Level 1 or 2.
- Exits are reported as "no longer reported"; never guess why a fund exited.

## Engineering rules

- Reuse, don't re-implement. For parsing, use `extractAllHoldings`, `extractFundMeta`, `classifyInstrument`,
  `issuerKeyOf` and `instrumentKey` in `parsers.js`. For splits, use the logic in `public/splits.js`. A scratch
  parser that skipped `assetConditional` once dropped a real $1.09B Anthropic position.
- All SEC HTTP calls go through the paced `fetchWithRetry` (SEC fair access is about 10 req/s, and a real
  User-Agent is required).
- Ingest is idempotent and transactional (one transaction per quarter or batch), logs row counts to
  `ingest_log`, and fails loudly.
- **Background jobs must have a terminal state.** No orphaned wait or poll loops. A background wait must
  exit on success _and_ on failure. A leftover `until …; sleep` loop once ran for 5.5 hours.
- Provenance: every stored row traces to `accession` + holding row (+ bulk quarter or `source='edgar'`).
- Schema changes go in numbered migrations (`db/migrations/NNNN_*.sql`). No ORM.
- Keep the warehouse (`warehouse.db`) separate from the request cache (`cache.db`).
- Match the surrounding code style: Prettier config, ESLint flat config, Node ≥22, CommonJS.

## Commands

```bash
npm test                 # offline suite (real-data fixtures, no network)
npm run lint             # ESLint
npm run format:check     # Prettier
npm run test:live        # LIVE_SEC=1 end-to-end against real EDGAR (minutes)
```

```bash
npm run ingest:bulk -- --missing   # load SEC bulk quarters not yet in warehouse.db (--all, --quarter 2026q2)
npm run ingest:delta               # catch up on filings made after the newest bulk quarter (--since/--until)
npm run refresh                    # nightly: new bulk quarter(s), catch-up, N-CEN, entity upkeep
npm run ingest:ncen                # N-CEN adviser data sets + EDGAR top-up (managers, ADR 0007)
npm run seed:entities              # write data/review/{aliases,managers}.csv suggestions (--force to overwrite)
npm run review:aliases             # import the reviewed CSVs, re-resolve holdings (human in the loop)
```

## Scope

- In scope: private equity-type exposure and marks (common, preferred, warrants, SPV/fund interests) in
  N-PORT; firm/fund/class analytics; the tracked-company list; the MCP server.
- Deferred: enhancements to private credit (BDC 10-Q/10-K path stays as is).
- Adopted after real-data checks: Form N-CEN advisers for manager mapping (ADR 0007).
- Rejected after real-data checks: 13F, 13D/G, N-PX, insider forms, fund flows, Form ADV, Form D and XBRL
  as primary sources. Keyword (full-text) search is on-demand only, because it cannot see exits or opaque SPVs.
