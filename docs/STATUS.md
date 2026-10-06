# Vantage v2 Status

**Phase:** P6b (analyst workspace) and P6c (staff review remediation) are **complete and signed off** (W5 on
2026-10-06). **Next: the user chooses** among P7 (MCP server), P8 (operations) and a PR of `v2-p6b-workspace` to main.
Branch `v2-p6b-workspace` (pushed, in sync).
**Last updated:** 2026-10-06. Earlier results: [archive/STATUS-history.md](archive/STATUS-history.md).

## Phase tracker

- [x] P0–P5b: live fixes, warehouse, refresh, as-of, entities, identity, services, company and fund pages
      (signed off 2026-09-28..30; ROADMAP "Done")
- [x] P6 core: analysis views (signed off 2026-10-01; remaining items in ROADMAP §6)
- [x] P6b: analyst workspace, W0–W5 (signed off 2026-10-01..06; ROADMAP §6b)
- [x] P6c: review remediation R1–R3 (signed off 2026-10-05; [plan](plans/P6c-review-remediation.md), ADR 0009)
- [ ] P7: MCP server (open; the services exist)
- [ ] P8: operations hardening (nightly job, backups and restore drill, readiness, alerting, doctor; F10/F11 items)
- [ ] P9: public deployment (hosting to decide as ADR 0006; capacity envelope, shared SEC budget)

## What the app answers now (all from the warehouse, every row with mark date and accession)

The analyst workspace is served at `/`; the route map is at the top of the [README](../README.md).

| View                | Where                             | What                                                                                                   |
| ------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Search              | ⌘K anywhere                       | one ranked search over companies, unreviewed names, firms, funds and classes                           |
| Market              | `/` (Top, Movers, Newly reported) | top private companies as of any date; largest mark effects and position flows; first reported in range |
| Company             | `/company/<id>`                   | overview + bridge, holders, positions grid, changes, marks & classes (spreads, leadership), filings    |
| Position history    | `/company/<id>?pos=<fund>`        | one fund's legs at every filing, one mark line per class                                               |
| Fund                | `/fund/<key>`                     | private book (X-Ray), timeline, marks vs others, compare, mark-implied returns                         |
| Firm                | `/firm/<id>`, `/firms`            | a manager's book, timeline, fund × company matrix, marks vs others, paged changes                      |
| Explore             | `/explore`                        | firm/fund/company/class × month/quarter/year, every metric; any cell drills to the legs behind it      |
| Activity            | `/activity`                       | changes in newly filed reports, firm and fund filters, paged; KPIs over every match                    |
| Compare             | `/compare`                        | 2–5 companies, firms, funds or classes side by side                                                    |
| Tracked & Watchlist | `/tracked`                        | the tracked list and the viewer's watchlist (statuses for listed, merged or dropped ids)               |
| Private Credit (v1) | `/legacy`                         | BDC 10-Q/10-K schedules (deferred scope); the other v1 tabs link to their replacements                 |
| Exports             | every table                       | CSV/XLSX with mark date, accession, source and how history is read (Basis); formula-safe CSV           |

## Where things stand (2026-10-06)

- **Data:** every write is a warehouse job (`lib/warehouse/job.js`, ADR 0009). It builds a candidate, rebuilds
  every derived table, validates it, and publishes `generations/warehouse-<id>.db` behind the `warehouse.db` link.
  Readers switch on their next request. `npm run warehouse` lists generations and `-- --rollback` goes back one.
  Company and firm ids are permanent ledgers in `data/review/`.
- **Rules added in P6c:**
  - trap 53 (a class at $0 is a mark move);
  - one mark observation per fund × class × date (F06);
  - disclosed ranges obey `knownAsOf`;
  - bulk archives are validated before they replace a quarter (trap 41 updated);
  - display rules for basis, paging and partial answers (DATA-QUALITY).
- **Assurance:**
  - `npm test` (backend, incl. `test/job.test.js` and the raw-EDGAR oracle `test/oracle.test.js`);
  - `npm run test:web` (Vitest);
  - `npm run test:e2e` (Playwright, Chromium: 7 workflow tests plus an axe audit of 10 views in light and dark).

  CI runs all three, with actions pinned by SHA.

- **v1:** only Private Credit remains visible at `/legacy`. The retired tabs' code is hidden, not deleted, because
  about 30 v1 regression tests drive it.

