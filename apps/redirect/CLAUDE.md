# @knn/redirect — public redirect engine (Hono)

The latency-critical public hot path. Target **p95 < 50ms**, cache HIT < 5ms. Keep it lean.

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

Phase 0 ships only health + a placeholder `/go/:id`. Real logic = Phase 7.
