#!/usr/bin/env bash
#
# LOCAL staging deploy (run from your machine, NOT the box — cf. deploy/deploy.sh which
# runs on the box). Mirrors the committed tree (HEAD) to /opt/rsoc with `rsync --delete`,
# then builds + recreates.
#
# Why rsync --delete instead of `git archive | tar -x`: tar EXTRACTS but never DELETES, so a
# file removed in a commit lingers on the box — which has bitten us (a deleted `robots.ts`
# kept serving a stale /robots.txt after it was replaced by a route handler). rsync --delete
# makes the box an exact MIRROR of HEAD, so removals propagate.
#
# It deliberately PRESERVES the box-only state that isn't in git (excluded from --delete):
#   - deploy/.env.staging          (secrets)
#   - deploy/.env.staging.bak.*    (env backups)
#   - backups/                     (DB dumps from backup.sh — never delete these!)
#   - node_modules/, .next/        (built inside Docker, not shipped in the context)
# Docker named volumes (pgdata/uploads/etc.) live outside /opt/rsoc and are untouched.
#
# Usage:
#   deploy/push-staging.sh                 # mirror + build + recreate the FULL stack (+ caddy)
#   deploy/push-staging.sh article         # mirror + build + recreate only `article`
#   deploy/push-staging.sh api article     # ... only these services
#   SYNC_ONLY=1 deploy/push-staging.sh     # mirror only (no build/up)
#   DRY_RUN=1   deploy/push-staging.sh     # show what rsync WOULD change/delete, then stop
#
set -euo pipefail

SSH_KEY="${SSH_KEY:-$HOME/.ssh/rsoc_staging_ed25519}"
HOST="${DEPLOY_HOST:-root@178.105.241.185}"
DEST="${DEPLOY_DIR:-/opt/rsoc}"
SSH=(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new)
COMPOSE="docker compose -f deploy/docker-compose.staging.yml --env-file deploy/.env.staging"
SERVICES="$*"

RSYNC_EXCLUDES=(
  --exclude='/deploy/.env.staging'
  --exclude='/deploy/.env.staging.bak.*'
  --exclude='/backups/'
  --exclude='node_modules/'
  --exclude='.next/'
  --exclude='.wrangler/'
)

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "==> Extracting committed tree (HEAD) → $TMP"
git archive HEAD | tar -x -C "$TMP"

if [ -n "${DRY_RUN:-}" ]; then
  echo "==> DRY RUN — rsync --delete would do (no changes made):"
  rsync -ai --delete --dry-run "${RSYNC_EXCLUDES[@]}" -e "${SSH[*]}" "$TMP/" "$HOST:$DEST/"
  echo "(dry run only; nothing changed)"
  exit 0
fi

echo "==> Mirroring → $HOST:$DEST (rsync --delete; secrets + backups/ preserved)"
rsync -az --delete "${RSYNC_EXCLUDES[@]}" -e "${SSH[*]}" "$TMP/" "$HOST:$DEST/"

if [ -n "${SYNC_ONLY:-}" ]; then
  echo "✓ synced (SYNC_ONLY — skipped build/up)"
  exit 0
fi

echo "==> Build"
"${SSH[@]}" "$HOST" "cd $DEST && $COMPOSE build"

if [ -n "$SERVICES" ]; then
  echo "==> Recreate: $SERVICES"
  "${SSH[@]}" "$HOST" "cd $DEST && $COMPOSE up -d $SERVICES"
else
  echo "==> Recreate: full stack (+ edge/caddy, --remove-orphans)"
  "${SSH[@]}" "$HOST" "cd $DEST && $COMPOSE --profile edge up -d --remove-orphans"
fi
echo "✓ deployed${SERVICES:+ ($SERVICES)}"
