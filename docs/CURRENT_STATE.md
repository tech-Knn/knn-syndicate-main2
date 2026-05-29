# Current State

> Update at the end of every session. A new session should read this first (after `CLAUDE.md`).

_Last updated: 2026-05-30 — **`/search` money-page overhaul: organic Web results (the compliance fix) + fast inline-during-parse ads + the `ch`→`cid` revenue-attribution fix. All DEPLOYED + live-verified.** Reverse-engineered three live competitor RSOC funnels (rvguide.com / storyimagur.com / creatorrule.com): all three show **organic "Web results"** on their `/search` results page so the AFS ads SUPPLEMENT real results (Search-ads policy answer/7003954: "ads supplement search results, not act as the results themselves"; "number of ads ≤ number of search results") — ours showed ads + a related-search unit only. A real click-through the user captured also proved Google appends **`rsToken` + click telemetry** to our `/search` URL (we ARE on the modern enrolled RSOC build, `referrerAdCreative` passed) — and exposed a bug: Google's telemetry includes **`ch=1`**, which COLLIDED with our `ch` AFS-channel param (Next parsed two `ch` values → array → `str()` dropped it → the `/search` ads fired with NO channel → per-offer AFS revenue silently un-attributed on the page that actually earns). Every competitor uses **`cid`** for the channel for exactly this reason. **Shipped (article + api):** (1) **`ch`→`cid`** — `related-search-unit.tsx` forwards the channel to `/search` as `cid`, `search/page.tsx` reads `sp.cid`; the redirect still emits `ch` on the *article* URL (no Worker change — no Google telemetry on the content page). Verified live: `"channel":"05219"` survives even with `&ch=1` present. (2) **Inline CSA bootstrap** — new SERVER component `search/search-ads.tsx` fires `_googCsa('ads', …)` from a server-rendered inline `<script>` during HTML parse (the official AdSense snippet pattern + XSS-safe `safeJson` for the URL-derived query/rc/channel) instead of the old client `useEffect` that waited for ~100 kB of hydration; + site-wide **preconnects** to Google ad origins via React 19's `preconnect()`/`prefetchDNS()` (`app/resource-hints.tsx`, client comp — raw `<link>` as `<html>` children caused a hydration mismatch, the API does not). (3) **React #418 hydration fix** — diagnosed in local dev (`next dev`, full message): ads.js injects ad `<iframe>`s into `#afscontainer1`/`#relatedsearches1` during parse; `suppressHydrationWarning` does NOT cover injected *child* nodes, so the containers are marked **`dangerouslySetInnerHTML={{__html:''}}`** (externally-managed → React never recurses into or wipes them). (4) **`ignoredPageParams`** removed from the ads call (CSA logs it as unsupported on the results page). (5) **Organic "Web results"** — new `GET /api/public/articles?host=&limit=` → `listArticlesForHost` (articles.service): the host's own READY articles via its offers' article (per-offer variant, else campaign default), newest-first, **host-scoped = tenant-safe**, short public `Cache-Control`. A `<WebResults>` async server component (`search/web-results.tsx`) renders them SERP-style, wrapped in **`<Suspense>`** so it NEVER blocks the ad request (ads flush + fire in the first chunk; results stream in). CSS **`order`** on a flex `.page` sets the visual order **ads → Web results → related searches** (the related container stays flushed-early so ads.js finds it by id — only its visual slot moves; it was a ~915px unit that had pushed the organic results below the fold). Sourced from our OWN articles — the FASTEST option (plain server HTML, no extra Google CSE widget, cached fetch off the critical path) per the "money page, within ms" mandate. **Gate:** api articles module **14/14** (incl. **+6 new `web-results.test.ts`**: host scope, per-offer-variant vs campaign-default, READY-only filter, markdown→snippet, host normalization, unknown host→[]), api typecheck/lint green; article typecheck/lint/build green. **Live-verified on `articles.10linesabout.com/search`:** the API returns 4 real host-scoped articles; the page renders the "Web results" SERP listing **above the fold** with the ads inline-firing (SODAR `adtrafficquality.google` beacon) + `"channel":"05219"`; fresh-tab console **clean** (no #418, no `ignoredPageParams` warning — both confirmed via the same check that caught them on prior deploys). Commits `1b27bf1` (cid + inline ads), `a0c05e4`+`9c2ee08` (#418 hydration), `4ca3ed4` (ignoredPageParams), `8728e68` (Web results + api endpoint + tests), `3644306` (reorder); deploy recreated **api + article**, no migration. **Resolves** the prior session's open compliance gaps on the results page: "ads supplement results" → satisfied (real organic Web results present). **Follow-ups (same session):** content-page related-search unit trimmed **10→6 chips** (matches Google's official RSOC examples — a supplement under the headline/lead, not the page's focus; commit `3700888`); and the **results-page related-search unit was REMOVED** (commit `8d0b8bb`) — once `/search` shows real organic Web results, the related-search widget there is redundant (the Web results ARE the results the ads supplement), so `/search` is now simply header → ads → Web results. The related-search unit lives on the **content page only** (it's the CTA driving clicks to `/search`). `/search` ads + organic Web results are each **capped at 5** (`number:5` on the ad block + `limit=5` on the fetch; commit `ced653c`) — equal caps keep "ads ≤ results" once a host has ≥5 articles (Google may serve fewer ads). **Note:** a manual test URL may show no-fill ads (no `rsToken` provenance), though high-commercial queries do fill live (verified — real Policybazaar/HDFC ads on `auto insurance quotes`); real FB→cloak→article→click traffic carries `rsToken`. Below: article AFS/RSOC compliance + mobile-fold._

_Last updated: 2026-05-29 — **Article AFS/RSOC compliance + mobile-first RSOC placement (deployed + live-verified).** Researched Google's official RSOC/AFS/CSA policies (support.google.com/adsense + developers.google.com/custom-search-ads) and audited `apps/article`. Fixed two issues end-to-end: **(#1 placeholder)** removed the literal placeholder strings AND the always-on empty dashed `.afsSlot` box AND our redundant "Related searches" label (Google's CSA unit renders its own header in its iframe — ours was a duplicate that read as broken). The related-search container is always mounted (CSA needs it) but our wrapper reveals chrome only once the unit actually fills (`adLoadedCallback adsLoaded=true`); uncrawled/empty = zero-height/invisible; misconfigured host = nothing. **(#2 mobile fold)** mobile CSS (`@media max-width:600px`) caps the headline at 2 lines + lead at 3 lines (line-clamp) + tighter spacing so a long generated title can never push the unit below the fold; generation prompt now produces a concise headline (≤~7 words, no "Complete Guide to…" boilerplate) + a short 35-55w lead. Live-verified on `articles.10linesabout.com` (real filled Google unit, mobile viewport): worst-case long title → headline 2 lines, lead 3 lines, **unit top at 166px, first chip fully visible in a 667px viewport (409px spare); still passes at an extreme 383px viewport (125px spare)** — Headline → few lines → RSOC unit (5 chips) → article, clickable without scrolling, on both the clubs + medicare articles. Commits `e6c4d20`, `a99fac6` (#1), mobile-fold commit (#2). Article app typecheck/lint/build + ai 12 tests green. **Compliance gaps still open (from the audit):** crawl/sitemap pre-warm (empty unit before Google crawls), `adtest=on` on staging (must be off in prod), `ivt:false` review, templated article skeleton, results-page related-searches unit (keep/drop = revenue call), adsafe level. Below: live offer editing._



_Last updated: 2026-05-29 — **Live (post-launch) offer editing — rebalance/add/remove with ZERO Facebook impact.** The FB ad creative carries only the stable `/go/{redirectId}` link; all routing (weighted splits, per-offer channels, article URLs) is in edge KV — so a running campaign's offers can be re-edited by rewriting KV, no ad republish. New `syncCampaignRedirectConfigs(campaignId)` (launch.service, no-FB KV rebuild from current offers; tolerates unconfigured KV). `updateLiveOffers` (offers.service): for live campaigns (PROCESSING/LAUNCHING/BATCHED/ACTIVE/PAUSED), diff offers by id — update kept (weight/article, **channel preserved**), create added, delete removed. **Weights/variant-only → re-sync KV inline (instant, next click); add/remove → enqueue worker `rebalance`** (`rebalanceOfferChannels`: release channels orphaned by removed offers + assign new offers' channels via the existing SKIP-LOCKED path, status-safe on ACTIVE → `POST /api/internal/resync-offers/:id`). `PUT /api/campaigns/:id/offers/live`. Offers editor is now editable on live campaigns ("Save — no ad republish"). Answers the buyer ask: shift a 50/50 split to 100% on the winner, swap article angles, add/remove offers — all live. Gate: api **154 tests** (+3), worker 43, typecheck/lint/web build green. No schema change. Commit `97abe1d` (NOT yet deployed). Below: traffic-splits (article A/B)._

