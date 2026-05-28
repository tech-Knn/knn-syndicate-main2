#!/usr/bin/env bash
# Install the daily Postgres-backup cron (Phase 11). Idempotent — replaces any prior
# `# knn-backup` line. Default: 03:00 UTC daily. Override with BACKUP_HOUR / ROOT.
set -euo pipefail

ROOT="${ROOT:-/opt/rsoc}"
HOUR="${BACKUP_HOUR:-3}"
LINE="0 $HOUR * * * ROOT=$ROOT $ROOT/deploy/backup.sh >> $ROOT/backups/backup.log 2>&1 # knn-backup"

mkdir -p "$ROOT/backups"
( crontab -l 2>/dev/null | grep -v '# knn-backup' || true; echo "$LINE" ) | crontab -
echo "[cron] installed daily backup:"
crontab -l | grep 'knn-backup'
