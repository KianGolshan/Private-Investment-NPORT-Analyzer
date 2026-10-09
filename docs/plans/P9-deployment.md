# P9: Vantage public deployment plan

## Context

You're done iterating for now and want Vantage **live, shareable and professional**:

- many people using it at once;
- data that refreshes itself every night and loads in without anyone noticing;
- app updates that ship automatically when you push to `main`, with an easy way to keep building features and
  fixes;
- free or close to it.

This is ROADMAP Phase 9. The assessment comes from reading the code (`server.js`, `lib/api/*`, `lib/warehouse/*`,
`web/`), STATUS, ROADMAP §9 and current hosting prices (Oct 2026).

**Your choices:** an Oracle Cloud Always Free VM ($0), and a new domain on Cloudflare (free DNS, TLS, CDN, Tunnel and
Access). **Total cost: about $10–11 per year**, which is the domain.

---

## 1. Readiness assessment

### Already ready

| Area                        | Evidence                                                                                                                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stack                       | Node 22+, Express and SQLite; one process serves the API and the built workspace. No external DB needed.                                                                                                                  |
| Visitors never call the SEC | The workspace reads only the warehouse. `web/src` calls none of the live routes (checked by grep).                                                                                                                        |
| Seamless data swaps         | ADR 0009: each refresh publishes a new read-only generation. Readers switch on their next request with no restart, the ETag carries the generation, and the client refreshes freshness in place.                          |
| Pipeline                    | `npm run nightly` = refresh + backup + watch + doctor, with exit codes, a 3 h job limit, disk checks, a lock and an optional `VANTAGE_ALERT_URL`. `npm run monthly` = EDGAR reconcile + LIVE.                             |
| Security                    | Strict CSP and security headers, per-IP rate limits, production refuses to start without `SEC_USER_AGENT`, loopback `HOST`, `TRUST_PROXY`, and admin refused unless `VANTAGE_ADMIN=1` and local with no forwarded header. |
| Quality                     | Backend 607 pass, web 39/39, e2e 27/27 (axe: 0 findings), CI green with SHA-pinned actions and audits. Lighthouse 95–98.                                                                                                  |
| Speed                       | p95 of about 27 ms across all routes (single user). The warehouse is 578 MB, within the 1 GB budget.                                                                                                                      |
| Linux                       | `ps -o lstart` works, `COPYFILE_FICLONE` falls back to a copy on ext4, and the macOS notification is skipped off-darwin.                                                                                                  |

### Gaps, grouped by what you asked for

**A. Safe for the public (blockers)**

1. **Live SEC routes are exposed** (`server.js` 421–1164: `search-nport`, `parse-nport`, `search-10q`,
   `parse-10q`, `search-fund`, `fund-series*`, `fund-xray*`, plus `/legacy`). They call the SEC under your user agent
   on a visitor's behalf, so a crawler could get the server's IP blocked by the SEC. **Fix:** a public mode turns them
   off.
2. **No health endpoints** for the uptime monitor and the deploy check.
3. **Backups sit on the same disk.** ROADMAP's Litestream idea no longer fits ADR 0009, which writes a new file per
   generation. The fix is the verified `npm run backup` plus a sync to Cloudflare R2.

**B. Many users at once**

4. **One Node process runs on one core.** better-sqlite3 is synchronous, so a slow query or gzip briefly blocks
   everyone on that process. The fix is **two app instances** behind a local Caddy load balancer, which uses both
   cores and lets one instance keep serving while the other restarts.
5. **No measured concurrency envelope** (R17). p95 is known for one user only. The fix is a load test (50 and 100
   concurrent visitors over a realistic route mix), with p50/p95/p99, errors, RSS and event-loop lag recorded as a
   budget.
6. **The warm-up blocks each process for up to about 2.7 s** when a new generation lands. The fix is to stagger the
   two instances' switch so one is always warm, and to bound the memo by bytes (R17).
7. **The CDN can't cache API answers** (`Cache-Control: no-cache`). The fix: warehouse answers send
   `Cache-Control: public, s-maxage=…` keyed to the generation, so Cloudflare serves repeat views from its edge and
   a new generation changes the ETag.

**C. Seamless refresh and updates**

8. **No automatic deploys.** The fix is a GitHub Actions `deploy` job that runs after CI passes on `main`, over a
   Cloudflare-Access-protected SSH tunnel, as a rolling restart with a smoke test and automatic rollback.
9. **Open tabs break after a deploy.** Old hashed JS chunks disappear, so a lazy-loaded page 404s. The fix: keep the
   previous build's `assets/`, and show a "New version available: Reload" toast when the server build changes, plus
   a quiet "Data updated to <date>" note when the generation changes.
