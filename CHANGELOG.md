# Changelog

Releases of the public site. Detail lives in [docs/STATUS.md](docs/STATUS.md) and its archive.

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
