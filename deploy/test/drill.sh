#!/usr/bin/env bash
# check '<condition>' below expands its variables when it runs (eval), on purpose:
# shellcheck disable=SC2016,SC2034
# The deploy drill (P9 W3; CI job deploy-drill). Runs the real vantage-deploy
# and deploy.sh in a temporary tree on Linux, with real server processes over
# the golden warehouse (a fake systemctl starts them), and checks:
#   1. a first deploy serves the commit on both instances;
#   2. a new commit that changes data/review runs the review import job (a new
#      generation), switches, and records the previous release;
#   3. a broken commit fails its readiness check and puts the previous release back;
#   4. "rollback" deploys the recorded previous release again;
#   5. status reports what runs;
#   6. vantage-autodeploy (the direct edge) waits for a green Test run, deploys
#      main's new commit, does nothing twice, and does not retry a failed one.
# Needs: bash, git, node with this repository's npm ci, curl, flock (Linux).
set -Eeuo pipefail

SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
T=$(mktemp -d "${TMPDIR:-/tmp}/vantage-drill-XXXXXX")
export VANTAGE_APP=$T/app
export VANTAGE_DATA=$T/data
export VANTAGE_ENV_FILE=$T/vantage.env
export VANTAGE_SYSTEMCTL=$SRC/deploy/test/fake-systemctl
export VANTAGE_DEPLOY_SMOKE_URL=http://127.0.0.1:3002
export VANTAGE_DEPLOY_SMOKE_ARGS=--no-goldens
export VANTAGE_DEPLOY_READY_TRIES=30
export VANTAGE_DEPLOY_LOCK_WAIT=60
GIT=(git -c user.name=drill -c user.email=drill@example.com -c init.defaultBranch=main)