_Earlier — **Traffic splits (OQ#9) resolved: per-offer article A/B variants.** OQ#9's premise was stale — Phase E **offers** already wire weighted `splits` to KV end-to-end (`launchCampaign` → `{url,weight,channel,offerId}` per PAID offer → `pickSplit` routes; proven by `launch.test` + 13 `resolve.test` cases), so the planned `campaign_traffic_splits` table was never needed. The real gap (every offer served the campaign's one article) is now closed with **per-offer article variants**: `offers.article_id` (migration `20260529230000_offer_article_variant`, nullable/no-FK), `setOffers` validates the variant is a READY org article, `launchCampaign` builds each split URL from the offer's article slug (fallback = campaign article), and the offers-editor has a per-offer "Article (A/B)" picker fed by new `GET /api/campaigns/article-variants`. Per-variant revenue attributes via each offer's own channel (Phase F). Gate: api **151 tests** (+4 new), redirect 13, typecheck/lint/web build green. Commit `939f06e` (NOT yet deployed — carries the migration). Below: AdSense live pull._

_Earlier — **AdSense LIVE revenue pull working + the OQ#4 channel-id mapping resolved.** The connected account (`partner-pub-6567805284657549`) pulls real AFS revenue via Management API v2 `reports:generate` — a new super-admin **revenue preview** (`GET /api/adsense/accounts/:id/report`, top-earning channels over a range) returned **gross ~$91,084 / 1,324,929 AFS clicks over 7 days** from the live account, proving reporting access is granted. The preview surfaced the real OQ#4 bug: the report keys channels as **`{afsPubId}:{code}`** (`partner-pub-6567805284657549:05219`) while our pool stores the bare `code`, so 0 reported channels matched and AFS revenue would never have attributed. **Fixed:** `qualifyChannelId`/`bareChannelId` in `@knn/adsense` (tested) — `liveAdsenseFetch` qualifies the report filter with the account's pubId then strips it back to match `Channel.channelId`; the preview matches on the bare code. New operator surface on the Setup→AdSense card: per-account **"Revenue (7d)"** expandable preview + **"Pull revenue now"** (enqueues the worker `finalize` job for an on-demand FB+AdSense pull). No schema change. Gate: `@knn/adsense` 20 tests, worker attribution 43, api 147, typecheck/lint/web build all green. **DEPLOYED** (commits `19846ca` preview/trigger + `6e890dc` mapping fix). Verified live in-browser: preview returns the $91k/1.3M-clicks report; channel ids now display as bare codes (strip confirmed); "Pull revenue now" enqueues with no worker errors. Caveat: Test 2's `05219` reads $0 (just launched, no real traffic) so attribution shows $0 for it — pipeline is correct, awaiting real funnel traffic. OQ#4 marked RESOLVED. Below: IA reshuffle._

_Earlier — **Super-admin IA reshuffle → Platform hub + Channels & Articles lineage views.** Reorganized the super-admin surface so the 8-tab flat nav becomes a lean top nav (Overview · Analytics · Campaigns · Approvals · **Platform**) plus a settings-style left **sub-nav** inside the hub. New nested layout `apps/web/app/dashboard/platform/layout.tsx` (one SUPER_ADMIN guard; sub-nav: Setup · Companies · Domains · Channels · Articles · Facebook). Moved `companies/` and `domains/` pages under `/dashboard/platform/*` (git mv + import depth fix); left **redirect stubs** at the old paths so bookmarks don't 404. The platform landing is now **Setup** (AdSense accounts + Redirect Domains panel + platform settings; the old Channel-pool card removed). **Channels page** (`/platform/channels`) is the single home for channels — (1) **usage lineage** search by channel id → `getChannelUsage` (resolve by AFS id OR uuid → assignment spans collapsed per consecutive IST day → campaign/company/article-link/website/period/revenue/AFS-clicks), (2) pool summary, (3) per-website catalog browse/import (lifted out of Domains; `?domain=<id>` preselects, the Domains "Channels" button links here). **Articles page** (`/platform/articles`) lists every generated article (the previously-orphaned `admin.articles()`) + an expandable per-article lineage → `getArticleUsage` (campaign → channel → domain + live URL + window + revenue; RLS-scoped so company-admins see only their org). Backend: 4 new DTOs in `stats.ts` (`ChannelAssignmentSpan`/`ChannelUsage`/`ArticleUsageCampaign`/`ArticleUsage`), `getChannelUsage`+`getArticleUsage`+span helpers in `platform.service.ts`, routes `GET /admin/channels/:id/usage` (super) & `GET /admin/articles/:id/usage` (super+company), api-client `admin.channelUsage`/`admin.articleUsage`. No schema/migration change. Gate: web typecheck+lint clean, shared+api typecheck clean, **147 api tests pass (incl. 5 new `usage.test.ts`)**, web production build green. **DEPLOYED to staging** (commit `151f15c` + a fixup): old `/dashboard/companies|domains` bookmarks now redirect at the routing layer via `next.config.mjs` `redirects()` → a real **HTTP 308** to `/dashboard/platform/*` (a `force-dynamic` stub page only client-redirects under the client-component dashboard layout, so config redirects are the correct mechanism; stub pages deleted — also `rm`'d on the box since `tar -x` doesn't delete). Verified live: `/dashboard/companies` → 308 → `/dashboard/platform/companies` (200); all hub routes 200; `GET /api/admin/channels/:id/usage` → 401 (registered+gated); migrate exit 0, all services healthy. **Remaining: interactive in-browser pass as super-admin** (sub-nav click-through, channel-usage search e.g. `05219`, expand an article's lineage) — needs a logged-in super-admin session. Below: redirect-domains + relaunch._

_Earlier — **Redirect Domains super-admin panel + relaunch capability + DEPLOYED.** (1) **Relaunch:** new `relaunchCampaign` (launch.service) pauses an already-launched campaign's FB campaign, clears the stored FB ids, resets to PROCESSING, and re-creates Campaign→AdSet→Ad with the CURRENT config — used to fix live campaigns whose creatives carry a stale redirect link. Exposed via token-guarded `POST /api/internal/relaunch/:id`. Ran it for Test 2 (`4c1b959e`): paused the old broken FB campaign + created a fresh one (`120250024266230066`, ACTIVE) linking to the corrected `go.10linesabout.com` — verified click-through-able. (2) **Redirect Domains panel:** the redirect domain (what ad creatives link to) is now a managed resource instead of a lone env var. New `RedirectDomain` model + migration `20260529210000_redirect_domains` (global, super-admin; partial-unique index → ≤1 default). Super-admin CRUD at `/api/admin/redirect-domains` (list/create/set-default/verify[pings `{host}/health/live`]/delete). `createFbStructure` now builds the creative link from the DEFAULT redirect domain (`resolveRedirectBase`), falling back to env `REDIRECT_DOMAIN`. New **Redirect Domains panel** on the super-admin Platform page (list + add + set-default + verify + delete + a "How it works" explainer). Seeded `go.10linesabout.com` as the default (matches the env fallback). Gate: api redirect-domains 4, launch 15, full api 142, web build, typecheck+lint. Migration applied on staging (migrate exit 0). Below: full-funnel validation + redirect-domain fix._

