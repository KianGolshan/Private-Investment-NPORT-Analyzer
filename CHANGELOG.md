# Changelog

Releases of the public site. Detail lives in [docs/STATUS.md](docs/STATUS.md) and its archive.

## Unreleased: copy and UX review, wave 1 (truth and trust)

- **Freshness says what it means:** the header, Market and Status show the newest mark (the latest mark date of any
  private holding) instead of the newest report date, which ran two months ahead of any private mark.
- **Market's # column** ranks within the list shown (operating companies by default), with no gaps.
- **Money** picks its unit after rounding: $1.0M, never $1000.0K.
- **Pages:** the browser tab title follows the page; a page that fails shows a way out instead of a blank page;
  internal notes and storage words left the tooltips; About drops a dated one-off result and adds hedge funds and
  the report-date rule.

## v2.1.1: engineering and security review (P11), 2026-10-15

- **Safety:** a per-visitor time budget on every API route, fair load shedding, case-sensitive API paths; the web
  server runs as its own sandboxed user without the jobs' secrets; SSH limited to one user.
- **Data:** units a fund restates at the same value (a 1,000-for-1 re-denomination, say) are no longer read as
  trades (trap 63, golden F58).
- **Hosting:** one Oracle Cloud VM under a DuckDNS name, HTTPS from Caddy; `main` is protected (pull requests with
  green checks only).

## v2.1.0: launch review fixes (P10)

- **What counts as a private company:** each reviewed company is an operating company, a fund interest, a CLO or an
  insurance vehicle. Market lists operating companies by default, with a switch for everything. CLO families,
  25 firm labels and a merged firm ("Boston") corrected; Bending Spoons and Malco Energy marked listed.
- **Reliability:** the nightly refresh has its own memory ceiling and reports a crash as a crash; the Status page
  shows when the nightly golden check and the monthly EDGAR reconciliation last passed; optional off-site backups
  to Oracle Object Storage or Cloudflare R2 (not set up on the live site).
- **Safety:** expensive queries have their own per-visitor budget and shed load when the server is busy; extra
  security headers; key-only SSH without root.
- **Pages:** a plain-English introduction and example questions, the method note folded, no sideways scrolling on
  phones, no layout jump while loading, accessibility fixes, a real 404 for unknown ids.
- **v1 retired:** the original tool (live per-filing search, Batch, Private Credit) leaves the live project and is
  kept at the git tag `v1-archive`.

## v2.0.0: public launch (P9)

- **Public site:** Oracle Cloud VM behind Cloudflare (Tunnel, CDN, Access), two app instances behind Caddy,
  systemd timers, releases as git worktrees, and deploys from GitHub Actions with automatic rollback
  ([ADR 0006](docs/decisions/0006-hosting.md), [DEPLOY.md](docs/DEPLOY.md)).
- **Public mode:** no visitor request reaches the SEC. Health and readiness endpoints, a warm-then-swap switch to
  each new data generation, and CDN-cacheable answers.
- **New pages:** About the data, Status, link previews (Open Graph), sitemap, a 404 page, and notices in open tabs
  for a new version and for new data.
- **Operations:** optional off-site backups to R2 (not set up on the live site), a nightly smoke check against the golden numbers, a load-test script,
  Dependabot and shellcheck in CI.

## v2 (P0–P8)

The SEC-verified warehouse (N-PORT since 2019Q4, nightly EDGAR catch-up, N-CEN advisers), the as-of engine,
company and firm identity, and the analyst workspace (market, company, fund, firm, explore, activity, compare,
tracked). See [docs/ROADMAP.md](docs/ROADMAP.md).
