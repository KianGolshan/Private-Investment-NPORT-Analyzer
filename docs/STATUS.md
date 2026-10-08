# Vantage v2 Status

**Phase:** **P9** (public deployment), on branch `v2-p9-deploy`. The user approved the plan on 2026-10-08
([plans/P9-deployment.md](plans/P9-deployment.md)): Oracle Cloud Always Free VM, a new domain on Cloudflare, two app
instances behind Caddy, nightly refresh and auto-deploy. W1 (public-ready server) is signed off. **W2 (seamless client
and polish) is built, awaiting sign-off.** W3 (deployment files and docs) follows. P8 is paused (W1–W3 signed off and merged);
its open items are under [Deferred](#deferred). Live warehouse: generation 32.

## Phase tracker

- [x] P0–P5b: live fixes, warehouse, refresh, as-of, entities, identity, services, company and fund pages
      (signed off 2026-09-28..30; ROADMAP "Done")
- [x] P6 core: analysis views (signed off 2026-10-01; the remaining P6 items are deferred)
- [x] P6b: analyst workspace, W0–W5 (signed off 2026-10-01..06; ROADMAP §6b)
- [x] P6c: review remediation R1–R3 (signed off 2026-10-05; [plan](plans/P6c-review-remediation.md), ADR 0009)
- [x] P6d: full-stack review remediation, W1–W3 (signed off 2026-10-06; ROADMAP §6d, ADR 0009 amendment)
- [x] P6e: Codex verification follow-ups, W1–W2 (signed off 2026-10-06; V11 closed)
- [ ] P7: MCP server (deferred)
- [~] P8: operations. W1 (pre-flight fixes), W2 (backups and nightly) and W3 (reconciliation and watch) are
  signed off and merged. The W4 research and the P8 checkpoint (30 unattended nights) are deferred.
- [~] P9: public deployment. W1 signed off 2026-10-08; W2 (client and polish) built, awaiting sign-off; W3 next
  ([plan](plans/P9-deployment.md))

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

## Operations (P8): what runs and how to check it

| Command             | What it does                                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------------- |
| `npm run doctor`    | read-only health: freshness, last job, lock, disk room, backup, nightly/monthly, leftovers; exit 1 = act        |
| `npm run refresh`   | one warehouse job: new bulk quarters, the EDGAR catch-up (NT NPORT-P included), N-CEN, derived rebuild          |
| `npm run nightly`   | refresh, backup, watch report, doctor; macOS notification and exit 1 on a failure; optional `VANTAGE_ALERT_URL` |
| `npm run monthly`   | `npm run reconcile` (EDGAR indexes vs stored filings, re-fetch sample) plus the LIVE regression, with alerts    |
| `npm run backup`    | verified copy of the published generation (`-- --list`, `-- --restore FILE`), 3 kept                            |
| `npm run watch`     | review suggestions against the previous generation (`reports/watch/`), never applied                            |
| `npm run warehouse` | generations and the last job; `-- --rollback`, `-- --sync-curation`                                             |
| `npm run bench`     | p50/p95 per route, RSS and event-loop delay, after the warm-up (`--cold` without)                               |

Safeguards (P8 W1–W3): every job has a time limit (3 h) and a disk check, a stalled download fails after 60 s, a
lock or "running" state left by a dead process is recognized (start time and boot time), a killed job's candidate
is removed, and the server re-warms its caches on each new generation.

## Where things stand (2026-10-08)

- **Data:** every write is a warehouse job (`lib/warehouse/job.js`, ADR 0009). A job builds a candidate, rebuilds
  every derived table, validates it, and publishes `generations/warehouse-<id>.db` behind the `warehouse.db` link.
  Readers switch on their next request. Company and firm ids are permanent ledgers in `data/review/`.
- **Coverage:** checked against EDGAR on 2026-10-07/08:
  - every N-PORT EDGAR lists is stored except the 117 filed as NT NPORT-P since 2026-07-01. The catch-up now lists
    them, and the next refresh loads them (trap 59);
  - 0 stored filings are deleted from EDGAR;
  - 0 of 300 re-fetched filings changed.
- **Curation:** the trap 58 fund-family split and its relabel correction are in `data/review` (generation 32).
- **Assurance:**
  - `npm test`: backend, including the job, backup and reconcile tests and the raw-EDGAR oracle;
  - `npm run test:web`: Vitest;
  - `npm run test:e2e`: Playwright, 7 workflow tests plus an axe audit of 10 views × light/dark;
  - `npm run test:live`: LIVE.

  CI runs the first three, with actions pinned by SHA.

- **v1:** only Private Credit remains visible at `/legacy`; the retired tabs' code is hidden, not deleted.

## Handoff: how to work on this project

- **Working with the user.** The user signs off each wave ("sign off", or "continue" = sign-off and build the next).
  Start each phase on a feature branch off `main` (e.g. `v2-p7-mcp`). Build the whole wave, verify it in the browser
  on the live warehouse, update docs, commit and push the branch, then stop for sign-off. Recommend, don't survey; decide delegated questions by v1 behavior and
  v2 goals and list the call under Open decisions. No PR, merge to main, launchd job or global config without an
  explicit yes.
- **Real data only.** Check any new metric's definition on real rows _before_ building it. Every new number shown as a
  finding goes to GOLDEN-NUMBERS after a raw-EDGAR check: `node scripts/verify-edgar.js <cik> <pattern> <accession>…`
  (fails closed when nothing matches; needs `SEC_USER_AGENT` from `.env`). Last golden: **F54**.
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

| Metric                         | Budget               | Latest                                                                                                                                                                                                |
| ------------------------------ | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Warehouse size                 | ≤1 GB per generation | **578.0 MB** (generation 32; two generations kept, ~1.8 GB on disk with a candidate)                                                                                                                  |
| Nightly refresh                | ≤5 min               | 0.8 min as a job (#22: copy, refresh, derived rebuild, validation, publish in 47 s)                                                                                                                   |
| API p95, all routes            | <200ms               | 25.2 / 27.0 ms over 3,805 requests after the warm-up (P8 W3, load 2.6); no route over 150 ms p95 or 300 ms max; event-loop max 267 / 296 ms. The warm-up: 8.4 s, one stall of 2,657 ms per generation |
| Backup / restore               | —                    | 2.9 s / 2.6 s for generation 31 (APFS clone, same disk; drill 2026-10-07, identical answers)                                                                                                          |
| Lighthouse perf / a11y         | ≥90                  | Market 96/98, Explore 97/98, company 98/98, firm 95/98 (W5)                                                                                                                                           |
| Accessibility (axe, WCAG 2.1)  | 0 serious            | 0 findings of any impact, 10 views × light/dark (e2e 2026-10-08)                                                                                                                                      |
| Suite                          | green                | 2026-10-08: backend 638 (607 pass, 31 skipped, 0 fail); web 39/39; e2e 27/27; audits 0; CI green. LIVE 31/31 last run at W5 (2026-10-06)                                                              |
| Full backfill / first catch-up | —                    | 13.6 min / 26.9 min (P1, P2)                                                                                                                                                                          |

## Warehouse state (generation 32, 2026-10-08)

Schema at migration 0021. Generations 30–32 are review imports (the trap 58 split, the NEA exclusion, the relabel
correction); 31 and 32 are kept, and 32 is published and backed up (`~/Vantage-backups`). The files are read-only on
disk.

- 355,007 N-PORT filings: bulk 2019Q4–2026Q2 plus catch-up through filings of 2026-10-05 (117 NT NPORT-P pending a
  refresh).
- 1.165M private-candidate rows.
- 898 companies: 394 private, 504 public; 180 tracked.
- 529 firms, 18,852 funds, 71,842 unreviewed entities, 68,127 position-fact legs, 198,326 N-CEN adviser rows.
- `ingest_errors` empty. 2026Q3 bulk not posted yet.

## Decisions waiting on the user

1. **Run a refresh** (about 1 minute) to load the 117 NT NPORT-P reports? CLAUDE.md asks before a refresh.
2. **Install the launchd jobs:** `npm run nightly` daily at 06:15 and `npm run monthly` monthly (plists in
   ARCHITECTURE §Refresh lifecycle). The P8 checkpoint, 30 unattended nights, starts here.
3. **Choose the backup location** (`VANTAGE_BACKUP_DIR`): an external disk, iCloud Drive or another machine. Today
   backups go to `~/Vantage-backups` on the same disk, and the doctor warns.
4. **Alert URL (optional):** a dead-man's switch such as healthchecks.io (`VANTAGE_ALERT_URL`).
5. **Delete the leftover temp directories** (about 1,250 `vantage-*` folders, ~14.7 GiB, from test runs before the W1
   fix; the doctor counts them). The permission classifier blocked the sweep. Command:
   `find -E "$TMPDIR" -maxdepth 1 -type d -mmin +60 -regex '.*/vantage-(job|review|cache|ncen|zip|admin|curation|ro)-[A-Za-z0-9]{6}' -exec rm -rf {} +`

## Calls made, open to overrule

- **P8:**
  - jobs have a 3 h time limit and need room for a candidate plus 1 GiB;
  - 3 backups are kept, and a restore is a new generation;
  - the nightly and monthly runs continue after a failed step, and a doctor warning makes the night "warn";
  - below-zero values count as $0 and read "reported below $0 (counted as $0)" (trap 57);
  - the trap 58 rules: one company per fund vintage or CLO, unless the filer's instrument id and share count carry
    over (then one company); no fund named and no evidence means unreviewed; the 3 Partners Group "NEA 18" rows
    follow their title.
- **P6d:**
  - rollback is a new generation;
  - a live local job is never taken over;
  - staged curation with `--sync-curation`;
  - N-CEN drift fails the load;
  - empty-section filings are a warning (trap 55);
  - "reported at $0" is kept for a zero+exit position;
  - the proxy is trusted only on a loopback `HOST` or by `TRUST_PROXY`;
  - 5 retry attempts;
  - the export `Source` column.
- **P6c and W5 (archive):**
  - mark observation per fund (F06);
  - $0 class semantics (F05);
  - formula-safe CSV;
  - generation files plus a symlink;
  - shrink limits;
  - `partial` publication;
  - Last-Modified re-post detection;
  - firm rename by identical keys;
  - feed paging and basis labels;
  - v1 tab code hidden, not deleted;
  - light-theme contrast colors;
  - ECharts deferred to idle;
  - drill payload not trimmed.
- **W4 and earlier:**
  - the watchlist lives in the browser;
  - Compare keeps Batch's spread and mark age;
  - movers rank dollars;
  - two VIP funds are set `public`;
  - trap 52;
  - dated firm attribution not adopted;
  - trap 45;
  - the 1 GB budget.

## Deferred

Everything known and not built, in one place (2026-10-08). Each item says why it waits.

### P8 (operations), remaining

- **W4 research.** Check real filings first, build only if the data holds, and report negative findings.
  - _Last private mark vs first listed price:_ `companies.public_since` is empty for all 504 listed companies, and
    the keep rule drops post-listing rows, so a listing date and price source must come from filings. This also
    fixes the next item.
  - _Historical views use today's curation:_ a company that later listed drops out of earlier periods (labeled on
    screen and in exports).
  - _Fund type from N-CEN_ (ETF, open-end, closed-end, interval: which holders are retail-accessible). Only advisers
    are loaded from N-CEN today; check the field's coverage first (trap 21).
- **P8 checkpoint:** 30 unattended nightly runs with no gaps, and a green monthly run. This needs decision 2. The
  monthly run (reconcile plus LIVE) has never run on a schedule; `npm run reconcile` ran by hand on 2026-10-08. LIVE
  last passed at W5.
- **Off-host backup and an alert URL:** decisions 3 and 4. The restore drill was done on the same disk only.
- **Crash drills at the publication boundary (R09).** The SIGKILL drill kills a job mid-run, and the fault-injection
  sweeps fail every post-commit step. A process killed exactly at the link rename (or between the generation rename
  and the link swap) has not been drilled.
- **Watch report gaps (ROADMAP §8):** status changes cover listing evidence (likely IPOs) only. Delistings
  (listed → private) and post-IPO lock-up or PIPE signals are not detected yet; check how real filings label them
  first.
- **Intermittent single-test failures under heavy load**, none reproduced on rerun:
  - "scope: … post-filter" (2026-10-05);
  - "API goldens: Stripe A5" (2026-10-06);
  - prod-startup ECONNRESET at load 16–20;
  - analysis unified search;
  - edge-cases "cik/accession are validated".

  None were seen in the 2026-10-07/08 runs (load 2–6). Likely timing under load; not investigated.

- **Leftover temp directories:** decision 5.

### Data and curation (review items, each needs evidence before a change)

- **Watch report** (`reports/watch/2026-10-08.md`, local and git-ignored; `npm run watch` regenerates it), suggestions
  not yet reviewed:
  - 7 listing-evidence hits (Endeavor, Altice France, Talwandi Sabo);
  - 12 identity links (e.g. Alliant Holdings, Melange Capital Partners, Windstream / Uniti);
  - 23 split instrument ids: Windstream Parent and New Windstream share one id in 14 funds, and Ascent Resources and
    Ascent CNR share one in 3. These are corporate events, not filer relabels.
- **Vehicle families still grouped** under one company (not vintages, so trap 58 did not split them):
  - Five Arrows co-invests;
  - HOF Capital SPVs;
  - Parthenon Kairos;
  - Greenbriar co-invests;
  - EQT VIII co-investment;
  - Disruptive Technology Solutions series;
  - FTAI SPVs;
  - Beacon Re Committed / Uncommitted.
- **`issuerKeyOf` strips a trailing one-letter or two-digit numeral** as a class (the root of trap 58). Curation now
  works around it with regex aliases. Changing the parser would re-key every stored row, so it needs a
  warehouse-wide diff and a curation re-key.
- **`public/splits.js` knows only a fixed list of ratios (2–100):**
  - a 60:1 share exchange (Nscale 2026-05-31) reads as a class change;
  - a non-split exchange reads as "added" plus "mark moved". Mesquite Energy (×2.41, Fidelity 2026-04-30, F52) is
    Market's largest mark move down, −$801.4M, with a +$561.2M position flow. The bridge still reconciles.
- **Fidelity's opaque per-fund vehicles** (~$0.6B) stay unresolved: no filing names their targets.
- **Below-zero values:** activity legs carry the counted $0; only the holders list and the Filings tab show the
  filed negative value (trap 57).
- **Explore's firm picker** lists every firm holding private value (~170), including small advisers with terse
  N-CEN names.

### Performance and capacity (mostly P9)

- The warm-up (8.4 s) blocks the event loop for up to ~2.7 s once per new generation. The fix is to precompute in
  the job or use a worker thread.
- The server memo is bounded by entry count (200), not bytes; large responses are gzipped on the event loop (R17).
- The SEC request budget is per process; a shared budget across the web server and jobs is a P9 item (R11). So are
  the verified proxy/origin boundary, caps on queued work and a measured concurrency envelope.

### Product (remaining P6 items)

- An indirect-exposure view: named SPVs, per-fund vehicles and disclosed ranges in one section.
- Entity editing (rename, merge, track) through the admin job, like "make this a company".
- Split `public/app.js` (v1, 4.6k lines), and delete v1's retired tabs with their ~30 regression tests once the user
  agrees nothing more is needed from them.

### Phases not started

- **P7: MCP server** (ROADMAP §7; the services exist).

### Housekeeping

- The global git identity is "Test User <test@test.com>" (`git config --global`); this repo sets its own.

## Next session

> Resume Vantage v2 P9 on `v2-p9-deploy` ([plans/P9-deployment.md](plans/P9-deployment.md)). W1 (public-ready server)
> and W2 (client and polish) are built; on the user's sign-off build **W3**
> (`deploy/`: setup.sh, systemd units, Caddyfile, cloudflared config, deploy.sh with rolling restart and rollback; the
> GitHub Actions deploy workflow; Dependabot; DEPLOY.md, ADR 0006, README). The user's account steps are §5 of the
> plan. Read CLAUDE.md, this file and the plan first.
>
> This Mac has 8 GB of memory: run one heavy job at a time in the foreground, run tests with
> `--test-concurrency=2`, and ask before a refresh, the e2e suite or the LIVE suite. Gates:
>
> - `npm test`, `npm run lint`, `npm run format:check`;
> - `npm run test:web`, `npm run lint:web`;
> - `npm run build:web`, then `npm run test:e2e`.

## Log

- **2026-10-08 (P9 W2):** W1 signed off ("continue"). W2 built:
  - **Open tabs stay current:**
    - a new deploy shows "A new version of Vantage is available" with Reload (the build from `/api/config`,
      checked every 5 min and on focus);
    - a new data version shows "Data updated: filings through …" for 8 s;
    - a page whose code chunk is gone reloads once, but not without session storage, so it can never loop;
    - Vite's `vite:preloadError` is handled the same way.
  - **`/about`:** sources, how the numbers are read (staggered calendars, the 123-day as-of rule, private by company
    status, marks, change words), how it is checked, known limits, disclaimer and privacy. Counts come from the new
    `/api/stats`, and the page links GOLDEN-NUMBERS, DATA-QUALITY and ARCHITECTURE on GitHub (the repo is public).
  - **`/status`:** filings and marks through, the last refresh, the data version, details and readiness, plus an
    optional `VANTAGE_STATUS_URL` link to the uptime page.
  - **Link previews** (`lib/api/pages.js`): the server writes each page's title, description, canonical URL and
    Open Graph and Twitter tags.
    - A company's description uses its stored stats: Anthropic reads "123 funds reported $18.16B as of Aug 31,
      2026", the same as company_stats and STATUS.
    - The image is `public/og.png` (1200×630, no numbers).
    - Unknown pages, companies, funds and firms answer 404 with `noindex`, and unreviewed `/name/` pages are
      `noindex`.
    - `robots.txt` and `sitemap.xml` (static pages, private companies, firms; 520 URLs).
  - **Optional Cloudflare Web Analytics** (`VANTAGE_ANALYTICS_TOKEN`, validated) adds the beacon and its CSP hosts.
  - **Nav and footer:** About and Status in the nav. A footer (About · Status · Source code · "Not investment
    advice") is on every page; on a phone it is the only way to About and Status.
  - **Verified** in public mode on generation 32:
    - About and Status in dark and light, at 375 px with no horizontal scroll (the Status table now wraps);
    - the 404s, robots, sitemap and the og image;
    - smoke 17/17; console clean.
  - **Tests:** backend 659 (627 pass, 31 skipped, 0 fail; new `test/pages.test.js`; the edge-case title check now
    accepts page titles); web 45/45 (new `notices.test.ts`); e2e adds heads and 404s, About and Status, the reload
    offer, and axe on `/about`, `/status` and a 404 page. CI runs e2e on the push (not run on this Mac).

- **2026-10-08 (P9 W1):** the user approved the P9 plan (readiness assessment, Oracle + Cloudflare, concurrency,
  seamless refresh and updates). W1 built on `v2-p9-deploy`:
  - **Public mode** (`VANTAGE_PUBLIC=1`): v1's ten live per-filing routes answer 410 without an SEC request, and
    `/legacy` and `/index.html` answer 410. `/api/config` gains `public` and `build`, and the nav hides "Private
    Credit (v1)". The workspace never called these routes (checked by grep).
  - **Health:** `/healthz` (build, uptime, RSS, event-loop p99/max over the last minute) and `/readyz` (200 once
    warmed; `?fresh=1` also needs a refresh within 48 h and a last job that did not fail). Both sit outside the rate
    limits and are `no-store`.
  - **Seamless data:** a new generation is opened beside the old one and warmed, then swapped in one step. The old
    one answers meanwhile. `VANTAGE_WARM_DELAY_MS` staggers a second instance, and the server checks for a new
    generation every 15 s, so an idle instance switches too. A failed open keeps the old generation and retries. Found
    while testing: an open that threw at once left the switch marked as running forever (fixed, with a regression
    test).
  - **CDN:** `VANTAGE_CDN_MAX_AGE` gives warehouse answers `public, max-age=0, must-revalidate, s-maxage=N`.
    Errors are `no-store` and drop the generation ETag. `APP_BUILD` is one ETag build for every instance.
  - **Memo** bounded by bytes (`VANTAGE_MEMO_MAX_MB`, 256), with the whole-warehouse tables pinned (R17).
  - **Off-site backup** (`VANTAGE_OFFSITE_CMD`, e.g. rclone to R2) is a nightly step; a failure is "warn". The doctor
    counts a recent off-site copy as off-host.
  - **`scripts/smoke.js`:** health, headers, goldens A1/A2/A4/A5/A6 (by company), admin 403 and public-mode 410s. It
    is a nightly step when `VANTAGE_PUBLIC_URL` is set.
  - **`scripts/loadtest.js`:** N visitors over the workspace's real page mix, reading the server's RSS and event-loop
    delay.
  - **Verified** on generation 32, in public mode on this Mac:
    - smoke: 17/17, every golden equal to GOLDEN-NUMBERS;
    - load test, 10 users for 20 s at load 2.9, warmed: 345 requests, **0 errors**, p50 12 ms, p95 137 ms,
      p99 201 ms, RSS 314 MB, event-loop max 359 ms;
    - browser: no v1 link, console clean;
    - headers: CSP, `s-maxage=300` with ETag `W/"r32-local-p9"`, freshness `no-store`.
  - **Tests:** backend 653 (621 pass, 31 skipped, 0 fail; 22 new across public-mode, deploy-readiness and backup
    off-site); web 39/39; lint, format, lint:web and build clean. e2e not run (not asked).

- **2026-10-08:** the user signed off P8 W3 and asked for the PR and merge: `v2-p8-operations` merged to `main`.

- **2026-10-08 (close-out):** the user stopped P8 ("Stop. Status report."). W3 is built and not signed off;
  W4 and every open item moved to Deferred. Verified on bbc513f:
  - backend 607/0/31 skipped; web 39/39; e2e 27/27; lint, format and audits clean; CI green on the branch;
  - every route answered 200 on generation 32;
  - Anthropic $18.16B in 123 funds; Market shows 365 private companies;
  - the retired id 880 redirects to Formentera Partners Fund II;
  - the console was clean.

- **2026-10-08 (P8 W3):** W2 signed off. W3 built.
  - **Real-data checks first (R12):**
    - every quarter's EDGAR index against all 355,007 stored filings: **0 deleted**, 0 missing as NPORT-P;
    - a 200-filing re-fetch, then 100 more by `npm run reconcile`: **0 changed** under the same accession;
    - 580 stored filings are typed "NT NPORT-P" on EDGAR but are complete N-PORTs, and the catch-up skipped such
      filings: **117 missing** since 2026-07-01 (trap 59, fixed in `delta.js`).
  - **New:** `npm run reconcile` and `npm run monthly` (reconcile plus `test:live`, with alerts; doctor reports
    them); `npm run watch` (four kinds of review suggestions, a nightly step); `runSteps`; and warm-on-switch, which
    also warms the 12 largest firms' change pages. The bench warms up first, and `--cold` skips it.
  - **Trap 58 correction:** the watch report's split-identity check found BlackRock relabels (DF Residential I to
    III; Formentera "I" is Fund II) and iCapital's KKR III rows filed under IV. The two were merged back (ids 880
    and 883 retired with redirects; generation 32, 43 rows moved, diff checked).
  - **Bench after the warm-up** (load 2.6): every route within budget, and the loop max during passes fell from
    1.4 s to 0.3 s.
  - **Tests:** backend 607/0/31 skipped (reconcile, watch, warm-on-switch, NT index line). No temp directories
    are left.

