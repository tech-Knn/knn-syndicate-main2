# @knn/redirect — public redirect engine (Hono)

The latency-critical public hot path. Target **p95 < 50ms** globally. Keep it lean.

## Architecture: EDGE (Cloudflare Workers + KV)

Phase-7 research settled D3's "move to edge later": a single origin can't hit <50ms for a global FB
audience (physics — 90–250ms RTT for far users), so the redirect runs as a **Hono Cloudflare Worker**
across 300+ PoPs (~8–25ms). Per-ad configs live in **Workers KV** (`redirect:{redirectId}`), write-
through-synced from the origin (Postgres = source of truth) on launch/update. Hot path = one KV read
(1–5ms) + the pure `resolveRedirect` — **no origin round-trip**.

- `src/resolve.ts` — the pure, runtime-agnostic decision (tested in `resolve.test.ts`).
- `src/worker.ts` + `wrangler.toml` — the Worker (the deploy target). KV eventually-consistent
  (config propagates in seconds — fine; configs change rarely).
- **Worker-only** (task #18): the legacy Node origin service (`app.ts`/`index.ts`) was retired now
  the Worker is live on `go.*` — it's gone from the origin docker-compose + Caddy so a stray route
  flip to the box can't serve unmonetized 302s. This package no longer has a `build`/`start`; it's
  linted/typechecked/tested in the monorepo and deployed separately with wrangler.
  Local dev: `pnpm --filter @knn/redirect dev:worker` (`wrangler dev`); deploy: `… deploy`
  (`wrangler deploy`). `REDIRECT_DOMAIN` must point at the Worker host (`go.*`), not the origin.

## Invariants

- This service is publicly exposed on its OWN domain (`go.*`) for cloaking hygiene — keep the
  `articles.*` domain clean for AdSense. Don't couple it to the API.
- **Cache aggressively**: `redirect:{redirect_id}` in Redis (5-min TTL), invalidated on ad
  update/pause. A cache miss falls back to a single DB lookup, then caches.
- `redirect_id` is **per-ad** (D9). It resolves the ad → its **campaign**, which supplies the
  shared AFS params `ch` (campaign channel), `q` (campaign keywords), `rac` (campaign RAC), the
  article slug, `styleId`, `px`, and the per-ad `pxe`.
- Ad-traffic detection (Phase 7): has `fbclid`? OR `utm_source=facebook`? OR campaign-name key?
  → YES: 302 to the article with params. NO (organic/bot/ad-library): 302 to `fallback_url`.
- Ad traffic split: weighted random destination (weights sum to 100), then append params.

## Don't

- Don't add heavy middleware or Prisma to the cached path. Don't import the FB/AdSense SDKs here.
- Don't log PII or full query strings at info level in prod.

The Worker (`/go/:id`: KV read → `resolveRedirect` → 302) is live on `go.10linesabout.com` (Phase 7).
