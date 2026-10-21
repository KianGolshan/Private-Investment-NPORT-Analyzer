# Vantage v2 Status

**Phase:** **P13 W1–W4 built** (the 2026-10-18 outside review, ROADMAP §13; branch `v2-review3-w1`, PR #30 for the
user to merge; v2.3.0). **P12 is complete** (the 2026-10-15 copy and UX review: W1 #23, W2 #24, W3 #25, W4 #28 merged and live,
the close-out PR with the tab pattern and CHANGELOG v2.2.0; ROADMAP §12). P11 (the 2026-10-14 engineering and
security review) is complete and live. Vantage is live at **https://vantage-kian.duckdns.org** (Oracle Cloud Always
Free VM on Pay As You Go, DuckDNS, HTTPS from Caddy, nightly SEC refresh, auto-deploy of every green commit on
`main`; [DEPLOY.md](DEPLOY.md)). **`main` is protected:** changes go through a pull request with the CI checks green
(`archive/v1` keeps v1). Waiting on the user: the Oracle security-list rule for SSH (DEPLOY.md 1A.6). Not started or
deferred by choice: P7 (MCP server), P8's 30-night checkpoint. Next: the user's instructions.

## Phase tracker

- [x] P0–P5b: live fixes, warehouse, refresh, as-of, entities, identity, services, company and fund pages
      (signed off 2026-09-28..30; ROADMAP "Done")
- [x] P6 core, P6b (workspace), P6c, P6d, P6e (signed off 2026-10-01..06)
- [ ] P7: MCP server (not started)
- [~] P8: operations. W1–W3 signed off. W4 research and the checkpoint (30 unattended nights, a green monthly run)
  are deferred.
- [x] P9: public deployment, live 2026-10-14 ([plan](plans/P9-deployment.md), [DEPLOY.md](DEPLOY.md)).
- [x] P10: launch review remediation (ROADMAP §10). W0 and W1 live; W2 done except off-site backups (not now).
- [x] P12: copy and UX review (ROADMAP §12). W1–W4 and the close-out merged 2026-10-15..18.
- [~] P13: outside review (ROADMAP §13, [plan](plans/P13-outside-review.md)). W1–W4 built in PR #30; the user merges.
- [~] P14: sectors, industries and themes ([plan](plans/P14-sectors.md), ROADMAP §14). W0 done except the classifier
  pilot (needs an Anthropic API key); branch `v2-p14-w0`.
- [x] P11: engineering and security review remediation (ROADMAP §11). W1, W2, W3 live 2026-10-15; the user's
      Oracle SSH rule pending.

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
| Tracked & Watchlist | `/watchlist` (`/tracked` → 301)   | the tracked list and the viewer's watchlist                                                                                        |
| About, Status       | `/about`, `/status`               | method, sources, limits; freshness and the last nightly (golden smoke check) and monthly (EDGAR reconciliation) results            |
| Exports             | every table                       | CSV/XLSX with mark date, accession, source, category and how history is read                                                       |

v1 (the per-filing live routes, Batch, Private Credit) is out of the live project since W1, kept runnable at the git
tag **`v1-archive`** (and branch `archive/v1`).

## Operations: what runs and how to check it