10. **No staging.** The fix is `staging.<domain>` on the same VM, deployed from the `staging` branch and visible only
    to you (Cloudflare Access).

**D. Professional portfolio polish**

11. **About and Methodology page**: sources, the as-of rule, staggered calendars, reconciliation results, golden
    numbers, known limits, a "not investment advice" disclaimer and a privacy note (no cookies).
12. **Public `/status` page**: data as of, last refresh, generation, uptime link.
13. **Link previews**: per-page `<title>`, description and Open Graph tags rendered on the server for company, fund
    and firm URLs (LinkedIn's crawler doesn't run JS). Plus `robots.txt`, `sitemap.xml` and a branded 404.
14. **Live accuracy check** (`scripts/smoke.js`): the deployed URL is checked against GOLDEN-NUMBERS (Anthropic,
    Stripe A5, A1–A6) after every deploy and every nightly run.
15. **Monitoring**: an uptime monitor on `/readyz` every 5 min, a nightly dead-man's switch, and Cloudflare Web
    Analytics (cookieless, free).
16. **GitHub hygiene**: branch protection on `main` (CI required), Dependabot, a README with the live link,
    screenshots and an architecture diagram, release tags with a CHANGELOG, and ADR 0006.

### Deferred (fine to launch without)

MCP server (P7), the W4 research, the open curation review items, the Private Credit v1 tab (off publicly), and
splitting `public/app.js`.

---

## 2. Target architecture

```
Visitors ─HTTPS─> Cloudflare edge: DNS, TLS, CDN cache (assets + generation-keyed API), WAF rate rule, Web Analytics
                     │ Cloudflare Tunnel (outbound from the VM; no open web ports)
                     ▼
Oracle A1 VM · Ubuntu 24.04 ARM · 2 OCPU / 12 GB / 100 GB
  cloudflared ─┬─> vantage.<domain>          → Caddy :8080 ─┬─> vantage@3002  (node, prod)
               │                                            └─> vantage@3003  (node, prod)   round-robin + /readyz health checks
               ├─> staging.<domain> (Access)  → vantage-staging@3010 (staging branch, reads prod's warehouse read-only)
               └─> ssh.<domain>     (Access)  → sshd :22   (GitHub Actions deploys + your SSH)
  systemd timers: nightly 06:15 ET (refresh → backup → R2 → watch → doctor → smoke → ping) · monthly reconcile+LIVE
  ~/vantage/generations/warehouse-N.db (read-only) ← warehouse.db symlink; both instances read it
```

**Why it's built this way:**

- **Plain systemd, not Docker.** One VM and one app, so there are fewer moving parts, and the code runs unchanged.
- **Caddy between cloudflared and Node.** It provides load balancing, health checks and rolling restarts. Caddy sets
  `X-Forwarded-For` from Cloudflare's `CF-Connecting-IP`, so `TRUST_PROXY=1` gives each real visitor their own
  rate-limit bucket. Admin stays refused (a forwarded header is present, and `VANTAGE_ADMIN` is never set on the
  server).
- **Data and code are independent.** The nightly job publishes generations while both instances keep serving the old
  one until their next request. A code deploy never touches data.
- **Curation stays local** (ADR 0008). You edit `data/review` on your Mac and run the import there, then push. The
  deploy runs `npm run review:aliases` as a job on the server only if `data/review` changed.

---

## 3. How you'll ship changes after launch (day-to-day)

1. Work locally as today, on a feature branch.
2. Open a PR. CI runs (tests, lint, web, e2e).
3. Optional preview: push to `staging`, and it auto-deploys to `staging.<domain>`, which only you can see.
4. Merge to `main`. CI passes, then the **Deploy** job runs:
   - pull, `npm ci`, `build:web` (old assets kept);
   - restart instance B, wait for `/readyz`, then restart instance A;
   - run `smoke.js` against the live URL;
   - **auto-roll back** to the previous commit if anything fails.

   Visitors see no downtime. Open tabs get a "Reload for the new version" toast.

5. To roll back by hand: GitHub → Actions → Deploy → "Run workflow" with a previous tag. Data has its own rollback
   (`npm run warehouse -- --rollback`).

Data needs nothing from you. Every night the new filings land as a new generation, R2 gets a backup, the live site is
checked against the goldens, and healthchecks.io emails you only if something fails.

---

## 4. Build work (me, branch `v2-p9-deploy`, in 3 waves, each followed by your sign-off)

### W1: Public-ready server (code)