## Handoff: how to work on this project

- **Working with the user.** The user signs off each wave ("sign off", or "continue" = sign-off and build the next).
  Build the whole wave, verify it in the browser on the live warehouse, update docs, commit and push to
  `v2-p6b-workspace`, then stop for sign-off. Recommend, don't survey; decide delegated questions by v1 behavior and
  v2 goals and list the call under Open decisions. No PR, merge to main, launchd job or global config without an
  explicit yes.
- **Real data only.** Check any new metric's definition on real rows _before_ building it. Every new number shown as a
  finding goes to GOLDEN-NUMBERS after a raw-EDGAR check: `node scripts/verify-edgar.js <cik> <pattern> <accession>…`
  (fails closed when nothing matches; needs `SEC_USER_AGENT` from `.env`). Last golden: **F53**.
- **One definition, held equal by tests.** New answers must equal `exposureAsOf` / `companyActivity` / `firmBook`
  where they overlap (`test/analysis.test.js` pattern). Where shared code could be wrong, add an independent check
  to the oracle (`test/fixtures/oracle/build-oracle.js`, hand-picked rows, plain arithmetic).
- **Writes are jobs.** A new writer goes through `runJob`; never open `warehouse.db` read-write from a script. A
  rule that changes stored facts gets a warehouse-wide before/after diff (LESSONS 36; see the F05 diff in the
  archive).
- **Words as filed:** first reported, added, reduced, no longer reported, reported at $0, reported above $0 again,
  mark moved. Never sale, bought, led. Compare marks only at the same mark date.
- **Frontend patterns:**
  - Pages read the scope from the URL and send it to the server; never filter on the client.
  - Every chart has a table twin and an export (`basis={BASIS}` on cross-company tables).
  - Tooltip HTML goes through `escapeHtml`; dialogs use `useDialog`.
  - Build with `npm run build:web` before `preview_start` (`nport-analyzer`, port 3000) or `npm run test:e2e`.
  - Check light, dark, 375 px and the console.
- **Performance:** add every new route to `scripts/bench.js` (p95 < 200 ms; record the load average). Lighthouse is
  run with `CHROME_PATH` pointing at Playwright's Chromium for Testing (see the W5 log in the archive).
- **Gotchas:**
  - Never run `cat > file` without input in a command; it waits on stdin and hangs.
  - Scratch scripts go in the session scratchpad.
  - Ids worth knowing:
    - companies: Anthropic 1, Databricks 2, Stripe 5, Canva 6, FHU 741;
    - firms: BlackRock 1, Fidelity 3, T. Rowe 8, Capital Group 9;
    - funds: Growth Fund of America `S000009228`, Contrafund `S000006037`.

## Measurements

