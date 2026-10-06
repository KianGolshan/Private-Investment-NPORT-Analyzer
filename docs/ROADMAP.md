# Vantage v2 Roadmap

**Goal:** real, SEC-verified private-investment data, refreshed automatically, that can be analyzed through every
view: **security (share class) → issuer (company) → fund → manager (firm)**, at any date, with per-share marks,
new positions, adds, reductions, exits, mark moves and trends. Covers any private company in N-PORT filings plus a
curated tracked list (180). Evidence for each design choice is in [ARCHITECTURE.md](ARCHITECTURE.md),
[DATA-QUALITY.md](DATA-QUALITY.md) and [GOLDEN-NUMBERS.md](GOLDEN-NUMBERS.md).

## How phases work

- Each phase has an **entry gate**, **tasks**, **tests**, **success criteria** and a **checkpoint**. A failed
  success criterion blocks the next phase.
- Checkpoint: `npm test`, lint and format green; the phase's LIVE checks (`npm run test:live`) pass; STATUS updated;
  commits on a branch; user sign-off before the next phase.
- Offline tests use real-derived fixtures only; anything needing the network sits behind `LIVE_SEC=1`.
- Every new number is verified on raw EDGAR and recorded in GOLDEN-NUMBERS with its accession.

## Done (P0–P5b, signed off 2026-09-28..30)

Full phase text (tasks, tests, checkpoints) is in [archive/ROADMAP-P0-P5.md](archive/ROADMAP-P0-P5.md); results per
phase are in [archive/STATUS-history.md](archive/STATUS-history.md). Code comments that cite "ROADMAP §5a task 4",
"§Phase 4.5" or "STATUS 'Phase 3 decisions'" refer to those two archive files.

| Phase | Built                                                                                                                |
| ----- | -------------------------------------------------------------------------------------------------------------------- |
| P0    | Live-search fixes: de-duped hits, whole-word matching, newest-first windows                                          |
| P1    | SQLite warehouse, 27 bulk quarters 2019Q4–2026Q2 (13.6 min), keep rule (ADR 0003), parity with the app's parser      |
| P2    | Daily EDGAR catch-up and `npm run refresh` (bulk replacement, retries, `ingest_errors`)                              |
| P3    | Canonical filings and the as-of engine (ADR 0004); goldens A1–A6 reproduced                                          |
| P4    | Fund identity by series LEI, N-CEN advisers and firms (ADR 0007), companies, aliases, SPVs, tracked list             |
| P4.5  | Evidence-based identity graph, brands, unresolved-value review queue                                                 |
| P5a   | Services, stable company ids, search over every issuer, read-only API, the company page on the warehouse (ADR 0008)  |
| P5b   | `filing_totals`, capital-structure rows, fund page, Batch and Watchlist on services, exports, admin "make a company" |

## Phase 6: analysis views (core signed off 2026-10-01; remaining items below; branch `v2-phase6`)

**Entry gate:** P5b signed off (2026-09-30).

**Built (2026-10-01; STATUS "What the app answers now"):**

- Post-P5 review fixes: fund identity on the company page (trap 48), listed companies' stored rows on request (trap 49),
  strong-match search, unreviewed-key redirects, X-Ray private book by kind, locks and rollback, gzip.
- Data rules: loans filed as OTHER are debt (trap 45, decided), EC/EP title keys (trap 47).
- **Issuer:** Activity (`/api/companies/:id/activity`: first reported, added, reduced, no longer reported, reported
  at $0, mark moved; split-adjusted shares; per filing with both accessions), Trend (`/trend`: funds and value at every
  month end, entries and exits), holders as of any date with `knownAsOf` (P5a).
- **Security:** Share classes (`/classes?date=`: every fund's per-share mark per class, spreads at one mark date, gaps
  within a filing) and per-class mark history (`/marks`).
