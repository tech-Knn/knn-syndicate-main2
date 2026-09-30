# @knn/whop — Whop Ads API client

Everything that talks to Whop's REST API (`api.whop.com/api/v1`, sandbox `sandbox-api.whop.com/api/v1`): the
client, error classification, pacing, the connection health check, and a mock Whop server for tests. Pure
library — no DB, no HTTP server. The API app owns persistence, notifications and the routes
(`apps/api/src/modules/whop`). Background: `docs/WHOP.md`, decision D32.

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
- Whop's spec is the source of truth (`https://api.whop.com/api/v1/openapi.json`). When a phase adds an endpoint
  to the client, add it to the mock in the same change and keep the scopes identical to the spec.
- `pnpm --filter @knn/whop mock` runs it on `127.0.0.1:4919` with three demo businesses for clicking through the
  dashboard. Its keys are public: never use it against anything real.

## Tests

`vitest`, against the mock over real HTTP, plus injected `fetch`/clock where timing matters. No DB, no real
network. Cover: error classification, Retry-After parsing, idempotent retry rules, pagination, the checklist for
each business state, and that the key never shows up in an error. The API's integration tests
(`apps/api/src/modules/whop/whop.test.ts`) rewrite Whop's hosts to the mock and use real Postgres.
