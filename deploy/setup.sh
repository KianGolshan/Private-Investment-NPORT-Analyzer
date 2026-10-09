#!/usr/bin/env bash
# One-time (and re-runnable) setup of a Vantage server (P9, docs/DEPLOY.md).
# Ubuntu 24.04 (arm64 or amd64), run as root from a clone of the repository:
#
#   sudo bash setup.sh            # packages, user, config, services, first release
#   sudo bash setup.sh --tunnel   # cloudflare edge only, after `cloudflared tunnel login`
#
# Two edges (how visitors reach the server), asked once:
#   direct      a free DuckDNS name (or any name pointing here); Caddy serves HTTPS
#               itself on 80/443; the server deploys main on its own (vantage-autodeploy)
#   cloudflare  your own domain through Cloudflare Tunnel, CDN and Access; GitHub
#               Actions deploys over SSH (.github/workflows/deploy.yml)
# Answers are kept in /etc/vantage/vantage.env (mode 640, root:vantage);
# re-running keeps them. Safe to run again after a repository update.
set -Eeuo pipefail

REPO_URL=${VANTAGE_REPO_URL:-https://github.com/KianGolshan/Private-Investment-NPORT-Analyzer.git}
SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) # this deploy/ directory
ETC=/etc/vantage
ENV_FILE=$ETC/vantage.env
DATA=/var/lib/vantage
APP=/opt/vantage

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() {
  echo "setup: $*" >&2
  exit 1
}
[[ $EUID -eq 0 ]] || die "run as root: sudo bash $0"
. /etc/os-release
[[ ${ID:-} == ubuntu ]] || echo "warning: tested on Ubuntu 24.04; this is ${PRETTY_NAME:-unknown}"

