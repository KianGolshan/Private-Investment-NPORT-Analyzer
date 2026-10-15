# Changelog

Releases of the public site. Detail lives in [docs/STATUS.md](docs/STATUS.md) and its archive.

## v2.1.0: launch review fixes (P10)

- **What counts as a private company:** each reviewed company is an operating company, a fund interest, a CLO or an
  insurance vehicle. Market lists operating companies by default, with a switch for everything. CLO families,
  25 firm labels and a merged firm ("Boston") corrected; Bending Spoons and Malco Energy marked listed.
- **Reliability:** the nightly refresh has its own memory ceiling and reports a crash as a crash; the Status page
  shows when the nightly golden check and the monthly EDGAR reconciliation last passed; off-site backups to Oracle
  Object Storage or Cloudflare R2.
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
- **Operations:** off-site backups to R2, a nightly smoke check against the golden numbers, a load-test script,
  Dependabot and shellcheck in CI.

## v2 (P0–P8)

The SEC-verified warehouse (N-PORT since 2019Q4, nightly EDGAR catch-up, N-CEN advisers), the as-of engine,
company and firm identity, and the analyst workspace (market, company, fund, firm, explore, activity, compare,
tracked). See [docs/ROADMAP.md](docs/ROADMAP.md).