| Command             | What it does                                                                                                                                 |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run doctor`    | read-only health: freshness, last job, lock, disk room, backup, nightly/monthly, leftovers; exit 1 = act                                     |
| `npm run refresh`   | one warehouse job: new bulk quarters, the EDGAR catch-up (NT NPORT-P included), N-CEN, derived rebuild                                       |
| `npm run nightly`   | refresh (own 3 GB heap), backup, watch report, doctor, smoke (+ off-site copy if configured; none live); healthchecks.io ping, exit 1 = fail |
| `npm run monthly`   | `npm run reconcile` (EDGAR indexes vs stored filings, re-fetch sample) plus the LIVE regression, with alerts                                 |
| `npm run backup`    | verified copy of the published generation (`-- --list`, `-- --restore FILE`), 3 kept                                                         |
| `npm run watch`     | review suggestions against the previous generation (`reports/watch/`), never applied                                                         |
| `npm run warehouse` | generations and the last job; `-- --rollback`, `-- --sync-curation`                                                                          |
| `npm run bench`     | p50/p95 per route, RSS and event-loop delay, after the warm-up (`--cold` without)                                                            |

On the server: `sudo vantage-run npm run doctor`; timers `vantage-nightly` (06:15 New York), `vantage-monthly` (3rd),
`vantage-autodeploy` (5 min), `vantage-duckdns`. Units come from `setup.sh`, not from deploys; the live server also
has `/etc/systemd/system/vantage-{nightly,monthly}.service.d/memory.conf` (5 GB cap, 3 GB heap; 2026-10-14).

## Where things stand (2026-10-20)

- **P14 sectors and themes, W0 (branch `v2-p14-w0`, stacked on `v2-review3-w1`/PR #30):** the user approved the plan
  ([plans/P14-sectors.md](plans/P14-sectors.md)): one Claude classifier pass for names, entity type and
  sector/industry/themes; the whole unreviewed queue brought to a final state; a sector bridge and a matched-pair mark
  index. Results:
  - draft taxonomy (9 sectors, 39 industries, 8 themes);
  - draft labels for all 197 reviewed operating companies (high 95.5% of value, medium 2.6%, unclear 1.9%);
  - six category errors found in the reviewed list;
  - Form D rejected as an industry source (34% of value, coarse groups, name collisions);
  - biotech has too few repeat marks for Q3 2026 (4 companies), so the index gets a minimum sample.
- **Open:** the classifier pilot (needs `ANTHROPIC_API_KEY`); a person's check of the medium labels plus 20 random high
  labels before W1.
- **Next prompt:** "P14: run the W0 classifier pilot (key is set), then build W1."

## Where things stand (2026-10-19)

- **Outside review triage (2026-10-18, P13):** the reviewer read the public repository only. Checked on real data:
  21/21 random live positions (generation 40) equal raw EDGAR to the cent, and Wasabi's value ($54,955,503.33) and
  ARK Invest's book ($678,529,720.46) rebuilt from raw rows equal the live answers. Real: X-Ray fail-open, mixed
  share-class marks (Skyhawk "Common" median $31.21 vs $53.14 filed), "as of" counts later-filed reports
  ($53.8B of $62.2B at 2026-06-30) without saying so, the Firms footer ($8.4M double count), wording. Missed by the
  review: Firms and Explore count fund interests, CLOs and insurance ($10.58B live) where Market does not.
- **W1 (branch `v2-review3-w1`):**
  - Fund X-Ray: a row with no issuer name (trap 64, F60) is "not classified", never private. The 100 canonical
    filings with one drop by exactly that row ($35,161,231.72 in all); Market top, Firms and the top 5 firm books are
    identical at 2024-06-30, 2025-12-31 and 2026-08-31 (old code vs new on generation 34);
  - every job fails if a row with a name has neither a company nor an entity, and warns when unnamed rows grow;
  - Firms: one line from the same answer, "$X held by N funds across all firms" (each fund once, `uniqueValue`);
    the footer counts firms only;
  - "Who first reported each new mark (by mark date)", "First reported by", "Reported first"; About's as-of rule
    says "report" and that later-filed reports count; `isLevel3Holding` / `isLevel3EquityHolding` (renamed);
  - Gates: backend 465 (461 pass, 4 skipped); web 18 files, 65 tests; lint, lint:web, format clean; build;
    browser: Firms, Fund X-Ray (L&G 2024-10-31), Stripe Marks in light and dark at desktop and 375 px, no overflow,
    no console errors. e2e runs in CI on the PR.
- **W2–W4 (same branch, the user said "finish everything" on 2026-10-19; calls in ROADMAP §13):**
  - W2 marks: a fund with several marks under one class label is left out of median, low, high, spread, leadership
    and marks-vs-others (`classes.markStats` `mixedFunds`, trap 65, F61); never the low within its filing; the
    Marks table shows "Left out". Generation 34 at 2026-08-31: 44 of 1,150 observations have such a fund, 41 change,
    26 keep no comparable fund; no other observation changes (old code vs new). Skyhawk Common 2026-05-31: no median
    (was $31.21, spread 50%; "+531,096,715%" within its filing);
  - W3 dates: the glossary, Basis note, About, Market, Firms and Explore say a past date counts reports filed later;
    "Filed by <date>" (`?known=1`) on Market and Firms, the firm book takes it too. 2026-06-30 on generation 34:
    $62.23B → $47.27B (Market), Firms $47.26B (each fund once; $109,344.92 sits in funds with no firm on file);
    ADR 0004 amended;
  - W4 categories: Firms, firm pages (book, overview, timeline, changes) and Explore (pivot, drill, bridge) default
    to operating companies with the Market switch (`?show=all`). Firms on generation 34: $74.72B → $64.10B, equal to
    Market;
  - Gates: backend 475 (471 pass, 4 skipped); web 18 files, 67 tests; lint, lint:web, format clean; build;
    browser: Skyhawk Marks, Firms (Filed by), Market, firm 11 and firm 9, Explore in light and dark, desktop and
    375 px, no overflow, no console errors. e2e runs in CI on the PR.

## Where things stand (2026-10-15)

- **Copy and UX review (2026-10-15, private artifact https://claude.ai/artifact/BGQE1NEZR9dRVe9CYgVv8N):** product,
  copy and UX review of docs, workspace and live site. Plan: W1 truth and trust, W2 navigation and names, W3 words,
  definitions and exports (incl. one position-effect definition, bridge tiles that add up), W4 positioning, About
  with the author line (Kian Golshan, kiangolshan.com, LinkedIn `kian-golshan-058b32144`, confirmed), mobile polish.
- **W1 (branch `v2-w1-truth-and-trust`):**
  - freshness: new `newestPrivateMark` (`/api/freshness`, `/api/stats`; `market.newestPrivateMark`) and
    `newestMark` on `/api/market/top`. The header reads "Filings to … · newest mark …", Market "Data as of … newest
    mark …", Status "Newest mark". The old "marks to" used the newest report date (live Sep 30) while no private
    mark is newer than Jul 31 (golden F59);
  - Market rank within the list shown (was over every category: 177 of 192 live rows off);
  - `moneyC` and the server's page-text money pick the unit after rounding ("$1000.0K" → "$1.0M");
  - tab titles per page (`web/src/lib/title.ts`, held equal to `lib/api/pages.js`); `PageBoundary` fallback;
  - copy: About (no dated reconciliation, hedge funds, report-date rule, no "bought, sold"), no "trap 52"/"F30"/
    "asset category OTHER"/"warehouse"/"Legacy" in visitor text, the Basis note shows "Data version #N" (exports
    keep the full provenance), the "v2" badge gone; README, CHANGELOG, STATUS no longer claim an off-site copy.
  - Gates: backend 454 (450 pass, 4 skipped, 0 fail); web 14 files, 53 tests; lint, lint:web, format clean;
    browser: Market, Company, Firms, Status, About, 404 in light and dark at 1280 px and 375 px, no overflow, no
    console errors besides the expected 404s. e2e (a new W1 test) runs in CI on the PR.
- **W2 (branch `v2-w2-navigation-and-names`):**
  - nav: Market, Firms, What's new, Explore, Compare, Watchlist under "Data"; About and Status on the phone nav too;
  - `/watchlist` (title "Watchlist and tracked companies"); `/tracked` answers 301 to it with its query (server and
    in-app); a first visit opens on the tracked companies, with what "tracked" means (hand-picked in the reviewed
    list, `track = Y` in `data/review/aliases.csv`);
  - tab labels: Fund Private book, Period compare, Mark-implied returns; Company Over time, Marks by class; ids
    unchanged, so old `?tab=` links open the same tab. "Who filed each new mark first", "First filed by";
    "Follow (RSS)"; Firms eyebrow "Firms"; Activity's page title and eyebrow "What's new";
  - the as-of control reads "As of: latest" until a date is asked for (`AsOfPicker`); header "Compact rows"
    (`aria-pressed`) and a theme button that says what a click does; Activity's scope is a segmented control
    (Tracked companies / All private companies) with the default shown;
  - Gates: backend 455 (451 pass, 4 skipped); web 15 files, 56 tests; lint, lint:web, format clean; browser:
    Market (as-of picked and cleared), Watchlist, `/tracked` redirect, Activity, Fund tabs in light and dark at 1280
    and 375 px, no overflow. A new W2 e2e test runs in CI.
- **W3 (branch `v2-w3-words-and-exports`):**
  - one definition of "from positions" (shares first reported, added, reduced, no longer reported, at the prior mark;
    `POSITION_KEYS`); funds that start or stop filing and rows with no share count are "other changes"
    (`OTHER_KEYS`, new `otherEffect` on the bridge). Overview tables, the bridge tiles and the period chart show the
    three parts, so start + parts = end (Anthropic's latest year: $505.4M + $8.40B + $9.31B − $48.8M = $18.16B).
    Every table says "From positions" / "From marks" (was eight names: Position Δ, flow, net flow, effect …);
  - glossary (`web/src/lib/glossary.ts`, for W4's About too) and `ui/Term.tsx` popovers on Market (mark, as of,
    N-PORT, mark dates), Company and Firms (Form N-CEN), Explore (as of), the bridge;
  - copy: Fair-value level (with its meaning), Held indirectly, Fund mark dates, value "at each fund's latest mark",
    SEC series ID, the firm lede, Explore's heading, Activity's pager, MOIC/IRR spelled out, Filings-tab code
    meanings; no Tracked badge in Market's table;
  - exports: the Source column on every export whose answer names a data version (was only with a Basis); XLSX adds
    an "About this export" sheet (title, page, time, data version, method, disclaimer). CSV stays one plain table so
    it opens in any tool (a call made: no preamble rows);
  - Status: a plain badge ("Data is older than expected: last refresh …"), job, digest and build under "Technical
    details";
  - accessibility and small surprises: skip link, filing links say where they go, named export buttons, pressed
    1Y/3Y/All, `role="status"` loading, "Copy link" says whether it worked, Compare offers back picks it cleared,
    Previous/Next paging on Firm. Tab panels with `aria-controls` were deferred here and done in the close-out.
  - Gates: backend 456 (452 pass, 4 skipped; new: the bridge's parts add up at three windows and equal the pivot);
    web 16 files, 61 tests; lint, lint:web, format clean; browser in light and dark at 1280 and 375 px (the term
    card fixed to the screen after it first widened the page at 375 px). A new W3 e2e test runs in CI.
- **W4 (branch `v2-w4-positioning-about`):**
  - positioning: "Private-company holdings and marks, straight from SEC fund filings" as Market's heading, the site
    title (`lib/api/pages.js`, `web/src/lib/title.ts`, `web/index.html`) and the README opening; a description of
    158 characters; `og:image:alt` matches the share image (kept: its text already says the same);
  - Market's intro names the fund types and three companies, and a live line from the same `/api/market/top` answer
    as the Top tab: "As of …: N private companies held by registered funds, $X at each fund's latest mark (newest mark
    …)";
  - About ("About Vantage", tab "About"): what it is, who it is for, six questions with live links, sources and
    method, the glossary (`lib/glossary.ts`, anchors `#term-…`), limits, freshness and checks (live dates), the
    author, disclaimer; nav "About";
  - the author line (`web/src/lib/author.ts`: kiangolshan.com, LinkedIn `kian-golshan-058b32144`, GitHub) in the
    footer, About and the README, links `target="_blank" rel="noopener noreferrer"` with names that read alone;
  - README: positioning, a dated live line (2026-10-18: 355,177 filings, 18,959 funds, 192 companies held as of
    2026-09-30, $63.24B, newest mark 2026-08-31), the six questions, `/watchlist`, an Author section;
    `package.json` description, homepage, repository, author; ARCHITECTURE lists `/api/stats`, `/api/config`,
    `/readyz?report=1`;
  - phones: chart axis labels never overlap (`hideOverlap`, fewer ticks, room for the legend), a freshness line at
    the top, no ⌘K hint on touch screens, a company's tiles in one sideways row (tabs at 348 px, were below the fold).
  - Gates: backend 457 (453 pass, 4 skipped; new: the home page head); web 16 files, 62 tests; lint, lint:web,
    format clean; browser: Market, About, footer, Company in light and dark at 1280 and 375 px, no overflow, no
    console errors. A new W4 e2e test runs in CI.
  - Note for local previews: `vantage-public` pins `APP_BUILD=local-p9`, so after a code change the browser can
    revalidate an API answer to the old body (same ETag) until the data version changes; live deploys set
    `APP_BUILD` to the commit, so visitors are not affected.

