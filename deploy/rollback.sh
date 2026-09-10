#!/usr/bin/env bash
#
# Put the running app back on a previous build. Run it ON the droplet:
#
#   ssh <droplet> "bash /opt/meta-dashboard/deploy/rollback.sh"              # newest backup
#   ssh <droplet> "bash /opt/meta-dashboard/deploy/rollback.sh /opt/backups/pre-base44-…"
#
# This restores the BUILT ARTIFACT, not the source. That is deliberate: `deploy.sh` recovers by
# rebuilding, which needs bun install, the network and a build that succeeds — every one of which
# can fail in the moment you most need the old version back. Unpacking `.output/` and restarting is
# a file copy plus a systemctl call, so it works even when the build is broken.
#
# It takes the same lock as `deploy.sh`, because there is one checkout and one `.output/`: a
# rollback racing a deploy would restart the service onto a half-written tree.
#
# The DATABASE IS NOT TOUCHED. Restoring 2 GB of production data over a live box is a decision, not
# a step in a script — and a rollback is almost never a data problem. When you genuinely need it:
#
#   systemctl stop meta-web meta-sync
#   sudo -u postgres dropdb meta && sudo -u postgres createdb -O meta meta
#   sudo -u postgres pg_restore -d meta --no-owner /opt/backups/<dir>/meta.dump
#   diff <(sudo -u postgres psql -d meta -tAc "select relname||'='||n_live_tup \
#     from pg_stat_user_tables order by relname") /opt/backups/<dir>/rowcounts.txt
#   systemctl start meta-web meta-sync
#
# Row counts will not match exactly if the sync worker has run since the dump; treat large
# discrepancies in `accounts`, `clients` or `users` as a failed restore.
set -euo pipefail

main() {
  local app_dir="${APP_DIR:-/opt/meta-dashboard}"
  local root="${BACKUP_ROOT:-/opt/backups}"
  local lock="/var/lock/meta-deploy.lock"
  local health="http://127.0.0.1:8787/login"
  local dir="${1:-}"

  [[ -n "$dir" ]] || dir="$(cat "$root/LATEST" 2>/dev/null || true)"
  [[ -n "$dir" && -d "$dir" ]] || {
    echo "rollback: no backup directory given and $root/LATEST is missing or stale" >&2
    echo "rollback: available:" >&2
    ls -1d "$root"/*/ 2>/dev/null >&2 || echo "  (none)" >&2
    exit 1
  }
  [[ -f "$dir/output.tar.gz" ]] || {
    echo "rollback: $dir has no output.tar.gz" >&2
    exit 1
  }

  echo "rollback: target $dir"
  sed 's/^/         /' "$dir/MANIFEST.txt" 2>/dev/null || true

  cd "$app_dir"
  exec 9>"$lock"
  echo "rollback: acquiring lock…"
  flock -w 600 9 || {
    echo "rollback: a deploy held the lock for over 10 minutes; aborting" >&2
    exit 1
  }

  # Snapshot what we are replacing, so the rollback is itself reversible. Without this, rolling back
  # destroys the only copy of the build you were trying to diagnose.
  local aside="$root/replaced-$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$aside"
  echo "rollback: setting the current build aside in $aside"
  tar czf "$aside/output.tar.gz" -C "$app_dir" .output
  git rev-parse HEAD >"$aside/COMMIT"

  echo "rollback: restoring .output"
  rm -rf "$app_dir/.output"
  tar xzf "$dir/output.tar.gz" -C "$app_dir"

  # Point the checkout at the commit the artifact was built from, so the next `git pull --ff-only`
  # fast-forwards from the right place instead of failing on a divergence nobody expects. The server
  # checkout is not a source of truth, so moving its branch ref is safe.
  local commit
  commit="$(sed -n 's/^deployed_commit=//p' "$dir/MANIFEST.txt" 2>/dev/null || true)"
  if [[ -n "$commit" ]] && git cat-file -e "$commit^{commit}" 2>/dev/null; then
    echo "rollback: resetting checkout to ${commit:0:8}"
    git reset --hard "$commit"
  elif [[ -n "$commit" ]]; then
    echo "rollback: WARNING — commit ${commit:0:8} is not in this checkout; source and artifact now disagree" >&2
  fi

  # Restore .env only if the running one is gone: it holds live secrets that may have been rotated
  # since the backup, and silently reverting a rotated token is its own outage.
  if [[ ! -f "$app_dir/.env" && -f "$dir/env.backup" ]]; then
    echo "rollback: .env was missing — restoring it from the backup"
    cp "$dir/env.backup" "$app_dir/.env"
    chmod 600 "$app_dir/.env"
  fi

  echo "rollback: restarting meta-web + meta-sync"
  systemctl restart meta-web meta-sync

  echo "rollback: waiting for health"
  local code=""
  for _ in $(seq 1 30); do
    code="$(curl -s -o /dev/null -w '%{http_code}' "$health" || true)"
    [[ "$code" == "200" ]] && break
    sleep 1
  done

  local web sync
  web="$(systemctl is-active meta-web || true)"
  sync="$(systemctl is-active meta-sync || true)"
  echo "rollback: meta-web=$web meta-sync=$sync health=$code"

  if [[ "$web" != "active" || "$sync" != "active" || "$code" != "200" ]]; then
    echo "rollback: FAILED — check 'journalctl -u meta-web -n 50'" >&2
    exit 1
  fi
  echo "rollback: ok — restored from $dir (previous build kept at $aside)"
}

main "$@"
