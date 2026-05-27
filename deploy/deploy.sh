#!/usr/bin/env bash
# Build + (re)deploy the staging/prod stack on the box. Run from the repo root
# (or anywhere — it cd's to the repo). Requires deploy/.env.staging to exist.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f deploy/.env.staging ]; then
  echo "ERROR: deploy/.env.staging not found. Copy deploy/.env.staging.example and fill it in." >&2
  exit 1
fi

COMPOSE=(docker compose -f deploy/docker-compose.staging.yml --env-file deploy/.env.staging --profile edge)

echo "==> Pulling latest code"
git pull --ff-only || echo "(skipping git pull)"

echo "==> Building image"
"${COMPOSE[@]}" build

echo "==> Starting stack (migrate runs first, then apps + caddy)"
"${COMPOSE[@]}" up -d --remove-orphans

echo "==> Status"
"${COMPOSE[@]}" ps
