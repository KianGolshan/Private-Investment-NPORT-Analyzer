# 0006: Hosting: one small VM behind Cloudflare, systemd releases, R2 backups

**Status:** accepted, 2026-10-08 (P9). The user approved the deployment plan
([plans/P9-deployment.md](../plans/P9-deployment.md)) and chose Oracle Cloud Always Free and a new domain on
Cloudflare. The runbook is [DEPLOY.md](../DEPLOY.md).

## Context

The public site has to be:

- free or close to it;
- usable by many visitors at once;
- refreshed from the SEC every night with no manual step;
- updated from `main` without downtime, and easy to keep developing.

The app is Node and SQLite: a 578 MB warehouse that one job writes as whole generations (ADR 0009), with
read-only web processes. ROADMAP §9 required that visitors never cause an SEC request, and that publishing never
writes git-tracked files or allows admin actions.

## Decision

1. **One always-on VM**, not serverless and not a hosted database. It is an Oracle Cloud Always Free Ampere A1
   (2 OCPU, 12 GB, 100 GB), upgraded to pay-as-you-go so it is not reclaimed when idle. A Hetzner CAX11 (about
   €5/month) is the fallback with identical steps. The code runs unchanged, and the job and the web processes share
   the warehouse on local disk.
2. **Cloudflare in front:**
   - DNS, TLS, CDN and a WAF rate rule;
   - a **Tunnel**, outbound from the VM, so no web port is open;
   - **Access** for `staging.` and `ssh.`.

   Warehouse answers carry `s-maxage` keyed to the generation ETag (`VANTAGE_CDN_MAX_AGE`), and errors are never
   cached.

3. **Two app instances behind Caddy** on loopback, with least-connections balancing and `/readyz` health checks.
   Both cores are used, and one instance always serves while the other restarts or warms. Caddy takes the
   visitor's address from `CF-Connecting-IP`, and the app trusts one hop.
4. **Public mode** (`VANTAGE_PUBLIC=1`): v1's live per-filing routes and page answer 410, and only the nightly job
   calls the SEC.
5. **Releases, not in-place updates.** Each deploy is a git worktree at `/opt/vantage/<target>/releases/<sha>`, so
   jobs can still record `code_rev` and `curation_rev`, and a `current` link is switched in one step. Rollback
   points the link back. Data lives apart, in `/var/lib/vantage`. A commit that adds a migration or changes
   `data/review` runs one review import job before the switch.
6. **Deploys from GitHub Actions** after the Test workflow passes. They use SSH through Cloudflare Access with a
   service token. The key is pinned to a forced command (`vantage-deploy`) that accepts only
   `deploy|status <target> <sha|main|staging|rollback>` and runs the deploy script of the commit being deployed.
7. **Scheduling** with systemd timers: the nightly run at 06:15 New York, the monthly check on the 3rd.
8. **Backups:** the verified `npm run backup` (P8) plus an rclone mirror to Cloudflare R2 (`VANTAGE_OFFSITE_CMD`),
   which the doctor counts as off-host. Restore drill: `vantage-restore`.
9. **Alerting:** healthchecks.io (`VANTAGE_ALERT_URL`) for the nightly run, and an uptime monitor on
   `/readyz?fresh=1`.

## Rejected

- **Litestream** (ROADMAP §9's original plan). ADR 0009 publishes each generation as a new file behind a link,
  instead of updating one database through its WAL, so there is no continuous stream to replicate. Copying each
  verified backup is simpler and exact.
- **Serverless platforms** (e.g. Vercel functions): no writable persistent disk for the warehouse or the job.
- **Fly.io, Railway, Render:** no longer free for an always-on service with a persistent volume; the VM is $0.
- **Docker:** one app on one VM gains little from it. systemd units, a worktree per release and `setup.sh` are
  fewer moving parts. The setup can be revisited if the site moves to a container platform.
- **Opening ports 80/443 with Caddy's automatic HTTPS:** that works, but it exposes the origin and gives up the
  CDN, the WAF rule and Access.

## Consequences

- **Cost** is the domain, about $10–11 a year.
- **Capacity:** 12 GB is room for both instances (about 0.3–0.4 GB each), a refresh job (about 0.7 GB peak) and
  staging. 100 GB holds two generations, three backups and four releases per target.
- **Single machine:** an Oracle outage takes the site down until the VM is back or rebuilt from R2 (DEPLOY.md
  part 5). That is acceptable for a portfolio site.
- **Oracle's free-tier terms change** (the A1 allowance was cut in 2026). The Hetzner fallback keeps every step the
  same.