- **2026-10-07 (P8 W2):** W1 signed off ("sign off, continue to W2"). W2 built:
  - `npm run backup`: a verified copy (SHA-256 against the source, `quick_check`, `.sha256` beside it, 3 kept),
    and `--restore <file>`, which publishes the backup as a new generation (`job.restoreBackup`; rollback now
    shares its `republish`);
  - `npm run nightly`: refresh, backup and doctor; a failure gives a macOS notification and exit 1, and an
    optional `VANTAGE_ALERT_URL` dead-man's switch is pinged;
  - the doctor reports the backup (missing, old, behind, same disk) and the last nightly run;
  - bench reports RSS and event-loop delay (R17).

  Live drill: generation 31 backed up in 2.9 s and restored onto an empty directory in 2.6 s. Its counts and the
  Anthropic and Stripe answers were identical.

  Tests: 7 new (restore drill, bad or missing checksum, restore over live, rotation, nightly alerts, doctor).
  Backend 603/0/31 skipped, with no temp directories left (the V03 test's stage now lands in a removed
  directory). The bench at load 4.1 shows three routes over 200 ms p95 and loop stalls up to 1.4 s, a W3 item.

- **2026-10-07 (P8 W1):** the user said "proceed with full fixes". Every pre-flight finding is fixed, each with
  a regression test. Detail is in the plan's "Outcome".
  - New: `test/helpers/tmp.js` (a full run leaves 0 temp directories, was ~280), the download idle limit, the
    `runJob` time limit and disk check, removal of stale candidates, lock and state identity (`holderGone`), the
    `interrupted` job state and pill, `npm run doctor`, trap 57 wording, and `countsRule` used once.
  - The SIGKILL crash drill passes; it found that a killed job's candidate was left on disk (fixed).
  - Trap 58, found while checking the negative rows on EDGAR: 20 companies merged several funds, so they were
    split through two review imports (generations 30 and 31). The diff found 2,955 rows that changed company,
    all within 24 companies; 98 are now unreviewed.
  - Gates: backend 596/0/31 skipped; lint, format, web 39/39, lint:web and build are green. e2e and LIVE were not
    run (not asked). The browser on generation 31 shows Icon Partners IV and V apart, Triton Fund 6's filings row
    "−$82.1K (below $0, counted as $0)", and the "Last job interrupted" pill (state file restored after).

- **2026-10-07:** PR #7 merged; branch `v2-p8-operations` made. P8 pre-flight analysis
  ([plans/P8-preflight-analysis.md](plans/P8-preflight-analysis.md)): backend 582/0/31 skipped, lint, format, web,
  audits and main CI all green. The analysis found:
  - four high operational defects: the test temp leak (26 GB), no idle timeout or job cap (a stalled download hangs
    the job while it holds the lock), a pid-only lock check (pid reuse after a reboot), and a "running" state that
    is never cleared;
  - below-zero marks labeled "$0" (18 rows);
  - the counting rule written twice;
  - a misleading curation label (company 743 is the ASF VIII Sidecar).

- **2026-10-06:** P6e W2 signed off; PR #7 to `main` opened. V11: the Finastra private-credit live test, run alone at a
  load of 3.0, **passed in 35.2 s** (deadline 420 s). Codex's 564 s timeout was at a load of about 23, with suites
  overlapping, so it was machine contention, not an app defect. Next phase: P8 (user's choice).

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
