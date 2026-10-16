# Vantage

[![Test](https://github.com/KianGolshan/Private-Investment-NPORT-Analyzer/actions/workflows/test.yml/badge.svg)](https://github.com/KianGolshan/Private-Investment-NPORT-Analyzer/actions/workflows/test.yml)

Which mutual funds and ETFs hold stakes in private companies like Anthropic, Stripe and Databricks, what each fund
says a share is worth, and how that changed, from the N-PORT holdings reports funds file with the SEC. By share
class, company, fund and firm, at any date since 2019. Every number links to its filing.

**Live:** [vantage-kian.duckdns.org](https://vantage-kian.duckdns.org)

## What it shows

Vantage answers from an SEC-verified warehouse: every N-PORT filing since 2019Q4, refreshed nightly from EDGAR and
published as whole, validated versions. Amendments, exits, funds that stop filing, $0 positions, stock splits and
staggered fund calendars are handled by rules documented in [docs/DATA-QUALITY.md](docs/DATA-QUALITY.md).
Companies are resolved from filing evidence and reviewed by hand; a fund's firm comes from its Form N-CEN adviser.

| Where                  | What                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------- |
| ⌘K (anywhere)          | one search over companies, unreviewed names, firms, funds and share classes                           |
| `/` Market             | top private companies as of any date, movers (mark and position effects), newly reported             |
| `/company/<id>`        | overview and bridge, holders, positions, changes, marks and share classes, filings as filed           |
| `/name/<key>`          | the same views for a name not yet reviewed into a company                                             |
| `/fund/<key>`          | a fund's private book (X-Ray), timeline, marks against other funds, period compare, mark-implied returns |
| `/firm/<id>`, `/firms` | a manager's private book, timeline, fund × company matrix, marks against others, changes               |
| `/explore`             | pivot of firm, fund, company or class × month, quarter or year; every cell drills to its filings       |
| `/activity`            | changes in newly filed reports, by firm and fund                                                       |
| `/compare`             | two to five companies, firms, funds or classes side by side                                            |
| `/tracked`             | the tracked list and your watchlist (kept in your browser)                                             |
| `/about`, `/status`    | method, sources, known limits; how current the data is and when the checks last passed               |

Every view reads its scope from the URL, every chart has a table twin, and every export carries mark dates,
accession numbers and how it reads history. Changes are worded only as the filings allow: first reported, added,
reduced, no longer reported, reported at $0, mark moved.

Funds also report stakes in private-equity funds, CLOs and reinsurance vehicles. Each reviewed company has a
category (operating company, fund interest, CLO, insurance vehicle); Market lists operating companies by default.

- Plan: [docs/ROADMAP.md](docs/ROADMAP.md) · Progress: [docs/STATUS.md](docs/STATUS.md) · Design:
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · Verified figures: [docs/GOLDEN-NUMBERS.md](docs/GOLDEN-NUMBERS.md) ·
  Decisions: [docs/decisions/](docs/decisions/) · How we work: [docs/LESSONS.md](docs/LESSONS.md),
  [CLAUDE.md](CLAUDE.md)

## Live site and deployment

```
Visitors → Caddy (HTTPS, Let's Encrypt) → two Node instances → SQLite warehouse (read-only, published versions)
           nightly job: SEC refresh → validated new version → backup → golden-number smoke check
```

The public site runs on one free Oracle Cloud VM under a DuckDNS name. The server deploys each commit on `main` once
CI is green, with readiness checks and automatic rollback ([ADR 0006](docs/decisions/0006-hosting.md)). A path
through Cloudflare with your own domain is documented too.

- **Runbook:** [docs/DEPLOY.md](docs/DEPLOY.md) (setup, shipping changes, operating, recovery); scripts in
  [deploy/](deploy/).
- **Public mode** (`VANTAGE_PUBLIC=1`): no visitor request reaches the SEC; admin actions are off. `/healthz` and
  `/readyz` serve the balancer and an uptime monitor.
- **Limits:** a per-visitor rate limit on the API and a smaller one on the expensive analysis routes, which also
  answer "busy" when heavy work fills the server ([lib/api/heavy.js](lib/api/heavy.js)).
- **Checks:** `node scripts/smoke.js <url>` (golden numbers, headers, public mode) after every deploy and every
  night; `node scripts/loadtest.js <url>` for concurrent visitors.

## Setup

Node.js 22 or later and npm.

```bash
git clone https://github.com/KianGolshan/Private-Investment-NPORT-Analyzer.git
cd Private-Investment-NPORT-Analyzer
npm install
npm --prefix web install
npm run build:web             # builds web/dist, which the server serves at /
cp .env.example .env          # set SEC_USER_AGENT to your name and email (SEC fair-access policy)
```

### Build the warehouse

```bash
npm run ingest:bulk -- --all  # SEC quarterly bulk data sets, 2019Q4 on (~14 minutes)
npm run ingest:delta          # filings made after the newest bulk quarter, from EDGAR
npm run ingest:ncen           # Form N-CEN advisers (the firms)
npm run review:aliases        # import the reviewed companies and firms in data/review/
npm start                     # http://localhost:3002 (PORT in .env)
```

Every command that writes the warehouse runs as one job
([ADR 0009](docs/decisions/0009-published-generations.md)): it builds a copy, rebuilds everything derived,
validates it and publishes it as a new version (`generations/warehouse-<id>.db`, with `warehouse.db` linking to the
published one). A failed job publishes nothing, and only one job runs at a time.

```bash
npm run refresh        # new or re-posted bulk quarters, the EDGAR catch-up, N-CEN, entity upkeep
npm run nightly        # what the server's timer runs: refresh, backup, watch report, doctor, smoke (+ an off-site copy if configured)
npm run monthly        # reconcile with EDGAR and the LIVE regression
npm run doctor         # read-only health check; exit 1 = act
npm run backup         # verified copy of the published version (-- --list, -- --restore FILE)
npm run warehouse      # versions and the last job (-- --rollback)
```

Companies, aliases, categories and firms are human-reviewed files in `data/review/`. Company and firm ids are
permanent ledgers there (`company_ids.csv`, `manager_ids.csv`); the import writes them back.

### Develop and test

```bash
npm run dev:web        # Vite on :5173, proxying /api to the server (VANTAGE_API to change it)
npm test               # backend: real-filing fixtures, the golden warehouse, an independent EDGAR oracle
npm run test:web       # workspace typecheck and Vitest
npm run test:e2e       # the workspace in Chromium (Playwright) on the golden warehouse; build:web first
npm run test:live      # LIVE_SEC=1: the warehouse answers against real EDGAR (minutes)
npm run lint && npm run lint:web && npm run format:check
```

CI runs the backend (Node 22 and 24), lint, the workspace, the browser suite with an accessibility audit, the
deploy scripts (shellcheck) and a deploy drill with real server processes.

## Project structure

```
server.js            Express: security headers, rate limits, health, the workspace pages, the warehouse API
parsers.js           N-PORT XML parsing, instrument classification, Fund X-Ray, mark-implied returns
lib/api/             warehouse API routes, page heads and sitemap, heavy-route guards, admin (local only)
lib/services/        company, fund, firm, market, analysis, marks, search (all read the warehouse)
lib/analytics/       the as-of engine (exposureAsOf), activity legs, split detection
lib/warehouse/       ingest (bulk, EDGAR, N-CEN), jobs and published versions, backup, doctor, nightly
lib/entities/        company and firm identity, the review import
web/                 the analyst workspace (Vite + Preact + TypeScript)
data/review/         reviewed companies, aliases, categories, firms and id ledgers
db/migrations/       numbered SQL migrations
deploy/              server setup, deploy, systemd units, Caddy
scripts/             command-line entry points (npm run …)
docs/                roadmap, status, architecture, data quality, golden numbers, decisions
```

## v1 (archived)

The original tool searched EDGAR live for one security at a time and had tabs for Batch, Watchlist, Fund X-Ray and
Private Credit (BDC 10-Q/10-K schedules). v2 replaced it, and on 2026-10-13 v1 was removed from the live project. It
is kept, runnable, at the git tag [`v1-archive`](https://github.com/KianGolshan/Private-Investment-NPORT-Analyzer/tree/v1-archive)
(also the branch `archive/v1`): `git checkout v1-archive && npm ci && npm start`, then open `/legacy`.

## SEC data notes

- Each fund files one N-PORT per fiscal quarter, within 60 days of its end, and only the quarter's last month is
  public. Fund calendars are staggered (Jan/Apr/Jul/Oct, Feb/May/Aug/Nov or Mar/Jun/Sep/Dec), so every holding shows
  its own mark date.
- Only registered funds file N-PORT: mutual funds, ETFs, closed-end and interval funds. Hedge funds, venture funds
  and private funds do not, and the filings carry no company share counts, so Vantage shows no company valuations.
- Values are as of each report date, not the filing date.

Not investment advice. Figures are as the funds report them; check the linked filing before relying on any number.