cleanup() {
  local code=$?
  for f in "$VANTAGE_DATA"/run/*.pid; do
    if [[ -f $f ]]; then kill "$(cat "$f")" 2>/dev/null || true; fi
  done
  if [[ $code -ne 0 ]]; then
    echo "---- deploy.log"
    cat "$VANTAGE_DATA/deploy.log" 2>/dev/null || true
    for f in "$VANTAGE_DATA"/run/*.log; do
      echo "---- $f"
      tail -n 30 "$f"
    done
  fi
  rm -rf "$T"
  exit "$code"
}
trap cleanup EXIT

step() { printf '\n\033[1m== drill: %s\033[0m\n' "$*"; }
check() {
  if ! eval "$1"; then
    echo "drill FAILED: $2" >&2
    exit 1
  fi
  echo "ok: $2"
}
deploy() { SSH_ORIGINAL_COMMAND="$*" bash "$SRC/deploy/bin/vantage-deploy"; }
build_of() { curl -fsS "http://127.0.0.1:$1/healthz" | node -pe 'JSON.parse(require("fs").readFileSync(0)).build'; }
generation() { curl -fsS "http://127.0.0.1:3002/readyz" | node -pe 'JSON.parse(require("fs").readFileSync(0)).generation'; }
current() { basename "$(readlink -f "$VANTAGE_APP/prod/current")"; }

step "layout, origin and warehouse"
mkdir -p "$VANTAGE_APP/prod" "$VANTAGE_APP/staging" "$VANTAGE_DATA/run"
# origin: a bare repository holding this checkout's commit as main (CI checks out
# a detached merge commit for a pull request; full history: fetch-depth 0)
"${GIT[@]}" init -q --bare "$T/origin.git"
git -C "$SRC" push -q "$T/origin.git" HEAD:refs/heads/main
"${GIT[@]}" clone -q "$T/origin.git" "$VANTAGE_APP/repo"
"${GIT[@]}" clone -q "$T/origin.git" "$T/work"
cat >"$VANTAGE_ENV_FILE" <<EOF
NODE_ENV="production"
HOST="127.0.0.1"
VANTAGE_PUBLIC="1"
SEC_USER_AGENT="Vantage deploy drill drill@example.com"
WAREHOUSE_DB_PATH="$VANTAGE_DATA/warehouse.db"
CACHE_DB_PATH="$VANTAGE_DATA/cache.db"
EOF
(cd "$SRC" && WAREHOUSE=$VANTAGE_DATA/warehouse.db node deploy/test/make-warehouse.js)
A=$(git -C "$T/work" rev-parse HEAD)

step "1. first deploy of $A"
deploy deploy production "$A"
check '[[ $(current) == "$A" ]]' "current is A"
check '[[ $(build_of 3002) == "$A" && $(build_of 3003) == "$A" ]]' "both instances run A"
check 'grep -q "APP_BUILD=$A" "$VANTAGE_DATA/build-production.env"' "APP_BUILD recorded"
check '[[ ! -f $VANTAGE_DATA/previous-production ]]' "no previous release yet"
GEN_A=$(generation)

step "2. a commit that changes data/review"
(
  cd "$T/work"
  node -e 'const f="data/review/curation.json";const fs=require("fs");fs.writeFileSync(f,JSON.stringify(JSON.parse(fs.readFileSync(f,"utf8")),null,1)+"\n")'
  "${GIT[@]}" commit -qam "drill: reformat curation.json"
  "${GIT[@]}" push -q origin HEAD:refs/heads/drill-b
)
B=$(git -C "$T/work" rev-parse HEAD)
deploy deploy production "$B"
check '[[ $(current) == "$B" ]]' "current is B"
check '[[ $(build_of 3002) == "$B" && $(build_of 3003) == "$B" ]]' "both instances run B"
check '[[ $(cat "$VANTAGE_DATA/previous-production") == "$A" ]]' "previous release is A"
check 'grep -q "running the review import job" "$VANTAGE_DATA/deploy.log"' "the review import ran"
check '[[ $(generation) -gt $GEN_A ]] || { sleep 20; [[ $(generation) -gt $GEN_A ]]; }' "a new generation is served"
check '[[ -d $VANTAGE_APP/prod/releases/$A ]]' "release A kept for rollback"

step "3. a broken commit rolls itself back"
(
  cd "$T/work"
  printf "throw new Error('drill: a broken release');\n" | cat - server.js >server.tmp && mv server.tmp server.js
  "${GIT[@]}" commit -qam "drill: broken server"
  "${GIT[@]}" push -q origin HEAD:refs/heads/drill-c
)
C=$(git -C "$T/work" rev-parse HEAD)
if deploy deploy production "$C"; then
  echo "drill FAILED: the broken deploy succeeded" >&2
  exit 1
fi
check '[[ $(current) == "$B" ]]' "current is B again"
check '[[ $(build_of 3002) == "$B" && $(build_of 3003) == "$B" ]]' "both instances serve B"
check 'grep -q "rolled back; the previous release is serving" "$VANTAGE_DATA/deploy.log"' "the rollback is logged"
check '[[ $(cat "$VANTAGE_DATA/previous-production") == "$A" ]]' "a failed deploy leaves the rollback target alone"

step "4. rollback"
deploy deploy production rollback
check '[[ $(current) == "$A" ]]' "current is A"
check '[[ $(build_of 3002) == "$A" ]]' "A serves"
check '[[ $(cat "$VANTAGE_DATA/previous-production") == "$B" ]]' "previous is now B"

step "5. status, and a deploy of what already runs"
deploy status production | tee "$T/status.txt"
check 'grep -q "release: $A" "$T/status.txt"' "status names the release"
deploy deploy production "$A"
check 'tail -n 1 "$VANTAGE_DATA/deploy.log" | grep -q "nothing to do"' "re-deploying the running commit is a no-op"

step "6. auto-deploy from main (the direct edge)"
export VANTAGE_DEPLOY_BIN=$SRC/deploy/bin/vantage-deploy VANTAGE_CI_JSON=$T/ci.json
(
  cd "$T/work"
  git checkout -q -B drill-d "$A"
  echo "drill" >DRILL.md
  git add DRILL.md
  "${GIT[@]}" commit -qm "drill: a new commit on main"
  git push -q origin HEAD:refs/heads/main
)
D=$(git -C "$T/work" rev-parse HEAD)
ci() { printf '{"workflow_runs":[{"name":"%s","head_sha":"%s","conclusion":"%s"}]}' "$1" "$2" "$3" >"$T/ci.json"; }
ci Test "$D" failure
bash "$SRC/deploy/bin/vantage-autodeploy" | tee "$T/auto.txt"
check 'grep -q "waiting: the Test workflow has not passed" "$T/auto.txt" && [[ $(current) == "$A" ]]' "a commit without a green Test run waits"
ci Lint "$D" success
bash "$SRC/deploy/bin/vantage-autodeploy" >/dev/null
check '[[ $(current) == "$A" ]]' "another workflow's success does not count"
ci Test "$D" success
bash "$SRC/deploy/bin/vantage-autodeploy"
check '[[ $(current) == "$D" && $(build_of 3002) == "$D" ]]' "main's green commit is deployed"
lines=$(wc -l <"$VANTAGE_DATA/deploy.log")
bash "$SRC/deploy/bin/vantage-autodeploy"
check '[[ $(wc -l <"$VANTAGE_DATA/deploy.log") == "$lines" ]]' "nothing happens when main is already deployed"
(
  cd "$T/work"
  printf "throw new Error('drill: broken on main');\n" | cat - server.js >server.tmp && mv server.tmp server.js
  "${GIT[@]}" commit -qam "drill: broken on main"
  git push -q origin HEAD:refs/heads/main
)
E=$(git -C "$T/work" rev-parse HEAD)
ci Test "$E" success
if bash "$SRC/deploy/bin/vantage-autodeploy"; then
  echo "drill FAILED: the broken auto-deploy succeeded" >&2
  exit 1
fi
check '[[ $(current) == "$D" && $(cat "$VANTAGE_DATA/autodeploy-failed-production") == "$E" ]]' "a failed auto-deploy keeps D and remembers E"
lines=$(wc -l <"$VANTAGE_DATA/deploy.log")
bash "$SRC/deploy/bin/vantage-autodeploy"
check '[[ $(wc -l <"$VANTAGE_DATA/deploy.log") == "$lines" ]]' "a failed commit is not retried"

step "passed"