| #   | Change                                                                                                                                                                        | Where                                                            |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| B1  | `VANTAGE_PUBLIC=1`: live SEC routes and `/legacy` return 410 with a message; `/api/config` adds `public` and `build`; the nav hides "Private Credit (v1)"                     | `server.js`, `web/src/app.tsx`, `test/public-mode.test.js`       |
| B2  | `/healthz` (process up) and `/readyz` (warehouse open, generation, newest filing, last job; 503 if stale > 3 days, failed, or still warming up); not rate-limited, `no-store` | `lib/api/warehouse.js` (reuse `freshness`, `job-state.jobState`) |
| B3  | CDN-cacheable warehouse answers: `public, max-age=0, s-maxage=300, stale-while-revalidate=86400` with the existing generation ETag; freshness and job pills stay `no-store`   | `lib/api/warehouse.js` `route()` (lines ~206–219)                |
| B4  | Memo bounded by bytes, not only by count (R17); a warm-up stagger via `VANTAGE_WARM_DELAY_MS` so instance B switches 60 s after A                                             | `lib/services/memo.js`, `lib/api/warehouse.js` warm-on-switch    |
| B5  | Off-site backup step `VANTAGE_OFFSITE_CMD` in nightly `runSteps`; the doctor counts a recent successful off-site sync as an off-host backup                                   | `lib/warehouse/nightly.js`, `lib/warehouse/doctor.js`            |
| B6  | `scripts/smoke.js <url>`: readyz, goldens (Anthropic $18.16B / 123 funds, Stripe A5, A1–A6 from GOLDEN-NUMBERS), headers, 410s, admin 403; exits 1 on any mismatch            | new; a nightly step when `VANTAGE_PUBLIC_URL` is set             |
| B7  | `scripts/loadtest.js`: N concurrent virtual users over a recorded route mix (Market, company, fund, firm, Explore, search), reporting p50/p95/p99, errors and server RSS/lag  | extends `scripts/bench.js` (reuses its route list)               |

**Tests** (fix-completeness rules):

- Public mode: every live route returns 410, warehouse routes return 200, `/legacy` is hidden; public mode off means
  no change.
- `/readyz`: fresh, stale, failed job, missing warehouse and warming up.
- Caching: the headers on warehouse answers vs freshness; a 304 on a matching ETag; a new generation gives a new ETag.
- Memo: an entry over the byte limit, eviction order, and the cache emptied on a switch.
- Off-site: success, failure, timeout and unset (a failure means "warn", and the refresh still counts).
- Smoke: passes on the golden fixture and fails on an altered golden.

### W2: Seamless client and portfolio polish (web)

| #   | Change                                                                                                                                                                                                                             | Where                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| B8  | Version toast: poll `/api/config` build every 5 min and on focus; on a change, show "A new version is available: Reload". On a generation change, show "Data updated to <date>"                                                    | `web/src` (top bar, next to the freshness pill) |
| B9  | Chunk-load failure recovery: a lazy import that fails reloads the page once                                                                                                                                                        | `web/src` router                                |
| B10 | `/about` (methodology, sources, goldens, limits, disclaimer, privacy) and `/status` (freshness, last jobs, uptime link); footer links                                                                                              | `web/src/pages`, `APP_ROUTES` in `server.js`    |
| B11 | Server-rendered meta: `<title>`, description, OG and Twitter tags for `/company/:ref`, `/fund/:key`, `/firm/:id`, from the warehouse; a default OG image; `robots.txt`; `sitemap.xml` (companies, firms, top funds); a branded 404 | `server.js` `APP_ROUTES` handler, `public/`     |
| B12 | Cloudflare Web Analytics beacon allowed in the CSP (`static.cloudflareinsights.com`, `cloudflareinsights.com`), only when `VANTAGE_ANALYTICS_TOKEN` is set                                                                         | `server.js` `cspOf`, `web/index.html`           |

**Tests:** e2e for About, Status, the 404 and the toast (mock build change), and axe light/dark on the new pages.
Meta tags: unit tests for each page type and for unknown ids (default tags, no crash).

### W3: Deployment and operations (infra as code + docs)

