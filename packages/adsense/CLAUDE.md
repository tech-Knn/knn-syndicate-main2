# @knn/adsense — AdSense AFS revenue client

The AFS (Custom Search Ads) revenue source of truth for attribution (Phase 9, D8). Reads
per-custom-channel, per-day estimated earnings + AFS clicks from the AdSense Management API v2
`reports:generate`. Pure library — no DB. Fetch-based (no Google SDK); keys/token are the caller's.

## Invariants / footguns

- **Revenue is per CUSTOM_CHANNEL_ID = per campaign** (D7: one channel ↔ one campaign/day). The
  worker maps the reported channel id → our `Channel.channelId` (the `ch` value), then to the campaign
  holding it that IST day via `ChannelAssignment.for_day`.
- **Native currency, minor units.** Earnings come as a decimal in the report currency (header
  `currencyCode`, default USD); we store native minor units + a USD field via the daily FxRate (D15).
  Never sum across currencies.
- **`parseChannelReport` is pure + the contract** (tested). `fetchChannelReport` only adds the HTTP
  call; it throws `AdsenseNotConfiguredError` with no token (the dormant path) and `AdsenseRequestError`
  on a non-OK response.
- **External-gated (OPEN_QUESTIONS #4).** AFS reporting access is invite-only and the exact
  CUSTOM_CHANNEL_ID ↔ `ch` mapping + any AFS product filter must be confirmed on a live account. Until a
  Google OAuth token is wired, the real path is dormant; the worker injects this client so attribution
  is exercised with fake data. Don't block the build on live AdSense.

## Tests

`vitest`: report parsing (header-order independence, currency, skips), query building, and the
not-configured + bearer-fetch paths. No network.