| Metric                         | Budget               | Latest                                                                                     |
| ------------------------------ | -------------------- | ------------------------------------------------------------------------------------------ |
| Warehouse size                 | ≤1 GB per generation | **577.1 MB** (generation 24; two generations kept, ~1.8 GB on disk with a candidate)       |
| Nightly refresh                | ≤5 min               | 0.8 min as a job (#22: copy, refresh, derived rebuild, validation, publish in 47 s)        |
| API p95, all routes            | <200ms               | 13.5–16.1 ms over 3,805 requests (W5, load 3.2); drill total 382 KB JSON = 48.8 KB gzipped |
| Lighthouse perf / a11y         | ≥90                  | Market 96/98, Explore 97/98, company 98/98, firm 95/98 (W5)                                |
| Accessibility (axe, WCAG 2.1)  | 0 serious            | 0 findings of any impact, 10 views × light/dark                                            |
| Suite                          | green                | 570 backend (538 pass, 31 skipped, 0 fail on rerun); web 34/34; e2e 27/27; LIVE 31/31      |
| Full backfill / first catch-up | —                    | 13.6 min / 26.9 min (P1, P2)                                                               |

## Warehouse state (generation 24, 2026-10-06)

Schema at migration 0020.

- 355,007 N-PORT filings: bulk 2019Q4–2026Q2 plus catch-up through filings of 2026-10-05.
- 1.165M private-candidate rows.
- 806 companies: 302 private, 504 public; 180 tracked.
- 529 firms (ledger `manager_ids.csv`), 18,852 funds, 71,835 unreviewed entities.
- 68,277 position-fact legs.
- `ingest_errors` empty. 2026Q3 bulk not posted yet.
- The published generation 24 records curation `83d1d8c+dirty`: built before `manager_ids.csv` was committed. The
  next job records it clean.

## Open decisions (user)

- **Next phase:** P7 (MCP server), P8 (operations) or a PR to main. No PR is open; `v2-phase6` and `v2-p6b-workspace`
  are pushed.
- **Install the nightly refresh** (launchd entry in ARCHITECTURE §Refresh lifecycle)? Not installed; until then run
  `npm run refresh` at session start. P8's 30-day unattended run cannot start before it.
- **Calls still open to overrule** (details in the archive's "Decisions as recorded at W5 sign-off"):
  - W5:
    - v1 tab code hidden, not deleted;
    - light-theme contrast colors;
    - ECharts deferred to idle;
    - drill payload not trimmed.
  - P6c:
    - mark observation unit per fund (F06);
    - $0 class semantics (F05);
    - formula-safe CSV;
    - generation files plus a symlink;
    - shrink limits (2% per job, 90% per quarter reload);
    - `partial` publication;
    - Last-Modified re-post detection;
    - firm rename by identical keys;
    - feed paging and basis labels.
  - W4:
    - the watchlist lives in this browser;
    - Compare keeps v1 Batch's spread and mark age;
    - movers rank dollars, not percent.
  - Curation: two VIP funds set `public`.
  - Earlier:
    - trap 52;
    - dated firm attribution not adopted;
    - trap 45 (loans filed as OTHER are debt);
    - the 1 GB budget.
- **Deferred cleanup:** delete v1's retired tabs (`public/app.js`, `views.js`) together with their regression tests,
  when the user agrees nothing more is needed from them.
- **Global git identity** is "Test User <test@test.com>" (`git config --global`); this repo sets its own.

## Known issues

- Intermittent single-test failures in full parallel `npm test` runs, none reproduced on rerun:
  - "scope: … post-filter", 2026-10-05;
  - "API goldens: Stripe A5 …", 2026-10-06;
  - earlier: prod-startup "behind a proxy" ECONNRESET at load 16–20; analysis unified search; edge-cases
    "cik/accession are validated…".

  Likely timing under load (the start-up warm-up can block the event loop past the 5 s keep-alive). Worth a look in
  P8.

- Fidelity's opaque per-fund vehicles (~$0.6B) stay on the review list (no filing names their targets).
- `public/splits.js` knows ratios 2–100 from a fixed list. Two consequences:
  - A 60:1 share exchange (Nscale 2026-05-31) reads as a class change, not a split.
  - A non-split share exchange reads as "added" plus "mark moved". Mesquite Energy (shares ×2.41, $205.76 → $15.45,
    Fidelity 2026-04-30; F52) is Market's largest mark move down (−$801.4M) with a +$561.2M position flow.

  The bridge still reconciles.

- Explore's firm picker lists every firm holding private value (~170), including small advisers with terse N-CEN
  names.
- Historical cross-company views use today's curation, so a company that later listed drops out of earlier periods
  (labeled on screen and in exports). `public_since` research is a P8 item.

## Next session

> Resume Vantage v2 on branch `v2-p6b-workspace` (pushed). P6b and P6c are complete and signed off. Ask the user
> which comes next:
>
> - **P7 (MCP server)**: ROADMAP §7; open, the services exist.
> - **P8 (operations)**: ROADMAP §8, plus the F10/F11 items. These are a readiness endpoint, binding to
>   127.0.0.1 by default, async gzip, a byte-bounded memo, a backup restore drill from a kept generation, alerts, the
>   intermittent test failures, and the nightly launchd job (only with the user's yes).
> - **A PR of `v2-p6b-workspace` to main**: only when the user says so.
>
> Read CLAUDE.md, this file and docs/ROADMAP.md first. Gates: `npm test`, `npm run lint`, `npm run format:check`,
> `npm run test:web`, `npm run lint:web`, `npm run build:web` then `npm run test:e2e`, `npm run test:live`; run
> `npm run refresh` at session start.

## Log

- **2026-10-06:** W5 signed off by the user; P6b and P6c complete. STATUS shortened to the current state: the P6b W1–W5
  and P6c log, the pre-W4 snapshot and the decisions as recorded moved verbatim to the archive.