| #   | Change                                                                                                                                                                                                                                                                                                                | Where                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| B13 | `deploy/setup.sh` (idempotent): Node 22, build tools, Caddy, cloudflared, rclone, a 4 GB swap, unattended-upgrades (reboot at 04:00), ufw and fail2ban, the `vantage` user, `/etc/vantage.env` (mode 600, prompts for secrets)                                                                                        | `deploy/`                |
| B14 | systemd units: `vantage@.service` (ports 3002/3003, `Restart=always`, memory cap), `vantage-staging.service`, `vantage-nightly.{service,timer}` (nice/ionice, `Persistent=true`), `vantage-monthly.{service,timer}`; `Caddyfile`; `cloudflared.yml`                                                                   | `deploy/`                |
| B15 | `deploy/deploy.sh [--ref SHA] [--rollback]`: fetch, `npm ci`, build (merging the previous `assets/`), review import if `data/review` changed, rolling restart gated on `/readyz`, smoke, and rollback on failure; logs to `deploy.log`                                                                                | `deploy/`                |
| B16 | `.github/workflows/deploy.yml`: on push to `main` after `Test` succeeds (`workflow_run`), and `workflow_dispatch` with a ref for rollback; environment `production`; SSH over `cloudflared access` with a service token; also `staging`                                                                               | `.github/workflows/`     |
| B17 | Dependabot (npm root, web, actions; weekly, grouped)                                                                                                                                                                                                                                                                  | `.github/dependabot.yml` |
| B18 | Docs: `docs/DEPLOY.md` (runbook: first load, deploy, rollback, restore drill, rotating secrets, VM rebuild from zero); ADR 0006 (hosting, and why not Litestream); ROADMAP §9 corrected; README with the live link, screenshots, architecture diagram and badges; CHANGELOG with tag `v2.0.0`; `.env.example`; STATUS | `docs/`, `README.md`     |

**Tests:** `shellcheck` on `deploy/*.sh` in CI; `deploy.sh` is run in a dry-run mode in CI; `systemd-analyze verify`
runs on the VM during setup.

---

## 5. Your steps (concrete, in order; about 2 hours total, mostly waiting)

> **Built in W3:** the authoritative, step-by-step version with the exact commands is [DEPLOY.md](../DEPLOY.md)
> part 1. Two changes from this outline: Bot Fight Mode stays **off** (it can challenge the uptime monitor), and
> GitHub also needs the secret `DEPLOY_KNOWN_HOSTS` and the variable `DEPLOY_ENABLED=true`.

### A. Accounts (about 40 min)

1. **Cloudflare** (dash.cloudflare.com): sign up. Under **Domain Registration**, buy your domain (~$10/yr, at
   cost), e.g. `vantage-<yourname>.com`. Tell me the name.
2. **Cloudflare R2**: enable it (a card is needed, $0 within 10 GB). Create bucket `vantage-backups`, then an R2 API
   token scoped to that bucket with Object Read & Write. Save the Access Key ID, the Secret and the endpoint.
3. **Cloudflare Zero Trust** (free, up to 50 users): pick a team name. Under Access → Applications, add **two
   self-hosted apps**:
   - `staging.<domain>`, policy: your email;
   - `ssh.<domain>`, policy: your email **or** a service token.

   Create a **Service Token** named `github-deploy` and save its Client ID and Secret.

4. **Oracle Cloud** (cloud.oracle.com): sign up. Choose a home region near you (e.g. US East Ashburn); it is
   permanent. Then **Billing → Upgrade to Pay As You Go**. It stays $0 within Always Free, and it prevents idle
   instances from being reclaimed. Set a **budget alert at $1** as a safety net.
5. **healthchecks.io** (free): create check `vantage-nightly` (period 1 day, grace 6 h). Copy its ping URL.
6. **Uptime monitor**: UptimeRobot or Better Stack (free). An HTTP check on `https://<domain>/readyz` every 5 min,
   with email alerts. Optionally a public status page on it, which `/status` links to.
7. **Cloudflare Web Analytics** (optional): add the site and copy the token.

### B. Create the VM (about 15 min)

8. Oracle Console → Compute → Create instance:
   - Ubuntu 24.04 **aarch64**, shape **VM.Standard.A1.Flex 2 OCPU / 12 GB**, boot volume **100 GB**;
   - paste your Mac's SSH public key (`cat ~/.ssh/id_ed25519.pub`; create one with `ssh-keygen -t ed25519` if
     missing).
   - On "Out of capacity", retry another availability domain or a few hours later. **Fallback:** Hetzner CAX11
     (~€5/mo, ARM); every later step is the same.
9. VCN security list: allow TCP 22 **from your home IP only**, as break-glass access. No 80/443 ingress; the tunnel
   is outbound.

### C. Bootstrap (scripts prepared in W3; you run a few commands)

10. ```bash
    ssh ubuntu@<VM_IP>
    ```
11. On the VM: `git clone https://github.com/KianGolshan/Private-Investment-NPORT-Analyzer.git /opt/vantage && sudo /opt/vantage/deploy/setup.sh`.
    It prompts for:
    - `SEC_USER_AGENT` ("Your Name your@email");
    - the healthchecks URL;
    - the R2 keys;
    - the domain;
    - the analytics token (optional).

    Secrets go to `/etc/vantage.env` (mode 600), never the repo. If the repo is private, setup.sh prints how to add a
    read-only deploy key.

