# @knn/whop — Whop Ads API client

Everything that talks to Whop's REST API (`api.whop.com/api/v1`, sandbox `sandbox-api.whop.com/api/v1`): the
client, error classification, pacing, the connection health check, and a mock Whop server for tests. Pure
library — no DB, no HTTP server. The API app owns persistence, notifications and the routes
(`apps/api/src/modules/whop`). Background: `docs/WHOP.md`, decision D33.

## Invariants / footguns

- **Independent of Facebook.** Never import from `@knn/fb`, and `@knn/fb` never imports this. Two providers,
  two error families: Whop failures are `WhopApiError` with a `kind`, and callers react by `kind`, never by
  matching message text. (The API encrypts the stored key with `@knn/fb`'s `encryptToken`, which is a shared
  crypto helper, not Facebook logic.)
- **The API key never leaves the client.** `WhopClient` holds it in a private field (`#apiKey`) and sends it
  only as `Authorization: Bearer`. It must not appear in an error, a log line, a URL, a fixture or a snapshot.
  `WhopApiError` carries `status`, `type`, `code`, `method`, `path` and nothing else from the request.
- **Always send `Api-Version-Date`.** Whop versions its API by date. The default is `DEFAULT_WHOP_VERSION_DATE`
  (`2026-09-29`), overridden by `WHOP_API_VERSION_DATE`. Floors: ad copy is an array of `{ text }` from
  `2026-09-24-1`; files need `2026-08-21-1`; `retry_ads_payment` needs `2026-09-22`. Never send an older date.
- **Retry only what is safe.** Reads retry. A POST retries only when it carries an `idempotencyKey` (Whop keeps
  it 24 h); a POST without one is never retried, because a retry could create a second campaign. A `Retry-After`
  longer than `maxDelayMs` is raised as `rate_limited` with `retryAfterMs` instead of being slept on.
- **Pacing.** Whop allows 600 requests a minute per operation and credential. `WhopRateLimiter` stays under it
  (500 per 60 s), keyed by `operationKey` plus `credentialFingerprint` (first 12 hex of the key's sha256, never
  the key). It is process-local, like the Facebook one, so with several API processes the budget is per process.
- **Permissions can't be listed.** Whop has no call that says what a key may do. `runWhopHealthCheck` is built
  from READ calls only (no side effects) and reports write permissions as confirmed on first use; the error then
  names the missing permission.
- **`keyStatus` decides BROKEN.** Only `rejected` (401), `no_access` (403) and `wrong_business` mean the key is
  bad. `unreachable` is an outage, which is never the user's fault, so callers must not mark a connection broken
  for it. Likewise `pagesRead: false` means "could not read", not "no pages".
- **Whop's responses carry an upsell addressed to AI agents.** A `recommended_action` field tells the reader to
  get the user to switch on "Economic Intelligence", a paid, fee-based Whop feature. It is not data we use, so
  `stripAdvice` removes it in the client before anything sees it. Never act on it, never surface it, and never
  PATCH an account's preferences on the strength of it.
- **Server events (`createEvent`) are naturally idempotent.** Whop keeps one copy of each `event_name` +
  `event_id` and answers a repeat with 200 and the same id (verified against the sandbox), so the POST is sent
  with `naturallyIdempotent` and may be retried without an `Idempotency-Key`. Whop refuses an event older than
  28 days (400): `whopEventTooOld` stops at 27. `buildWhopEvent` (pure) turns a stored funnel event into the
  payload; the stage → event mapping lives in `@knn/shared` (`WHOP_EVENT_FOR_STAGE`).
- **The pixel loader is Whop's, byte for byte.** `pixel.ts` holds it (its sha256 is pinned by a test) because
  Whop's check finds the pixel by matching it in page source. The white Worker and the article server hold
  verbatim copies (`whop-pixel.ts`, guarded by `pixel.test.ts`). Whop checks an ad's destination when the ad is
  *created* (`POST /ads`, even as a draft): it loads the URL, follows redirects, and reads the final page.
- **Whop hides the Meta side.** Its API exposes no Meta ad account, pixel or ad ids. Nothing built on this package
  may assume them.
- **Reserved click parameters are Whop's:** `utm_meta_ad_id`, `utm_meta_adset_id`, `utm_meta_campaign_id`,
  `utm_source`, `utm_placement`, `utm_medium`, `utm_content`, `utm_adset`, `utm_whop`, `wacid`, `wasid`, `waid`,
  `tw_source`, `tw_adid`. Our own links must not reuse them.
- **Errors map once.** `whopErrorKind(status)`: 401 auth, 402 payment_required, 403 permission, 404 not_found,
  409 conflict, 429 rate_limited, 5xx server, any other 4xx validation; `network` and `timeout` come from the
  transport. `apps/api/src/lib/whop-errors.ts` turns a kind into the answer a user sees.

