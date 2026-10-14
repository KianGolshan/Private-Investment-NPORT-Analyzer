# Vantage v2 Status

**Phase:** **P10, launch review remediation.** Vantage is live at **https://vantage-kian.duckdns.org** (Oracle
Cloud Always Free VM on Pay As You Go, DuckDNS, HTTPS from Caddy, nightly SEC refresh, auto-deploy of every green
commit on `main`; [DEPLOY.md](DEPLOY.md)). The review of 2026-10-13 graded it B and listed 20 findings (F-01..F-20).
W0 is done on the server; W1 is built on **`v2-review-fixes`** and waits for the user's sign-off before merge (a
merge deploys). Server warehouse: **generation 34** (2026Q3 bulk loaded, filings through 2026-10-13).

## Phase tracker

- [x] P0–P5b: live fixes, warehouse, refresh, as-of, entities, identity, services, company and fund pages
      (signed off 2026-09-28..30; ROADMAP "Done")
- [x] P6 core, P6b (workspace), P6c, P6d, P6e (signed off 2026-10-01..06)
- [ ] P7: MCP server (not started)
- [~] P8: operations. W1–W3 signed off. W4 research and the checkpoint (30 unattended nights, a green monthly run)
  are deferred.
- [x] P9: public deployment, live 2026-10-14 ([plan](plans/P9-deployment.md), [DEPLOY.md](DEPLOY.md)).
- [~] P10: launch review remediation (ROADMAP §10). W0 done; **W1 built, awaiting sign-off**; W2 after the merge.

## What the app answers now (all from the warehouse, every row with mark date and accession)

The analyst workspace is served at `/`; the route map is in the [README](../README.md).

| View                | Where                             | What                                                                                                                               |
| ------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Search              | ⌘K anywhere                       | one ranked search over companies, unreviewed names, firms, funds and classes                                                       |
| Market              | `/` (Top, Movers, Newly reported) | operating companies by default (`?show=all`: fund interests, CLOs, insurance vehicles too); as of any date; movers; first reported |
| Company             | `/company/<id>`                   | overview + bridge, holders, positions grid, changes, marks & classes (spreads, leadership), filings; header says its category      |
| Position history    | `/company/<id>?pos=<fund>`        | one fund's legs at every filing, one mark line per class                                                                           |
| Fund                | `/fund/<key>`                     | private book (X-Ray), timeline, marks vs others, compare, mark-implied returns (labeled proxies)                                   |
| Firm                | `/firm/<id>`, `/firms`            | a manager's book, timeline, fund × company matrix, marks vs others, paged changes                                                  |
| Explore             | `/explore`                        | firm/fund/company/class × month/quarter/year, every metric; any cell drills to the legs behind it                                  |
| Activity            | `/activity`                       | changes in newly filed reports, firm and fund filters, paged; KPIs over every match                                                |
| Compare             | `/compare`                        | 2–5 companies, firms, funds or classes side by side (with example links when empty)                                                |
| Tracked & Watchlist | `/tracked`                        | the tracked list and the viewer's watchlist                                                                                        |
| About, Status       | `/about`, `/status`               | method, sources, limits; freshness and the last nightly (golden smoke check) and monthly (EDGAR reconciliation) results            |
| Exports             | every table                       | CSV/XLSX with mark date, accession, source, category and how history is read                                                       |

v1 (the per-filing live routes, Batch, Private Credit) is out of the live project since W1, kept runnable at the git
tag **`v1-archive`** (and branch `archive/v1`).

## Operations: what runs and how to check it

