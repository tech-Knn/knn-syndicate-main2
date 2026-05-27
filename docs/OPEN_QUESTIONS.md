# Open Questions

Things we're not fully sure about, with the current best answer so we don't re-decide them
differently each session. Promote to `DECISIONS.md` once settled.

| # | Question | Current best answer / status |
|---|----------|------------------------------|
| 1 | Zero-conversion revenue allocation: a campaign has revenue but Σ conversions = 0. | **Proposed:** split by FB clicks share; if clicks 0, by impressions; if all 0, hold as a campaign-level "unallocated" bucket (admin-visible). `allocateByWeights` already returns zeros for zero weights so the caller applies this fallback. _Confirm with Aman._ |
| 2 | Which real domains? Need 3: `app.*` (dashboard+API), `articles.*` (must be AdSense-approved), separate `go.*` redirect domain (keeps the article domain clean). | Not provisioned. Using `localhost` ports locally. Needed before staging. |
| 3 | Facebook App + business verification (can take days). Perms: `ads_management, ads_read, pages_show_list, pages_read_engagement, business_management`; App Review for prod. | Not started. Hard dependency for Phase 2/8. Staging uses FB **test** ad accounts. |
| 4 | AdSense AFS / Custom Search Ads is invite/approval-gated by Google; Management API access must be granted. | Not confirmed. Hard dependency for Phase 5/9. |
| 5 | FB token model: also offer the Business-Manager partner / system-user path (non-expiring) vs per-user OAuth (~60d churn)? | Default v1 = per-user OAuth long-lived tokens with `CONNECTION_BROKEN` handling (D13). Partner/system-user is the durable upgrade for scale. |
| 6 | Revenue-cut authority: does a Company-Admin take a further cut from their buyers (2-level margin)? | Default v1 = single-level (platform/Super-Admin sets the cut per company/buyer). |
| 7 | Final Facebook Graph API version to pin. | `.env` defaults `FB_API_VERSION=v21.0`; revisit at Phase 2 against the then-current stable. |
