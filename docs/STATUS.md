# Vantage v2 Status

**Phase:** P6 (analysis views) **built through the core views, awaiting sign-off**, on branch `v2-phase6`.
**Last updated:** 2026-10-01. Earlier phases' results: [archive/STATUS-history.md](archive/STATUS-history.md).

## Phase tracker

- [x] P0–P5b: live fixes, warehouse, refresh, as-of, entities, identity, services, company and fund pages
      (signed off 2026-09-28..30; ROADMAP "Done")
- [ ] **P6: analysis views** (core built 2026-10-01; remaining items in ROADMAP §6)
- [ ] P7: MCP server (open now; the services exist)
- [ ] P8: operations hardening (nightly job, backups, alerting, doctor)
- [ ] P9: public deployment (hosting to decide as ADR 0006)

## What the app answers now (all from the warehouse, every row with mark date and accession)

| View                         | Where                          | What                                                                                                   |
| ---------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Issuer: holders as of a date | company page (`/company/<id>`) | funds, value, % of fund (conviction), labels, "known as of", no longer reported, $0                    |
| Issuer: activity             | company page → Activity        | per fund filing: first reported, added, reduced, no longer reported, $0, mark moved (split-adjusted)   |
| Issuer: trend                | company page → Trend           | funds and value at every month end; entries, exits, mark-ups/downs per month                           |
| Security: share classes      | company page → Share classes   | every fund's per-share mark per class, spreads at one date, gaps within a filing, stale marks, history |
| Fund                         | Fund X-Ray, `/fund/<key>`      | private book (operating companies, fund interests, vehicles), compare, returns, changes by filing      |
| Manager                      | Firms tab, `/firm/<id>`        | book as of any date by company and fund, marks per class, 12 months of changes                         |
| Market                       | Market & What's New tab        | top private companies as of any date, by country, tracked dashboard, feed of new filings               |
| Exports                      | every view                     | CSV with mark date, accession and source (XLSX/PDF on the v1 views)                                    |

## Post-P5 review and this session (2026-10-01)

- **Review findings, all fixed** (archive has the review): funds sharing a name merged on the company page (trap 48);
  listed companies' private-era history unreachable (trap 49, now `?stored=1`, labeled); a lone weak search match
  opened by itself (search now marks `strong`); `review:aliases` skipped the lock; a failed make-company left the
  warehouse half-applied; resolved unreviewed keys did not redirect; X-Ray's private book mixed fund interests; no
  gzip; docs drift; CI ran twice; merged branches; `npm audit` (now 0).
- **Decided by Claude under "fix everything" (user can overrule):** trap 45, loans filed as OTHER are debt by the
  filer's own wording (71,043 rows, $22.8B, 349 filings; goldens unchanged; C26); size budget raised to **1 GB**.
- **Found while building and fixed:** common and preferred under one title merged (trap 47, F37); class and firm
  marks counted amended filings (now canonical only); a class label's 12-month median compared different securities
  across OpenAI's restructuring (the dashboard now uses each fund's own split-adjusted series).
- **Verified on raw EDGAR:** F37 (Nuveen Winslow EC/EP rows), F38 (Blue Owl's 26,201 loan rows by wording).
- **Goldens through the new views** (`test/views.test.js`, `test/app-views.test.js`): F8/F9 exit; Capital Group Stripe
  $33.73 → $35.50 → $41.42 → $63.00 and 8 of 12 months; F13 split not an add; A1/A2 via the trend; F30 +5.76%; A3
  9 / $8.46B two ways; A5 via the dashboard; F2 in the feed; every top company = `exposureAsOf`.
- **Docs:** archived (verbatim) STATUS history, ROADMAP P0–P5, the full DATA-QUALITY traps, LESSONS stories and old
  prompts to `docs/archive/`; session-start reading cut from ~175 KB to ~45 KB.

## Measurements

| Metric                         | Budget | Latest                                                                                                |
| ------------------------------ | ------ | ----------------------------------------------------------------------------------------------------- |
| Warehouse size                 | ≤1 GB  | **544.0 MB** (2026-10-01; ~25–30 MB per bulk quarter)                                                 |
| Nightly refresh                | ≤5 min | 0.7 min (#15, nothing new; reclassify adds ~4 s)                                                      |
| API p95, new routes (load ~4)  | <200ms | activity 28, trend 11, classes 9, marks 5, firm 11, firm changes 138, top 118, feed 192, firms 103 ms |
| API p95, P5 routes             | <200ms | all routes 19.7 ms (P5b bench)                                                                        |
| Suite                          | green  | 496 tests, 465 pass, 0 fail, 31 skipped; `npm run test:live` 31 / 31; lint and format clean           |
| Full backfill / first catch-up | —      | 13.6 min / 26.9 min (P1, P2)                                                                          |

Cold first requests are slower (disk); the server warms tracked exposure, the market list, firms and the dashboard
at start (dashboard ~4.5 s cold).

## Warehouse state (refresh #15, 2026-10-01)

Schema at migration 0018. 354,999 N-PORT filings (bulk 2019Q4–2026Q2 + catch-up through filings of 2026-09-30),
1.165M private-candidate rows (74k now debt by trap 45), 806 companies (304 private), 180 tracked, 529 firms,
18,852 funds, 71,833 unreviewed entities. `ingest_errors` empty. 2026Q3 bulk not posted yet (loads on the next
refresh once it is).

## Open decisions (user)

- **Sign off P6's core**, then the remaining P6 items (ROADMAP §6) or P7 (MCP) next.
- **Install the nightly refresh** (launchd entry in ARCHITECTURE §Refresh lifecycle)? Not installed; until then run
  `npm run refresh` at session start. P8's 30-day unattended run cannot start before it.
- **Overrule or keep** the two decisions above (trap 45 rule, 1 GB budget).
- **Global git identity** is "Test User <test@test.com>" (`git config --global`); this repo sets its own. Fix with
  `git config --global user.name …` if wanted (not changed: system config).
- **Push and PR:** `v2-phase6` is committed locally; push it and open a PR when you say so.
- Balance-0 rows (trap 43) count under the P3 precedent; tracked-list size is yours to change.

## Known issues

- `test/edge-cases.test.js` "cik/accession are validated…" failed once in a full run under heavy machine load and
  passed in every rerun (3/3 alone, 2/2 full); like the v1 429-retry test, timing-sensitive.
- Fidelity's opaque per-fund vehicles (~$0.6B) stay on the review list (no filing names their targets).

## Next session

> Resume Vantage v2. Read CLAUDE.md, docs/STATUS.md, docs/ROADMAP.md §6–7, docs/DATA-QUALITY.md, docs/LESSONS.md.
> `npm run refresh` first (2026Q3 bulk may load: report it, `ingest_errors`, size vs 1 GB). Run npm test (check the
> exit code), lint, format, `npm run test:live`. Then the user's choice: the remaining P6 items in order, or P7.

## Log

- **2026-10-01:** Post-P5 fixes, trap 45/47 rules, the P6 analysis views (issuer, security, fund, manager, market,
  feed, dashboard), docs archived and shortened, merged branches deleted. Stopped for P6 sign-off.
- **2026-09-30:** Post-P5 review (findings), P5b signed off and merged (PR #4). Earlier: archive.