| Command             | What it does                                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `npm run doctor`    | read-only health: freshness, last job, lock, disk room, backup, nightly/monthly, leftovers; exit 1 = act         |
| `npm run refresh`   | one warehouse job: new bulk quarters, the EDGAR catch-up (NT NPORT-P included), N-CEN, derived rebuild           |
| `npm run nightly`   | refresh (own 3 GB heap), backup, off-site copy, watch report, doctor, smoke; healthchecks.io ping, exit 1 = fail |
| `npm run monthly`   | `npm run reconcile` (EDGAR indexes vs stored filings, re-fetch sample) plus the LIVE regression, with alerts     |
| `npm run backup`    | verified copy of the published generation (`-- --list`, `-- --restore FILE`), 3 kept                             |
| `npm run watch`     | review suggestions against the previous generation (`reports/watch/`), never applied                             |
| `npm run warehouse` | generations and the last job; `-- --rollback`, `-- --sync-curation`                                              |
| `npm run bench`     | p50/p95 per route, RSS and event-loop delay, after the warm-up (`--cold` without)                                |

On the server: `sudo vantage-run npm run doctor`; timers `vantage-nightly` (06:15 New York), `vantage-monthly` (3rd),
`vantage-autodeploy` (5 min), `vantage-duckdns`. Units come from `setup.sh`, not from deploys; the live server also
has `/etc/systemd/system/vantage-{nightly,monthly}.service.d/memory.conf` (5 GB cap, 3 GB heap; 2026-10-14).

## Where things stand (2026-10-14)

- **Server:** the first nightly ran out of memory (Node sized its heap at 1.5 GB from `MemoryMax=3G`) and was
  reported as "killed after the time limit". With a 3 GB heap and a 5 GB cap it ran in 4.4 min: 2026q3 bulk (14,066
  filings), 35 EDGAR filings, N-CEN 2026q3, generation 34 published, backed up (591.3 MB), smoke 17/17. SSH is
  key-only without root; rpcbind is off. healthchecks.io is set; no off-site copy yet (W2).
- **Branch `v2-review-fixes`** (two commits plus docs): everything in ROADMAP §10 W1. Gates: backend 431 (427 pass,
  4 skipped, 0 fail), web 47/47, lint, lint:web, format clean. e2e runs in CI on the PR (the local Playwright needs a
  browser download after the Dependabot bump). A local crawl of 32 pages × light/dark × desktop/375 px on the new
  build: 0 axe violations, 0 console errors on real pages, no horizontal overflow (Activity fixed after the crawl).
- **Curation in W1** (warehouse-wide diff against the previous local generation: only these changed):
  - categories: 197 operating companies, 159 fund interests, 23 CLOs, 13 insurance vehicles (traps 60–61);
  - six CLO families renamed, ids kept (771 Octagon CLOs (55, 57, 58, 60, 75), 780 OCP, 769 Ares, 775 Elmwood, 776
    Oaktree, 763 Carlyle);
  - Bending Spoons (54) and Malco Energy (161) marked public on Level 1 listing evidence (F55, F56): 115 legs leave
    the private views;
  - 25 firm labels became the advisers' filed names; "Boston" split, Boston Partners is firm 531 (trap 62).

## Handoff: how to work on this project

- **Working with the user.** The user signs off each wave ("sign off", or "continue" = sign-off and build the next).
  Start each phase on a feature branch off `main`. Build the whole wave, verify it in the browser, update docs,
  commit and push the branch, then stop for sign-off. Recommend, don't survey; decide delegated questions by v1
  behavior and v2 goals and list the call under "Calls made". A merge to `main` deploys to the live site: never
  without an explicit yes.
- **Real data only.** Check any new metric's definition on real rows _before_ building it. Every new number shown as a
  finding goes to GOLDEN-NUMBERS after a raw-EDGAR check: `node scripts/verify-edgar.js <cik> <pattern> <accession>…`
  (fails closed when nothing matches; needs `SEC_USER_AGENT` from `.env`). Last golden: **F57**.
- **One definition, held equal by tests.** New answers must equal `exposureAsOf` / `companyActivity` / `firmBook`
  where they overlap (`test/analysis.test.js` pattern). Where shared code could be wrong, add an independent check
  to the oracle (`test/fixtures/oracle/build-oracle.js`, hand-picked rows, plain arithmetic).
- **Writes are jobs.** A new writer goes through `runJob`; never open `warehouse.db` read-write from a script. A
  rule that changes stored facts gets a warehouse-wide before/after diff (LESSONS 36).
