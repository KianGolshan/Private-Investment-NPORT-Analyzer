# CLAUDE.md: standing rules for Vantage

Vantage tracks **private-investment exposure and valuation marks** reported by SEC-registered funds (N-PORT-P),
plus BDC private-credit marks (10-Q/10-K). We are building **Vantage v2**: real, SEC-verified data from 2019Q4,
refreshed automatically, analyzable by **security (class) → issuer → fund → manager** at any date, with per-share
marks, new positions, adds, reductions, exits and trends. Keep that goal in view in every change.

## Start every session here

1. Read `docs/STATUS.md` to find the current phase, the last checkpoint and open decisions.
2. Read the matching phase in `docs/ROADMAP.md`: entry gate, tasks, tests, success criteria.
3. Skim `docs/DATA-QUALITY.md` before touching any ingest or aggregation code, and `docs/LESSONS.md` for how
   we work (verification, long jobs, sign-off).
4. Before ending the session, update `docs/STATUS.md` (what changed, test results, next prompt). Keep it the
   current state: finished history goes to `docs/archive/` (read only when needed).

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
- **Aggregates go through the canonical views and the as-of rule only** (`canonical_filings`, `exposureAsOf` and the
  services built on it; a new view's numbers are tested equal to `exposureAsOf` where they overlap); see
  `docs/DATA-QUALITY.md` for amendments, blank series IDs, exits, dead funds, debt vs. equity, SPVs and
  splits.
- **"Private" means the company's status** (the `companies` table), not fair-value Level 3 alone. Real
  filers label private holdings Level 1 or 2.
- Exits are reported as "no longer reported"; never guess why a fund exited. Changes are worded as the filings
  allow: first reported, added, reduced, reported at $0, mark moved.
- **Group by identity, display by name:** fund_key, company id, instrument key; names are labels (trap 48).

## Engineering rules

- Reuse, don't re-implement. For parsing, use `extractAllHoldings`, `extractFundMeta`, `classifyInstrument`,
  `issuerKeyOf` and `instrumentKey` in `parsers.js`. For splits, use the logic in `public/splits.js`. A scratch
  parser that skipped `assetConditional` once dropped a real $1.09B Anthropic position.
- All SEC HTTP calls go through the paced `fetchWithRetry` (SEC fair access is about 10 req/s, and a real
  User-Agent is required).
- Ingest is idempotent and transactional (one transaction per quarter or batch), logs row counts to
  `ingest_log`, and fails loudly.
- **Every write is a job** (`lib/warehouse/job.js` `runJob`, ADR 0009): lock, candidate copy, full derived
  rebuild, validation, then a new published generation. A new writer goes through `runJob`; never open
  `warehouse.db` read-write from a script.
- **Background jobs must have a terminal state.** No orphaned wait or poll loops. A background wait must
  exit on success _and_ on failure. A leftover `until …; sleep` loop once ran for 5.5 hours.
- Provenance: every stored row traces to `accession` + holding row (+ bulk quarter or `source='edgar'`).
- Schema changes go in numbered migrations (`db/migrations/NNNN_*.sql`). No ORM.
- Company and firm ids are stable (ADR 0008, 0009): `data/review/company_ids.csv` and `manager_ids.csv` are the
  ledgers; the review import reads and rewrites them. Never renumber or reuse an id.
- Keep the warehouse (`warehouse.db`) separate from the request cache (`cache.db`). Readers (web server,
  MCP server) open it with `openWarehouseReadOnly`; only jobs migrate or write.
- The app answers private companies, funds, firms and the market from the warehouse (`lib/services`,
  `lib/analytics`; module map and API in `docs/ARCHITECTURE.md`); v1's per-filing routes are a compatibility layer
  for the live path only. Warehouse size budget: 1 GB. Admin actions are local, behind `VANTAGE_ADMIN=1`, and run as jobs.
- Match the surrounding code style: Prettier config, ESLint flat config, Node ≥22, CommonJS.

## Commands

```bash
npm test                 # offline suite (real-data fixtures, no network)
npm run lint             # ESLint
npm run format:check     # Prettier
npm run test:live        # LIVE_SEC=1 end-to-end against real EDGAR (minutes)
npm run build:web        # the analyst workspace (web/, Vite + Preact + TS) -> web/dist, served at /
npm run test:web         # workspace typecheck + Vitest; npm run lint:web; npm run dev:web (Vite, proxies /api)
```

```bash
npm run ingest:bulk -- --missing   # load SEC bulk quarters not yet in warehouse.db (--all, --quarter 2026q2)
npm run ingest:delta               # catch up on filings made after the newest bulk quarter (--since/--until)
npm run refresh                    # nightly: new/re-posted bulk quarter(s), catch-up, N-CEN, entity upkeep
npm run warehouse                  # published generations and the last job (-- --rollback: previous generation)
npm run ingest:ncen                # N-CEN adviser data sets + EDGAR top-up (managers, ADR 0007)
npm run seed:entities              # write data/review/{aliases,managers}.csv suggestions (--force to overwrite)
npm run review:aliases             # import the reviewed CSVs, re-resolve holdings (under the refresh lock)
npm run entities:report            # review queue: unresolved value by component, conflicts (reports/entities/)
npm run bench                      # p50/p95 per warehouse route on the live warehouse (note the load average)
node scripts/backfill-filing-totals.js --status   # one-off P5b backfill of filing_totals + capital rows (--bulk, --edgar, --max-minutes)
node scripts/make-company.js --key KEY --name NAME  # admin: make an unreviewed name a company (writes data/review, runs the import)
node scripts/verify-edgar.js CIK PATTERN ACCESSION...   # raw primary_doc.xml rows behind a number (golden checks)
```

## Scope

- In scope: private equity-type exposure and marks (common, preferred, warrants, SPV/fund interests) in
  N-PORT; firm/fund/class analytics; the tracked-company list; the MCP server.
- Deferred: enhancements to private credit (BDC 10-Q/10-K path stays as is).
- Adopted after real-data checks: Form N-CEN advisers for manager mapping (ADR 0007).
- Rejected after real-data checks: 13F, 13D/G, N-PX, insider forms, fund flows, Form ADV, Form D and XBRL
  as primary sources. Keyword (full-text) search is on-demand only, because it cannot see exits or opaque SPVs.
