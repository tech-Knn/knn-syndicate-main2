# Open Questions

Things we're not fully sure about, with the current best answer so we don't re-decide them
differently each session. Promote to `DECISIONS.md` once settled.

| # | Question | Current best answer / status |
|---|----------|------------------------------|
| 1 | Zero-conversion revenue allocation: a campaign has revenue but Σ conversions = 0. | **Proposed:** split by FB clicks share; if clicks 0, by impressions; if all 0, hold as a campaign-level "unallocated" bucket (admin-visible). `allocateByWeights` already returns zeros for zero weights so the caller applies this fallback. _Confirm with Aman._ |
| 2 | Which real domains? Need 3: `app.*` (dashboard+API), `articles.*` (must be AdSense-approved), separate `go.*` redirect domain (keeps the article domain clean). | Not provisioned. Using `localhost` ports locally. Needed before staging. |
| 3 | Facebook App + business verification (can take days). Perms: `ads_management, ads_read, pages_show_list, pages_read_engagement, business_management`; App Review for prod. | **Phase 2 code is complete + tested (mocked Graph).** Remaining is the external app: create the FB Business app + verification, then set `FB_APP_ID/SECRET/OAUTH_REDIRECT_URI` to enable live connect. `auth-url` returns 503 until configured. Staging uses FB **test** ad accounts (D18). _Aman to own app creation._ |
| 4 | AdSense AFS / Custom Search Ads is invite/approval-gated by Google; Management API access must be granted. | Not confirmed. Hard dependency for Phase 5/9. |
| 5 | FB token model: also offer the Business-Manager partner / system-user path (non-expiring) vs per-user OAuth (~60d churn)? | Default v1 = per-user OAuth long-lived tokens with `CONNECTION_BROKEN` handling (D13). Partner/system-user is the durable upgrade for scale. |
| 6 | Revenue-cut authority: does a Company-Admin take a further cut from their buyers (2-level margin)? | Default v1 = single-level (platform/Super-Admin sets the cut per company/buyer). |
| 7 | Final Facebook Graph API version to pin. | Pinned `FB_API_VERSION=v21.0` for Phase 2 (configurable via env). Re-confirm against the then-current stable before prod App Review. |
| 8 | Playwright E2E — the Phase 3 gate names a browser E2E ("build a 2-adset/4-ad campaign → draft → submit"); none exists yet. | **Substituted for now** by API integration tests (`campaigns.test.ts`/`approval.test.ts`, real PG) + manual in-browser verification (Preview MCP). A real Playwright harness (config + browser deps + seeded authed buyer w/ mocked FB assets, wired into CI) is deferred — _decide with Aman: build it now, or formally accept the substitution and move the E2E gate to a later hardening pass._ |
| 9 | Traffic split (`campaign_traffic_splits`) — listed under the Phase 3 data-model in the plan but not built. | **Deferred to Phase 7 (redirect engine)**, where the weighted split is actually applied (`/go/:id`). Tracked here so it isn't forgotten; revisit when building the redirect. |
