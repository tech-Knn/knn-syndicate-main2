# @knn/fb — Facebook Marketing API client

Everything that talks to Facebook: OAuth, the Graph client, error classification, the per-ad-account
rate-limit/backoff/circuit-breaker layer, token encryption, and account/page/pixel sync. Pure
library — no DB, no HTTP server. The API/worker apps own persistence and notifications.

## Invariants / footguns

- **We use `fetch`, not the official SDK.** The SDK does **no** backoff (DECISION D12), so every
  call goes through `graphRequest` → our `FbRateLimiter`. Don't reintroduce `facebook-nodejs-business-sdk`.
- **Calls scoped to an ad account MUST pass `accountId`** so they're gated by that account's limiter
  (BUC limits are per ad account, ~`300 + 40×active_ads`/hr). `/me`, `/me/adaccounts`, `/me/accounts`
  are user-scoped and intentionally ungated; `/act_<id>/...` calls pass `accountId`.
- **Error classification is the contract** (`classifyFbError`): code 190 or a token subcode
  (458/459/460/463/466/467) → `FbConnectionBrokenError` (→ the app flips the connection to
  `CONNECTION_BROKEN` and degrades, D13). Codes 4/17/32/613/80000/80003/80004 → `FbRateLimitError`
  (the limiter retries with backoff, then trips the breaker). Everything else → `FbApiError`.
- **Backoff hint** comes from `x-business-use-case-usage` (`estimated_time_to_regain_access`, in
  **minutes** → ms) or `retry-after` (seconds). The limiter prefers `err.retryAfterMs` over its own
  exponential schedule.
- **Tokens are AES-256-GCM encrypted at rest** (`encryptToken`/`decryptToken`); the 32-byte key is
  `TOKEN_ENCRYPTION_KEY` (64 hex). Stored payload = base64(iv‖tag‖ciphertext). Never log decrypted
  tokens or persist a plaintext token column.
- **Long-lived tokens (~60d)** via `exchangeForLongLivedToken`. They can't be refreshed forever —
  the worker's daily `token-refresh` job extends within a 10-day window, degrades on expiry, and
  nudges a proactive re-auth (~day 55). Persisting/notifying is the **caller's** job, not this package's.
- **`fetchPixels` reads `/act_<id>/adspixels`** and is rate-limited per account; ad-accounts/pages are
  bulk reads with `limit`. Map everything to the small DTOs here — don't leak raw Graph shapes upward.
- **All sync fetchers follow cursor pagination** via `fetchAllPages` (`paging.next` + `paging.cursors.after`),
  so a BM with >`limit` accounts/pages/pixels isn't silently truncated. Account-scoped pages stay gated by
  the per-account limiter (each page passes `accountId`). Don't go back to reading only `r.data`.

## Tests

`vitest` with `vi.stubGlobal('fetch', …)`. Cover: error classification, BUC throttle → `retryAfterMs`,
limiter retry/backoff/breaker, DTO mapping. No network, no DB.