- **Words as filed:** first reported, added, reduced, no longer reported, reported at $0, reported above $0 again,
  mark moved. Never sale, bought, led. Compare marks only at the same mark date.
- **Labels are claims (LESSONS 41).** Before showing a group's name (a company, a class, a firm, a category), read
  the filer keys and titles behind it.
- **Frontend patterns:**
  - Pages read the scope from the URL and send it to the server; never filter on the client.
  - Every chart has a table twin and an export (`basis={BASIS}` on cross-company tables).
  - Tooltip HTML goes through `escapeHtml`; dialogs use `useDialog`.
  - Build with `npm run build:web` before `preview_start` (`vantage-public`, port 3005) or `npm run test:e2e`.
  - Check light, dark, 375 px and the console.
- **Performance:** add every new route to `scripts/bench.js` (p95 < 200 ms; record the load average); a heavy route
  also goes in `lib/api/heavy.js`.
- **Gotchas:**
  - Never run `cat > file` without input in a command; it waits on stdin and hangs.
  - Scratch scripts go in the session scratchpad.
  - Ids worth knowing:
    - companies: Anthropic 1, Databricks 2, Stripe 5, Canva 6, OpenAI 7, FHU 741;
    - firms: BlackRock 1, Fidelity 3, T. Rowe 8, Capital Group 9;
    - funds: Growth Fund of America `S000009228`, Contrafund `S000006037`.

## Measurements

| Metric                        | Budget               | Latest                                                                                                                                               |
| ----------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Warehouse size                | ≤1 GB per generation | **591.3 MB** (server generation 34, with 2026q3)                                                                                                     |
| Nightly run (server)          | ≤5 min refresh       | 4.4 min for the whole nightly with a new bulk quarter (2026-10-14); 1.9 GB peak memory on the failed run                                             |
| API p95, all routes           | <200ms               | 25.2 / 27.0 ms after the warm-up (P8 W3). Uncached heavy routes on the live server: 1.0–1.5 s (now guarded, `lib/api/heavy.js`). Load test: W2       |
| Backup / restore              | —                    | server backups 2026-10-14 (g33, g34); restore drill on the same disk only (2026-10-07); off-site: W2                                                 |
| Lighthouse (live, before W1)  | ≥90                  | desktop: Market 99, company 85, Explore 99, firm 96; mobile: Market **68** (layout shift 0.285), company 93, Explore 93, firm 95; a11y 98 everywhere |
| Accessibility (axe, WCAG 2.1) | 0 serious            | live before W1: 1 (dark Firm → Book contrast); local W1 build: **0** on 32 pages × light/dark                                                        |
| Data accuracy (review)        | exact                | 12/12 random live rows and 6/6 special cases (amendment, $0, exit, 3:1 split, as-of) equal raw EDGAR                                                 |
| Suite                         | green                | 2026-10-14 on `v2-review-fixes`: backend 431 (427 pass, 4 skipped); web 47/47; e2e in CI                                                             |

## Decisions waiting on the user

