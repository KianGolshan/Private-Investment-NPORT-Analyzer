# Deploying and running Vantage in public

The runbook for the public site (P9; plan: [plans/P9-deployment.md](plans/P9-deployment.md); decision:
[ADR 0006](decisions/0006-hosting.md)). Part 1 is done once, in one of two ways:

- **1A, free, no domain:** a free DuckDNS name with HTTPS served by the server itself. $0. Start here.
- **1B, your own domain:** through Cloudflare (CDN, firewall, private staging, deploys from GitHub). About $10 a
  year. Move to it later.

Parts 2–4 are day-to-day work. Part 5 covers recovery.

```
Visitors ─HTTPS─> Cloudflare: DNS, TLS, CDN, WAF rate rule, Access (staging, ssh)
                    │ Cloudflare Tunnel (outbound from the server; no web port open)
                    ▼
Ubuntu 24.04 VM (Oracle Cloud Always Free, 2 OCPU / 12 GB / 100 GB)
  cloudflared ─┬─> <domain>          → Caddy 127.0.0.1:8080 ─┬─> vantage@3002 ┐ two app instances,
               │                                             └─> vantage@3003 ┘ restarted one at a time
               ├─> staging.<domain>  → vantage-staging 3010 (the staging branch; production's data, read-only)
               └─> ssh.<domain>      → sshd (GitHub Actions deploys; your SSH)
  timers: vantage-nightly 06:15 New York (refresh → backup → R2 → watch → doctor → smoke → healthchecks.io)
          vantage-monthly on the 3rd (EDGAR reconciliation + LIVE regression)
  /opt/vantage/{prod,staging}/releases/<sha>  code (a git worktree per deploy), `current` → the running one
  /var/lib/vantage                            data: warehouse generations, backups, cache, logs (deploys never touch it)
  /etc/vantage/vantage.env                    configuration and secrets (root:vantage, 640)
```

That picture is 1B. In 1A, visitors reach Caddy directly on port 443 at `https://<name>.duckdns.org`, and the
server deploys `main` on its own.

Cost:

- 1A: $0. Oracle asks for a card to verify your identity, and nothing is charged.
- 1B: the domain, about $10–11 a year.

If Oracle has no capacity, a Hetzner CAX11 (about €5 a month) works with the same steps.

---

## 1A. Free start: a DuckDNS name (no domain, about 45 minutes)

Caveats of a free dynamic-DNS name:

- some company networks block or warn on `*.duckdns.org`;
- DuckDNS has no uptime guarantee;
- links shared now stop working when you move to a domain (1B).

That makes 1A good for testing and showing people, and 1B the version for your resume.

### 1A.1 Accounts

1. **Oracle Cloud** (cloud.oracle.com): sign up. The card is for identity verification only, and Always Free
   resources are $0. Choose a home region near you; it cannot be changed later.
   - Recommended: _Billing → Upgrade to Pay As You Go_. It is still $0 within Always Free, and it stops Oracle from
     stopping an instance it judges idle.
   - Add a **budget alert at $1**.
2. **DuckDNS** (duckdns.org): sign in with GitHub or Google and add a subdomain, e.g. `vantage-yourname`. Keep the
   **token** shown at the top of the page.
3. **healthchecks.io** (free, recommended): create a check `vantage-nightly`, period 1 day, grace 6 hours. Keep its
   **ping URL**. It emails you if a nightly refresh fails or never runs.
4. Optional, any time later:
   - **Cloudflare R2** for off-site backups (1.1 step 2). Without it, backups stay on the server.
   - An uptime monitor (UptimeRobot, free) on `https://<name>.duckdns.org/readyz?fresh=1`.

### 1A.2 The server

1. Create the instance as in **1.2**: Ubuntu 24.04 aarch64, VM.Standard.A1.Flex, 2 OCPU, 12 GB, 100 GB boot
   volume, and your Mac's SSH public key.
