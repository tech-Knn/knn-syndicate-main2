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

- **`wrangler deploy` applies `wrangler.toml` over whatever was set in the Cloudflare dashboard.** Anything that exists
  only in the dashboard is overwritten, so keep every setting the live Worker relies on in the file: `[vars]` (incl.
  `CLOAK_VERIFY_MODE`; the live value must match the file before a deploy) and `[observability]` (Workers Logs: the
  D33 go-live deploy switched them off until the block was added). Secrets are not touched by a deploy (set them with
  `wrangler secret put`). Wrangler lists what differs and asks before it uploads: read that list, don't just say yes.
  `wrangler deploy --dry-run` shows the variables that would be applied without uploading anything.
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

## Whop Ads (D33)

A config with a `whop: { bizId }` block is a Whop campaign; Facebook configs never have one and route exactly as
before. For a Whop config the Worker: (1) counts Whop's own click signal (valid `wacid`/`wasid`/`waid`, or
`utm_whop=true`) as paid, (2) writes a `whop` block into the KV click record (`bizId`, Whop's ids, the landing
URL with only Whop's parameters) so the conversion can be reported back to Whop server-side, (3) tags the
*non-paid* landing with a signed `_ws` scope (`whop-scope.ts`) so that page can carry the business's Whop pixel.
The money route never carries `_ws`. `whop-click.ts` is a deliberate copy of `extractWhopClick` in `@knn/shared`
(this Worker stays dependency-free; `@knn/shared` is a test-only devDependency that proves the two agree).
`whop-scope.ts` is a verbatim copy in `apps/white` and `apps/article` (test-guarded). Needs the
`WHOP_SCOPE_SECRET` Worker secret; unset = nothing Whop-related happens.

## Don't

- Don't add heavy middleware or Prisma to the cached path. Don't import the FB/AdSense SDKs here.
- Don't log PII or full query strings at info level in prod.

The Worker (`/go/:id`: KV read → `resolveRedirect` → 302) is live on `go.10linesabout.com` (Phase 7).