- **Fund:** private-company changes filing by filing (`/api/funds/:key/changes`), on top of X-Ray, compare and returns.
- **Manager:** Firms tab and `/firm/<id>`: firms by private value; a firm's book as of any date by company and fund;
  its marks per class (median, low, high per report date); its changes (`/api/firms…`).
- **Market:** top private companies as of any date, by country, and the what's-new feed of changes in filings made
  since a date (`/api/market/…`, `/api/feed`). CSV export on every view, with mark date, accession and source.
- Goldens on screen and through the API: F8/F9, the Capital Group Stripe path and its 8 of 12 months, F13, A1/A2
  through the trend, F30 (+5.76%), A3 (9 / $8.46B), F2 in the feed.

- **Also built:** conviction (% of fund) on holders; stale marks; the tracked dashboard (holders now vs a year ago,
  12-month split-adjusted mark change, spread, stale count); freshness banner; Atom feed per company; fund and firm
  names linked to their pages.

**Remaining (in this order):**

1. ~~**Mark leadership**~~ (done in P6b W2: Marks & classes, `/leadership`, F49).
2. **Indirect exposure view:** named SPVs, per-fund vehicles and `disclosed_exposure` ranges in one section.
3. ~~**One search box** for companies, funds and firms~~ (done in P6b W1: `/api/search?kinds=…`, ⌘K).
4. Entity editing (rename, merge, track) through the admin job, like "make this a company" (local only, ADR 0008).
5. Split `public/app.js` (4.6k lines, v1's tabs) into page modules as the UI moves to company / fund / firm pages.

**Not built (filings don't support it):** company valuations (no total share counts), reasons for exits, valuation
methods. Any new metric is checked on real filings first.

**Tests:** jsdom and API tests per view on the golden fixture; each view's numbers equal `exposureAsOf` where they
overlap (LESSONS 32).

**Success criteria:** every row and chart point cites its accession and mark date; every view reproduces its goldens;
p95 < 200 ms on every route (measured 2026-10-01 at load ~4: activity 28 ms, trend 11, classes 9, firm 11, firm
changes 138, top 118, feed 192).

---

## Phase 6b: analyst workspace (branch `v2-p6b-workspace`; W0–W3 signed off 2026-10-01, W4 signed off 2026-10-05, W5 next)

**Goal (user, 2026-10-01):** the best way to search, analyze and display the data.

1. One private company in depth: consolidated across funds, with price per share, value and shares at a date or
   over any range. Narrow it to a manager, fund or class. Show when each fund bought, added, reduced or exited, and
   split each value change into **position (quantity) vs mark (price)**.
2. Across funds and manager umbrellas: when each firm invested, and how its private book, marks and new positions
   changed.

The full plan is in [plans/P6b-analyst-workspace.md](plans/P6b-analyst-workspace.md).

- **Decided with the user:** Vite + Preact + TypeScript in `web/`; v1 under `/legacy` until each tab is replaced;
  power-analyst first, with shareable URLs.
- **This section absorbs:** P6 remaining items 3 (one search box), 5 (split `app.js`) and 1 (mark leadership,
  W2).

**Entry gate:** the P6 core is built (signed off with W0).

**Waves (each one ends at a checkpoint and the user's sign-off):**

| Wave                   | Scope                                                                                                                                                                                                                                                                                                                    | Exit check                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| **W0 Foundations**     | `web/` scaffold, tokens and themes, shell, router, scope ⇄ URL, API client, DataTable, Chart, export, ⌘K, Express serving and `/legacy`, CI                                                                                                                                                                              | **Signed off 2026-10-01** (with the Anthropic and Canva audit fixes)           |
| **W1 Data**            | `legsOf` refactor, `position_facts` (migration 0019, built by refresh, measured), `analysis.js` (bridge, pivot, cube, timeline), scope filters, unified search, attribution research, goldens; from the Anthropic audit: one class across EC/EP labels (trap 50 proposal), one "kind" (direct, named SPV, fund interest) | **Signed off 2026-10-01** (STATUS archive)                                     |
| **W2 Company**         | Workbench: overview, holders, positions grid, changes + bridge, marks & classes + mark leadership, filings, position drawer                                                                                                                                                                                              | **Signed off 2026-10-01** (STATUS archive)                                     |
| **W3 Firm & Fund**     | Overview, investment timeline, book matrix, marks vs median, changes, bridge; X-Ray ported to the fund page                                                                                                                                                                                                              | **Signed off 2026-10-01** (STATUS archive)                                     |
| **W4 Cross-cutting**   | Explore pivot, Market movers and newly reported, Activity, Tracked & Watchlist, Compare                                                                                                                                                                                                                                  | **Signed off 2026-10-05** (pivot = `exposureAsOf`; drill legs = cell; F51–F53) |
| **W5 Retire & polish** | Batch → Compare; only Private Credit stays in Legacy; a11y audit, perf, docs                                                                                                                                                                                                                                             | Lighthouse ≥ 90 for perf and a11y; LIVE suite green                            |

**Period rule (it goes into DATA-QUALITY with W1):**

- Levels are as of the period end (`exposureAsOf`).
- Changes are dated by each fund's own mark date and summed over the window, labeled "changes in filings with mark
  dates in …".
- Mark dates are never relabeled to a quarter end.

---

## Phase 6c: review remediation (before W5; plan: [plans/P6c-review-remediation.md](plans/P6c-review-remediation.md))

**Entry gate:** W4 signed off; the staff engineering review of 2026-10-05 (findings F01–F18) checked against the code.

| Wave                        | Scope                                                                                                                                                                                                                                         | Exit check                                                                 |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **R1 Correctness/security** | F05 partial $0 class, F06 fund-level mark unit, F07 disclosure `knownAsOf`, F01 tooltip escaping + v2 CSP, F02 browser freshness, F09 CSV formulas, F15 per-class drawer marks; palette error state, chart retry, `verify-edgar` fails closed | **Signed off 2026-10-05** (117 legs re-attributed; no golden changed)      |
| **R2 Publication**          | one writer (`runJob`), generation files + pointer, derived chain rebuilt per job, heartbeat lease, source validation and re-post detection (F03, F04, F12), durable firm ids (F08), curation revision stamp (F14)                             | **Built 2026-10-05**, awaiting sign-off (ADR 0009; live generations 22–24) |
| **R3 Assurance**            | browser suite (Playwright) in CI, paged activity with full breakdowns (F16), partial live results (F13), independent oracle (F17), temporal labels (F14)                                                                                      | browser suite green; activity totals = SQL over > 3,000 events             |

Then W5 (with the rest of F18). F10 and F11 move to P8 (readiness, binding, backups/restore, alerts) and P9 (capacity).

---

## Phase 7: MCP server

**Entry gate:** P5a checkpoint (open now; every service it needs exists).

**Tasks:** `mcp-server.js` (stdio, `@modelcontextprotocol/sdk`) over `lib/services`, opening the warehouse
with `openWarehouseReadOnly`. Tools take a company id or a name (resolved through search, returning the
candidates with their match reason when ambiguous) and always return ids (ADR 0008). Answers carry
`source`, `refreshId`, mark dates and accessions, and the same labels as the app ("indirect", "reported at
$0", "no longer reported", "unreviewed"). Listed companies and debt return a typed "not warehoused" error
rather than a live SEC call. Tools (the fund and firm tools arrive when P5b and P6 build their services):

- `find_company`
- `exposure_asof`
- `company_marks`
- `manager_exposure`
- `holder_changes`
- `top_private`
- `fund_private_book`
- `tracked_list`
- `position_changes` (company, fund or firm; built in P6 as `lib/analytics/activity.js`)
- `class_marks` (`lib/services/marks.js`), `firm_book` (`lib/services/firm.js`), `whats_new` (`market.feed`)

**Tests:** tool calls return golden numbers; compact JSON; errors are typed.

**Success criteria:** p95 **<200 ms**. Documented setup (`claude mcp add …`) in README.

---

## Phase 8: operations hardening

**Entry gate:** P6 checkpoint.

**Tasks**

- Nightly `warehouse.db` backup with rotation.
- Refresh failure alerting.
- A monthly `LIVE_SEC` regression run that re-verifies GOLDEN-NUMBERS.
- `npm run doctor`: reports freshness, row counts, unresolved aliases and orphan processes.
- **Nightly watch reports** after each refresh (suggestions only, never auto-applied):
  - unresolved private value, ranked (the P4.5 report);
  - rename / codename evidence: new same-instrument-id, same-share-count or same-mark links;
  - status changes: new post-IPO lock-up, PIPE or listing evidence (likely IPOs), and delistings;
  - new companies and vehicles crossing the candidate threshold;
  - company status changes (private ↔ listed) for review: a status change moves a company between the
    warehouse and the live path (ADR 0008), so it is never applied without review.
- **Research tasks (check real filings first; build nothing unless the data holds, and report negative
  findings):**
  - _Last private mark vs. first listed price_ for companies that went public. `companies.public_since` is
    empty for all 502 listed companies (2026-09-30), and the keep rule drops post-listing rows, so this needs
    a listing date and price source from filings.
  - _Fund type_ (ETF, open-end, closed-end, interval) from N-CEN, to show which holders are retail-accessible
    vehicles. Only advisers are loaded from N-CEN today; check the field's coverage in the data sets and on
    EDGAR (trap 21) before adopting.

**Success criteria:** 30 days of unattended nightly refreshes with no gaps; the monthly regression is green.

---

## Phase 9: public deployment

**Goal:** a public, always-current Vantage at a stable URL (e.g. `vantage.<your-domain>`), fit to share on
LinkedIn, a personal website and a resume. It refreshes itself nightly from the SEC with no manual steps.

**Entry gate:**

- P5a and P5b checkpoints (hard requirement): visitors must never trigger SEC requests.
  - Today every search calls EDGAR live under one shared `SEC_USER_AGENT` and SEC's ~10 req/s fair-access
    limit.
  - A traffic spike would get the server throttled or blocked, and the demo would look broken.
  - After P5, private companies and fund pages answer from the warehouse. What stays live by design (ADR
    0008): listed companies, debt, the keyword search (ADR 0005) and, if 5b did not store them, X-Ray's
    capital-structure tranches. Publicly these are **off** or behind their own low limit, labeled.
- P8 checkpoint: backups, refresh alerting and `npm run doctor` exist.
- P6 freshness banner exists.
- **Deployed curation path decided** (ADR 0008 left it open): the container never writes git-tracked
  files and the public site has no admin actions. Recommended at that time: curation stays local; the
  reviewed files ship with each deploy and the server's refresh re-imports them.
- **Company ids survive a rebuild** (P5a): the fallback "full ingest on the server" must reproduce every
  public URL.
- A private staging deploy may start once P5b is signed off. Public launch waits for P6 and P8.

**Decision to confirm with the user first (record as ADR 0006):** hosting provider.

- **Recommended: one always-on container or VM with a persistent volume.** Options: Fly.io, Railway,
  Render, or a small Hetzner/DigitalOcean VPS.
  - The existing Node + SQLite code runs unchanged.
  - The web app and the nightly job share one `warehouse.db`. WAL mode lets visitors read while the
    refresh writes.
- **Not serverless** (e.g. Vercel functions). There's no writable persistent disk for a 500 MB+ SQLite
  file.
- **Hosted database** (Postgres, Neon, Turso) only if multi-user scale demands it. ADR 0002 notes the
  schema ports cleanly.
- Sizing from measured numbers:
  - 1–2 GB RAM: loading a bulk quarter peaked at 670 MB RSS.
  - A volume of at least 5 GB: the warehouse is 544 MB (2026-10-01) and growing about 25–30 MB per quarter (budget
    1 GB), plus WAL and temporary zips of about 700 MB each.
- Verify current pricing and limits at decision time; don't rely on remembered prices.

**Tasks**

- **Container:**
  - A `Dockerfile` (Node ≥22, `npm ci --omit=dev`, non-root user, `WAREHOUSE_DB_PATH` on the volume).
  - A `/healthz` route that reports app status and warehouse freshness (newest filing date, last
    `refresh_runs` status).
- **Scheduled refresh:** `npm run refresh` daily at about 06:15, via the platform's scheduler or a cron
  (e.g. supercronic) inside the container.
  - It must run on the machine that owns the volume.
  - A lock (e.g. a `refresh_runs` row with status `running` younger than 2 h) prevents overlapping runs.
- **Alerting:** after each refresh, ping a dead-man's-switch URL (e.g. healthchecks.io) on success, and
  send a fail signal on non-zero exit. A missed or failed night emails the owner.
- **Backups:** continuous SQLite replication with Litestream to object storage (Cloudflare R2 or S3).
  - On boot, restore from the replica if the volume is empty.
  - Document the restore drill.
- **First data load:** restore from the Litestream replica, or upload a local `warehouse.db` snapshot.
  Fall back to a full `ingest:bulk -- --all` plus `ingest:delta` on the server (about 14 + 27 min).
- **Secrets and config:**
  - `SEC_USER_AGENT` (contains the owner's email) lives only in the host's secret store, never in the
    public repo.
  - `NODE_ENV=production`: the app already refuses to start without a real UA, and trusts one proxy hop
    for rate limiting.
- **Traffic spikes:**
  - Warehouse-backed API responses carry `Cache-Control` until the next scheduled refresh, with the
    `refreshId` as ETag (P5a), so a CDN serves repeats and a refresh invalidates them.
  - The per-company RSS feeds (P6) are cached the same way.
  - A CDN (e.g. Cloudflare) sits in front of the site.
  - Existing per-visitor rate limits stay on.
  - The on-demand live EDGAR check (ADR 0005) stays behind its own low limit, or is disabled publicly.
- **Presentation:**
  - Custom domain and HTTPS.
  - The freshness banner ("Data as of … · refreshed …").
  - An "About the data" page: SEC sources, the completeness check (0 of 2,905 filings missing), golden
    numbers, the nightly refresh and known limits.
  - Open Graph and preview tags for LinkedIn link cards.
- **Deploy pipeline:** GitHub Actions runs `npm test`, lint and format on the PR, then deploys `main` to
  the host. Staging first, then production.

**Tests**

- The container builds and boots locally against a fixture warehouse. `/healthz` returns freshness from
  `refresh_runs`.
- **Refresh in the deployed environment:** a manual trigger on staging loads new filings and pings the
  health check; a forced failure raises the alert.
- **Restore drill:** delete the staging volume, redeploy, and confirm Litestream restores the warehouse.
  Golden numbers A1–A6 still match.
- **Load:** a burst of cached page and API requests (e.g. 50 concurrent) makes **zero** outbound SEC
  requests (check the logs) and meets the P5 latency budget.
- **Security:**
  - No secrets in the image or repo.
  - Production refuses to start without `SEC_USER_AGENT`.
  - Security headers and CSP are still present.

**Success criteria**

- The public URL serves warehouse data with the freshness banner.
- 14 consecutive unattended nightly refreshes on production with no gaps and no manual steps. A failed
  night alerts within 24 h.
- A restore from backup is proven on staging in ≤30 min.
- No visitor request causes an SEC call. Page and API p95 <200 ms under the load test.
- Golden numbers on the live site match GOLDEN-NUMBERS.

**Rollback:** keep the previous image tag deployable. The warehouse is independent of app deploys (it
lives on the volume and in the replica), so rolling back the app never touches data.