# The value of KEY in the env file, if set.
current() { [[ -f $ENV_FILE ]] && sed -n "s/^$1=\"\(.*\)\"$/\1/p" "$ENV_FILE" | tail -n 1; }
# Asks for KEY unless it is already set; rejects characters that would break the file.
ask() {
  local key=$1 prompt=$2 secret=${3:-} value
  value=$(current "$key")
  if [[ -n $value ]]; then
    printf '%s' "$value"
    return
  fi
  while :; do
    if [[ $secret == secret ]]; then read -rsp "$prompt: " value </dev/tty && echo >/dev/tty; else read -rp "$prompt: " value </dev/tty; fi
    [[ $value =~ [\"\$\`\\] ]] && {
      echo "quotes, \$, backticks and backslashes are not allowed" >/dev/tty
      continue
    }
    printf '%s' "$value"
    return
  done
}

tunnel_setup() {
  local domain id
  domain=$(current VANTAGE_DOMAIN)
  [[ -n $domain ]] || die "run setup.sh without --tunnel first"
  [[ $(current VANTAGE_EDGE) == cloudflare ]] || die "--tunnel is for the cloudflare edge (this server uses: $(current VANTAGE_EDGE))"
  [[ -f /root/.cloudflared/cert.pem ]] || die "run 'cloudflared tunnel login' first (opens a link to pick $domain)"
  say "Cloudflare Tunnel for $domain"
  if ! cloudflared tunnel info vantage >/dev/null 2>&1; then cloudflared tunnel create vantage; fi
  id=$(cloudflared tunnel list --output json | jq -r '.[] | select(.name == "vantage") | .id')
  [[ $id =~ ^[0-9a-f-]{36}$ ]] || die "could not read the tunnel id"
  install -d -m 755 /etc/cloudflared
  install -m 600 "/root/.cloudflared/$id.json" "/etc/cloudflared/$id.json"
  sed -e "s/__TUNNEL_ID__/$id/g" -e "s/__DOMAIN__/$domain/g" "$SRC/cloudflared.yml" >/etc/cloudflared/config.yml
  cloudflared tunnel ingress validate --config /etc/cloudflared/config.yml
  for host in "$domain" "www.$domain" "staging.$domain" "ssh.$domain"; do
    cloudflared tunnel route dns --overwrite-dns vantage "$host"
  done
  if [[ ! -f /etc/systemd/system/cloudflared.service ]]; then cloudflared service install; fi
  systemctl enable --now cloudflared
  systemctl restart cloudflared
  say "Tunnel up. Next (docs/DEPLOY.md): Cloudflare Access for staging.$domain and ssh.$domain, then GitHub secrets."
  echo "DEPLOY_KNOWN_HOSTS secret (one line):"
  echo "ssh.$domain $(cut -d' ' -f1-2 /etc/ssh/ssh_host_ed25519_key.pub)"
}

if [[ ${1:-} == --tunnel ]]; then
  tunnel_setup
  exit 0
fi

say "Packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q ca-certificates curl gnupg git jq sqlite3 build-essential python3 rclone fail2ban \
  unattended-upgrades debian-keyring debian-archive-keyring apt-transport-https
# Node.js 22 (NodeSource)
if ! command -v node >/dev/null || [[ $(node -p 'process.versions.node.split(".")[0]') -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -q nodejs
fi
# Caddy (official repository)
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt >/etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q && apt-get install -y -q caddy
fi
# cloudflared (official repository)
if ! command -v cloudflared >/dev/null; then
  install -d -m 755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
  echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
    >/etc/apt/sources.list.d/cloudflared.list
  apt-get update -q && apt-get install -y -q cloudflared
fi

say "Security updates (automatic, reboot at 04:00 when needed), fail2ban, swap"
cat >/etc/apt/apt.conf.d/52vantage-upgrades <<'EOF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:00";
EOF
systemctl enable --now unattended-upgrades fail2ban
if ! swapon --show | grep -q .; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi

say "The vantage user and directories"
id vantage >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --shell /bin/bash vantage
# no password, but not locked: key-only SSH (the deploy key's forced command) must work
usermod -p '*' vantage
install -d -o vantage -g vantage -m 750 "$DATA" "$DATA/backups" "$DATA/incoming" "$DATA/.ssh"
install -d -o vantage -g vantage -m 755 "$APP" "$APP/prod" "$APP/staging"
install -d -m 750 -g vantage "$ETC"
if [[ ! -d $APP/repo/.git ]]; then sudo -u vantage git clone --quiet "$REPO_URL" "$APP/repo"; fi
sudo -u vantage git -C "$APP/repo" fetch --quiet --prune origin

say "Configuration ($ENV_FILE)"
EDGE=$(ask VANTAGE_EDGE "Edge: 'direct' (free DuckDNS name, no domain) or 'cloudflare' (your own domain)")
[[ $EDGE =~ ^(direct|cloudflare)$ ]] || die "the edge must be direct or cloudflare, not '$EDGE'"
if [[ $EDGE == direct ]]; then
  DOMAIN=$(ask VANTAGE_DOMAIN "Hostname (e.g. vantage-yourname.duckdns.org)")
else
  DOMAIN=$(ask VANTAGE_DOMAIN "Domain (e.g. vantage-example.com, no https://)")
fi
[[ $DOMAIN =~ ^[a-z0-9.-]+\.[a-z]{2,}$ ]] || die "not a hostname: $DOMAIN"
DUCKDNS=
if [[ $DOMAIN == *.duckdns.org ]]; then
  DUCKDNS=$(ask DUCKDNS_TOKEN "DuckDNS token (shown at the top of duckdns.org after you sign in)" secret)
  [[ $DUCKDNS =~ ^[0-9a-f-]{36}$ ]] || die "a DuckDNS token looks like 8-4-4-4-12 hex digits"
fi
UA=$(ask SEC_USER_AGENT "SEC user agent: your name and email (e.g. Jane Doe jane@example.com)")
[[ $UA =~ @ ]] || die "the SEC user agent must include an email"
ALERT=$(ask VANTAGE_ALERT_URL "healthchecks.io ping URL (https://hc-ping.com/...)")
STATUS_URL=$(ask VANTAGE_STATUS_URL "Public uptime status page URL (optional, Enter to skip)")
ANALYTICS=$(ask VANTAGE_ANALYTICS_TOKEN "Cloudflare Web Analytics token (optional, Enter to skip)")
# Off-site backups to Cloudflare R2 (free, no domain needed): optional; without
# them backups stay on this server and the doctor says so.
R2_ENDPOINT=$(ask VANTAGE_R2_ENDPOINT "R2 endpoint for off-site backups (https://<account-id>.r2.cloudflarestorage.com; Enter to skip)")
R2_KEY= R2_SECRET= R2_BUCKET= OFFSITE=
if [[ -n $R2_ENDPOINT ]]; then
  R2_KEY=$(ask VANTAGE_R2_ACCESS_KEY_ID "R2 access key id")
  R2_SECRET=$(ask VANTAGE_R2_SECRET_ACCESS_KEY "R2 secret access key" secret)
  R2_BUCKET=$(ask VANTAGE_R2_BUCKET "R2 bucket name (Enter for vantage-backups)")
  R2_BUCKET=${R2_BUCKET:-vantage-backups}
  OFFSITE=/usr/local/bin/vantage-offsite
fi
CDN_MAX_AGE=300
[[ $EDGE == direct ]] && CDN_MAX_AGE=0 # no shared cache in front
umask 027
cat >"$ENV_FILE.tmp" <<EOF
# Vantage service configuration (written by deploy/setup.sh; secrets: keep private).
NODE_ENV="production"
HOST="127.0.0.1"
TRUST_PROXY="1"
VANTAGE_PUBLIC="1"
VANTAGE_CDN_MAX_AGE="$CDN_MAX_AGE"
VANTAGE_NOTIFY="0"
VANTAGE_EDGE="$EDGE"
VANTAGE_DOMAIN="$DOMAIN"
DUCKDNS_TOKEN="$DUCKDNS"
VANTAGE_GITHUB_REPO="$(sed -E 's#^https://github.com/##; s#\.git$##' <<<"$REPO_URL")"
VANTAGE_PUBLIC_URL="https://$DOMAIN"
VANTAGE_SMOKE_URL="http://127.0.0.1:8080"
SEC_USER_AGENT="$UA"
WAREHOUSE_DB_PATH="$DATA/warehouse.db"
CACHE_DB_PATH="$DATA/cache.db"
VANTAGE_BACKUP_DIR="$DATA/backups"
VANTAGE_OFFSITE_CMD="$OFFSITE"
VANTAGE_ALERT_URL="$ALERT"
VANTAGE_STATUS_URL="$STATUS_URL"
VANTAGE_ANALYTICS_TOKEN="$ANALYTICS"
VANTAGE_R2_ENDPOINT="$R2_ENDPOINT"
VANTAGE_R2_ACCESS_KEY_ID="$R2_KEY"
VANTAGE_R2_SECRET_ACCESS_KEY="$R2_SECRET"
VANTAGE_R2_BUCKET="$R2_BUCKET"
EOF
install -m 640 -o root -g vantage "$ENV_FILE.tmp" "$ENV_FILE" && rm -f "$ENV_FILE.tmp"
umask 022
# the second instance warms a new generation a minute after the first
printf 'VANTAGE_WARM_DELAY_MS="60000"\n' >"$ETC/instance-3003.env"
# rclone's R2 remote, for the vantage user
install -d -o vantage -g vantage -m 700 "$DATA/.config" "$DATA/.config/rclone"
[[ -n $R2_ENDPOINT ]] && cat >"$DATA/.config/rclone/rclone.conf" <<EOF
[r2]
type = s3
provider = Cloudflare
access_key_id = $R2_KEY
secret_access_key = $R2_SECRET
endpoint = $R2_ENDPOINT
acl = private
EOF
if [[ -f $DATA/.config/rclone/rclone.conf ]]; then
  chown vantage:vantage "$DATA/.config/rclone/rclone.conf" && chmod 600 "$DATA/.config/rclone/rclone.conf"
fi

say "Programs, services, Caddy"
install -m 755 "$SRC"/bin/vantage-* /usr/local/bin/
install -m 644 "$SRC"/systemd/*.service "$SRC"/systemd/*.timer /etc/systemd/system/
CADDYFILE=$SRC/Caddyfile
[[ $EDGE == direct ]] && CADDYFILE=$SRC/Caddyfile.direct
sed "s/__DOMAIN__/$DOMAIN/g" "$CADDYFILE" >/etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
cat >/etc/sudoers.d/vantage-deploy <<'EOF'
# deploy.sh restarts the app instances, and nothing else (P9)
vantage ALL=(root) NOPASSWD: /usr/bin/systemctl restart vantage@3002, /usr/bin/systemctl restart vantage@3003, /usr/bin/systemctl restart vantage-staging
EOF
chmod 440 /etc/sudoers.d/vantage-deploy
visudo -cf /etc/sudoers.d/vantage-deploy
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/vantage@.service /etc/systemd/system/vantage-nightly.service \
  /etc/systemd/system/vantage-monthly.service || true
systemctl enable caddy vantage@3002 vantage@3003 vantage-staging vantage-nightly.timer vantage-monthly.timer

if [[ $EDGE == direct ]]; then
  say "Direct edge: DuckDNS, ports 80 and 443, auto-deploy"
  if [[ -n $DUCKDNS ]]; then vantage-duckdns || echo "warning: the DuckDNS update failed; check the name and token"; fi
  # Oracle's Ubuntu images reject everything but SSH in iptables; open the two
  # web ports (Let's Encrypt needs 80) and keep them across reboots.
  for port in 80 443; do
    iptables -C INPUT -p tcp --dport "$port" -m conntrack --ctstate NEW -j ACCEPT 2>/dev/null ||
      iptables -I INPUT -p tcp --dport "$port" -m conntrack --ctstate NEW -j ACCEPT
  done
  if command -v netfilter-persistent >/dev/null; then netfilter-persistent save; fi
  if command -v ufw >/dev/null && ufw status | grep -q 'Status: active'; then ufw allow 80/tcp && ufw allow 443/tcp; fi
  systemctl enable vantage-autodeploy.timer vantage-duckdns.timer
else
  systemctl disable --now vantage-autodeploy.timer vantage-duckdns.timer 2>/dev/null || true
fi
systemctl restart caddy

KEYS=$DATA/.ssh/authorized_keys
if [[ $EDGE == direct ]]; then
  : # deploys are pulled by vantage-autodeploy: no deploy key
elif ! grep -q 'vantage-github-deploy' "$KEYS" 2>/dev/null; then
  say "Deploy key for GitHub Actions (forced command: vantage-deploy only)"
  tmpk=$(mktemp -d)
  ssh-keygen -q -t ed25519 -N '' -C vantage-github-deploy -f "$tmpk/key"
  echo "command=\"/usr/local/bin/vantage-deploy\",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty $(cat "$tmpk/key.pub")" >>"$KEYS"
  chown vantage:vantage "$KEYS" && chmod 600 "$KEYS"
  echo "DEPLOY_SSH_KEY secret: copy everything between the lines (shown once, then deleted):"
  echo "----------------------------------------------------------------"
  cat "$tmpk/key"
  echo "----------------------------------------------------------------"
  rm -rf "$tmpk"
else
  echo "already installed (to replace it: remove the vantage-github-deploy line from $KEYS and re-run)"
fi

say "First release"
# Builds main for production and staging and starts them (no data yet, so
# readiness and the smoke check are skipped: FIRST=1). Later deploys come from
# GitHub Actions or `sudo -u vantage vantage-deploy deploy production main`.
for target in production staging; do
  dir=$APP/prod
  [[ $target == staging ]] && dir=$APP/staging
  [[ -L $dir/current ]] && continue
  sha=$(sudo -u vantage git -C "$APP/repo" rev-parse origin/main)
  first=$(mktemp)
  # as the repository's owner: git refuses a repository owned by another user
  sudo -u vantage git -C "$APP/repo" show "$sha:deploy/deploy.sh" >"$first"
  chmod 644 "$first"
  sudo -u vantage -H env FIRST=1 bash "$first" "$target" "$sha"
  rm -f "$first"
done
systemctl start vantage-nightly.timer vantage-monthly.timer
[[ $EDGE == direct ]] && systemctl start vantage-autodeploy.timer vantage-duckdns.timer

say "Done"
echo "Next (docs/DEPLOY.md):"
echo "  1. Load the data: copy a backup from your Mac to $DATA/incoming/ (scp), then"
echo "       sudo vantage-run npm run backup -- --restore $DATA/incoming/<file>.db"
echo "       sudo systemctl restart vantage@3003 vantage@3002"
if [[ $EDGE == direct ]]; then
  echo "  2. Open TCP 80 and 443 to 0.0.0.0/0 in the instance's Oracle security list (VCN), then open https://$DOMAIN"
else
  echo "  2. The tunnel: sudo cloudflared tunnel login && sudo bash $SRC/setup.sh --tunnel"
fi
echo "  3. Check: curl -s http://127.0.0.1:8080/readyz && sudo vantage-run npm run doctor"
