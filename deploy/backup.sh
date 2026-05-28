#!/usr/bin/env bash
# Daily Postgres backup with N-day retention (Phase 11). Dumps the compose `postgres`
# service to a gzip'd SQL file and prunes dumps older than RETENTION_DAYS. Designed to
# run from cron on the box (see `deploy/install-backup-cron.sh`).
#
# Env overrides: BACKUP_DIR, RETENTION_DAYS, COMPOSE_FILE, ENV_FILE, PG_USER, PG_DB.
set -euo pipefail

ROOT="${ROOT:-/opt/rsoc}"
BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
COMPOSE_FILE="${COMPOSE_FILE:-$ROOT/deploy/docker-compose.staging.yml}"
ENV_FILE="${ENV_FILE:-$ROOT/deploy/.env.staging}"
PG_USER="${PG_USER:-knn}"
PG_DB="${PG_DB:-knn}"

compose() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

mkdir -p "$BACKUP_DIR"
ts="$(date -u +%Y%m%dT%H%M%SZ)"
out="$BACKUP_DIR/knn-$ts.sql.gz"

echo "[backup] dumping $PG_DB → $out"
# -T: no TTY (cron-safe). pg_dump streams to gzip; pipefail catches a dump failure.
compose exec -T postgres pg_dump -U "$PG_USER" -d "$PG_DB" --no-owner --clean --if-exists | gzip -9 > "$out"

# A 0-byte (or near-empty) file means the dump failed even if the pipe "succeeded".
if [ ! -s "$out" ] || [ "$(stat -c%s "$out" 2>/dev/null || stat -f%z "$out")" -lt 200 ]; then
  echo "[backup] ERROR: dump looks empty — removing $out" >&2
  rm -f "$out"
  exit 1
fi

find "$BACKUP_DIR" -name 'knn-*.sql.gz' -type f -mtime +"$RETENTION_DAYS" -delete
echo "[backup] ok ($(du -h "$out" | cut -f1)). retained dumps:"
ls -1t "$BACKUP_DIR"/knn-*.sql.gz | head -10