- **Review (2026-10-14, private artifact, grade B+):** 27/27 raw-EDGAR checks (18 random live positions, 8 with 2026Q3
  mark dates; 8 catch-up rows of 0001193125-26-413969; one exit), cross-checks equal, no injection or XSS path, 0
  advisories. 2 high (H1: `/api/market/tracked?date=` held a process 4.8 s per new date, off the heavy list; H2:
  `/API/...` skipped the heavy guard), 7 medium, 11 low, 6 docs; fix plan in ROADMAP §11.
- **P11 (the 2026-10-14 review), closed out 2026-10-15.** Every finding is fixed and live, except one click:
  - H1/H2/M1: per-visitor time budget on every API route, fair shedding, case-sensitive paths; the tracked dashboard
    at a new date 0.6–0.9 s live (was 4.8 s);
  - M2: `main` protected (pull request, the 7 CI checks, no force push, admins included); Dependabot security
    updates on;
  - M3: the web runs as `vantage-web` in a systemd sandbox (exposure 1.7 "OK", was 7.8), without the jobs' secrets;
  - M4: SSH `AllowUsers ubuntu`, no X11 or agent forwarding (setup.sh); **the Oracle security-list rule (port 22
    from the user's home address only) is the user's click** (DEPLOY.md 1A.6);
  - M5/M6/M7: data rolled back with a failed deploy; a busy lock is "try later"; warnings that need a person page,
    accepted local backups are ok;
  - L1–L11 and D1–D6: fixed (L4 changed 0 of 68,004 private-company legs; it only affects a listed company's stored
    rows); L11's old commits under test@test.com stay in history (this repo sets its own identity).
  - Server after setup: web as vantage-web, smoke 17/17, doctor all ok, backup of generation 36.

- **Server:** the first nightly ran out of memory (Node sized its heap at 1.5 GB from `MemoryMax=3G`) and was
  reported as "killed after the time limit". With a 3 GB heap and a 5 GB cap it ran in 4.4 min: 2026q3 bulk (14,066
  filings), 35 EDGAR filings, N-CEN 2026q3, generation 34 published, backed up (591.3 MB), smoke 17/17. SSH is
  key-only without root; rpcbind is off. healthchecks.io is set; no off-site copy (the user: not now).
- **W1, PR #21 (live 2026-10-15):** everything in ROADMAP §10 W1. Gates: backend 431 (427 pass,
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
  (fails closed when nothing matches; needs `SEC_USER_AGENT` from `.env`). Last golden: **F60**.
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

| Metric                        | Budget               | Latest                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Warehouse size                | ≤1 GB per generation | **591.3 MB** (server generation 34, with 2026q3)                                                                                                                                                                                                                                                                                                                            |
| Nightly run (server)          | ≤5 min refresh       | 4.4 min for the whole nightly with a new bulk quarter (2026-10-14); the scheduled 10:16 UTC run the same day succeeded on its own                                                                                                                                                                                                                                           |
| API p95, all routes           | <200ms               | Load test on the server (127.0.0.1:8080, one client address), 2026-10-15: **50 users** 3,691 requests, p95 48 ms, p99 124 ms, 0 errors; **100 users** 7,252 requests (121/s), p95 48 ms, p99 139 ms, 0 errors, RSS 318 MB, event-loop max 312 ms. The 429s (296; 2,601) are the per-visitor caps on one address; a 5.4 s stall in the first run was the post-deploy warm-up |
| Backup / restore              | —                    | server backups 2026-10-14 (g33, g34); restore drill on the same disk only (2026-10-07); off-site: W2                                                                                                                                                                                                                                                                        |
| Lighthouse (live)             | ≥90                  | after W1 (2026-10-15): Market mobile **98** (was 68; layout shift 0), company mobile 98, company desktop 87 (layout shift 0.268 from the chart card); accessibility **100**, best practices 100, SEO 100                                                                                                                                                                    |
| Accessibility (axe, WCAG 2.1) | 0 serious            | **0** on 32 pages × light/dark (W1 build: local crawl and CI e2e)                                                                                                                                                                                                                                                                                                           |
| Data accuracy (review)        | exact                | 2026-10-14: 27/27 (18 random live positions incl. 8 with 2026Q3 mark dates, 8 catch-up rows, 1 exit); 2026-10-13: 12/12 rows and 6/6 special cases (amendment, $0, exit, 3:1 split, as-of)                                                                                                                                                                                  |
| Suite                         | green                | 2026-10-19 on `v2-review3-w1`: backend 475 (471 pass, 4 skipped); web 67/67; e2e in CI on the PR                                                                                                                                                                                                                                                                            |

## Decisions waiting on the user

1. **A domain** (about $10 a year): declined for now (2026-10-13).
2. **Major dependency upgrades** (Express 5, dotenv 18, Preact 11, TypeScript 7, @types/node 26): one at a time, with
   the full gates.
3. **Leftover temp directories on this Mac** (~1,250 `vantage-*` folders, ~14.7 GiB, from before P8 W1):
   `find -E "$TMPDIR" -maxdepth 1 -type d -mmin +60 -regex '.*/vantage-(job|review|cache|ncen|zip|admin|curation|ro)-[A-Za-z0-9]{6}' -exec rm -rf {} +`

Off-site backups: **not now, and do not ask again** (the user, 2026-10-15). The code and the steps are ready
([DEPLOY.md](DEPLOY.md#off-site-backups-oracle-object-storage)); backups stay on the server and on this Mac.

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

### P10 W2 (remaining)

- Off-site backups and a restore drill from them: the user's call (see above).
- 14 unattended nights with healthchecks.io (P9 criterion); the first scheduled monthly run on 2026-11-03.
- The company page on desktop still shifts as its chart card loads (Lighthouse layout shift 0.268): reserve the
  chart's height before data arrives.
- A load test from many client addresses (the server-side run shares one address, so the caps answer 429).

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

> Vantage v2 is live at https://vantage-kian.duckdns.org. P13 (the 2026-10-18 outside review) W1–W4 are built on
> `v2-review3-w1` (PR #30, v2.3.0) and wait for the user's merge. A separate study measures whether new private
> companies can be admitted automatically (docs/plans/auto-admit-measurement.md, its own session). `main` is protected: work on a branch, open a pull request, merge when CI is green (the user
> merges, or says to). Start with CLAUDE.md, this file and docs/ROADMAP.md. Waiting on the user: the Oracle
> security-list rule for SSH (DEPLOY.md 1A.6); then their next instructions. Do not ask about off-site backups.
> Server: `ssh ubuntu@129.146.24.191`; `sudo vantage-run npm run doctor`; a server-side change ships with
> `cd ~/vantage-setup && git pull && sudo bash deploy/setup.sh` (keeps every answer; ASK_AGAIN to change one).
>
> This Mac has 8 GB of memory: one heavy job at a time in the foreground, `--test-concurrency=2`, and ask before a
> refresh, the e2e suite or the LIVE suite. Gates: `npm test`, `npm run lint`, `npm run format:check`,
> `npm run test:web`, `npm run lint:web`, `npm run build:web` then `npm run test:e2e`; for the live site
> `node scripts/smoke.js https://vantage-kian.duckdns.org`.

## Log

- **2026-10-19 (P13 W2–W4, built):** the user said to finish everything in this session; W2–W4 added to PR #30 with
  the plan's recommended answers as calls (ROADMAP §13). Not run: e2e locally (CI runs it), LIVE, bench.
- **2026-10-19 (P13 W1, built):** the user approved the triage plan and asked for W1 on `v2-review3-w1`. Built,
  tested and checked in the browser (see "Where things stand"); a PR for the user to merge. Not run: e2e locally
  (CI runs it), LIVE, bench.

- **2026-10-15 (units-restated fix, branch `v2-fix-unit-restatement`):** a product review found filers restating a
  holding in other units at the same value read as giant trades (live: Ferrellgas 2021 "added $153.27B", mark
  −$153.27B; Explore 2021 "added" $156.4B). `detectSplit` now restates the prior side by the exact ratio when shares
  change 10× or more at a value within 1% (trap 63, F58); the views say "units restated ×k". Warehouse-wide diff: 11 of
  68,004 legs changed, nothing else. The user asked for this fix only; the rest of the review is not adopted.

- **2026-10-15 (P11 closed out):** the user said "continue, finish out the entire review". W2 merged (`090cbd1`,
  deployed); the server's setup re-run first stalled on a prompt (a `git log` pager ate the answers; stopped with
  nothing changed), so setup.sh now keeps blank optional answers (`0ec92e3`, `ASK_AGAIN` re-asks) and the re-run
  succeeded: web as vantage-web, SSH AllowUsers ubuntu, reports and accepted backups set, instances restarted one at
  a time. W3 merged (`2ae79ee`, deployed; live checks: SpaceX `source: 'listed'`, the L1 redirect keeps the query,
  smoke 17/17). Backup of generation 36 taken; doctor all ok. `main` protected and Dependabot security updates on
  (GitHub API). Gates on W3: backend 449 (445 pass, 4 skipped), web 48/48, lint, lint:web, format, build; CI green on
  all 7 jobs for every merge. Not run: e2e locally (CI ran it), LIVE, bench, a load test.

- **2026-10-15 (P11 W1 live, W2 built):** the user said "merge push": `34dc409` fast-forwarded to `main` (CI green on
  the branch, all 7 jobs) and auto-deployed in 30 s; live checks in "Where things stand". W2 built on
  `v2-p11-wave2` (M3, M5, M6, M7, L7; L8 moved to W3). Gates: backend 443 (439 pass, 4 skipped), lint, format; CI
  green with the new drill steps 3b (data put back) and 6b (a held lock is "not now"). Not run: e2e locally, LIVE,
  bench, load test. Not yet on the server: setup.sh (waits for the merge and the user's yes).

- **2026-10-14 (P11 W1, built):** the user signed off the review and asked for W1 (H2, H1, M1, L10) with the clicks
  for M2 and M4. Built on `v2-p11-wave1`: `lib/api/heavy.js` (visitor time budget, fair shedding, any-case pattern),
  case-sensitive routing (`server.js`, both routers), the dashboard's per-generation inputs (`dashboard.js`,
  `marks.staleMarks` takes them; memo `dashboard:inputs` pinned), `/healthz` details on loopback, `setup.sh` SSH
  settings, DEPLOY.md 1A.6, LESSONS 42, ROADMAP §11. Gates: backend 441 (437 pass, 4 skipped), web 47/47, lint,
  lint:web, format, build. Browser on the local warehouse (public mode): Tracked, company, Explore and firm pages,
  every API call 200, no console errors; `/API/analysis/pivot` 404. Not run: e2e, LIVE, bench, load test (ask first).

- **2026-10-15 (P10 close-out):** the user merged PR #21 on GitHub (one e2e assertion matched the old Status wording;
  fixed before the merge). Auto-deploy shipped `eb1697e` 8 minutes after the merge, ran the review import
  (generation 36: 197 companies, 159 fund interests, 23 CLOs, 13 insurance vehicles; firm 531 Boston Partners) and
  restarted both instances. Smoke 17/17 on the live URL; load test at 50 and 100 users and Lighthouse after W1 in
  Measurements. The scheduled nightly of 2026-10-14 10:16 UTC ran on its own (generation 35). The user declined
  off-site backups for now. Branch `v2-review-fixes` deleted.

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
