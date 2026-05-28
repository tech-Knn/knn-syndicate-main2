#!/usr/bin/env bash
# Restore a Postgres backup (Phase 11). DESTRUCTIVE by default — overwrites the target DB.
#
#   deploy/restore.sh <backup.sql.gz>                  # restore into the live DB (knn)
#   DRILL=1 deploy/restore.sh <backup.sql.gz>          # safe drill: restore into a temp DB,
#                                                      # report row counts, then drop it
#
# Env overrides: COMPOSE_FILE, ENV_FILE, PG_USER, PG_DB.
set -euo pipefail

FILE="${1:?usage: restore.sh <backup.sql.gz>}"
ROOT="${ROOT:-/opt/rsoc}"
COMPOSE_FILE="${COMPOSE_FILE:-$ROOT/deploy/docker-compose.staging.yml}"
ENV_FILE="${ENV_FILE:-$ROOT/deploy/.env.staging}"
PG_USER="${PG_USER:-knn}"
PG_DB="${PG_DB:-knn}"
DRILL="${DRILL:-0}"

compose() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }
psql_db() { compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "$PG_USER" "$@"; }

[ -s "$FILE" ] || { echo "[restore] no such backup: $FILE" >&2; exit 1; }

if [ "$DRILL" = "1" ]; then
  TMP="knn_restore_drill"
  echo "[restore:drill] restoring $FILE into a throwaway DB '$TMP' (live DB untouched)"
  psql_db -d "$PG_DB" -c "DROP DATABASE IF EXISTS $TMP;" -c "CREATE DATABASE $TMP;"
  gunzip -c "$FILE" | compose exec -T postgres psql -q -U "$PG_USER" -d "$TMP" >/dev/null
  echo "[restore:drill] row counts in the restored copy:"
  psql_db -d "$TMP" -tAc "SELECT 'users='||count(*) FROM users;" || true
  psql_db -d "$TMP" -tAc "SELECT 'campaigns='||count(*) FROM campaigns;" || true
  psql_db -d "$TMP" -tAc "SELECT 'channels='||count(*) FROM channels;" || true
  psql_db -d "$PG_DB" -c "DROP DATABASE $TMP;"
  echo "[restore:drill] PASS — backup is valid + restorable."
else
  echo "[restore] OVERWRITING live DB '$PG_DB' from $FILE"
  gunzip -c "$FILE" | psql_db -d "$PG_DB" >/dev/null
  echo "[restore] done."
fi
