#!/usr/bin/env bash
# Deploys one commit to production or staging (P9, docs/DEPLOY.md). Run by
# vantage-deploy (deploy/bin) as the vantage user, from the commit being
# deployed. Zero downtime: the new release is built beside the running one,
# switched in one step, the instances restart one at a time behind Caddy, and a
# failed readiness or smoke check puts the previous release back.
#
#   deploy.sh <production|staging> <40-hex sha>
#
# Layout:
#   /opt/vantage/repo                       git clone (fetch only)
#   /opt/vantage/<prod|staging>/releases/   one git worktree per commit (provenance: git rev-parse works)
#   /opt/vantage/<prod|staging>/current     link to the release the services run
#   /var/lib/vantage                        the warehouse, backups, cache, logs: never touched by a deploy
set -Eeuo pipefail

TARGET=${1:?target}
SHA=${2:?sha}
[[ $TARGET =~ ^(production|staging)$ ]] || {
  echo "bad target $TARGET" >&2
  exit 2
}
[[ $SHA =~ ^[0-9a-f]{40}$ ]] || {
  echo "bad sha $SHA" >&2
  exit 2
}

# The paths below; the deploy drill (deploy/test/drill.sh, CI) points them at a
# temporary tree. An SSH client cannot set them (sshd passes no client environment).
APP_ROOT=${VANTAGE_APP:-/opt/vantage}
REPO=$APP_ROOT/repo
DATA=${VANTAGE_DATA:-/var/lib/vantage}
ENV_FILE=${VANTAGE_ENV_FILE:-/etc/vantage/vantage.env}
KEEP=4 # releases kept per target (the current one and the rollback target among them)
ASSET_DAYS=14 # a previous build's code chunks stay this long, for tabs left open
if [[ $TARGET == production ]]; then
  DIR=$APP_ROOT/prod
  UNITS=(vantage@3003 vantage@3002) # the second instance first: it warms later (VANTAGE_WARM_DELAY_MS)
  PORTS=(3003 3002)
  SMOKE_URL=${VANTAGE_DEPLOY_SMOKE_URL:-http://127.0.0.1:8080} # through Caddy, as visitors arrive
else
  DIR=$APP_ROOT/staging
  UNITS=(vantage-staging)
  PORTS=(3010)
  SMOKE_URL=${VANTAGE_DEPLOY_SMOKE_URL:-http://127.0.0.1:3010}
fi
# --no-goldens only in the drill, whose test warehouse is not the live one
read -r -a SMOKE_ARGS <<<"${VANTAGE_DEPLOY_SMOKE_ARGS:-}"
REL=$DIR/releases/$SHA
LOG=$DATA/deploy.log

log() { printf '%s [%s %s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$TARGET" "${SHA:0:12}" "$*" | tee -a "$LOG"; }
fail() {
  log "FAILED: $*"
  exit 1
}

# One deploy per target at a time; a second waits up to 30 minutes.
exec 9>"$DATA/deploy-$TARGET.lock"
flock -w "${VANTAGE_DEPLOY_LOCK_WAIT:-1800}" 9 || fail "another $TARGET deploy holds the lock"

# (readlink -f prints a path even when the link is missing: check the link first)
PREV=
if [[ -L $DIR/current ]]; then PREV=$(readlink -f "$DIR/current"); fi
PREV_SHA=$(basename "${PREV:-none}")
if [[ $PREV_SHA == "$SHA" && ${FORCE:-} != 1 ]]; then
  log "already running $SHA; nothing to do"
  exit 0
fi
log "deploying (previous: ${PREV_SHA:0:12})"

# Runs a command in a release with the service environment.
in_release() {
  local rel=$1
  shift
  (
    set -a
    # shellcheck source=/dev/null
    . "$ENV_FILE"
    set +a
    cd "$rel"
    "$@"
  )
}

wait_ready() {
  local port=$1 i
  for i in $(seq 1 "${VANTAGE_DEPLOY_READY_TRIES:-90}"); do
    if curl -fsS -o /dev/null --max-time 3 "http://127.0.0.1:$port/readyz"; then return 0; fi
    sleep 2
  done
  return 1
}

# FIRST=1 (setup.sh, before any data is loaded): start without waiting for
# readiness and skip the smoke check; there is no warehouse to be ready with.
restart_all() {
  local i
  for i in "${!UNITS[@]}"; do
    # 9>&-: nothing started here may hold the deploy lock
    if [[ -n ${VANTAGE_SYSTEMCTL:-} ]]; then
      "$VANTAGE_SYSTEMCTL" restart "${UNITS[$i]}" 9>&-
    else
      sudo /usr/bin/systemctl restart "${UNITS[$i]}" 9>&-
    fi
    [[ ${FIRST:-} == 1 ]] && continue
    wait_ready "${PORTS[$i]}" || return 1
  done
}

switch_to() {
  ln -sfn "$1" "$DIR/current.next"
  mv -Tf "$DIR/current.next" "$DIR/current"
  printf 'APP_BUILD=%s\n' "$(basename "$1")" >"$DATA/build-$TARGET.env"
}

SWITCHED=0
rollback() {
  local code=$?
  trap - ERR EXIT
  if [[ $code -ne 0 && $SWITCHED == 1 && -n $PREV && -d $PREV ]]; then
    log "rolling back to ${PREV_SHA:0:12}"
    switch_to "$PREV"
    if restart_all; then log "rolled back; the previous release is serving"; else log "ROLLBACK FAILED: check journalctl -u vantage@3002"; fi
  fi
  exit "$code"
}
trap rollback EXIT
trap 'fail "line $LINENO: $BASH_COMMAND"' ERR

# 1. Build the release (a git worktree, so the jobs can record the commit).
if [[ ! -f $REL/.vantage-built ]]; then
  log "building release"
  rm -rf "$REL"
  git -C "$REPO" worktree prune
  mkdir -p "$DIR/releases"
  git -C "$REPO" worktree add --force --detach "$REL" "$SHA" >/dev/null
  (cd "$REL" && npm ci --no-audit --no-fund --loglevel=error)
  (cd "$REL/web" && npm ci --no-audit --no-fund --loglevel=error)
  (cd "$REL" && npm run --silent build:web >/dev/null)
  # this build's own chunks, never pruned below (a rollback to an old release keeps them)
  (cd "$REL/web/dist/assets" && ls -1) >"$REL/.vantage-assets"
  touch "$REL/.vantage-built"
fi
# Tabs left open still ask for the previous build's chunks: keep those a while
# beside this build's own.
if [[ -n $PREV && -d $PREV/web/dist/assets ]]; then
  cp -an "$PREV/web/dist/assets/." "$REL/web/dist/assets/" 2>/dev/null || true
  find "$REL/web/dist/assets" -type f -mtime +"$ASSET_DAYS" -print | while read -r f; do
    grep -qxF "$(basename "$f")" "$REL/.vantage-assets" || rm -f "$f"
  done
fi

# 2. Data that must change with the code (production only; staging reads
# production's warehouse). A new migration or reviewed files run one review
# import job, which migrates the warehouse and re-imports data/review as a new
# generation; the running servers switch to it on their own. Retried while the
# nightly job holds the warehouse lock.
if [[ $TARGET == production && -n $PREV ]]; then
  if ! git -C "$REPO" diff --quiet "$PREV_SHA" "$SHA" -- db/migrations data/review 2>/dev/null; then
    log "migrations or reviewed files changed: running the review import job"
    ok=0
    for attempt in 1 2 3 4 5 6; do
      if in_release "$REL" node scripts/review-aliases.js >>"$LOG" 2>&1; then
        ok=1
        break
      fi
      log "review import attempt $attempt failed; retrying in 60 s"
      sleep 60
    done
    [[ $ok == 1 ]] || fail "the review import job failed (see $LOG); nothing was switched"
  fi
fi

# 3. Switch and restart one instance at a time (Caddy sends traffic to the other).
switch_to "$REL"
SWITCHED=1
log "switched; restarting ${UNITS[*]}"
restart_all || fail "an instance did not become ready"

# 4. What visitors get: health, goldens, headers, public mode.
if [[ ${FIRST:-} == 1 ]]; then
  log "first deploy: readiness and smoke skipped (load the data next, docs/DEPLOY.md)"
else
  log "smoke check on $SMOKE_URL"
  in_release "$REL" node scripts/smoke.js "$SMOKE_URL" "${SMOKE_ARGS[@]}" >>"$LOG" 2>&1 || fail "smoke check failed (see $LOG)"
fi

# 5. Done: remember the rollback target, prune old releases.
if [[ -n $PREV && $PREV_SHA != none ]]; then echo "$PREV_SHA" >"$DATA/previous-$TARGET"; fi
SWITCHED=0
log "deployed"
# shellcheck disable=SC2012 # release names are hex shas
ls -1dt "$DIR"/releases/*/ 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  old=${old%/}
  [[ $old == "$REL" || $old == "$PREV" ]] && continue
  git -C "$REPO" worktree remove --force "$old" 2>/dev/null || rm -rf "$old"
  log "removed old release $(basename "$old" | cut -c1-12)"
done
git -C "$REPO" worktree prune