2. In the instance's subnet **security list**, add ingress rules:
   - TCP **22** from your home IP;
   - TCP **80** from `0.0.0.0/0` (Let's Encrypt checks it to issue the certificate);
   - TCP **443** from `0.0.0.0/0`.

### 1A.3 Setup

```bash
ssh ubuntu@<server-ip>
git clone https://github.com/KianGolshan/Private-Investment-NPORT-Analyzer.git ~/vantage-setup
sudo bash ~/vantage-setup/deploy/setup.sh
```

| Asked for           | Answer                                           |
| ------------------- | ------------------------------------------------ |
| Edge                | `direct`                                         |
| Hostname            | `vantage-yourname.duckdns.org`                   |
| DuckDNS token       | from 1A.1                                        |
| SEC user agent      | `Your Name you@example.com` (an SEC requirement) |
| healthchecks.io URL | from 1A.1 (Enter to skip)                        |
| The optional ones   | Enter to skip (status page, analytics, R2)       |

Setup also points the DuckDNS name at the server, opens ports 80 and 443 in the server's firewall, and turns on
**auto-deploy**. Every 5 minutes the server checks GitHub, and when `main` has a new commit whose CI passed, it
deploys it: rolling restart, smoke check, automatic rollback. Nothing needs setting up in GitHub.

### 1A.4 The data

As in **1.3**: run `npm run backup` on your Mac, copy the backup with `scp`, run `sudo vantage-run npm run backup
-- --restore …` on the server, then restart the instances.

### 1A.5 Check and share

1. Open `https://vantage-yourname.duckdns.org`. The first visit may take up to a minute while Caddy gets the
   certificate.
2. From your Mac: `node scripts/smoke.js https://vantage-yourname.duckdns.org` passes every check.
3. Run one nightly by hand: `sudo systemctl start vantage-nightly && journalctl -fu vantage-nightly`. Then check
   for a green ping on healthchecks.io.
4. Auto-deploy: merge something to `main`. About 5 minutes after CI passes, `journalctl -u vantage-autodeploy`
   shows it deployed, and `/status` shows the new app version.

Staging in 1A is not public. Push a `staging` branch, then:

```bash
sudo -u vantage vantage-deploy deploy staging staging
```

Open it through SSH: `ssh -L 3010:127.0.0.1:3010 ubuntu@<server-ip>`, then <http://localhost:3010>.

### Moving from 1A to a domain (1B) later

1. Buy the domain on Cloudflare and do the Cloudflare parts of 1.1 (R2 if you like).
2. On the server, `sudoedit /etc/vantage/vantage.env`:
   - set `VANTAGE_EDGE="cloudflare"` and `VANTAGE_DOMAIN="<your domain>"`;
   - empty `DUCKDNS_TOKEN`.
3. Re-run `sudo bash ~/vantage-setup/deploy/setup.sh`. It installs the Cloudflare Caddyfile, stops auto-deploy and
   prints a GitHub deploy key.
4. Do 1.4 (tunnel), 1.5 (GitHub) and 1.6. Then remove the 80/443 rules from the security list.
5. Update the links you shared.

---

## 1B. With your own domain through Cloudflare (once, about 2 hours, mostly waiting)

### 1.1 Accounts

1. **Cloudflare** (dash.cloudflare.com): sign up. Under _Domain Registration → Register_, buy the domain (at cost).
2. **Cloudflare R2:** enable it; a card is required, and it costs $0 within 10 GB.
   1. Create the bucket `vantage-backups`.
   2. Under _Manage R2 API tokens_, create a token with **Object Read & Write** on that bucket only.
   3. Keep the **Access Key ID**, **Secret Access Key** and the **endpoint** (`https://<account-id>.r2.cloudflarestorage.com`).
3. **Oracle Cloud** (cloud.oracle.com): sign up and choose a home region near you; it cannot be changed later.
   - Then **upgrade to Pay As You Go** (_Billing → Upgrade_). Always Free resources stay $0, and idle Always Free
     instances are no longer reclaimed.
   - Add a **budget alert at $1** (_Billing → Budgets_).
4. **healthchecks.io** (free): create a check `vantage-nightly`, period 1 day, grace 6 hours. Keep its **ping URL**.
5. **Uptime monitor** (UptimeRobot or Better Stack, free): add an HTTP check after go-live (1.6).
6. **Cloudflare Web Analytics** (optional, cookieless): add the site and keep the **token**.

### 1.2 The server

1. Oracle Console → _Compute → Instances → Create instance_:
   - image **Ubuntu 24.04** (aarch64), shape **VM.Standard.A1.Flex** with **2 OCPU, 12 GB**, boot volume **100 GB**;
   - paste your Mac's SSH public key (`cat ~/.ssh/id_ed25519.pub`; `ssh-keygen -t ed25519` if you have none).
   - "Out of capacity": try another availability domain, or again later.
2. In the instance's subnet security list, allow TCP 22 **from your home IP only** (break-glass access). Open
   nothing else: the tunnel needs no inbound port.
3. Log in and run the setup:

   ```bash
   ssh ubuntu@<server-ip>
   git clone https://github.com/KianGolshan/Private-Investment-NPORT-Analyzer.git ~/vantage-setup
   sudo bash ~/vantage-setup/deploy/setup.sh
   ```

   It installs Node 22, Caddy, cloudflared, rclone, fail2ban, automatic security updates (rebooting at 04:00 when
   needed) and swap. It creates the `vantage` user, asks for the settings below, installs the services, and builds
   the first release of `main` for production and staging.

   | Asked for                   | Example                                       |
   | --------------------------- | --------------------------------------------- |
   | Edge                        | `cloudflare`                                  |
   | Domain                      | `vantage-example.com`                         |
   | SEC user agent              | `Jane Doe jane@example.com` (SEC requirement) |
   | healthchecks.io ping URL    | `https://hc-ping.com/…`                       |
   | Uptime status page          | optional                                      |
   | Web Analytics token         | optional                                      |
   | R2 endpoint, key and secret | from 1.1                                      |

   It prints a **deploy SSH private key once**. Copy it into the GitHub secret `DEPLOY_SSH_KEY` (1.5).

### 1.3 The data

Load the warehouse from your Mac, which keeps every company id and URL identical. It takes about a minute to
publish.

```bash
npm run backup -- --list
```

```bash
scp ~/Vantage-backups/vantage-g<N>-<time>.db ~/Vantage-backups/vantage-g<N>-<time>.db.sha256 ubuntu@<server-ip>:/tmp/
```

On the server:

```bash
sudo mv /tmp/vantage-g*.db* /var/lib/vantage/incoming/ && sudo chown vantage: /var/lib/vantage/incoming/*
sudo vantage-run npm run backup -- --restore /var/lib/vantage/incoming/vantage-g<N>-<time>.db
sudo systemctl restart vantage@3003 vantage@3002
curl -s http://127.0.0.1:8080/readyz
```

(Without a backup to copy, the fallback is a full build on the server, about 45 minutes:
`sudo vantage-run npm run ingest:bulk -- --all`, then `sudo vantage-run npm run refresh`.)

### 1.4 The tunnel and DNS

```bash
sudo cloudflared tunnel login
sudo bash ~/vantage-setup/deploy/setup.sh --tunnel
```

`tunnel login` prints a link: open it and pick your domain. The second command creates the tunnel, the DNS records
for `<domain>`, `www.`, `staging.` and `ssh.`, and starts it. It prints the **`DEPLOY_KNOWN_HOSTS`** line for
GitHub.

Then, in the Cloudflare dashboard:

- **Zero Trust → Access → Applications:**
  - add a _Self-hosted_ app for `staging.<domain>`, with a policy that allows your email;
  - add one for `ssh.<domain>`, with two policies: your email, and _Service Auth_ with a service token.
- **Zero Trust → Access → Service credentials:** create the service token `github-deploy`. Keep its **Client ID**
  and **Client Secret**, and attach it to the `ssh.` app's Service Auth policy.
- **SSL/TLS:** Full (strict); _Always Use HTTPS_ on.
- **Security → WAF → Rate limiting rules** (one is free): URI path starts with `/api/`, 300 requests per 10 seconds
  per IP, block for 1 minute.
- **Caching → Cache Rules:** for `/api/*`, _Eligible for cache_ with the edge TTL _Use cache-control header_ (the
  app sends `s-maxage=300` and never caches errors). For `/assets/*`, _Eligible for cache_ (hashed files, immutable).
- Leave **Bot Fight Mode off**: it can challenge the uptime monitor and API calls.

### 1.5 GitHub

In the repository, under **Settings → Secrets and variables → Actions**:

| Kind     | Name                      | Value                                                 |
| -------- | ------------------------- | ----------------------------------------------------- |
| Secret   | `DEPLOY_HOST`             | `ssh.<domain>`                                        |
| Secret   | `DEPLOY_SSH_KEY`          | the private key setup.sh printed                      |
| Secret   | `DEPLOY_KNOWN_HOSTS`      | the line `setup.sh --tunnel` printed                  |
| Secret   | `CF_ACCESS_CLIENT_ID`     | the service token's Client ID                         |
| Secret   | `CF_ACCESS_CLIENT_SECRET` | the service token's Client Secret                     |
| Variable | `DEPLOY_ENABLED`          | `true` (turns on automatic deploys from main/staging) |

Also:

- **Settings → Environments:** `production` and `staging` are created by the first deploy. Optionally require your
  approval on `production`.
- **Settings → Branches:** protect `main`. Require a pull request and the checks: test, lint, web, e2e,
  deploy-scripts.
- **Settings → Code security:** Dependabot alerts and secret scanning on.

Check it: **Actions → Deploy → Run workflow** (production, `main`). It should end green with "already running …"
or "deployed".

### 1.6 Go live

1. `https://<domain>` loads; `https://<domain>/readyz` shows `"ready":true`.
2. From your Mac: `node scripts/smoke.js https://<domain>` passes every check.
3. Uptime monitor: an HTTP check on `https://<domain>/readyz?fresh=1` every 5 minutes. It fails when the data is
   over 48 h old or the last job failed. Put its public status page URL in `VANTAGE_STATUS_URL` (part 4).
4. Run one nightly by hand and watch it: `sudo systemctl start vantage-nightly && journalctl -fu vantage-nightly`.
   Then check that healthchecks.io shows a green ping and R2 has the backup.
5. Share the link. LinkedIn's Post Inspector shows the preview card.

---

## 2. Shipping changes

| You do                                               | What happens                                                                                                                                                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Push a branch, open a PR                             | CI: tests, lint, web, e2e, deploy scripts                                                                                                                                                               |
| Push to `staging` (optional)                         | After CI passes: deployed to `staging.<domain>` (only you can open it)                                                                                                                                  |
| Merge to `main`                                      | After CI passes: deployed to production. The release is built beside the running one, switched, the instances restart one at a time, and the smoke check runs. A failure puts the previous release back |
| (1A) Merge to `main`                                 | The server's auto-deploy sees it within 5 minutes of CI passing and deploys it the same way                                                                                                             |
| Actions → Deploy → Run workflow, ref `rollback`      | The previous release again (it is still on disk: seconds)                                                                                                                                               |
| Actions → Deploy → Run workflow, any full commit SHA | That commit                                                                                                                                                                                             |

Open tabs offer "A new version of Vantage is available · Reload". A deploy whose commit adds a migration or changes
`data/review` runs one review import job first, which migrates the warehouse and publishes a new generation.

**Curation stays local** (ADR 0008):

1. Edit `data/review` on your Mac.
2. Run `npm run review:aliases` and check the result there.
3. Commit, push and merge. The deploy re-imports the files on the server.

Admin actions are never on in production.

From your Mac, without GitHub (needs `cloudflared` locally, and your email allowed on the `ssh.` app):

```bash
ssh -o ProxyCommand="cloudflared access ssh --hostname %h" ubuntu@ssh.<domain>
```

On the server, `sudo -u vantage vantage-deploy deploy production main` deploys by hand, and
`sudo -u vantage vantage-deploy status production` shows what is running.

---

## 3. What runs on its own

| When                        | What                                                                                                                                                 | Where to look                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Every night, 06:15 New York | `vantage-nightly`: refresh from the SEC (a new generation), backup, R2 copy, watch report, doctor, smoke check; pings healthchecks.io (fail = email) | `journalctl -u vantage-nightly`, healthchecks.io, `/status`                         |
| The 3rd of each month       | `vantage-monthly`: EDGAR reconciliation and the LIVE regression                                                                                      | `journalctl -u vantage-monthly`; `sudo vantage-run npm run doctor` shows its result |
| After each new generation   | Each instance warms the new data beside the old one, then swaps (the second a minute later); open tabs update within seconds                         | `/status`                                                                           |
| Security updates            | Installed daily; reboot at 04:00 when needed (the services start on boot)                                                                            | `/var/log/unattended-upgrades/`                                                     |
| Every 5 minutes             | The uptime monitor checks `/readyz?fresh=1`                                                                                                          | its dashboard                                                                       |

---

## 4. Operating

| Task                                       | Command (on the server)                                                                                                                                                                                                                                                    |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Health of everything                       | `sudo vantage-run npm run doctor`                                                                                                                                                                                                                                          |
| Generations, last job                      | `sudo vantage-run npm run warehouse`                                                                                                                                                                                                                                       |
| Logs                                       | `journalctl -u vantage@3002 -u vantage@3003 --since today`, `journalctl -u vantage-nightly`, `/var/lib/vantage/deploy.log`, `/var/log/caddy/vantage.log`                                                                                                                   |
| Refresh now                                | `sudo systemctl start vantage-nightly`                                                                                                                                                                                                                                     |
| Change a setting                           | `sudoedit /etc/vantage/vantage.env`, then `sudo systemctl restart vantage@3003 vantage@3002 vantage-staging`                                                                                                                                                               |
| Rotate the SEC user agent, R2 or alert URL | the same; for R2 also `sudo bash ~/vantage-setup/deploy/setup.sh` (rewrites the rclone config from the env file)                                                                                                                                                           |
| Disk                                       | `df -h /`; the doctor warns when a job lacks room (two generations of ~0.6 GB, three backups, releases)                                                                                                                                                                    |
| Load test                                  | from your Mac: `node scripts/loadtest.js https://<domain> --users 50 --seconds 300`. One IP hits the per-visitor limits (1,500/min app, the WAF rule): run it against `http://127.0.0.1:8080` on the server for the origin, or raise `API_RATE_LIMIT_PER_MIN` for the test |

---

## 5. Recovery

**Bad deploy.** Run the Deploy workflow with ref `rollback`, or `sudo -u vantage vantage-deploy deploy production
rollback`. A deploy that fails its own checks has already rolled itself back.

**Bad data** (a refresh or import published something wrong):

```bash
sudo vantage-run npm run warehouse -- --rollback
```

This publishes the previous generation as a new one. The servers switch to it within about a minute.

**Restore drill** (target: under 30 minutes; run on staging hardware or after a disk loss):

```bash
sudo vantage-restore
```

It downloads the newest backup from R2, verifies its SHA-256, publishes it as a new generation and restarts the
instances. Then:

```bash
node scripts/smoke.js https://<domain>
```

The goldens must pass. Record the date and duration in STATUS.

**Server lost.** Create a new VM (1.2), run `setup.sh` with the same answers (they are in your password manager),
then `sudo vantage-restore` instead of 1.3, then `setup.sh --tunnel` (it re-uses the tunnel). In GitHub, update
only `DEPLOY_KNOWN_HOSTS` (and `DEPLOY_SSH_KEY`, which setup.sh prints anew).

**An instance keeps restarting.** Run `journalctl -u vantage@3002 -n 100`. Caddy sends traffic to the healthy
instance meanwhile. With no warehouse (`/readyz` says "warehouse unavailable"), restore it.
