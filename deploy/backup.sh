#!/usr/bin/env bash
#
# Snapshot the deployed state so `rollback.sh` has something to go back to. Run it ON the droplet,
# before any deploy you are not certain about:
#
#   ssh <droplet> "bash /opt/meta-dashboard/deploy/backup.sh"
#
# What it captures, and why each piece:
#   - meta.dump      the `meta` database, pg_dump custom format. The only irreplaceable item: there
#                    is no staging copy and no second database anywhere.
#   - output.tar.gz  the built `.output/` tree. `meta-web` boots straight from
#                    `.output/server/index.mjs`, so restoring this restores the running app without
#                    a rebuild — no bun install, no network, no build step that can itself fail.
#   - env.backup     `/opt/meta-dashboard/.env`. Gitignored, so git alone cannot restore the box.
#   - repo.bundle    every ref in the checkout, so the code survives even if both remotes are lost.
#   - etc/           the nginx vhosts and both systemd units, which live outside the repo once
#                    certbot has rewritten them in place.
#   - rowcounts.txt  per-table live tuple counts, to compare against after any restore.
#
# It does NOT stop the services: pg_dump is an MVCC snapshot and the rest is a file copy, so this is
# safe to run against a live box.
set -euo pipefail

main() {
  local app_dir="${APP_DIR:-/opt/meta-dashboard}"
  local root="${BACKUP_ROOT:-/opt/backups}"
  local db="${DB_NAME:-meta}"
  local label="${LABEL:-manual}"
  local stamp dir
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  dir="$root/$label-$stamp"

  command -v pg_dump >/dev/null || {
    echo "backup: pg_dump not found on PATH" >&2
    exit 1
  }
  mkdir -p "$dir"
  cd "$app_dir"

  {
    echo "taken_utc=$stamp"
    echo "label=$label"
    echo "deployed_commit=$(git rev-parse HEAD)"
    echo "deployed_branch=$(git rev-parse --abbrev-ref HEAD)"
    echo "meta_web=$(systemctl is-active meta-web || true)"
    echo "meta_sync=$(systemctl is-active meta-sync || true)"
    echo "bun=$(bun --version 2>/dev/null || echo unknown)"
  } >"$dir/MANIFEST.txt"
  cat "$dir/MANIFEST.txt"

  echo "backup: artifact + env + config"
  tar czf "$dir/output.tar.gz" -C "$app_dir" .output
  cp "$app_dir/.env" "$dir/env.backup"
  chmod 600 "$dir/env.backup"
  mkdir -p "$dir/etc"
  cp -r /etc/nginx/sites-available "$dir/etc/nginx-sites-available"
  cp /etc/systemd/system/meta-web.service /etc/systemd/system/meta-sync.service "$dir/etc/" 2>/dev/null || true
  git bundle create "$dir/repo.bundle" --all >/dev/null

  # Redirected by this (root) shell rather than written by pg_dump: the postgres user has no write
  # permission inside /opt/backups, and `-f` therefore fails with EACCES.
  echo "backup: database $db"
  sudo -u postgres pg_dump -Fc -Z6 "$db" >"$dir/meta.dump"

  # A dump nobody has read is a hope, not a backup. Reading the TOC proves the archive header and
  # index are intact, which is what a truncated or half-written dump fails.
  local tables
  tables="$(sudo -u postgres pg_restore -l "$dir/meta.dump" | grep -cE 'TABLE DATA')"
  [[ "$tables" -gt 0 ]] || {
    echo "backup: FAILED — the dump lists no table data" >&2
    exit 1
  }

  sudo -u postgres psql -d "$db" -tAc \
    "select relname||'='||n_live_tup from pg_stat_user_tables order by relname" >"$dir/rowcounts.txt"

  echo "$dir" >"$root/LATEST"
  echo "backup: ok — $tables tables, $(du -sh "$dir" | cut -f1) at $dir"
}

main "$@"
