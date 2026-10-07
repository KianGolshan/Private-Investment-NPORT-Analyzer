# Vantage v2 Status

**Phase:** **P6e** (follow-ups from the Codex verification review of 2026-10-06, V01–V11) on branch
`v2-p6e-verification`. **W1 and W2 are signed off**; the PR to `main` is open for the user to merge. Open: the V11
Finastra live re-run (needs the user's yes). Next phase after the merge: the user picks P7 (MCP) or P8 (operations).

## Phase tracker

- [x] P0–P5b: live fixes, warehouse, refresh, as-of, entities, identity, services, company and fund pages
      (signed off 2026-09-28..30; ROADMAP "Done")
- [x] P6 core: analysis views (signed off 2026-10-01; remaining items in ROADMAP §6)
- [x] P6b: analyst workspace, W0–W5 (signed off 2026-10-01..06; ROADMAP §6b)
- [x] P6c: review remediation R1–R3 (signed off 2026-10-05; [plan](plans/P6c-review-remediation.md), ADR 0009)
- [x] P6d: full-stack review remediation, W1–W3 (signed off 2026-10-06; ROADMAP §6d, ADR 0009 amendment)
- [x] P6e: Codex verification follow-ups, W1–W2 (signed off 2026-10-06; V11 re-run pending the user's yes)
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
  Start each phase on a feature branch off `main` (e.g. `v2-p7-mcp`). Build the whole wave, verify it in the browser
  on the live warehouse, update docs, commit and push the branch, then stop for sign-off. Recommend, don't survey; decide delegated questions by v1 behavior and
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
| Suite                          | green                | 598 backend (567 pass, 31 skipped, 0 fail); web 37/37; e2e 27/27; LIVE 31/31 (W5)          |
| Full backfill / first catch-up | —                    | 13.6 min / 26.9 min (P1, P2)                                                               |

## Warehouse state (generation 29, 2026-10-06)

Schema at migration 0021. Generation 25 is a refresh (nothing new) and generation 26 a no-change review import. 26 is
the first generation with a curation snapshot (digest `327a4489…`, curation tree `eae566e`, clean). Generation 27 is a
refresh that publishes the R06 rule (one leg re-attributed, F54), 28 a no-change review import under the W3 code,
and 29 a refresh built by `main` (e5eca00, curation tree `eae566e`, clean). The files are read-only on disk.

- 355,007 N-PORT filings: bulk 2019Q4–2026Q2 plus catch-up through filings of 2026-10-05.
- 1.165M private-candidate rows.
- 806 companies: 302 private, 504 public; 180 tracked.
- 529 firms (ledger `manager_ids.csv`), 18,852 funds, 71,835 unreviewed entities.
- 68,277 position-fact legs.
- 198,326 N-CEN adviser rows (now in the shrink check).
- `ingest_errors` empty. 2026Q3 bulk not posted yet.
- Generation 24 (now pruned) had been switched to WAL mode at 19:42:53 on 2026-10-05, two minutes after it was
  published. Its WAL was empty, and no current script opens the warehouse read-write. Generations are now 0444 on
  disk (ADR 0009 amendment).

## Open decisions (user)

- **Next phase:** P7 (MCP server) or P8 (operations). `main` holds all of v2 (PRs #2–#5); there are no other branches
  and no open PRs.
- **P6d calls still open to overrule:**
  - rollback as a new generation;
  - no takeover of a live local job;
  - staged curation with `--sync-curation`;
  - N-CEN drift fails the load;
  - empty-section filings are a warning (trap 55);
  - "reported at $0" kept for a zero+exit position;
  - proxy trust only on a loopback `HOST` or by `TRUST_PROXY`;
  - 5 retry attempts;
  - the export `Source` column;
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

> Resume Vantage v2 on `main` (everything through P6d is merged; PR #5). Ask the user which comes next, then branch off
> `main` for it:
>
> - **P7 (MCP server)**: ROADMAP §7; the services exist.
> - **P8 (operations)**: ROADMAP §8, including the review's carried items:
>   - off-host backup and a restore drill;
>   - crash drills at the publication boundary;
>   - correction and deletion reconciliation;
>   - bench RSS and event-loop lag;
>   - the intermittent test failures under load;
>   - the nightly launchd job (only with the user's yes).
>
> This Mac has 8 GB of memory: run one heavy job at a time in the foreground, run tests with `--test-concurrency=2`, and
> ask before a refresh, the e2e suite or the LIVE suite. Read CLAUDE.md, this file and docs/ROADMAP.md first. Gates: `npm test`, `npm run lint`, `npm run format:check`,
> `npm run test:web`, `npm run lint:web`, `npm run build:web` then `npm run test:e2e`, `npm run test:live`; run
> `npm run refresh` at session start.

## Log

- **2026-10-06:** P6e W2 signed off; PR to `main` opened.

- **2026-10-06 (P6e W2):** W1 signed off ("continue"). W2 built:
  - **V05:** `job.warning` in freshness; the client refreshes `/api/freshness` in place when only the job changed; a
    top-bar pill shows "Job running", "Last job failed" or "Published with warnings";
  - **V07:** DataTable's Source comes from the rows' own answer (`source` prop, full digest) on all 34 exporting
    tables, guarded by `test/invariants.test.js`;
  - **V08:**
    - `hidden(row)` keeps screen and export equal (X-Ray Returns), and the returns export carries the proxy caveat;
    - the company stale panel honors the page date;
    - leadership is labeled "first at mark date";
  - **V09:**
    - nodemon replaced by `node --watch`; `npm audit fix`; root and web all-dependency audits clean, and CI gates
      them;
    - Vitest `maxWorkers: 2`.

  Verification:
  - every new regression fails on the W1 code;
  - backend 581/0/31 skipped; web 39/39; e2e 27/27;
  - browser on a scratch clone: the failed-job pill at a constant generation, and a Market CSV whose Source is
    "generation 30, curation sha256 327a4489…" (full digest).

  V11 (Finastra live re-run) waits for the user's yes.

- **2026-10-06 (P6e W1):** the Codex verification review checked; V01–V11 all real. W1 built:
  - **V01:** a stale lock is taken by rename and verified;
  - **V02:** `lib/warehouse/curation.js` is the only curation reader; a refresh uses the generation's snapshot;
  - **V03:** commit-aware cleanup in `runJob` and `rollback`;
  - **V04:** N-CEN coverage of at least half the funds (real 99.8%), and a filing is never replaced by zero advisers
    (trap 56);
  - **V06:** the newest empty filing warns; the shared label "no longer reported (the filing lists no holdings)"
    covers holders, activity and legs;
  - **V10:** the live test opens the warehouse read-only.

  Guards:
  - post-commit fault-injection sweeps for jobs and rollbacks (the first run found that a directory-sync failure was
    only logged);
  - `test/invariants.test.js`;
  - LESSONS 37–39 and CLAUDE.md fix-completeness rules;
  - `npm test` runs two files at a time.

  The prod-startup flake was traced: its servers warmed the real 578 MB warehouse during timed request bursts; now
  isolated. All 10 new regressions fail on 81496b8. Backend 579/0/31 skipped in 115 s; web 37/37.

- **2026-10-06 (close-out):** PR #5 merged to `main` (e5eca00) by the user; `v2-p6b-workspace` deleted on GitHub and
  locally; `main` is the only branch. Local alignment:
  - clean `npm ci` (root, web) and `build:web`;
  - refresh → generation 29, built by e5eca00;
  - gates on `main`: backend 567/0/31 skipped, web 37/37, e2e 27/27;
  - the LIVE suite was stopped unfinished: running everything back to back overloaded this 8 GB machine. Re-run it
    alone, at a quiet moment.
- **Paused (future builds, the user's call):** P7 MCP server, P8 operations, P9 public deployment (ROADMAP §7–9). Nothing
  else is open.

- **2026-10-06:** P6d W3 signed off; P6d complete. Git cleaned up: `v2-phase6` deleted (fully contained in
  `v2-p6b-workspace`), remote refs pruned, stray build artifacts removed.

- **2026-10-06 (P6d W3):** W2 signed off ("continue"). W3 built:
  - R10: proxy-addr 2.0.8 (lockfile only) and a CI step `npm audit --omit=dev --audit-level=high` for root and web;
  - R11: a `HOST` env (default 127.0.0.1; Vite's proxy now targets 127.0.0.1), `TRUST_PROXY` hop count, and an
    `SEC_MIN_INTERVAL_MS` floor;
  - R12: `ingest_errors` retried outside the index window (attempts < 5); ADR 0001 states the index lag and what
    is not reconciled;
  - R08: `/freshness` has no generation ETag;
  - R18: `curationDigest` in freshness, `basis`, the basis note and export `Source` columns;
  - R20: `runReviewImport` takes `rebuild`; jobs no longer run the derived chain twice. The live import took
    56.1 s against 47.0 s before, under load 3–8, so no gain was measured.

  Backend 567/0/31 skipped; web 37/37; e2e 27/27. Live: no-change import → generation 28. Browser: the server on
  127.0.0.1, and the basis note shows generation 28 and digest `327a448900d2`.
  - `npm audit fix --omit=dev` pruned dev dependencies from `node_modules`; restored with `npm ci`.
  - One prod-startup run failed at load 22 (known flake) and passed on rerun.

- **2026-10-06 (P6d W2):** W1 signed off ("continue"). W2 built:
  - R06: in the zeroed branch, a gone class is an exit leg (position) and a class re-keyed to $0 is paired. The
    warehouse-wide `position_facts` diff found 1 changed leg of 68,277, $6.52 moved from mark to position (Monitronics,
    Goldman Sachs Multi-Manager Non-Core Fixed Income, 2023-10-31, verified on raw EDGAR, F54, trap 54);
  - R07: a disclosed range needs its own accession to be the canonical filing (all 11 live ranges already are);
  - R13: strict calendar dates (2026-02-31 is a 400); X-Ray `pct_nav` is null when not filed and there is no
    net-asset substitution.
    - Real empty filings checked: 339 have no rows. Guinness Atkinson (final filing), Guggenheim ($0 net assets) and
      BMO 2020-11-30 ($1.9B, plain omission) all lack `<invstOrSecs>`.
    - Rejecting them would be wrong; none follows private-company rows today.
    - Jobs now warn on a new one (trap 55).
  - R14: distinct funds, and as-of staleness;
  - R15: subject status in compare and the watchlist; the Compare page shows "not in the warehouse";
  - R16: X-Ray `truncated` type and notice ("largest N rows by value").

  Every new regression fails on the old code. Backend 563/0/31 skipped; web 37/37; e2e 27/27. Live: refresh →
  generation 27. Browser: Compare with id 999999 shows a status badge and dashes; GFA X-Ray renders.

- **2026-10-06 (P6d W1):** the staff full-stack review checked against the code. All seven P1 findings were confirmed;
  R10, R11 and R17 are deployment concerns, and R02 follows from R01. W1 built:
  - generation ids from `generations/SEQUENCE`, and rollback as a new generation (R01, R02);
  - a lock token, `assertOwned` before the publish, and no takeover of a live local job (R03);
  - N-CEN required columns, adviser-type domain and orphan check, plus `ncen_advisers` in the shrink check (R04;
    the real 2026q2 data set loads: 501 filings, 3,959 rows);
  - staged curation with `curation_snapshot` and digest, written back after the publish (R05, R18);
  - post-commit warnings instead of failure, and fsync (R09);
  - 0444 generations.

  Verification:
  - 13 new regressions fail on c697a12;
  - backend 552/0/31 skipped; web 35/35;
  - on a clone of the live warehouse: job 25, rollback 26, review import 27 (82.5 s, files unchanged), job 28, then
    rollback 29; the open company page followed 28 and 29 without a reload;
  - live: refresh → generation 25, review import → 26.

- **2026-10-06:** W5 signed off by the user; P6b and P6c complete. STATUS shortened to the current state: the P6b W1–W5
  and P6c log, the pre-W4 snapshot and the decisions as recorded moved verbatim to the archive.