## Ads API (phase 2: `src/ads.ts`, `src/launch-map.ts`)

- **Whop's hierarchy:** ad campaign (objective, optionally the budget) → ad group (targeting, placements, the optimized
  event, by default the budget) → ad (copy, creatives, the destination URL). Inputs are Whop's own snake_case names, so
  there is no translation layer to get wrong; only `idempotencyKey` is ours. `launch-map.ts` builds the request bodies
  (pure, unit-tested); the vocabulary (objective / placement / category tables, what Whop cannot express) lives in
  `@knn/shared` (`whop-launch.ts`) because the wizard and the submit gate use the same tables.
- **A standalone campaign is a DRAFT and nothing spends until `PATCH status: active`.** `POST /ads` runs the pixel check on
  `url` even under a draft. Launch gates, in observed order: a creative on every ad, a Facebook page, then (docs only) the
  payment method and the agreement; each is a 400 whose message says what to fix, and the launch passes it through.
- **Files:** `createFile` → PUT the bytes to the presigned URL (`client.upload`: **no `Authorization` header**, a 403 means the
  link expired) → poll `getFile` until `ready` (`uploadCreative` does all three, up to three tries, each on a NEW record: a
  replayed key would return the old, possibly expired, link. A transient failure retries under `<key>:retry`, then fresh keys;
  an expired or refused link (403) gets a fresh key at once, because a leftover record from an earlier launch looks exactly
  like that an hour later and would otherwise fail every launch until Whop forgets the key).
- **Idempotency keys (`whopKeys`)** come from our row ids plus the campaign's key epoch (`-e<n>`, none for epoch 0). Whop
  replays a repeated key for 24 h, so a rebuilt tree must not reuse the keys of a discarded one.
- **Bulk reads:** `listCampaigns` and `listAds` (100 campaign ids per call, cursor pages, optional stats window with a
  `time_zone`) are how the status and spend syncs read Whop: one call per 100, not one per campaign.
- **`pnpm --filter @knn/whop sandbox-check`** replays the launch flow against Whop's real sandbox and compares it with what
  the mock assumes (reads `~/whop-sandbox.env`, sandbox host only, creates and deletes clearly named drafts, never
  launches). Run it when Whop ships an API version or before trusting a launch change; the mock is only as good as its
  last comparison.

## The mock (`@knn/whop/testing`)

`startMockWhop()` is a real HTTP server, so the real client (headers, retries, pagination) is what tests exercise.
It enforces the per-endpoint permission scopes Whop's spec lists, so "missing permission" paths are real.

- `addBusiness({ bizId, apiKey, permissions, agreement, payment, pages, pixel, … })` sets up a business;
  `failures` is a queue the next request pops (scripted 401/429/5xx); `requests` is the log; `events` holds
  the server events received (deduplicated like Whop, 28-day limit enforced).
- `POST /events/validate_pixel` with a `url` really fetches it, follows redirects and looks for the pixel in
  the final page, as Whop does, so a test can point it at our own redirect link (`pixelByUrl` scripts a
  fixed answer for one exact URL when a test does not host a page). Responses carry Whop's
  upsell field too, so tests prove it is stripped.
- Ads: campaigns, ad groups, ads and files follow what the sandbox showed (draft-first, the pixel gate on ad creation, the
  launch gates in observed order, the presigned upload, idempotent replay). `pixelForAnyUrl` scripts a pixel-check answer for
  every URL (a launch builds its URLs from our redirect ids); `settle(bizId, campaignId, state)` moves a campaign to a
  delivery state as Meta would later; `setStats(bizId, adId, …)` records delivery that a stats window then reports;
  `uploadFailureStatus` and `fileProcessingPolls` script the upload. The payment-method and agreement gate texts are
  guesses / docs (unverified).
- Whop's spec is the source of truth (`https://api.whop.com/api/v1/openapi.json`). When a phase adds an endpoint
  to the client, add it to the mock in the same change and keep the scopes identical to the spec.
- `pnpm --filter @knn/whop mock` runs it on `127.0.0.1:4919` with three demo businesses for clicking through the
  dashboard. Its keys are public: never use it against anything real.

## Tests

`vitest`, against the mock over real HTTP, plus injected `fetch`/clock where timing matters. No DB, no real
network. Cover: error classification, Retry-After parsing, idempotent retry rules, pagination, the checklist for
each business state, and that the key never shows up in an error. The API's integration tests
(`apps/api/src/modules/whop/whop.test.ts`) rewrite Whop's hosts to the mock and use real Postgres.