12. **First data load** from your Mac. This keeps every company id and URL identical to local, and takes seconds to
    publish:

    ```bash
    npm run backup
    ```

    Then `scp` the newest backup and its `.sha256` to the VM, and on the VM run
    `sudo -u vantage npm run backup -- --restore <file>`. The fallback is a full ingest on the VM (about 45 min).

13. **Tunnel:** on the VM, run `cloudflared tunnel login` (approve the domain in the browser), then
    `sudo /opt/vantage/deploy/setup.sh --tunnel`. It creates the tunnel and the DNS records for `<domain>`,
    `staging.` and `ssh.`, and starts everything.
14. **GitHub** → repo Settings:
    - **Environments**: create `production`. Add secrets `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`,
      `DEPLOY_SSH_KEY` (setup.sh generates it and prints the private key once) and `DEPLOY_HOST=ssh.<domain>`.
    - **Branches**: protect `main`. Require a PR and the CI checks (test, lint, web, e2e).
    - Enable **Dependabot alerts** and **secret scanning**.
15. **Cloudflare dashboard** (all free):
    - SSL/TLS → Full (strict);
    - Always Use HTTPS on;
    - Bot Fight Mode off (it can challenge the uptime monitor and API calls);
    - Security → WAF → one rate-limiting rule (e.g. 300 requests per 10 s per IP on `/api/*`, block for 1 min);
    - Caching → Cache Rules: "Respect origin" for `/api/*` and cache everything for `/assets/*`.

### D. Go live

16. Tell me the domain. I'll run the verification below and fix anything it finds. Then share the link.

---

## 6. Verification (definition of done)

1. **Up:** `https://<domain>/readyz` returns 200. Lighthouse 90+ (performance, accessibility, best practices, SEO).
   Clean in light, dark and at 375 px. The LinkedIn Post Inspector shows correct cards for the home, a company, a
   fund and a firm.
2. **Accurate:** `node scripts/smoke.js https://<domain>` passes, so every checked golden matches GOLDEN-NUMBERS on
   the live site.
3. **Many users:** `scripts/loadtest.js` with 50 and then 100 concurrent visitors for 5 min, uncached at the origin,
   and again through Cloudflare:
   - **0 errors** (apart from intended 429s);
   - origin **p95 < 200 ms** and p99 < 500 ms;
   - RSS per instance < 1 GB;
   - **zero outbound SEC requests** in the logs.

   The results are recorded in STATUS Measurements as the concurrency envelope.

4. **Seamless data:** trigger `systemctl start vantage-nightly` while the load test runs. A new generation
   publishes, there are 0 errors and no p99 spike over 1 s (staggered warm-up), and the site shows "Data updated".
5. **Seamless code:** merge a trivial PR while the load test runs. The Deploy job goes green, there are 0 errors and
   no gap in the uptime monitor, and an open tab shows the reload toast. Then a forced bad deploy (a failing smoke)
   **auto-rolls back**.
6. **Safe:**
   - live routes return 410 and `/api/admin/*` returns 403;
   - headers include CSP, nosniff and DENY;
   - staging and ssh hosts demand Cloudflare Access login;
   - `ufw status` shows SSH only;
   - no secrets in the repo or image (`git grep` check).
7. **Recoverable:**
   - restore drill: wipe `generations/`, pull the latest from R2, `--restore`, smoke passes, in under 30 min;
   - VM-from-zero rebuild documented in DEPLOY.md;
   - a forced nightly failure (bad user agent) produces an email from healthchecks.io.
8. **Sign-off gate:** 14 consecutive unattended nights green in healthchecks.io, with uptime ≥ 99.5% over the same
   period.

---

## 7. Cost summary

| Item                                                      | Cost                                                |
| --------------------------------------------------------- | --------------------------------------------------- |
| Oracle A1 VM (2 OCPU / 12 GB / 100 GB)                    | $0 (Always Free on a PAYG account, $1 budget alert) |
| Cloudflare DNS, CDN, Tunnel, Access, WAF rule, analytics  | $0                                                  |
| Cloudflare R2 backups (~2 GB)                             | $0 (10 GB free)                                     |
| healthchecks.io, UptimeRobot/Better Stack, GitHub Actions | $0                                                  |
| Domain                                                    | ~$10–11 per year                                    |
| Fallback only if Oracle fails: Hetzner CAX11              | ~€5 per month                                       |