_Earlier — **Full-funnel validation (first live ad) + redirect-domain fix.** Traced Test 2 (campaign `4c1b959e`, live on FB) end-to-end. Hops 1–4 verified working on the real Worker domain: redirect `go.10linesabout.com/go/<id>` → ad-click 302s to `articles.10linesabout.com/a/<slug>?rc=…&ch=05219&rac=Club&txid=…` (organic → clean 302, no monetization params); article SSR 200 with the AFS/CSA wired to the right pubId `partner-pub-6567805284657549` + channel `05219` + styleId; conversion beacon wiring present (`NEXT_PUBLIC_EVENTS_URL`, Cloudflare KV configured, `/api/events`→204, tracker on `/search`); KV proven (the redirect config resolved). Attribution is plumbed (channel assigned) but no live data yet ($0 spend/rev on a just-launched campaign). **THE break found + fixed:** `REDIRECT_DOMAIN` was `https://go.staging.rsoc.app` — which DNS-resolves to the box (no redirect there → SSL error), so live-ad clicks died — while the actual Cloudflare Worker is on **`go.10linesabout.com`**. Set `REDIRECT_DOMAIN=https://go.10linesabout.com` + `REDIRECT_HOST=go.10linesabout.com` on staging, recreated api+worker (env confirmed). Future launches now link to the working Worker. **Caveat:** the existing Test 2 ad has the old broken link baked into its FB creative (can't edit in place) + is ACTIVE → pause it (wasted spend on dead clicks) and launch a FRESH campaign to get a click-through-able ad. Deferred prod task: stand up a dedicated PLATFORM redirect domain (e.g. `go.staging.rsoc.app` as a real CF Worker custom domain) instead of reusing the offer's `go.10linesabout.com`. Below: the FB token checkpoint resolution._

_Earlier — **🎯 FB "authenticate your account" launch checkpoint SOLVED — root cause = the long-lived token exchange for app-Tester accounts.** After a long elimination hunt (NOT the IP — proven by India-egress proxy still failing; NOT our code/scopes — `debug_token` showed our stored token is identical to a working Graph Explorer token: USER type, `ads_management` granular = all objects, valid), the one remaining difference was **long-lived vs short-lived**. Our OAuth callback exchanges the short-lived token for a long-lived one; for a user who is an **app Tester** (L. M Marak), that exchange yields a **never-expiring token (`expires_at: 0`)**, and Facebook gates **ad publishing** (`POST /act_/ads`) on those with err **31/3858385** ("authenticate your account in Ads Manager"). Campaign/adset/image/creative all succeed; only the ad-publish is gated. The Explorer token works because it's short-lived (never exchanged). **Proof:** added `FB_SKIP_LONGLIVED` (config) → connect stores the short-lived token (skip exchange); set it on staging, reconnected L. M Marak, relaunched campaign `4c1b959e` ("Test 2") → **"Campaign is live", status ACTIVE, no error.** First successful end-to-end launch through the tool. **Production implications:** (1) short-lived tokens expire ~1–2h, so `FB_SKIP_LONGLIVED` is an interim TESTING measure (re-connect hourly), not the end-state; (2) the never-expiring gating is **Tester-specific** — real (non-Tester) buyers get normal 60-day long-lived tokens that should publish fine (verify with first real buyer); (3) still need **`ads_management` Advanced Access** (App Review + Business Verification) so non-Tester buyers can use the app at all (Standard Access only covers app roles). **Temp debug to clean up later:** `FB_SKIP_LONGLIVED=true` + the internal `POST /api/internal/debug-token/:id` route (token-guarded) are live on staging; `FB_DEBUG_LOG`/`FB_HTTPS_PROXY` already reverted. **Also fixed earlier in the saga:** uploads now persist on a volume (`knn_uploads`); err 31/3858385 + 368 classified as `FbAccountRestrictedError` with an actionable 409; appsecret_proof on all Graph calls; FB egress proxy support (env `FB_HTTPS_PROXY`, off); offers auto-launch + buyer manual launch; reopen-stuck-campaigns. Below: the IP/checkpoint investigation detail._

_Earlier — **FB checkpoint diagnosed (fires at ad-create) + India egress proxy support shipped + live ad backfilled + DEPLOYED**. Captured the exact launch sequence via an env-gated `[fb-call]` logger (`FB_DEBUG_LOG`): campaign/adset/adimage/adcreative all SUCCEED; only `POST /act_/ads` (the publish) fails with **code 31 / subcode 3858385** "requires the user to take a pending action" — the "authenticate your account in Ads Manager" checkpoint. The user reproduced the *identical* ad-create from an India IP (Graph Explorer token) → it **succeeded** (`{"id":...}`), where the EU Hetzner server (Gunzenhausen, DE) gets checkpointed. Two variables differ (IP + token), so not a clean IP proof, but strongly implicates the EU datacenter IP. **Fix chosen (Layer 1): optional India egress proxy for outbound FB Graph calls only** — `FB_HTTPS_PROXY` (config) → lazy undici `ProxyAgent` in `@knn/fb` graph client; when set, FB calls go through undici fetch+dispatcher (India exit), else normal global fetch. undici added as a direct dep of `@knn/fb` + the api/worker apps (they bundle `@knn/fb` via tsup `noExternal`, so the externalized `undici` import must resolve from each app's node_modules). Deployed (no-op until `FB_HTTPS_PROXY` set; api boots healthy with the top-level undici import → resolves at runtime). **Pending: user provides an India proxy/VPS endpoint** to activate + confirm end-to-end; then a dashboard launch should go live. Layer 2 (durable, deferred): Meta Business verification + system-user tokens (IP-agnostic — what big platforms actually do). **Backfilled** the manually-launched live ad into our DB (campaign `1a03ba99…` → ACTIVE + `fb_campaign_id=120250016574950066`, ad set `fb_ad_set_id=120250016576330066`, ad `fb_ad_id=120250016732520066`) so attribution tracks it. NOTE: that ad is live + spending (~$3/day). `FB_DEBUG_LOG=true` is still set on the box (diagnostic) — turn off after. Below: the uploads-volume fix._

_Earlier — **Ad-creative uploads now persist on a volume (was the launch 500) + DEPLOYED**. The "Internal Server Error" on launch was NOT Facebook — the new `[launch] Facebook error` logging showed `ENOENT … /repo/var/uploads/<id>.png` reading the ad creative. Root cause: `UPLOAD_DIR=/repo/var/uploads` lived on the API container's EPHEMERAL filesystem with no volume (postgres/redis had named volumes; uploads never did), so each of today's many container recreates **wiped all uploaded creatives** → a later launch 500s on the missing file. Fix (deployed): added named volume **`knn_uploads` → /repo/var/uploads** on the compose app anchor (confirmed mounted on api), so creatives survive redeploys; and `launch.service` now throws a clear **409** ("re-upload the ad's image, then relaunch") on ENOENT instead of a 500. **Creatives uploaded before the volume are gone** — they must be re-uploaded once (Reopen & edit → re-upload → resubmit/relaunch). Tests: api launch 15 (+1 missing-creative). Migrate exit 0, api healthy. Below: appsecret_proof + IP diagnosis._

_Earlier — **appsecret_proof on every Graph call + IP diagnosis + DEPLOYED** (commit `af66092`). Investigating the recurring "authenticate your account" checkpoint: confirmed the staging server egresses from **Hetzner Gunzenhausen, Bavaria, DE** (`178.105.241.185`, AS24940) while buyers operate from **India** → ad-creation calls are a token used from a foreign datacenter IP. Found a second smoking gun: the Graph client sent only the user Bearer token with **no `appsecret_proof`**, so calls looked like a replayed/stolen token — a prime trigger for the err 31/3858385 + 368 checkpoints. **Fix (deployed):** `computeAppSecretProof` (HMAC-SHA256(token, app_secret)) added to every `graphRequest` (covers sync/insights/launch/CAPI; OAuth exchange already uses client_secret). `FB_APP_SECRET` confirmed set on the box. **User chose** to clear abcmediabuyer2 in Ads Manager + relaunch and see if appsecret_proof alone fixes it before building the India egress proxy (deferred option) or scoping business-verification + system-user tokens (the IP-agnostic durable fix, also deferred). The `[launch] Facebook error` logging stays the diagnostic. fb 31 tests. Below: the err 31/3858385 classification._

_Earlier — **FB checkpoint err 31/3858385 now classified (the actual live signature) + DEPLOYED** (commit `b8…`). The err-368 logging deployed earlier immediately caught the REAL code on a live launch of "Sam Club 1" (abcmediabuyer2's account): `code=31 subcode=3858385 "This request requires the user to take a pending action"` — the exact API signature of the "authenticate your account in Ads Manager" checkpoint, which my classifier (368 only) had missed → it fell through to the generic silent-revert path. Added **31** + **3858385** to `FB_ACCOUNT_RESTRICTED_ERROR_CODES`/`_SUBCODES` so it now routes to `FbAccountRestrictedError` → revert to PROCESSING + notify + clear actionable 409, no blind retry. (Confirmed vs Meta docs + community thread 845129991936233.) The launch + auto-launch fixes from `b26df0a` are confirmed WORKING (the offers campaign auto-approved and the buyer reached launch). Gate: fb 30 (+1). The remaining blocker is Meta-side: the owner of each restricted ad account must complete the pending action in Ads Manager — it's **per-account** (authenticating one buyer's account doesn't clear another's), and fresh accounts creating ads via a new app routinely trip it until business-verified. Below: the offers auto-launch fix._

_Earlier — **Auto-launch fixed for offers campaigns + buyers can launch manually + DEPLOYED** (commit `b26df0a`). **Root-cause bug:** with a company's Auto-approve + Auto-launch both ON, campaigns still parked in PROCESSING and never went live. `triggerAutoLaunch` (worker) only checked `campaign.channelId`, but EVERY campaign is now an **offers** campaign (submit requires ≥1 PAID offer) where the channel lives on each `offer.channelRef`, not `campaign.channelId`. So channel assignment flipped the campaign to PROCESSING but the trigger bailed (`channelId` null) → the `FB_LAUNCH` job never enqueued → stuck forever. Fixed: the trigger now mirrors `launchCampaign`'s gate — an offers campaign is launch-ready when **every PAID offer holds a `channelRef`**; legacy single-channel still checks `channelId`. **Buyer manual launch:** `/:id/launch` dropped `adminOnly` → `[authenticate]` (the service already owner-scopes via `buyerId`, so a MEDIA_BUYER can launch only their own; admins any in-org), and the "Launch to Facebook" button now shows for the owner, not just admins. So buyers get BOTH manual launch and (org-toggle) auto-launch. **Approval stays admin-only** (approve/reject routes unchanged — creative/campaign approval is COMPANY_ADMIN/SUPER_ADMIN; launch ≠ approval). Gate: worker launch-trigger 10 (+2 offers regression), worker 43, api 137, typecheck + lint clean, web build. No migration; deployed (migrate exit 0, API healthy, worker up). **Note:** already-stuck PROCESSING campaigns won't retro-auto-launch — launch them with the now-available manual button (or reopen+resubmit); if the ad account is still under the err-368 hold they'll get the clear "authenticate in Ads Manager" message. Below: the err-368 handling._

_Earlier — **FB ad-account security hold (err 368) now detected + actionable + DEPLOYED** (commit `11573a0`). The user hit Meta's "We think someone may have tried to access your account… you won't be able to create or modify ads until you've authenticated your account in Ads Manager" checkpoint — a false-positive triggered by a freshly-connected app making (repeated, earlier-failing) create calls on a fresh ad account. Researched vs Meta docs: it surfaces as Marketing API **error 368** ("action deemed abusive or otherwise disallowed"; sometimes subcode **1487390**); reads + existing ads keep running, only create/modify is blocked until the OWNER re-authenticates in Ads Manager (FB emails a 6-digit code; sometimes needs incognito). Distinct from a token break (190/459 checkpoint). **Gap fixed:** 368 was falling through to a generic `FbApiError` → the launcher silently reverted to PROCESSING with no message (inviting retries that worsen the checkpoint), AND we never logged the FB code/subcode (undiagnosable). Now: `@knn/shared` `FB_ACCOUNT_RESTRICTED_ERROR_CODES [368]`/`_SUBCODES [1487390]`; `@knn/fb` new **`FbAccountRestrictedError`** (classify maps 368/1487390; parses `error_data`→`checkpointUrl`); `launch.service` logs every FB error (code/subcode/fbtrace), and on a restriction reverts to PROCESSING + notifies the buyer (`fb_account_restricted`) with the Ads-Manager re-auth steps + throws a clear **409** (incl. checkpoint URL) with **no auto-retry**; on a token break during launch it marks the connection `CONNECTION_BROKEN` (D13). Same handling on pause/resume. Gate: **fb 29** (+4 classification), **api launch 14** (+2: 368→PROCESSING+409 leaves the connection healthy; 190→CONNECTION_BROKEN), full api 137, typecheck + lint clean. No migration; deployed (migrate exit 0, API healthy, `/login` 200). **Action still on the user:** authenticate the ad account in Ads Manager to clear the hold; longer-term, business verification + a system-user token reduces these checkpoints. Below: the three launch-reliability features._

_Earlier — **Three launch-reliability features shipped + DEPLOYED** (commit `7a65ef1`). (1) **Objective↔performance-goal guard (ODAX).** `packages/shared/src/campaigns.ts` encodes Meta's Outcome-Driven matrix `PERFORMANCE_GOALS_BY_OBJECTIVE` (+ `performanceGoalsFor`/`isValidPerformanceGoal`/`defaultPerformanceGoal`/`goalRequiresPixel`, `WEBSITE_DESTINATION_GOALS`, `PERFORMANCE_GOAL_LABELS`): each objective only offers the goals it supports — incl. the user-confirmed **Engagement→Conversions(website)** path. `campaignSubmitIssues` now validates the goal-vs-objective combo, requires a pixel ONLY for conversion/value goals, and enforces the **$2.00** FB daily-budget floor (CBO + ABO, `< 200` cents). Launch (`launch.service.ts` + `@knn/fb` `createFbAdSet`) sets `destination_type=WEBSITE` on website-conversion ad sets and puts the bid strategy at the right level (campaign for CBO, ad set for ABO). The wizard (`campaign-wizard.tsx`) gained a per-ad-set **Performance goal** select (options filtered by objective; remaps invalid goals on objective change) + a pixel "(optional)" hint when not required. (2) **Reopen stuck pre-launch campaigns.** State machine (`campaign-status.ts`) allows `PROCESSING|BATCHED|QUEUED_NO_CHANNEL → DRAFT`; `reopenCampaign` releases the campaign-level channel AND every PAID offer's channel back to the pool (`withSystem`, AVAILABLE + cleared `currentCampaignId`/`lockedForDay`/`assignedAt`), clears `offer.channelRef`, resets review fields, audits `campaign.reopened`. Live (LAUNCHING/ACTIVE) campaigns are refused (409). New **"Reopen & edit"** button on the campaign detail page (also covers QUEUED_NO_CHANNEL with a tailored banner). (3) **Pre-launch FB readiness checklist** on the wizard Review step (budget ≥ $2, account/page set, ≥1 website destination, valid goals, pixel where required, every ad has a creative). Gate: **shared 66** (+8 ODAX/reopen), **api launch 12** (+3 reopen channel-release), full api suite 132, typecheck + lint clean across shared/api/fb/web, web prod build. **No migration** (reuses existing channel/campaign columns). Deployed via git-archive→box→`--profile edge` rebuild+up; migrate one-shot exited 0 (no new migrations), API `(healthy)`, all containers up, public `/login` 200 + `/api/campaigns` 401 (auth enforced). In-browser click-test of the buttons is the user's (needs their login). Below: the prior platform/channel work._

_Earlier — **Platform page reworked + bulk channel import** (DEPLOYED). Channel browser gained an **id-range** filter (e.g. `00500-01499`) on browse + import → one-click **Import range** assigns a contiguous block (≤2000/import); the table loads all matches (≤2000) so **select-all** is honest. **Platform page** made accurate + multi-account: an **AdSense accounts** section with an always-visible **Connect** (onboards every account a Google login sees; connect again with a different login to add more), per-account **In AdSense** (catalog/synced count) + **Imported** (in-pool count) + **Sync catalog** + Disconnect — the legacy single-account global range-sync is gone. **Channel pool** was showing the first 1000 of all channels (the fake `ch-*` placeholders, misleading "1000 total"); now an accurate summary — total / available / in-use (real groupBy) + **per-website** breakdown + an untagged-placeholder note. New `GET /api/admin/channel-summary`; `listAfsAccounts` returns `catalogCount`/`importedCount`. Channels are imported/keyed by **channel ID** (the `ch` value); the AdSense name is just a label. **Staging:** 1,001 real channels tagged to articles.10linesabout.com + ~50 untagged `ch-*` placeholders (a bulk-delete of placeholders was classifier-blocked — needs explicit auth; the summary shows them as legacy/ignored, so it's not misleading). Gate: api 112, web build, typecheck + lint. Below: the funnel shakedown + catalog._

_Earlier — **Full funnel shakedown + scalable 100k-channel management** (commits b3712be + 598cff4; DEPLOYED). Ran the whole gate (all 10 packages' tests, typecheck 12/12, lint 12/12, builds) — baseline green; then an end-to-end funnel review fixed **two real integration bugs**: (1) a campaign with **no offers** would pass approval then hang in `QUEUED_NO_CHANNEL` forever (its channel request hits the legacy assigner, which only takes GLOBAL `domain_id IS NULL` channels — and on a real DB every channel is domain-tagged); now **submit requires ≥1 PAID offer** with a clear message. (2) `deleteDomain` freed a domain's channels to the GLOBAL pool (a legacy campaign could grab them → attribution looks in the wrong AFS account); now it **deletes** the domain's AVAILABLE channels. **100k-channel management:** new `afs_channel_catalog` (per-account local mirror) + `POST /api/adsense/accounts/:id/catalog/sync` (pulls the account's full ≤200k channel list, per-account token refresh, wipe+reinsert); the domain channel browser now reads the **local catalog** when synced (instant search across all 100k, no live API scan) and falls back to a bounded live scan otherwise; a **"Sync from AdSense"** button in the browser. Migration `20260528182139_afs_channel_catalog` applied (pgvector intact). Gate: api 110 (3× stable), web build, typecheck + lint; verified on the box (migration applied, endpoints guarded, services healthy). Below: the original channel browser._

_Earlier — **Channel browser shipped + deployed** (commit 81dd4ec) — pick AFS channels by NAME, import the IDs you actually use (replaces blind range imports). The AdSense channel *name* is arbitrary; the channel *id* is what monetizes — so the super-admin now browses a domain's AFS account channels (id + name), searches by name, and ticks which ids to use. API (super-only): `GET /api/domains/:id/afs-channels?q=` lists the account's custom channels filtered by name/id substring, capped + flagged `imported` (bounded 20k scan for the 100k-channel account); `POST /api/domains/:id/afs-channels {add:[{channelId,label}], remove:[id]}` imports the selected ids (label = the AFS name) into the domain's pool / removes AVAILABLE ones (never an ASSIGNED channel in use). Web: a **"Channels"** action on each domain (Domains page) opens a browser — search, checkbox-select, Import/Remove, with imported/assigned badges. Range import (`sync`) stays as the bulk alternative. Verified: endpoints wired + super-guarded on the box; gate api 106, web build, typecheck+lint. **External blockers cleared by the user:** the FB ad account is real + usable (buyers go in as FB app **testers**), **all their domains are AFS-approved**, so the funnel can carry real traffic once channels are imported + a campaign launches. Below: Phase 11 hardening._

_Earlier — **Phase 11 hardening (application layer) shipped + deployed** (commit 2ec24c0). (1) **API rate limiting** — `@fastify/rate-limit`, Redis-backed (shared across replicas), **fail-open** on a Redis blip; 200/min per IP (`RATE_LIMIT_MAX`), auth endpoints (login/signup/refresh) 20/min (`RATE_LIMIT_AUTH_MAX`, brute-force guard); infra/edge paths exempt (`app.ts#isRateLimitExempt`: `/health`, `/api/public/*`, `/api/internal/*`, Bull-Board, `/`) so Caddy's on-demand-TLS ask + the article SSR `site-config` are never throttled; **skipped under NODE_ENV=test** (so the integration suite isn't throttled — behaviour covered by `rate-limit.test.ts`). Verified live: 26 logins from one IP → 20 through + 6×429. (2) **DB backups** — `deploy/backup.sh` (gzip `pg_dump`, 7-day retention, empty-dump guard), `restore.sh` (`DRILL=1` restores into a throwaway DB + row-count check, live DB untouched; bare = overwrite), `install-backup-cron.sh` (daily 03:00 UTC). Verified on the box: backup wrote a 32K dump; **restore drill PASS** (users=1 / campaigns=0 / channels=50 in the restored copy); cron installed. (3) **Channel-pool test flake fixed** — the worker rollover/queue tests no longer assert GLOBAL aggregate counts (`rolloverChannels().released`, `processQueue()`), which a concurrent api-package test sharing the DB could inflate; they assert their own fixtures' state now. api+worker concurrent turbo run green ×2; rule documented in `apps/worker/CLAUDE.md`. (4) **Security pass** — focused review of the new public endpoints (domain-allowed/site-config/events: low-sensitivity, `withSystem` reads only), the `$queryRawUnsafe` channel claims (parameterized `$1::uuid` / no user input), offer + stats ownership (`runScoped` + buyerId checks), token encryption at rest — clean; rate-limiting closed the main abuse gap. **Readiness** (`/health` checks DB+Redis) already existed. Gate: api 105, worker 41, typecheck + lint clean. **Remaining Phase 11 (infra / needs a decision or prod access):** PgBouncer pooling (Prisma needs `pgbouncer=true` + no prepared statements — deserves focused work), a GDPR delete endpoint, a redirect load test, and the staging→prod cutover runbook (blocked on OPEN_QUESTIONS: prod domains, the prod FB app + business verification, AFS approval). Below: Phase F._

_Earlier — **Phase F shipped — the Offers/Domains/AFS rearchitecture (A→F) is COMPLETE + deployed.** Per-offer attribution + ROI across multiple AFS accounts (commit 4434c18; migration `20260528170605_offer_revenue_daily` applied on staging — RLS on, `articles_embedding_idx` intact, pgvector DROP-INDEX footgun stripped). Revenue now attributes to the offer/website that earned it, from THAT website's own AFS account. New `offer_revenue_daily` (per-offer per-IST-day AFS revenue, RLS). **Worker:** the AdSense source is **multi-account** — channels are grouped by their AFS account (offer channel → its domain's account; legacy global channel → the platform account) and each is pulled with its OWN token (`adsense-source.ts#liveAdsenseFetch` now takes `accounts[]`); `pullAdsenseRevenue` writes per-offer rows AND **sums** into `campaign_revenue_daily` (fixes the overwrite when a campaign holds many offer channels — the per-ad allocation still runs on the campaign total); mixed-currency offers roll up in USD (D15). **API:** `GET /api/stats/campaigns/:id/offers` → per-offer buyer-visible revenue (platform cut applied; low-AFS-click suppression), owner/admin-scoped. **Web:** a **Revenue (30d)** column on the campaign Offers panel — which website monetizes best (cost is campaign-level FB spend; revenue is per offer). Gate: worker 41 (per-offer + multi-account attribution), api 103 (offer stats incl. cut/suppression), shared/db/web typecheck + lint + web build. **The full vision is live end-to-end:** a campaign fans across websites by weight (E) → each click routes to its offer's site + channel at the edge (E + Worker v9f854389) → the article renders that site's own pubId (D) → AdSense earns on that channel → revenue attributes back per-offer from the right AFS account (F). **Remaining program work:** Phase 11 (hardening: rate limits, PgBouncer, backups, security review, the cross-package channel-pool test-isolation flake) + deferred (Playwright E2E #16, buyer pause/resume #30) + the platform's REAL channel ranges & per-domain Google AFS approval (external). Below: Phase E._

_Earlier — **Phase E shipped: campaign offers (weighted offer-split + per-offer channels)** (commits f3c5419/7b262c1; app services + **edge redirect Worker both DEPLOYED to staging**; no migration, models from Phase A). A campaign now routes its FB traffic across multiple websites (offers), each monetizing under its OWN AFS account/channel — the worked example: Website1 20% / W2 25% / W3 25% / W4 30% + 1 organic. **Redirect** (`resolve.ts`/`worker.ts`/`kv-sync.ts`): a split carries the offer's `channel` + `offerId`; the picked offer's channel beats `config.channel`; the chosen `offerId` is logged to the `click:{txid}` record (Phase F join key); the ORGANIC offer is the non-ad fallback. **Channel pool** (`channel.service.ts`): `assignOfferChannels` claims a channel from EACH PAID offer's OWN domain pool (`FOR UPDATE SKIP LOCKED`, **all-or-nothing** → QUEUED_NO_CHANNEL on exhaustion, full rollback); `assignForCampaign` dispatches offers-vs-legacy; release/rollover generalized to free EVERY channel a campaign holds (per channel) + clear `offer.channelRef`. **Legacy `assignChannel` now only takes GLOBAL (`domain_id IS NULL`) channels** so it can't steal a website's allocation — the 100-concurrent stress test still passes + a new per-offer concurrency test. **Launch**: an offers campaign builds the weighted split (each offer's host `https://{host}/a/{slug}` + its channel + offerId) instead of the single channel; the gate accepts either path. **Article**: the `ch` param is finally plumbed into the CSA `channel` option (content unit forwards `ch` to /search) — **this fixes AFS channel attribution for offers AND legacy campaigns** (it was never wired into CSA before; verified live: `ch` now appears in the /search SSR props). **API**: `GET/PUT /api/campaigns/:id/offers` (replace set; validates LIVE domains / weights / ≤1 organic; editable pre-approval only) + `GET /api/campaigns/offer-domains` (LIVE domains for the picker, any role). **Web**: an Offers editor on the campaign detail page (pick website + weight + kind; read-only with assigned channels once approved). Gate: api 102, worker 40 (incl. per-offer + the stress test), redirect 13, web + article builds, typecheck + lint clean. **Edge Worker deploy:** done — `knn-redirect` redeployed to `go.10linesabout.com` (custom domain, Version 9f854389) with the Phase E code; verified live (`/health/live` ok, unknown `/go/:id` → 302 fallback). The runtime `CLOUDFLARE_API_TOKEN` in the box env is KV-scoped (can't deploy Workers); the deploy used a temporary **"Edit Cloudflare Workers"** token (account `40909e57…`, zone `10linesabout.com`) run via `docker run -w /repo/apps/redirect knn-app:latest npx wrangler@4 deploy` (the image has the workspace deps + the freshly-built redirect source). The deploy only touches the `go.` subdomain (custom_domain route). That token should be deleted after use. **Next:** F (per-offer attribution + dashboards). Below: Phase D._

_Earlier — **Phase D shipped: per-host AFS pubId — one article app serves many websites** (commit 244025b; DEPLOYED to staging; no migration). The article app baked ONE pubId at build, so every registered domain monetized under the same AFS account. Now each request resolves host → registered `Domain` → that domain's AFS account `afsPubId` (+ the domain's own styleId/adsafe) via a new public `GET /api/public/site-config?host=<host>` (`domains.service#resolveSiteConfig`; 404 → the article uses its build-time env fallback, so single-domain/local are unchanged; sends `cache-control: max-age=300`). Article side: `apps/article/app/_afs/site-config.ts#resolveSiteConfig()` reads the request Host header (`next/headers`), fetches the config (cached 300s, env fallback on miss/unreachable); `_afs/csa.ts` `basePageOptions(site,…)`/`afsConfigured(site)` now take a `SiteConfig` param instead of reading `NEXT_PUBLIC_*`; the article + search pages resolve it server-side and thread `site` to the CSA client units. **adtest stays a global build toggle** (not per-domain). Verified on the box: site-config 200/404/400; the search SSR for articles.10linesabout.com logged exactly one `/site-config?host=articles.10linesabout.com` call and embedded the resolved `partner-pub-6567805284657549` in the client-unit props; afscontainer1/relatedsearches1 slots render. Gate: api 95, domains 8, article typecheck + `next build` (routes stay dynamic), both lint clean. **Remaining:** E (campaign→offers — a campaign picks weighted offers/websites; redirect/KV offer-split) · F (per-offer attribution + dashboards). Below: the on-demand-TLS edge._

_Earlier — **Multi-domain article edge shipped: Caddy on-demand TLS + ask gate** (commit 57f92b6; DEPLOYED to staging; no migration). Any website registered in the Domains UI and pointed at the box now auto-provisions a Let's Encrypt cert and serves the article app with **zero per-domain Caddy changes**. New public `GET /api/public/domain-allowed?domain=<host>` (the Caddy `ask` endpoint — `publicEdgeRoutes` mounted at `/api/public`) returns 200 only for a registered `Domain` (any status — a cert must mint on the first HTTPS hit before liveness verify can pass, so gating on LIVE would be chicken-and-egg), 404 otherwise → no cert-abuse surface for arbitrary hosts pointed at the box. `deploy/Caddyfile`: global `on_demand_tls { ask … }` + a catch-all `https://` block placed AFTER the specific app./articles./AFS_TEST hosts (so those keep exact-match) reverse-proxying `article:3001`. `domains.service.ts#normalizeHost` now also strips ports (scheme→path→port). Verified on the box: ask endpoint 200 / 200-normalized / 404 / 400; existing app. + articles.10linesabout.com still serve post-recreate; Caddy adapted-config + admin API both show `on_demand` with the correct ask URL. Gate green (api 94, domains 7). Deploy needed `--force-recreate caddy` (the Caddyfile is bind-mounted). **To add a new website:** Cloudflare grey-cloud (DNS-only) CNAME the subdomain → `articles.staging.rsoc.app` (or A → 178.105.241.185), register it in Domains, Verify; Google AFS-approval of that host is still an external step. Below: the A+B+C rearchitecture._

_Earlier — **Offers/Domains/AFS rearchitecture A+B+C DEPLOYED to staging** (commits b045e97 → 0b805c9; see docs/OFFERS_DOMAINS_AFS.md). A = data model (Domain/Offer/per-domain channels, GoogleConnection→AfsAccount, RLS on offers); B = multi AFS-account management (connect onboards every account a login sees, each with pubId/label; super-admin list/relabel/disconnect); C = super-admin Domains (host→AFS account, channel ranges, DNS-record guidance + liveness verify via the article's /api/site-verify, per-domain channel sync, delete-guard). Migration applied; live AdSense account survived (afsPubId backfilled); domains/offers tables + endpoints live. Tests: adsense 14, domains 6, api 93/worker 35 (separately). **Known test flake:** the global channel pool gets contended when turbo runs api + worker test packages concurrently (a stray channel inflates the rollover-count assertion) — pre-existing isolation fragility, flag for Phase 11; both packages pass run separately. **Remaining:** D (per-host pubId funnel) · E (campaign→offers) · F (per-offer attribution/dashboards). + the platform's real channel ranges are still needed (the listed 00500–05000 are all outsourced). Below: the earlier AdSense detail._

_Earlier — **AdSense LIVE on staging + channel-RANGE selector shipped.** The AFS account holds ~100k channels split across teams (Maximizer / Mukul / Team 1-4 / Ajeet / Pihu …), so the platform imports only an **admin-selected id range** (`GoogleConnection.channelRanges`; range-aware discovery with early-stop; super-admin "Channel id ranges" input on the Platform page). The initial blind 2000-channel import (which overlapped other teams' ranges) was REMOVED. **OPEN:** which id range belongs to THIS platform (user to specify — none imported yet), and **multi-AFS** (other accounts, 500-channel limit) needs per-campaign pubId threading in the funnel — flagged as a larger follow-up. Below: the original connect detail._

_Earlier — **AdSense is LIVE on staging** 🎉 — Google/AdSense connect (D22) DEPLOYED + the platform AdSense account connected. Validated against the real account `pub-6567805284657549` (AFS client `partner-pub-6567805284657549`): AFS access IS granted; `reports:generate` returns real data ($75k earnings / 1.35M clicks last 7 days). Seeded the `GoogleConnection` (refresh token, ACTIVE) + **2000 real AFS channels** (`00500…`) into the pool (2050 total, all AVAILABLE) via `seed-google-connection.ts`. Hardened for the 10k-channel reality: attribution reports only assigned channels; sync is bounded+bulk. The worker's hourly attribution now pulls real per-channel AFS revenue for any channel assigned to a campaign — so **dashboard revenue populates the moment campaigns launch + run** (no revenue yet only because no campaigns are live). `GOOGLE_*` set on the box; migration `20260528122602` applied (pgvector intact). Below: the build detail + Phase 10 + earlier._

_Earlier — **Google/AdSense connect + channel-sync BUILT (D22)** — full gate green (api 85, adsense 12, worker 35). `@knn/adsense` OAuth (offline refresh token, read-only) + Management API account/channel listing; `GoogleConnection` global singleton (migration `20260528122602`, encrypted tokens, pgvector index intact); super-admin connect flow (`/api/adsense/*`) + **Connect AdSense** card on the Platform page; `syncChannels` upserts real AFS custom channels into the pool; worker attribution's `fetchAdsense` is now the **self-dormant `liveAdsenseFetch`** (auto-activates on connect, no-ops otherwise). Resolves the BUILD half of the AdSense revenue pull + real channel ids; remaining is external only (AFS Management API access + `GOOGLE_*` envs + the `…/api/adsense/callback` redirect URI). **To deploy:** has a migration (`google_connections`) — needs the usual deploy. Below: Phase 10 + earlier._

_**Phase 10 (dashboards + KNN design system) COMPLETE & DEPLOYED to staging** (commits aac397f/0f1a4a7/c2661d7; full gate green — api 80 tests; verified in-browser for all 3 roles; no migration). Built: role-scoped `/api/stats` read layer (summary / campaign perf / ad-set→ad breakdown / by-buyer / by-company) + admin platform surfaces (channel pool, articles, settings, revenue-cut). **Buyer Overview** (KPI tiles+sparklines, revenue-vs-spend SVG chart w/ hover, expandable campaign tree, 7/30/90-day range, CSV) — and because the API scopes by actor it serves all 3 roles. **Company-admin Team** (revenue-by-buyer + members approve/reject/suspend). **Super-admin Platform** (revenue-by-company + inline revenue-cut editor, global channel pool, platform settings: compliance prompt/domains). Design system = the bespoke CSS-module kit, NOT Tailwind/shadcn (D21). **Deferred:** buyer campaign pause/resume (needs a new mutation API + FB pause call) — tracked for a follow-up. Next: Phase 11 (hardening & deploy). Below: earlier work._

_Earlier — **Conversion tracking (D20) DEPLOYED to staging** (commit `8eae32e`; gate green; `conversion_events` migration applied on the box, `/api/events` live + returns 204, article rebuilt with `NEXT_PUBLIC_EVENTS_URL` baked into the `/search` bundle, worker CAPI_DISPATCH consumer running). The funnel is now end-to-end: `/search` infers the AFS final-ad click → beacons `POST /api/events` → resolves click→pixel+buyer-token → fires **Facebook CAPI S2S** via the worker. **Back-end click resolution is inert on staging until `CLOUDFLARE_*` (KV) is set + the edge Worker is redeployed via wrangler** (verified: the beacon 204s and logs `KvNotConfiguredError`, as designed). Also done this session: **Phase 9 (stats & revenue, D8/D15) + OpenAI article generator** (deployed to staging). Phases 0–8 done; legacy Node redirect retired (#18). Articles generate via **OpenAI `gpt-4.1-mini`**; needs `OPENAI_API_KEY`. Next: Phase 10 (dashboards). **Live deps:** AdSense AFS + Google OAuth (#4/#13, `@knn/adsense` dormant); CF KV token (click-log + redirect sync), FB test account, `NEXT_PUBLIC_EVENTS_URL` (conversion beacon), OPENAI/INTERNAL_API_* envs._

## Conversion tracking — D20 (committed `8eae32e`; DEPLOYED to staging; back-end inert pending CF KV token)

End-to-end FB conversion signal. The final ads sit in a cross-origin Google iframe so we **infer** the
click the way production AFS trackers (ClickFlare) do, then fire **Facebook Conversions API (CAPI) S2S**.

- **Detector** `apps/article/app/search/conversion-tracker.tsx` (client): on a `message` event, fire once
  if `event.origin` startsWith `https://syndicatedsearch.goog` **and** `document.activeElement` is an
  `IFRAME` **and** not already fired (`sessionStorage knn_conv_fired`) → `sendBeacon` the public events URL
  with `click_id`(=txid)/`value`/`currency`/`url`. Inert unless `NEXT_PUBLIC_EVENTS_URL` is set (baked at
  build — wired through `deploy/Dockerfile` ARG/ENV + compose build args + `.env(.staging).example`).
- **txid threading:** edge Worker (`apps/redirect/src/worker.ts`) now writes `click:{txid}` →
  `{redirectId, fbclid, ts}` to KV (`waitUntil`, 7-day TTL) **only when paid && redirect active**. The
  redirect already threads `txid` → `/a/[slug]` (`related-search-unit.tsx` adds it to the results-page URL)
  → `/search` (`page.tsx` reads `txid/cv/ccy`) → the beacon. The click id is the multi-tenant join key.
- **API** `apps/api/src/modules/events/` — public `POST /api/events` (`events.routes.ts`, query-param
  beacon, always 204, captures ip/ua). `events.service.ts#recordConversion`: KV `readClick` (added to
  `apps/api/src/lib/kv-sync.ts`) → `Ad`(redirectId) → `orgId`/`AdSet.pixelId`+`pxeEvent`/`campaignId`;
  persists a `ConversionEvent` (RLS, `clickId @unique` = idempotent) `pending` (pixel resolved) or
  `skipped` (no pixel); enqueues `CAPI_DISPATCH` (`jobId capi:{id}`, attempts 5, exp backoff) when pending.
- **Worker** `apps/worker/src/capi-dispatch.ts#dispatchConversion` (CAPI_DISPATCH queue, concurrency 4):
  loads the event, resolves the **fresh** buyer token (campaign.buyer → `FbConnection`, decrypted —
  handles rotation since ingest), builds the `CapiEvent` (`event_id=clickId` dedupe, `pxe`→event name,
  `fbc=fb.1.{ms}.{fbclid}`+ip+ua, value/currency), POSTs `@knn/fb/capi.ts` `sendConversionEvent`
  (`/{pixelId}/events`). Success → `sent`+`sentAt`. **Terminal `failed`:** no pixel, broken conn (err 190).
  **Retry (rethrow, stays `pending`):** rate-limit/transient. Already-`sent` → no-op.
- **Schema:** `ConversionEvent` (migration `20260528100449_conversion_events`, RLS `tenant_isolation`,
  pgvector DROP stripped) — `clickId @unique`, `pixelFbId`, `eventName`, `valueMinor`/`currency`,
  `clientIp`/`clientUa`/`eventSourceUrl`/`eventTime`, `status`/`attempts`/`fbResponse`/`sentAt`.
- **New code:** `@knn/shared/conversions.ts` (`pxeToFbEvent`, `buildFbc`), `@knn/fb/capi.ts`,
  `QUEUES.CAPI_DISPATCH`. **Gate green:** typecheck 12 ✓, lint 12 ✓, test (worker 35 incl. capi-dispatch 5,
  api 67 incl. events 4, fb 23 incl. capi 3, shared 57 incl. conversions 4), build 4 ✓.
- **Deployed (2026-05-28):** shipped `8eae32e` to the box, set `NEXT_PUBLIC_EVENTS_URL=https://app.staging.rsoc.app/api/events`
  in `.env.staging`, rebuilt the image (article bundle confirmed to inline the URL), `up -d` ran the
  `conversion_events` migration (RLS=true, pgvector index intact). Smoke: `POST /api/events` → 204;
  `/api/internal` still 403; worker boots the CAPI consumer cleanly.
- **Progress (2026-05-28, second pass):** OpenAI key persisted on the box (validated live, api+worker carry
  it). Edge Worker **redeployed** via wrangler (version `4f902640`, KV binding `REDIRECTS` 0480a994…) — the
  `click:{txid}` write is live. **Funnel + click-log proven live** by a KV round-trip: seeded one
  `redirect:{id}`, hit `go.10linesabout.com/go/…?fbclid=…` → 302 to the funnel article with
  `rc/ch/rac/styleId/txid` (not the fallback), and the Worker wrote `click:{txid}={redirectId,fbclid,ts}`
  (test keys cleaned up). `CLOUDFLARE_ACCOUNT_ID` + `CF_KV_NAMESPACE_ID` prefilled in `.env.staging`.
- **RESOLVED — conversion pipeline now fully wired on staging (2026-05-28).** User created a Cloudflare API
  token (`rsoc-staging-kv`, scope **Account › Workers KV Storage › Edit**); I verified it active + proved
  write/read/delete against namespace `0480a994…`, set it as `CLOUDFLARE_API_TOKEN` on the box, recreated
  `api`+`worker`. **Live-verified `readClick`:** seeded a `click:{txid}` in KV, fired the public beacon →
  204 with the api log showing a clean read (no more `KvNotConfiguredError`) → `unknown_ad` (fake redirect),
  exactly per `events.service`. The same token also powers the launch KV-sync (write). **What's left to see
  a real CAPI fire = a launched campaign** (creates the `redirectId → ad → adSet.pixel → campaign.buyer
  token` chain + writes its `redirect:{id}` KV config). Infra is done; the rest is the normal product flow.

## Article generation — OpenAI (Phase 9.5, amends D16)

Articles generate with **OpenAI `gpt-4.1-mini`** (`@knn/ai/openai.ts` `generateArticleOpenAI`, JSON mode)
— reverse-engineered from live competitors (creatorrule.com / goodprojectideas.com). Output:
`{title, teaser, body_markdown, related_search_terms}`. Skeleton = Define → Benefits → Concrete details
(numbers) → Steps → 3-Q FAQ, 8th-grade, ## headings. **The high-CPC monetization is `related_search_terms`**
(6 commercial-intent queries the model emits) → stored on `articles.related_search_terms` (migration
`20260528080854`) → fed to the content-page CSA `terms` (preferred over campaign keywords). Body renders
via `@knn/shared#articleBlocks` (safe h2/h3/p/ul/ol, no raw HTML); opening paragraph = lead above the AFS
unit. Compliance rewrite runs only when an admin `compliance_prompt` is set. Claude variants kept but not
default. Needs `OPENAI_API_KEY` (empty on staging → generation dormant; set it to go live).

## Phase 9 — Stats & revenue aggregation (code complete; gate green)

Four IST-day-keyed tables (migration `20260528070534_phase9_stats_revenue`; pgvector DROP removed,
RLS on the 3 org tables, `fx_rates` global): `ad_stats_daily` (FB insights per ad: imps/clicks/
conversions + native & USD spend), `campaign_revenue_daily` (gross AFS revenue per campaign, native &
USD, `afs_clicks`, `suppressed`), `ad_revenue_daily` (derived per-ad split: allocated/visible/margin +
`basis`), `fx_rates` (daily USD-per-unit). **Math** in `@knn/shared/money.ts`: `allocateCampaignRevenue`
(D8 conversion share → clicks → impressions → `unallocated`, largest-remainder exact-sum) +
`applyRevenueCut` (buyer override ?? org default) + `toUsdMinor` (D15). **FB insights** =
`@knn/fb/insights.ts` (`fetchAdInsights`/`extractConversions`, rate-limited). **AdSense** =
`@knn/adsense` (`fetchChannelReport`/`parseChannelReport`) — built + tested, **dormant** (injected
`fetchAdsense`, undefined by default; AFS access + Google OAuth pending, #4/#13). **Worker**
`src/attribution/` (`attribution.service.ts` + `fx.service.ts`): `runHourlyAttribution` (today),
`runFinalization` (trailing FB/AdSense windows §5.8); `ATTRIBUTION` queue + `:15`-hourly &
`*/6h` crons. All writes are upserts keyed on (entity, day) → re-pulls idempotent. **Gate met:**
worked examples ($50→1conv; $50→4conv=$12.50ea), zero-conversion fallback, EUR→USD conversion, `<10`
AFS-click suppression, buyer-cut override, and finalization idempotency (`attribution.test.ts`, real PG).
**Footgun fixed:** worker `vitest.config.ts` sets `fileParallelism:false` (global cross-org scans).

## Phase 8 — FB launch pipeline + meta-rejection (code complete; gate met vs mocked FB)

`launchCampaign` (`apps/api/src/modules/campaigns/launch.service.ts`): approved+channel'd campaign →
ensure article → write each ad's redirect config to edge KV (`lib/kv-sync.ts`) → create Campaign→AdSet→Ad
on FB **ACTIVE** (rate-limited, D12) → ACTIVE + notify + audit; FB rate-limit → **BATCHED**; idempotent;
no-channel → 409. Refactored the proven write-path into `resolveLaunchPlan`/`createFbStructure(status)`/
`persistFbIds` (shared with `testLaunchCampaign` PAUSED — folds in task #14). Route `POST /api/campaigns/:id/launch`
(admin). **Meta-rejection (D14):** `checkMetaRejections` (worker, `META_REJECTION_CHECK` queue + 30-min
cron) polls FB `effective_status`; DISAPPROVED → META_REJECTED + release channel + notify. KV env in
`@knn/config` (`CLOUDFLARE_*`/`CF_KV_NAMESPACE_ID`). **Gate met (mocked FB):** launch ACTIVE/BATCHED/
idempotent + rejection→status+notify+release. **Live = external deps** (CF token, FB test account, AI keys).

**Auto-launch (D19, done):** per-company `Organization.autoLaunch` toggle (default OFF = manual gate,
beside auto-approve on the Approvals page). When ON, `triggerAutoLaunch` (worker, `launch-trigger.ts`)
fires the instant a campaign acquires a channel — direct `assign` handler + queue-drain/rollover via an
`onAssigned` callback threaded through `processQueue`/`releaseChannelForCampaign`/`rolloverChannels`. It
gates on `autoLaunch && channelId && !fbCampaignId` → enqueues `FB_LAUNCH` (`attempts:1`, so a partial FB
failure can't double-create) → the worker POSTs the token-guarded `POST /api/internal/launch/:id`
(`x-internal-token`), which runs the same `launchCampaign` on the API (it owns the FB client + on-disk
creatives). Needs `INTERNAL_API_TOKEN`/`INTERNAL_API_URL` in the env. Tests: `launch-trigger.test.ts`
(gating + the HTTP call), an Approvals auto-launch toggle test, and launch-mode-aware notify wording.

## Phase 7 — Redirect engine (complete; deployed to the edge)

Decided on EDGE over single-origin (research: a single region can't hit <50ms globally). **Hono
Cloudflare Worker** (`apps/redirect/src/worker.ts` + `wrangler.toml`, KV namespace `REDIRECTS`
`0480a994…`) live on **`go.10linesabout.com`** (custom domain — scoped to `go`, main site untouched;
resolves to CF Worker IPs, not the origin). `/go/:id` → KV read (`redirect:{id}`) → pure
`resolveRedirect` (`src/resolve.ts`, 11 tests): paid (`fbclid`/`utm_source`) → 302 to the content page
with `rc`/`ch`/`rac`/`styleId` + minted `txid`; organic/paused/unknown → fallback; weighted split
supported. **Benchmarked ~20–25ms steady-state from EU** (Worker compute sub-1ms + KV 1–5ms; gate met).
`workers_dev=false`. **Legacy Node redirect RETIRED (task #18):** removed from the staging
compose + Caddy and deleted from source — `@knn/redirect` is Worker-only now (deploys via `wrangler`,
no origin `build`/`start`), so a stray route flip to the box can't serve unmonetized 302s.
**Remaining (Phase 8):** the origin→KV write-through sync (`redirect:{id}` config per ad) on launch +
a CF API token (Workers KV Edit) on the origin. One test KV key `redirect:test` exists (benchmark).

## Phase 6 — Channel pool & assignment (complete; gate green)

Global AdSense channel pool (`channels`, no RLS) assigned 1:1 to campaigns; per-campaign attribution
span (`channel_assignments`) + FIFO wait queue (`campaign_queue`) are org-scoped (RLS). Migration
`20260527211044_channel_pool` (the auto-generated `DROP INDEX articles_embedding_idx` was removed to
preserve the pgvector index). Service `apps/worker/src/channel-pool/channel.service.ts`:
`assignChannel` (FOR UPDATE SKIP LOCKED → PROCESSING, else enqueue + QUEUED_NO_CHANNEL),
`releaseChannelForCampaign`, `processQueue` (FIFO drain), `rolloverChannels` (IST midnight),
`seedChannels`. Worker runs the `CHANNEL_MAINTENANCE` queue (single writer) + the 00:05 IST rollover
cron; the API enqueues `assign` on approve/auto-approve. **Gate green:** the 100-concurrent stress
test asserts zero double-assignment; FIFO/release/resume/rollover covered (worker 9 tests). Pool via
`packages/db/scripts/seed-channels.ts` (placeholder ids; real AdSense channel ids = OPEN_QUESTIONS #4).

## AFS/RSOC funnel — VALIDATED LIVE (2026-05-28)

The monetization core is proven on a Google-approved domain (`articles.10linesabout.com`, AFS style
"Ajeet" `7465600436`, `partner-pub-6567805284657549`): the **content page** renders related-search
terms (after Google crawls it — the crawl is the hard gate, no bypass), clicking a term → **`/search?q=…`**
renders Google ads. Two-page RSOC via `_googCsa('relatedsearch'|'ads', …)` in `apps/article/app/_afs/csa.ts`.
Config matched to a live arbitrage funnel: `relatedSearchTargeting:'content'`, `referrerAdCreative` (←`rc`),
`ignoredPageParams`, `q` results param, `adsafe` (`NEXT_PUBLIC_AFS_ADSAFE`, default medium), `linkTarget:'_blank'`,
load callbacks. Running `adtest=on` (test mode) — flip off (rebuild) for real revenue. **Pre-warm/crawl an
article before driving FB traffic** (Phase 8). The competitor's `txid`→`/api/events` funnel = the Phase 7
(redirect click id) + Phase 9 (attribution, D8) blueprint. See `docs/DECISIONS.md` + memory `staging-deployment`.

## Phase 5 — Article engine + article frontend (complete; deployed; AFS validated live)

Built against **mocked AI** per the gate; live generation needs `ANTHROPIC_API_KEY` + `OPENAI_API_KEY`
wired (external dep, like FB live-connect) — the clients throw `AiNotConfiguredError` until then.

- **`@knn/ai`** (new package): fetch-based clients (not vendor SDKs, mirroring `@knn/fb`) — `embedText`
  (OpenAI `text-embedding-3-small`, 1536-d), `generateArticle` + `complianceRewrite` (Claude Messages).
  Keys optional → `AiNotConfiguredError`. 8 unit tests (fetch-stub + mocked config).
- **Schema** (migration `20260527175343_article_engine`): `articles` (raw + compliant content,
  `embedding vector(1536)`, ivfflat cosine index, status, slug) + RLS `tenant_isolation`. Campaign
  links via the existing scalar `articleId`.
- **Engine** `apps/api/src/modules/articles/articles.service.ts`: `generateArticleForCampaign` embeds
  the campaign keywords/angle → **reuses** an existing org article when cosine ≥ 0.70 (raw-SQL `<=>`,
  scoped via `withTenant(campaign.orgId)` so reuse never crosses tenants) else **generates** (Claude) →
  **compliance rewrite** → stores both versions + the embedding → attaches to the campaign. Idempotent;
  audits `article.generated` / `article.reused`. Route `POST /api/campaigns/:id/article` (owner/admin).
- **Public read** `GET /api/public/articles/:slug` (no auth, `withSystem`, compliant content only) —
  backs the article frontend without a DB import in the Next app (build-safe).
- **Frontend** `apps/article`: SSR content page `app/a/[slug]` (title, ≤100-word/≤300-char teaser via
  `@knn/shared#articleTeaser`, **RSOC related-search unit**, full body, SEO `generateMetadata`) + results
  page `app/search` (the **ads unit**). Real Google CSA wired (see the AFS section above) — NOT a
  placeholder. Light editorial theme (AdSense-friendly). `robots.txt` allows content, disallows `/search`.
- **Gate green:** typecheck 11/11, lint 11/11, build 5/5, **128 tests** (shared 38 incl. teaser, ai 8,
  api 53 incl. 8 article-engine [generate / reuse / no-reuse / idempotency / authz / public]).
- **In-browser verified** (Preview MCP): seeded one article → `/a/<slug>?q=…&ch=…` rendered title +
  teaser + AFS slot (data-query/channel from the URL) + body, with the SEO title set. Demo data +
  scaffolding cleaned up.

## Phase 4 — Approval system (complete; gate green; verified in-browser; deployed)

- **State machine** in `@knn/shared/campaign-status.ts` — `CAMPAIGN_TRANSITIONS` (the canonical
  campaign lifecycle graph) + `canTransitionCampaign`/`nextCampaignStates`/`isTerminalCampaignStatus`.
  Single source of truth for api + worker; the complete graph is defined now, later phases wire
  routes/jobs to edges. 8 unit tests (legal/illegal transitions, terminal ARCHIVED, self-transition
  forbidden).
- **Schema** (migration `20260527165639_campaign_approval`, additive only — no RLS change):
  `organizations.auto_approve` (Bool) + `campaigns.{reviewed_by_id, reviewed_at, rejection_reason}`.
- **API** `apps/api/src/modules/campaigns/approval.service.ts` + routes: `GET /api/campaigns/pending`
  (admin review queue), `POST /:id/approve`, `POST /:id/reject` (reason required), `POST /:id/reopen`
  (buyer withdraw/revise → DRAFT). `submitCampaign` now honors org **auto-approve** (submit +
  immediate system approval). Admin `GET /api/admin/organization` + `PATCH /organizations/:id/
  auto-approve` toggle (SUPER_ADMIN any org; COMPANY_ADMIN own). `requireRole` guards admin routes;
  RLS isolates COMPANY_ADMIN to their org (cross-org review → 404).
- **Audit** — `apps/api/src/lib/audit.ts#writeAudit` is the **first writer** to `audit_log` (written
  in-txn with the change). Also retrofitted onto the existing admin actions (user status changes,
  org creation).
- **Web** (Phase 10 slice): admin-only **Approvals** page (`/dashboard/approvals`) — review queue
  with offer summary (objective/budget ABO·CBO/geo/keywords/special-ad-cat), Approve + Reject
  (inline reason), and a COMPANY_ADMIN auto-approve toggle. Nav shows "Approvals" for admins.
  Campaigns list shows the rejection reason + **Revise**/**Withdraw** (reopen) actions.
- **Gate green:** typecheck (10) · lint (10) · build (5, incl. both Next apps) · tests — shared 32
  (+8), db 6, fb 14, redirect 2, worker 5, **api 45 (+13 approval/reopen)** = 104 total.
- **In-browser verified** (Preview MCP, local web+api, seeded demo): logged in as a COMPANY_ADMIN →
  Approvals page rendered 3 pending campaigns → **Approve** (Auto Insurance → APPROVED), **Reject**
  with reason (Medicare → REJECTED, reason persisted), **auto-approve toggle** (org flipped to true).
  DB confirmed statuses + `reviewedById` + audit actions `campaign.approved/rejected,
  org.auto_approve.enabled`. (Demo data + scaffolding cleaned up afterward.)

## Audit of Phases 0–4 (2026-05-27)

Full cross-check against the plan's per-phase gates + decisions D1–D18 (two independent
sub-audits + mechanical checks). **Verdict: gates met for Phases 0, 1, 2, 4; Phase 3 PARTIAL.**
- **RLS:** all 13 business tables carry `tenant_isolation` (USING + WITH CHECK); only the global
  `platform_settings` is exempt (correct). Cross-org isolation proven by `rls.test.ts`.
- **No decision violations.** Prisma `CampaignStatus` ⇄ `CAMPAIGN_STATUS` match exactly (no drift).
- **Fixed during the audit:** FB sync now follows cursor pagination (`fetchAllPages`) — previously
  truncated at one page (>200 accounts/pages, >100 pixels); +2 tests. `FB_LOGIN_CONFIG_ID` added to
  `.env.example`.
- **Open gaps (tracked):** (1) **Playwright E2E missing** — Phase 3 gate names it; substituted by
  API integration tests + manual in-browser verification → recommend folding E2E into Phase 10
  (OPEN_QUESTIONS #8, task #16). (2) traffic split deferred to Phase 7 (OPEN_QUESTIONS #9).
  (3) LOW: suspension isn't enforced on a live access token until it expires (≤15m) — standard JWT
  tradeoff, self-heals at refresh; revisit in Phase 11. (4) LOW: `notify` is a console stub (real
  email is Phase 11; durable signal is entity state per D13).

## Phase 3 — Ad launcher (complete, deployed)

- **Schema** (migration `20260527135109_campaigns_adsets_ads`, RLS on all 4 tables): `campaigns`
  (the offer — keywords/RAC/article-ref/channel-ref, D5–D7), `ad_sets`, `ads` (unique `redirect_id`
  D9 + selectable `pxe_event` D10), `uploads` (creative assets). FB asset refs (ad account/page/
  pixel) are scalar so disconnect-churn can't cascade-delete campaigns.
- **Validation** in `@knn/shared/campaigns`: lenient `campaignDraftSchema` + strict
  `campaignSubmitIssues` gate (DRAFT → PENDING_APPROVAL). 8 unit tests.
- **API** `apps/api/src/modules/{campaigns,uploads}`: campaigns CRUD + submit (buyer-scoped;
  FB-asset ownership enforced; only DRAFT editable/deletable) and a validated multipart creative
  upload (type/size). 11 integration tests on real PG (incl. unique redirect ids, 422 issue list,
  buyer-scope 404). `AppError` now carries `details` for the submit-issue list.
- **Web** `apps/web/app/dashboard/campaigns`: campaigns list (status badges, edit/view/delete) + a
  3-step **launch wizard** (Offer → Ad sets & ads w/ creative upload + pixel/pxe → Review) that
  pulls the buyer's live FB ad accounts/pages/pixels, saves drafts, and submits (surfacing server
  issues). `next.config` `extensionAlias` lets Next resolve the shared package's `.js` specifiers.
- **Gate green:** typecheck (10) · lint · build (5) · tests (api 31, shared 22, fb 14, worker 5,
  db 6, redirect 2). **Deployed:** migration applied on staging; `/api/campaigns` + `/api/uploads`
  mounted (401), `/dashboard/campaigns` served (200).
- **Pending = your in-browser walkthrough** of the wizard with real FB data (I can't log into the
  authed dashboard — the super-admin password is custom and I won't fabricate a session). The
  wizard will list the 8 ad accounts you just connected.

## Facebook connect — verified live (2026-05-27)

A real BM completed the self-serve flow on staging: dashboard login → **Connect Facebook** → FLB
consent → callback → token exchange → 60-day long-lived token → synced **8 ad accounts** (USD,
Asia/Kolkata), pages, and per-account pixels; status **Connected**, all five scopes granted. Two
gotchas resolved on the way, worth remembering:

- **Facebook Login for Business needs `config_id`, not `scope`.** The app uses FLB (not classic
  login), so `buildAuthUrl` emits `config_id` (+ `override_default_response_type`) — set via
  `FB_LOGIN_CONFIG_ID` (staging value `26693255093680532`, the "Rsoc.app" login configuration).
  Classic scope-based login is the fallback when that env is empty.
- **`Error validating client secret` = wrong `FB_APP_SECRET`.** The dialog only needs App ID +
  config, so it succeeded while the server-side code→token exchange failed; fixing the secret fixed
  the connect. (Diagnose via `docker compose logs api` on the box — the callback logs the FB error.)

Self-serve connect works **now for app role-holders** (admin/testers); opening it to arbitrary
buyers is the App Review path (deferred — D-OQ: advanced access + Business Verification [done] +
Data Protection Assessment + privacy policy + data-deletion callback). Token renewal is automatic
via the worker's daily token-refresh job.

## Done

- Planning complete; 12-phase roadmap approved (see the plan + `DECISIONS.md` D1–D18).
- **Phase 0 — DONE (gate green).** Monorepo (pnpm + Turborepo, TS strict, ESLint flat, Prettier).
  `infra/docker-compose.yml` (Postgres 16 + pgvector 0.8.2, Redis 7) running via Colima.
  Packages: `@knn/config` (validated env, zod), `@knn/shared` (constants, IST datetime,
  conversion-weighted money allocator — 14 unit tests), `@knn/queue` (BullMQ + Bull-Board feed),
  `@knn/db` (Prisma 6 + pgvector + `platform_settings`, first migration applied + seeded). Apps:
  `@knn/api` (Fastify — `/health` checks db+redis, Bull-Board at `/admin/queues` behind basic
  auth), `@knn/redirect` (Hono — health + placeholder `/go/:id`, lean ioredis), `@knn/worker`
  (BullMQ heartbeat + IST midnight cron stub), `@knn/web` + `@knn/article` (Next 15, branded).
  Root + per-module `CLAUDE.md`, `/docs`, GitHub Actions CI.
  - **Verified:** typecheck (9 pkgs), lint (0 errors), test (20 passing), build (5 pkgs incl. 2
    Next builds), and **runtime of the built bundles**: api `/health` → `{db:up,redis:up}`,
    Bull-Board 401→200 with auth, redirect `/go/:id` → 302, worker boots on `Asia/Kolkata`.

- **Phase 1 — multi-tenancy + RLS foundation DONE (verified).** Schema: `organizations`,
  `users` (Role / UserStatus / OrgStatus enums), `refresh_tokens`, `audit_log` (migration
  `20260527075938_auth_multitenancy`). Real RLS: a NON-superuser app role (`knn_app`, created by
  `pnpm db:bootstrap`) so policies actually apply; per-transaction GUCs `app.current_org` /
  `app.bypass_rls` drive `tenant_isolation` policies on all four tables; `@knn/db` exposes
  `withTenant(orgId, fn)` and `withSystem(fn)`. **6 isolation tests pass** (cross-org reads return
  nothing, `WITH CHECK` blocks cross-org writes, `withSystem` sees all). App now connects via
  `APP_DATABASE_URL`; migrations use `DATABASE_URL` (owner).

- **Phase 1 — auth layer DONE (verified).** bcrypt(12) hashing, JWT access (15m, via `jose`) +
  DB-backed rotating refresh tokens (7d); routes `signup`/`login`/`refresh`/`logout`/`me`;
  signup→PENDING→admin approve/reject; `authenticate` + `requireRole` middleware; `runScoped`
  tenant guard; admin endpoints (create org + first company-admin, list/approve users). Seed
  creates the platform org + a SUPER_ADMIN (`super@knn.local`). **Phase 1 COMPLETE** — 35 tests
  pass (9 auth lifecycle + 6 RLS + …), plus an HTTP smoke on the built bundle (login → /me →
  admin all 200; unauth/bad-password 401); lint/typecheck/build all green.

- **Staging deployed to Hetzner (2026-05-27).** Box `rsoc-staging` (CPX32, Falkenstein, Ubuntu
  24.04, IP `178.105.241.185`) in the KNN project. Full stack runs via
  `deploy/docker-compose.staging.yml` and is **verified healthy** (all 7 services up, api
  `db:up/redis:up`, `knn_app` RLS role bootstrapped, super admin `admin@rsoc.app` seeded). Code in
  `/opt/rsoc`; secrets in `/opt/rsoc/deploy/.env.staging`. See memory `staging-deployment`.

- **Staging is LIVE with TLS (2026-05-27).** DNS on Cloudflare (zone `rsoc.app`; Namecheap NS →
  `damian`/`gina.ns.cloudflare.com`; staging A records grey-cloud → `178.105.241.185`). Caddy
  (`edge` profile) issued Let's Encrypt certs. Verified end-to-end over public HTTPS:
  - `https://app.staging.rsoc.app/` → 200 (dashboard) · `/api/auth/login` → 200 + tokens
  - `https://articles.staging.rsoc.app/` → 200 · `https://go.staging.rsoc.app/go/x` → 302
  - Super-admin `admin@rsoc.app` login works. See memory `staging-deployment`.

- **Phase 2 — Facebook integration DONE (gate green).** New `@knn/fb` package: AES-256-GCM token
  crypto, `fetch`-based Graph client, error classification (`FbConnectionBrokenError` /
  `FbRateLimitError` / `FbApiError`), per-ad-account `FbRateLimiter` (concurrency cap + exponential
  backoff honoring `x-business-use-case-usage` + circuit breaker — D12), OAuth (long-lived ~60d token
  exchange, `FB_SCOPES`), and account/page/pixel sync → DTOs. See `packages/fb/CLAUDE.md`.
  - **Schema** (migration `20260527104653_fb_integration`, RLS on all 4 tables): `FbConnection`
    (one per user, encrypted token, `status` ACTIVE/CONNECTION_BROKEN), `FbAdAccount`, `FbPage`,
    `FbPixel` (lander/search/adclick event slots for the D10 `pxe` selector, populated later).
  - **API** `apps/api/src/modules/facebook`: signed OAuth `state` (jose, 10m, purpose-checked);
    `GET /api/facebook/auth-url` (503 if FB unconfigured), public `GET /callback` (exchange → encrypt
    → upsert connection → best-effort sync → 302 back to `WEB_DOMAIN/dashboard/facebook`),
    `GET /status|/accounts|/pages|/accounts/:id/pixels`, `POST /sync`, `DELETE /connection`. All
    reads go through `runScoped` (RLS-scoped); the callback uses `withSystem` (no session yet).
    Sync fetches from FB **outside** any txn, then upserts in one txn (no open txn across network).
  - **Worker** daily `token-refresh` job (02:30 IST cron → `TOKEN_REFRESH` queue): extends tokens in
    a 10-day window, degrades expired/190 → `CONNECTION_BROKEN` + notify, nudges re-auth ~day 55 (D13).
  - **Verified:** typecheck (10 pkgs), lint (0), build (5). **Tests:** FB integration (7, real PG +
    mocked Graph — connect+sync, broken-token→CONNECTION_BROKEN+notify, scoped lists, auth guards),
    token-refresh (5, real PG + injected clock — extend/degrade/proactive), `@knn/fb` unit (12 —
    classification, BUC throttle→retryAfterMs, limiter backoff/breaker, DTO mapping).

## In progress

- Nothing — Phase 5 code-complete, gate green, verified in-browser. **Not yet committed or shipped to
  staging** (pending go-ahead). When deploying, the article service needs `ARTICLE_API_BASE` set to the
  API origin (e.g. `https://app.staging.rsoc.app`) so its SSR fetch reaches the public article API
  across subdomains; live article generation also needs `ANTHROPIC_API_KEY` + `OPENAI_API_KEY`.
- Phase 4 is committed (`7bef2ca`) + deployed to staging; the FB-pagination audit fix is `b942263`.

## Next

- **Phase 6 (Channel pool & attribution-assignment)** — per-campaign channel assignment via
  `SELECT … FOR UPDATE SKIP LOCKED` in a single-writer worker (D11); FIFO queue; IST lock-for-day,
  release/resume rules, auto-pause → `QUEUED_NO_CHANNEL`; midnight cleanup cron (00:05 IST); history.
  **Gate:** 100-concurrent-approval stress test → zero double-assignment; queue FIFO; release/resume/
  rollover tests. This is where the approved → article → channel pipeline starts wiring together.

## Staging now runs Phase 2 with Facebook configured (2026-05-27)

- Shipped the Phase 2 tree to the box (`git archive HEAD` → `tar -x` into `/opt/rsoc`), set
  `FB_APP_ID` (906408948523489) + `FB_APP_SECRET` in `/opt/rsoc/deploy/.env.staging` (redirect URI
  was already `https://app.staging.rsoc.app/api/facebook/callback`), rebuilt `knn-app:latest`, and
  `up -d --build` (the `migrate` one-shot applied `fb_integration`). **Verified:** migrate exit 0 +
  "All migrations applied"; the 4 `fb_*` tables exist; api container has all 3 FB vars (so
  `isFbConfigured()` → true, `auth-url` no longer 503); public `GET /api/facebook/callback` → `302`
  to `/dashboard/facebook?fb_error=missing_code` over HTTPS.
- **Remaining = a human step (not code):** the live OAuth round-trip needs someone to open the
  `auth-url` and consent in a Facebook account that is an admin/developer/tester on the app, then
  connect a FB **test** ad account (D18 — never connect a real/prod ad account on staging). The app
  can stay in **Development mode** for this (no business verification needed for app-role users).
  for now trigger it via the dashboard's **Connect Facebook** button (see below).

## Dashboard auth shell + Facebook connect UI (2026-05-27, Phase 10 slice)

- Built a real (hand-crafted, no Tailwind/shadcn yet — that's the deliberate Phase 10 setup) UI in
  `apps/web`: `/login` (email+password), an `AuthProvider` with localStorage tokens + single-flight
  401-refresh, a guarded `/dashboard` shell (top nav, user chip, sign out), and `/dashboard/facebook`
  — **Connect** button (`auth-url` → FB dialog), connection status (scopes/expiry/connectedAt),
  synced ad accounts (expandable → pixels) and pages, **Re-sync**, **Disconnect**, and broken-state
  reconnect. Calls the same-origin `/api` (Caddy). Local dev: set `NEXT_PUBLIC_API_BASE=http://localhost:3000`.
- **Deployed to staging + verified in-browser:** `/login` renders (KNN dark theme, serif display);
  an unauthenticated `/dashboard/*` visit redirects to `/login` (client guard). Web build/typecheck/
  lint green; all 8 services healthy.
- **Tokens live in localStorage for now** (standard SPA pattern); Phase 11 hardening should move to
  httpOnly cookies. **The live connect is the user's step** — log in at
  `https://app.staging.rsoc.app/login`, open Facebook, click **Connect**, consent in a Facebook
  account that's an admin/dev/tester on the app, and pick a FB **test** ad account (D18). (Couldn't
  self-verify the authed flow: the staging super-admin password is custom and I won't fabricate a
  user in the shared DB.)

## Admin + Facebook rework (2026-05-29, deployed to staging)

- **Tenant-isolation fix:** a `COMPANY_ADMIN` can no longer see/act on a `SUPER_ADMIN`
  (`listUsers` filters super-admins for non-super actors); client users can't be added to the
  platform org (`isPlatform`); platform org hidden from the Companies list.
- **Super-admin user delete:** `DELETE /api/admin/users/:id` (`deleteUser`) + Team-page **Remove**
  button — frees an email for re-use; guards against deleting yourself/a super-admin.
- **Companies tab** now: expandable per-company **member details** (`GET /organizations/:id/users`),
  **Revenue-by-company + platform cut%** (moved off Platform; explicit **Save**, not silent on-blur),
  and a **Recent activity** log (`GET /api/admin/audit`, actor email + org resolved). Platform tab =
  AdSense + channel pool + settings only.
- **Facebook = multiple profiles per user** (migration `20260529000000_fb_multi_profile`: dropped
  `fb_connections.user_id` unique, added `fb_name` + `(user_id, fb_user_id)` unique). Profile-scoped
  API: `/profiles` (own), `/profiles/all` (super-admin oversight — every profile + owner/company),
  `/profiles/:id/{sync,accounts,pages}`, `DELETE /profiles/:id`. Aggregated `/accounts` + `/pages`
  still feed the launcher. UI shows profiles by **name**, expandable to ad accounts→pixels + pages;
  connect-multiple; super-admin sees the platform-wide list. **Re-sync also backfills the profile
  name** (for profiles connected before names were stored).
- **Token resolution hardened:** launch / attribution / CAPI dispatch / meta-rejection now use the
  token of the connection that **owns the campaign's ad account** (not "the buyer's only
  connection") — correct now that a buyer may have several profiles.
- Gate: api 123 + worker 41 tests, all 12 packages typecheck + lint, web build — green. Migration
  applied clean on staging (existing profile `1319558173572761` intact).

## New setup step

- After `pnpm db:migrate`, run **`pnpm db:bootstrap`** once per environment to create the
  non-superuser `knn_app` role that RLS depends on. (CI must run it before tests — TODO when we
  touch CI next.)

## Notes / gotchas for the next session

- Runtime Node is 25; `.nvmrc` pins 22. If a tool misbehaves, try Node 22.
- `pnpm db:*` scripts load the root `.env` via `dotenv-cli`.
- Bull-Board basic-auth creds are in `.env` (`BULL_BOARD_USER`/`PASSWORD`).
- External dependencies not yet provisioned: real domains, Facebook App + business verification,
  AdSense AFS API access, AI keys (see `OPEN_QUESTIONS.md`).