1. **Sign off W1** (branch `v2-review-fixes`) and say "merge": the merge deploys it.
2. **Off-site backups:** about 5 clicks in the Oracle console, then one command on the server
   ([DEPLOY.md, Off-site backups](DEPLOY.md#off-site-backups-oracle-object-storage)).
3. **A domain** (about $10 a year): declined for now (2026-10-13).
4. **Major dependency upgrades** (Express 5, dotenv 18, Preact 11, TypeScript 7, @types/node 26): one at a time, with
   the full gates.
5. **Leftover temp directories on this Mac** (~1,250 `vantage-*` folders, ~14.7 GiB, from before P8 W1):
   `find -E "$TMPDIR" -maxdepth 1 -type d -mmin +60 -regex '.*/vantage-(job|review|cache|ncen|zip|admin|curation|ro)-[A-Za-z0-9]{6}' -exec rm -rf {} +`

## Calls made, open to overrule

- **P10 (2026-10-13):**
  - company categories `company | fund | clo | insurance`, blank = company; the API default is every category, the
    Market pages ask for `company`;
  - holdcos of one operating business stay companies (Hockey Parent = Hub International, Gallop = Ascot Group);
    "Private fund" in `assetConditional` makes a fund interest even when it names one business (Shamrock ND, High
    Street HoldCo);
  - CLO families grouped and renamed instead of one company per vintage (trap 61);
  - Bending Spoons public on 3 filings' Level 1 evidence (only one July filing had posted); Talwandi Sabo stays
    private (one tiny listed row; the larger filer reports Level 3);
  - firm labels from the adviser's filed name, never a parent company;
  - v1 kept as a tag plus a branch, not a folder in `main`; "make this a company" stays as the CLI and admin API
    (its v1 button is gone);
  - heavy routes: 90 per visitor per minute and "busy" above 60% of the last 10 s;
  - `/readyz?report=1` shows only the status and time of the last nightly and monthly runs.
- **P8 / P9 / P6:** as recorded in [archive/STATUS-history.md](archive/STATUS-history.md) (3 h job limit, 3 backups,
  trap 57–58 rules, rollback as a new generation, staged curation, formula-safe CSV, the watchlist in the browser,
  movers rank dollars, the 1 GB budget, and the rest).

## Deferred

Everything known and not built (2026-10-14). Each item says why it waits.

### P10 W2 (after the merge)

- The load test at 50 and 100 users, on the server against `http://127.0.0.1:8080` (the user approved it for after
  the heavy-route guard is live).
- The off-site bucket (decision 2), then the restore drill from it (`sudo vantage-restore`) onto a fresh directory.
- 14 unattended nights with healthchecks.io (P9 criterion); the first scheduled monthly run on 2026-11-03.
- Lighthouse on the live site again after W1 (layout shift and mobile Market).

### Data and curation (each needs evidence before a change)

- **Class labels** such as "Indirect via ANTHROPIC SERIES H 1 PREFERRED STOCK": the label is computed at read time and
  feeds the class key, so tidying it re-keys share classes; it needs a warehouse-wide `position_facts` diff.
- **Watch report** items not reviewed: 12 identity links, 17 split instrument ids (Windstream Parent / New Windstream,
  Ascent Resources / Ascent CNR: corporate events), listing evidence for Endeavor (old CUSIP, taken private in 2025)
  and Altice France.
- **$29.2B in 3,421 unreviewed company-like names** (doctor): review the top by dollars; Market does not count them.
- **Nexus Apex Holdings** (company 798) is a Fundrise real-estate senior debt row filed under OTHER ("Senior Debt",
  PA); $0 now; check trap 45's wording rule for it.
- Vehicle families still grouped (Five Arrows, HOF Capital SPVs, Parthenon Kairos, Greenbriar, EQT VIII, Disruptive
  Technology Solutions, FTAI SPVs, Beacon Re): now labeled fund or insurance, so low priority.
- `issuerKeyOf` strips a trailing numeral (trap 58's root); a parser change re-keys every stored row.
- `lib/analytics/splits.js` knows only fixed ratios (2–100): Nscale 60:1 and Mesquite ×2.41 read as position plus mark.
- Fidelity's opaque per-fund vehicles (~$0.6B) stay unresolved.

### P8 (operations), remaining

- W4 research: last private mark vs first listed price (`public_since` is empty), dated private/public status (history
  uses today's list in both directions, now stated on /about), fund type from N-CEN.
- Checkpoint: 30 unattended nights and a green monthly run.
- Crash drills at the publication boundary (a kill exactly at the link rename).
- Watch report: delistings and post-IPO signals not detected.
- Intermittent single-test failures under heavy load (none seen at load 2–6).

### Performance and capacity

- The warm-up blocks one process's event loop for up to ~2.7 s per new generation; a worker thread would remove it
  and the heavy-route stalls.
- Large responses are gzipped on the event loop (R17).

### Product

- An indirect-exposure view (named SPVs, per-fund vehicles, disclosed ranges in one section).
- Entity editing (rename, merge, track, category) through the admin job.
- A "Make this a company" button in the workspace (v1 had one; the CLI and admin API remain).

### Phases not started

- **P7: MCP server** (ROADMAP §7; the services exist).

### Housekeeping

- The global git identity is "Test User <test@test.com>" (`git config --global`); this repo sets its own.
- The local Playwright needs `npx playwright install chromium` after the 1.64 bump (a download; ask first).

## Next session

> Vantage v2 is live at https://vantage-kian.duckdns.org. P10 (launch review remediation): W1 is on branch
> `v2-review-fixes`, waiting for the user's sign-off and "merge" (a merge deploys). Start with CLAUDE.md, this file,
> docs/ROADMAP.md §10 and docs/DEPLOY.md. After the merge: watch the deploy (`journalctl -u vantage-autodeploy` on the
> server; the review import runs because `data/review` and migrations changed), run the smoke check, then W2: the load
> test (approved), the off-site bucket once the user has made it, Lighthouse on the live URL. Server:
> `ssh ubuntu@129.146.24.191`; `sudo vantage-run npm run doctor`.
>
> This Mac has 8 GB of memory: one heavy job at a time in the foreground, `--test-concurrency=2`, and ask before a
> refresh, the e2e suite or the LIVE suite. Gates: `npm test`, `npm run lint`, `npm run format:check`,
> `npm run test:web`, `npm run lint:web`, `npm run build:web` then `npm run test:e2e`; for the live site
> `node scripts/smoke.js https://vantage-kian.duckdns.org`.

## Log

- **2026-10-14 (P10 W1, built):** the user decided the review's questions (Pay As You Go done; off-site "if easy";
  categories; no domain now; v1 kept outside the live project; "fix everything, go").
  - **Server (W0):** the first nightly failed (out of memory, mislabeled); a systemd drop-in gave it 5 GB and a
    3 GB heap and it published generation 34. SSH hardened, rpcbind off. Dependabot #17–#20 merged.
  - **v1 removed** from `main` (tag `v1-archive`, branch `archive/v1`): the page, the live routes, the request
    cache, the 10-Q parser, peer analytics and ~250 v1 tests; `splits.js` and `fund-groups.js` moved to `lib/`.
    `server.js` 1,350 → ~280 lines, `parsers.js` 1,654 → 1,129.
  - **F-05:** `lib/api/heavy.js` (90/min per visitor on heavy routes, 503 "busy" above 60% of the last 10 s);
    Permissions-Policy and COOP headers.
  - **F-03/F-04/F-13/F-19 curation** (see "Where things stand"); migration 0022; `/api/stats` by category.
  - **F-01 follow-up:** `runRefresh` passes `--max-old-space-size` (3 GB) and names a crash ("crashed (SIGABRT,
    usually out of memory)"); units at 5 GB.
  - **F-06:** `/readyz?report=1` and `/status` show the last nightly and monthly results; About wording fixed
    (reconciliation, history in both directions, categories).
  - **UI:** Market intro and example questions; the method note folded; category switch and badges; 375 px
    overflow fixed (grid minimum, Activity row); the page reserves a screen so the footer stays put; dark muted
    text 4.8:1+; card titles h2; the search button's name is its text; 404 page for unknown ids; charts open at the
    first holding; "1 fund"; proxy labels on returns; notes on the two counting methods; Compare examples.
  - **Off-site backups:** `setup.sh` accepts Oracle Object Storage or R2; DEPLOY.md has the clicks.
  - **Tests:** new `heavy`, `company-category`, `nightly-refresh`, readiness checks; backend 431 (427 pass, 4 skipped).
  - **Docs:** README rewritten for v2; CLAUDE.md, ARCHITECTURE, DEPLOY, DATA-QUALITY (traps 60–62), GOLDEN-NUMBERS
    (F55–F57, A2 by company), LESSONS 40–41, ROADMAP §10; older log entries moved to the archive.

- **2026-10-13 (review):** the user asked for a top-to-bottom review of the live site. Report published as a private
  artifact (grade B; 0 critical, 5 high: no refresh or backup yet, idle-shutdown risk, "private companies" mixing
  funds and CLOs, CLO identity, no cap on heavy queries). Verified: smoke 17/17, 12/12 random rows and 6/6 special
  cases equal raw EDGAR, axe 0 on 31 of 32 views, Lighthouse desktop 85–99 and mobile Market 68.

- **2026-10-14 (close-out):** PR #16 merged (Caddy log ownership; the DEPLOY.md upload command).
  - Dependabot: #12 (dev tools) and #11 (`actions/checkout` v7) merged; `actions/setup-node` v7 (#10) applied
    directly after it conflicted. #13 (Express 5, dotenv 18) and #14 (Preact 11, TypeScript 7; failing CI) were
    closed. Dependabot no longer proposes npm majors.
  - All feature branches deleted, locally and on GitHub; `main` is the only branch. STATUS, ROADMAP and README are
    current.

- **2026-10-14 (P9 live):** Vantage is live at **https://vantage-kian.duckdns.org**, on the direct edge:
  - an Oracle Cloud Always Free VM in US West (Phoenix), VM.Standard.A1.Flex, 2 OCPU, 12 GB, 100 GB, Ubuntu 24.04;
  - the user set it up by following DEPLOY.md part 1A;
  - the data was restored from backup g32, so the server is at generation 33.
  - **Smoke from the Mac:** 17/17. Every golden matches GOLDEN-NUMBERS, the headers are on, admin answers 403, and
    the live routes answer 410.
  - **Two setup bugs found on the real server (PR #16):**
    - `caddy validate` as root created `/var/log/caddy/vantage.log` as root, so Caddy could not start;
    - DEPLOY.md's move-and-chown expanded `*` as the login user, who cannot list the vantage-owned folder.

    Both were fixed by hand on the server, and PR #16 fixes the script and the guide.

  - **Open:**
    - the first refresh on the server (the data is from 2026-10-07);
    - merging PR #16, the first live test of auto-deploy;
    - optional healthchecks.io, R2 backups and an uptime monitor;
    - the load test against the live site (ask first).

- **2026-10-09 (P9 direct edge):** the user merged PR #9 to `main` and asked for a free start without a domain.
  Built on `v2-p9-duckdns`:
  - **`setup.sh` asks for the edge.**
    - `direct`: a DuckDNS name plus token, `Caddyfile.direct` (automatic HTTPS on 443, a loopback listener on 8080
      for smoke checks, compression, HSTS, no trusted forwarded header), iptables opened for 80 and 443, and the
      auto-deploy and DuckDNS timers. No GitHub deploy key.
    - `cloudflare`: as before. R2 is optional on both.
    - Fixed: the first release ran `git show` as root on a repository owned by vantage, which git refuses
      ("dubious ownership").
  - **`deploy/bin/vantage-autodeploy`** runs every 5 minutes. It deploys `origin/main` once GitHub's public API
    shows a successful push run of the Test workflow for that exact commit, through `vantage-deploy`. It skips a
    commit whose deploy failed.
  - **`deploy/bin/vantage-duckdns`** keeps the name pointing at the server.
  - **Drill step 6:** a commit with no green Test run (or only another workflow's) waits; a green one deploys; a
    second run does nothing; a broken one fails, keeps the previous release and is not retried.
  - **Docs:** DEPLOY.md part 1A (accounts, server with 22/80/443, setup, data, checks, staging through SSH, moving
    to a domain later); the domain path is now 1B; ADR 0006 amendment; README.
  - **The drill caught a real bug:** auto-deploy loads the service environment (`NODE_ENV=production`), so
    `npm ci` skipped devDependencies and the release build failed. `deploy.sh` now installs with `--include=dev`,
    with a test. CI is green on all 7 jobs (run 37877463260), and drill step 6 passes every check.
