#!/usr/bin/env bash
#
# The single deploy path for MetaConsole. Run it ON the droplet, and always pass the commit you
# expect to ship so a forgotten push fails loudly instead of silently deploying someone else's HEAD:
#
#   ssh <droplet> "EXPECT=$(git rev-parse HEAD) bash /opt/meta-dashboard/deploy/deploy.sh"
#
# IMPORTANT: this checkout's `origin` is the LOCAL bare repo /opt/meta.git, not GitHub. Code only
# reaches the server via `git push droplet <branch>` from a workstation. Pushing to GitHub alone
# changes nothing here — which is exactly what EXPECT catches.
#
# Both operators may deploy. Concurrent deploys are the hazard this script exists to remove:
# there is one checkout, one `.output/` build directory, and `meta-web` boots straight from
# `.output/server/index.mjs`, so two overlapping deploys can restart the service onto a
# half-written build. The flock below makes a second deploy wait instead of interleaving.
set -euo pipefail

# The whole body lives in a function so bash parses the file completely before executing any
# of it — otherwise the `git pull` below could rewrite this script while it is still being read.
main() {
  local app_dir="${APP_DIR:-/opt/meta-dashboard}"
  local branch="${BRANCH:-feat/meta-integration}"
  local remote="${REMOTE:-origin}"
  local lock="/var/lock/meta-deploy.lock"
  local health="http://127.0.0.1:8787/login"

  command -v bun >/dev/null || {
    echo "deploy: bun not found on PATH" >&2
    exit 1
  }
  cd "$app_dir"

  # Wait rather than fail: a queued deploy is almost always what the operator wants.
  exec 9>"$lock"
  echo "deploy: acquiring lock…"
  flock -w 600 9 || {
    echo "deploy: another deploy held the lock for over 10 minutes; aborting" >&2
    exit 1
  }

  local before after
  before="$(git rev-parse HEAD)"
  echo "deploy: pulling $remote/$branch (at ${before:0:8})"
  # --ff-only: never invent a merge commit on the server. If this fails, someone committed
  # directly on the droplet and that needs a human, not an automatic merge.
  git pull --ff-only "$remote" "$branch"
  after="$(git rev-parse HEAD)"

  # A forgotten `git push droplet` is the failure this guards: without it the pull is a no-op and the
  # deploy would happily rebuild and restart on stale code, reporting success.
  if [[ -n "${EXPECT:-}" && "$after" != "$EXPECT" ]]; then
    echo "deploy: ABORT — expected $EXPECT but the checkout is at $after" >&2
    echo "deploy: run 'git push droplet ${branch}' from your workstation, then deploy again" >&2
    exit 1
  fi

  if [[ "$before" == "$after" ]]; then
    echo "deploy: already at ${after:0:8} — rebuilding anyway to be certain the running build matches"
  else
    echo "deploy: ${before:0:8} → ${after:0:8}"
    git --no-pager log --oneline "$before..$after" | sed 's/^/         /'
  fi

  # Dependencies only when the manifest actually moved: `bun install` is slow and pointless otherwise.
  if [[ "$before" != "$after" ]] &&
    ! git diff --quiet "$before" "$after" -- package.json bun.lock; then
    echo "deploy: dependencies changed → bun install"
    bun install --frozen-lockfile
  fi

  echo "deploy: building"
  bun run build

  echo "deploy: restarting meta-web + meta-sync"
  # meta-sync is long-lived and only picks up new sync/job code on restart.
  systemctl restart meta-web meta-sync

  echo "deploy: waiting for health"
  local code=""
  for _ in $(seq 1 30); do
    code="$(curl -s -o /dev/null -w '%{http_code}' "$health" || true)"
    [[ "$code" == "200" ]] && break
    sleep 1
  done

  local web sync
  web="$(systemctl is-active meta-web || true)"
  sync="$(systemctl is-active meta-sync || true)"
  echo "deploy: meta-web=$web meta-sync=$sync health=$code commit=${after:0:8}"

  if [[ "$web" != "active" || "$sync" != "active" || "$code" != "200" ]]; then
    echo "deploy: FAILED — check 'journalctl -u meta-web -n 50' and 'journalctl -u meta-sync -n 50'" >&2
    exit 1
  fi
  echo "deploy: ok"
}

main "$@"
