# Whop Ads

A second ad provider next to the direct Facebook connection (decision **D33**, `docs/DECISIONS.md`).
Whop resells Meta advertising and owns the Meta ad account. A buyer connects their Whop business here with
its **business ID** and an **API key**; this page then checks everything Whop needs before ads can launch.

| Phase | What | State |
|---|---|---|
| 1 | **Connect:** add a Whop business, live checklist, Facebook-page step, pixel check, per-company switch | Built and tested |
| 0 | **Sandbox spike:** answers the unknowns in `OPEN_QUESTIONS.md` #15 | Ran 2026-09-30 (answers below; a few need real delivery) |
| 3a | **Tracking:** the pixel on the page Whop's check sees, server events for real conversions | Built and tested; a launch now writes the `whop` block that switches it on |
| 2 | **Build and launch** campaigns on Whop: wizard provider switch, draft-first resumable launch, pause / resume / budget / relaunch, clone, reopen | Built and tested (mock Whop over HTTP, real Postgres); proven against Whop's sandbox up to the launch gate |
| 3b | **Stats:** status sync, spend in the IST day, "(Whop)" labels in Analytics | Built and tested |
| 4 | **Operate:** webhooks, payment-failed retry button, admin overview | Not started (a payment failure is already told to the buyer, once) |

Nothing in Facebook's code path changed: Whop has its own tables, package and routes.

## Turn it on

Two switches, both off by default. Until both are on, every Whop route answers **404** and the nav item is hidden.

1. **Server flag** (API environment): `WHOP_ADS_ENABLED=true`.
2. **Company switch:** a super-admin opens **Platform → Companies** and turns **Whop Ads** on for the company
   (`organizations.whop_enabled`, audit entry `org.whop.updated`). A super-admin themselves needs only the server flag.

| Variable | Default | What it does |
|---|---|---|
| `WHOP_ADS_ENABLED` | `false` | Master switch. Off: no Whop route answers and nothing Whop-related shows. Stored connections are kept. |
| `WHOP_ALLOW_SANDBOX` | `false` | Lets **buyers** connect a business in Whop's sandbox (test data, no real money). A super-admin can always do it, so the platform owner can test anywhere. On for local and staging, off in production. |
| `WHOP_API_BASE` | `https://api.whop.com/api/v1` | Whop's production API. Change it only to point tests at the mock. |
| `WHOP_SANDBOX_API_BASE` | `https://sandbox-api.whop.com/api/v1` | Whop's sandbox API. |
| `WHOP_API_VERSION_DATE` | `2026-09-29` | Sent as `Api-Version-Date` on every call. Whop versions its API by date. Never go earlier than `2026-09-24-1`: the ad-copy shape changed then. |

All are validated in `@knn/config`. Apps never read `process.env` for them.

**Deploy order for the launch (phase 2).** The code reads columns the migrations add, so: (1) `pnpm db:deploy` (two additive
migrations: `20260930120029_whop_launch_columns`, `20260930150000_whop_key_epoch`; every existing campaign becomes
`FACEBOOK`, nothing is rewritten); (2) deploy the API, the worker and the web app together (the web app sends `adProvider`
and the API now returns it); (3) only then set `WHOP_ADS_ENABLED=true` and turn on a company. Tracking needs three more
things before a Whop ad can pass Whop's pixel check: the white site and the article app deployed, and `WHOP_SCOPE_SECRET`
(the same value) set on the redirect Worker, the white Worker and the article app (see "Tracking"). With the flag off a
deployment behaves exactly as before: nothing Whop-related is reachable, and the worker's Whop passes do nothing.

## Connect a Whop business (what a buyer does)

1. Open the business in Whop. The address bar shows `/dashboard/biz_…`. That is the **business ID**.
2. In Whop, go to **Developer → Account API Keys** and choose **Create**. Tick the permissions below, then copy
   the key. Whop may show it only once.
3. In the dashboard, open **Whop Ads**, paste both, and choose **Connect**. The page has a **Where do I find
   these?** section with the same steps and a **Copy list** button for the permissions.

We ask Whop whether the key works **before** saving anything. A wrong key is never stored. The key is stored
encrypted (AES-256-GCM, the same helper as Facebook and Google tokens); only its last four characters are ever
shown. Connecting the same business again replaces the key. **Remove connection** deletes the row, and the key with it.

A buyer sees and manages only their own connections. A super-admin sees everyone's (`GET /connections/all`).

## The checklist

Each connection shows seven lines, read live from Whop. Each says what is wrong in one sentence and gives one
button where we can help. **Check again** re-reads everything.

| Row | What we check | How to fix it | Needed to launch |
|---|---|---|---|
| **API key** | Whop accepts the key for this business. When the key may read its own account, we also confirm the business ID matches. | Wrong or deleted key: paste a new one. Wrong business: use the ID of the business the key belongs to. | Yes |
| **Key permissions** | The read permissions we can test without side effects. Create, update and event permissions are confirmed the first time they are used, and the error then names the missing one. | In Whop, open the key, tick the listed permissions, **Check again**. | Yes |
| **Whop Ads agreement** | The account owner signed it. | Only the owner can: **Open Whop dashboard**. | Yes |
| **Payment method** | A primary payment method exists (Whop balance or a card). | Add one in Whop. | Yes |
| **Reporting currency** | Whop's ads currency. Not USD shows a note; we convert with our exchange rates. | Nothing to do. | No |
| **Facebook page** | A usable Facebook page is attached. | **Connect Meta Business** (Whop's own sign-in), or **Create a Whop-managed page** (the business needs a logo, banner and description set in Whop first), or **Refresh page state** for a page that shows an error. | Yes |
| **Whop pixel** | Whop has seen its pixel recently. Informational: "not seen yet" is normal before a first launch. | Nothing. To test a page now, paste its address into **Check the Whop pixel on a page**. | No |

`canDraft` (the key works) and `canLaunch` (key, permissions, agreement, payment and page done) come from this list.
The pixel row never blocks anything: the pixel lives on OUR landing page, and Whop checks it per ad, on that ad's own
address, when the ad is created (a launch runs the same check first and says what it found). Drafts need `canDraft`;
submitting a campaign needs a working, enabled connection but not `canLaunch`, because a missing payment method or page
is something Whop says at launch, in its own words, and the buyer can fix it in Whop without going back through review.

Two steps can only be done by the Whop account owner, and the page links out to them: signing the agreement and
adding a payment method. The Meta Business sign-in is finished on Meta, then returns to our dashboard. The return
address must be on `WEB_DOMAIN`, never an arbitrary URL.

## Build and launch a campaign (phase 2)

In the campaign wizard, **Ad network** appears under the campaign name when Whop Ads is on for the buyer's company;
Facebook stays the default. Choosing **Whop** swaps the Facebook ad account, page and pixel for a **Whop business** and
the **Facebook page** its ads run under. Destination websites, keywords, the referrer ad creative, ads and creatives
are the same. **Switching network** clears what belongs to the other one (account, page, pixel, schedule, display links; a
call to action Whop has no name for becomes Learn more) and says what it cleared. What the new network merely might not be
able to run is **kept, marked "not on Whop" and reported** until the buyer removes it or switches back: a special ad
category is a compliance declaration, and a placement or bid strategy shapes delivery, so none of them is dropped silently.

| | Facebook | Whop |
|---|---|---|
| Account | Ad account + page + pixel | A connected Whop business + a Facebook page of that business. No pixel to pick: Whop owns it |
| Daily budget floor | $2.00 | $1.00 while building (the draft schema's floor, for every network). Whop enforces its own minimum at launch and answers in words when it is higher |
| Test launch (PAUSED) | Yes | No: Whop checks a campaign when its ads are created |
| Headline and primary text | Optional | Required |
| Placements | All | Whop has no name for Facebook video feeds or the Messenger inbox: not offered (one already chosen is kept, marked and reported) |
| Bid strategy | All | No ROAS goal; cost cap and bid cap work (a ROAS goal already chosen is kept, marked and reported) |
| Special ad categories | All | No online-gambling category (one already chosen is kept, marked and reported: a campaign cannot go out without a category it needs) |
| ROAS target, attribution window, display link | Yes | Hidden: Whop has no such setting |
| Analytics country and hour tabs | Yes | Empty: Whop reports no breakdown |

Every rule above is checked while building (the review step lists what is missing) and again by the server when the
campaign is submitted, from one table in `packages/shared/src/whop-launch.ts`: `whopUnsupportedProblems` (what Whop cannot
express at all) and `whopLaunchProblems` (that, plus what is not filled in yet).

### What a launch does

The Launch button, the worker's auto-launch and a relaunch all arrive at `launchCampaign`, which routes by provider
**before any side effect**. A Whop launch (`whop-launch.service.ts`) is draft-first and resumable: nothing spends until
its last step.

1. **Checks, touching nothing:** Whop Ads is on for the company; the campaign's business is still connected and not
   BROKEN (found by the connection id, or by the buyer's connection to the same business if that row was replaced);
   the campaign is complete; its page is still on the business; a channel is assigned.
2. **Article**, generated if the campaign has none.
3. **Routing:** the redirect (`go.*`) host and, for cloaker buyers, the white host are chosen and saved on the campaign.
   Once an ad exists its URL is fixed, so the host is reused from then on.
4. **Edge config**, written *active* and with the `whop` block (the business), so the go-link looks the way it will
   when real clicks arrive. A real KV failure stops the launch here; an unconfigured edge is tolerated, like Facebook.
5. **Claim:** one conditional update `PROCESSING` / `BATCHED` → `LAUNCHING`. Only the caller it matches may create
   anything, so the auto-launch and a manual click can never both build a campaign.
6. **Pixel preflight:** asks Whop (`validate_pixel`) whether our go-link ends on a page with its pixel, retrying for
   about 85 s while the config reaches every edge location. If Whop's checker itself is down the preflight steps aside:
   creating the ad runs the same check.
7. **Build:** the Whop campaign → its ad groups → for each ad, the creative upload and the ad. **Each Whop id is saved
   the moment it exists**, and every create carries an `Idempotency-Key` made from our row id and the campaign's *key
   epoch*, so a retry never makes a second object.
8. **Activate:** one `PATCH status: active`. Whop refuses in words when something is missing (a creative, the page, an
   ads payment method, the agreement). A campaign already past draft at Whop (an earlier activation landed but its answer
   was lost) is not activated again. **After any Whop error on this call the campaign is read back**, because the answer
   may have been lost after Whop acted: still a draft means the failure is real; past draft means it launched and is
   adopted; unreadable means we do not know (see below).
9. **Done:** `ACTIVE` (or `PAUSED` if it was paused meanwhile), audited (`campaign.launched`, `provider: WHOP`), buyer
   notified, edge config re-written from the new status. Saving this is retried: once Whop is live nothing may give the
   claim back.

**A failure Whop confirms** (a draft that did not activate, an error before anything spent) gives the claim back
(`PROCESSING`; `BATCHED` when Whop is rate-limiting), rewrites the edge config inactive, records the reason on the campaign
(the campaign page shows "Whop did not launch this campaign"), and notifies the buyer (`whop_launch_failed`). What Whop
already holds is kept and reused by the next launch. A 401 also marks the connection BROKEN.

**An outcome we cannot confirm is never reported as "not launched".** If the activation answer was lost and Whop cannot be
read, or Whop is live but the result could not be saved, the campaign stays `LAUNCHING` with its edge config *active* (so
paid clicks still reach the article, not the white page) and the buyer is told to wait (`whop_launch_unconfirmed` /
`whop_launch_unrecorded`). The status sync settles it from what Whop reports (see "Status and spend").

**Key epoch:** Whop replays a repeated idempotency key for 24 h, so after a Whop tree is discarded (reopen, relaunch, a
campaign deleted in Whop) the next one uses new keys: `campaigns.whop_key_epoch` is part of every key.

| What the buyer sees | What it means | What to do |
|---|---|---|
| "Whop's pixel was not found on the page … lands on" | The landing page for a visitor who is not a real ad click carries no Whop pixel. | Deploy the white site (and the article for normal funnels) and set `WHOP_SCOPE_SECRET` identically on the redirect Worker, the white Worker and the article app. Then launch again. |
| "Whop could not load <go-link>" | Whop could not open the redirect link. | Check the redirect domain is live (Platform → Domains), then launch again. |
| "Whop would not launch this campaign: Connect an ads payment method before launching" (or a page / agreement / creative message) | Whop's own launch gate. | Fix it in Whop. Launch again: nothing is rebuilt. |
| "This Whop connection needs attention (…)" / "no longer connected" | The key was rejected or the row is gone. | Settings → Whop: reconnect with a working key. |
| Status `BATCHED` | Whop asked us to slow down. | Launch again in a minute. |
| "A Whop launch was interrupted" / status `PROCESSING` again | The API restarted mid-launch and Whop never activated it (still a draft, or nothing created). | Launch again: everything Whop already created is reused. |
| Status `LAUNCHING` for a long time, or "a Whop campaign is live, but we could not record it" / "waiting for Whop to confirm" | Whop may be running it but we could not confirm or save that. | Do not launch again. After 15 quiet minutes the status sync asks Whop and completes it (`ACTIVE` / `PAUSED`), or, if Whop cannot be read, leaves it as it is. |

### Controls on a live campaign

- **Pause / resume** tell Whop first and only then change our status, so we can never say "paused" while Whop spends.
  "Already paused in Whop" counts as done. The edge config follows the status.
- **Budget** (campaign and per ad group, USD cents in, dollars to Whop): campaign budget under CBO, the single ad group's
  under ABO; several ad groups need the per-ad-set edit. No channel release and no edge write. No $2 floor (Whop states its
  own). A live edit sends only the amount: once launched, Whop refuses a change of budget type or optimization.
- **Relaunch** pauses the old Whop campaign (kept, not deleted) and goes on only once Whop confirms it is paused, a draft
  or gone (otherwise it stops and says so: a second campaign must never run beside a live one), forgets the Whop ids
  (uploaded creatives are kept), rotates onto a fresh redirect host, and launches again.
- **Reopen** a half-launched campaign (`PROCESSING`, `BATCHED`, …) clears its Whop ids in the same transaction as the
  reopen and then deletes the Whop campaign. If that delete fails the campaign is still a clean draft, and the buyer is
  told which Whop campaign to delete by hand (`whop.campaign_orphaned` in the audit trail).
- **Clone** keeps the Whop business and page only while the connection is healthy and the business still has the page.
- **Disconnect** is refused while a campaign is live on the business (`ACTIVE` / `LAUNCHING`): without the key it would
  keep spending with no way to pause it from here. Paused campaigns do not block it.

### Status and spend (the worker)

- **Status sync, every 30 minutes** (`reconcileWhopCampaigns`, next to the Facebook one): one bulk read of each
  business's campaigns and ads, then:
  - **every** ad rejected (Whop's `all_ads_rejected`, or all of the campaign's ads rejected / in appeal) → `META_REJECTED`, **paused at Whop too** (best effort: our
    redirect no longer sends it traffic, so a still-delivering ad would only burn money; the buyer is told whether that
    worked), routing stopped (below), buyer told why, in Meta's words. **Some** ads rejected does NOT stop the campaign
    (unlike Facebook's D14): Whop never serves a rejected ad and the rest can still earn, so the buyer is told once per
    rejected ad ("2 of 12 ads … the campaign keeps running") and the ads show as disapproved;
  - paused or resumed in Whop → mirrored (the channel is kept). The edge config must follow: if it cannot be updated the
    status is given back and nothing is announced, so the database and the edge agree and the next tick does it all again
    (a resumed campaign whose edge still says "inactive" would send paid clicks to the white page while it runs);
  - deleted in Whop → archived and routing stopped, **only on the second consecutive tick** on which a direct read says
    404 (Whop's real sandbox confirms a deleted campaign answers `not_found` and leaves the list): the first leaves
    `not_found` in the campaign's delivery word (shown as such), and any real answer from Whop clears it. Archiving is
    one-way, so one wrong answer must not do it;
  - a billing failure → told once per episode (`payment_failed` is recorded in the delivery word, which is what stops the
    repeat; it is told only after that record is written);
  - Whop's delivery word and its issues are mirrored onto the campaign and each ad group / ad for display.

  **Stopping routing** (rejected or archived) is two effects in the one order that cannot misattribute: the edge config is
  re-published first (it then stops emitting the channel), and only then is the channel released (it can be handed to someone
  else at once). Each is tried three times with a short wait. If either cannot be done, the campaign is already stopped and
  has left the scan, so every pass starts with a **repair**: a stopped Whop campaign that still holds a channel has work left,
  and it is finished. The buyer is told what actually happened, never that a channel was released when it was not.

  **Safe defaults:** no connection, a broken or unreadable key, an outage, a campaign whose ads could not be read, a
  campaign missing from a list (confirmed with a direct read first): all are "skip", never "archive". **No lost updates:**
  every write is conditional on the row still being what the tick read (status and Whop id), so a pause made here, or a
  relaunch that swapped the Whop campaign meanwhile, is never overwritten; the next tick sees the new state. A 401 or 403
  breaks the connection once. **A pass is bounded and fair:** it stops starting businesses after 5 minutes, or after three in a
  row fail to ANSWER (Whop is down; a rate limit, a rejected key or a refusal is Whop answering and does not count), and it
  visits businesses in a stable order rotated to a random start, so a stopped pass never starves the same businesses every
  time. Table: `packages/shared/src/whop-status.ts`. The Analytics "last updated" indicator follows the Facebook syncs on
  purpose: a Whop outage must not make a Facebook buyer's numbers look stale, and a broken Whop key is shown on the Whop page
  and notified.
- **A launch that went quiet** (`LAUNCHING`, no write to the campaign, its ad sets or its ads for 15 minutes) is settled
  from Whop's own word, never guessed: a campaign Whop shows past draft is completed here (`ACTIVE`, or `PAUSED` if paused
  meanwhile; audited as `campaign.launched` with `completedBy: status-sync`; the buyer told it is live); a draft, or no Whop
  campaign, goes back to `PROCESSING` (the Whop ids are kept, so a relaunch continues from them); a campaign Whop says does
  not exist does the same after two consecutive misses; anything unreadable (outage, broken key) is left as it is, because
  resetting a campaign Whop may be spending on would send paid clicks to the white page.
- **Spend, hourly and in the finalization re-pulls** (`pullWhopStats`): one read per business per IST day (Whop reads the
  window in `Asia/Kolkata`) → `ad_stats_daily`, per ad, exactly where the Facebook pull writes, so the revenue split
  (D8) is unchanged. `clicks` are link clicks. `conversions` (the weight revenue is split by) is **our own first-party
  ad-click events** per ad, counted by the same `createdAt` day Analytics uses (every ad has its own go-link, so an event
  maps to exactly one ad and the count is exact);
  Whop's `submitted_applications` (its last-click count of the same event, which lags and matches only a subset) is used
  only for a campaign-day on which we recorded none. One scale per campaign-day, never per ad. **Recorded spend is never
  erased:** whether Whop "reported something" for an ad and day is decided from Whop's own figures alone (impressions,
  clicks, spend, its count), and only then is the row rewritten, because after a relaunch our ad row points at a new Whop ad
  with no history and "Whop says zero for the days before it existed" must not overwrite what the old ad really spent. On such
  a day only the conversion count refreshes (it is ours, and what revenue is weighed by), creating a conversions-only row when
  there is none yet. Only campaigns Whop still lists are asked about (one deleted there would make the batch refuse the
  rest). Spend is converted with the day's FX rate (the businesses' reporting currencies, and any currency already stored,
  are fetched too). Country and hour breakdowns are not pulled.
- **Analytics** labels network-sourced columns by source: "(FB)", "(Whop)" or "(FB/Whop)" for a mix.

## Permissions for the API key

| Permission | Why we need it |
|---|---|
| `ad_campaign:basic:read` | Read campaigns, ad groups, ads and their stats |
| `ad_campaign:create` | Create campaigns, ad groups and ads |
| `ad_campaign:update` | Activate, pause, change budgets, retry a failed payment |
| `social_account:read` | List the Facebook page the ads run under |
| `social_account:create` | Connect Meta Business or create a Whop-managed page |
| `event:create` | Send conversion events from our server |
| `company:basic:read` | Check the Whop pixel and read events |

Optional: `developer:manage_webhook` (register status webhooks automatically, otherwise we poll) and
`company:balance:read` (confirm the key belongs to this business and show its name).

The list lives in `packages/shared/src/whop.ts` (`WHOP_REQUIRED_PERMISSIONS`), so the page, the docs and the
checks use one source.

## When a key stops working

A connection turns **Needs attention** (`BROKEN`) only when Whop says so: it rejects the key (401), the key lost
access (403), or it belongs to another business. **An outage never breaks a connection.** A timeout, a 5xx or a
rate limit leaves the status alone and shows "Try again in a minute."

- The owner gets one `whop_connection_broken` notification per break, not one per check.
- **Reconnect with a new key** opens the form with the business filled in. A good check after that recovers it.
- Rotating a key is the same move: connect the same business with the new key.

## Errors a buyer can see

| Whop answers | We answer | The buyer reads |
|---|---|---|
| 401 | 409 | "Whop rejected the API key. Reconnect with a working key." |
| 403 | 409 | Whop's own message, naming the missing permission |
| 400 / 422 | 400 | Whop's message (it already says what to fix, e.g. "A Facebook page is required") |
| 402 | 402 | Whop's message plus a deposit link |
| 404 | 404 | Whop's message |
| 409 | 409 | Whop's message |
| 429 | 429 | "Whop is limiting requests right now. Try again in a minute." |
| 5xx, timeout, no answer | 502 | "Whop is not responding. Try again in a minute." |

The API key never appears in an error, a response or the audit trail, and is stored only encrypted (all covered by
tests). No Whop code logs request headers or the key.

## Try it without a Whop account

`@knn/whop` ships a mock of the slice of Whop's API we use. It enforces the same permission scopes as Whop's
published spec, so "missing permission" paths are real. Both the integration tests and this local recipe use it.

```bash
pnpm --filter @knn/whop mock
```

It listens on `127.0.0.1:4919` with three demo businesses (the printout lists their IDs and their public demo keys):
one fully set up, one that still needs the agreement, payment, page and pixel, and one whose key lacks permissions.
Then start the API pointed at it:

```bash
WHOP_ADS_ENABLED=true WHOP_ALLOW_SANDBOX=true \
WHOP_API_BASE=http://127.0.0.1:4919/api/v1 WHOP_SANDBOX_API_BASE=http://127.0.0.1:4919/api/v1 \
pnpm --filter @knn/api dev
```

Finally, as a super-admin turn **Whop Ads** on for a company in **Platform → Companies**, sign in as that company's
buyer, and open **Whop Ads**. The mock's keys are public: never use it anywhere real.

## Testing against Whop's sandbox

Whop's sandbox (`sandbox-api.whop.com`) has the same API with separate accounts and data. A super-admin can
connect a sandbox business in any environment; buyers need `WHOP_ALLOW_SANDBOX=true`. The sandbox key lives
**only** in `~/whop-sandbox.env`, outside the repo
(`WHOP_SANDBOX_API_KEY`, `WHOP_SANDBOX_BIZ_ID`, mode `600`). Scripts read it from there. It is never pasted into
chat, committed, printed or logged.

## Tracking: how a Whop ad is measured

Whop checks an ad's destination for **its pixel** when the ad is created, and only then lets it exist. Real
conversions are reported **server-to-server**. This is the same split ClickFlare runs for Whop today.

```
Whop's check   → go-link (no params) → 302 → white page + `_ws` → Whop finds its pixel in the page source → ad may be created
A real click   → go-link (Whop's ids) → 302 → money page          (no Whop pixel, no `_ws`)
                      │ records the click + Whop's ids in KV
the money page fires lander / search / adclick → /api/events → conversion_events (provider = whop) → WHOP_DISPATCH → Whop's Events API
```

| Piece | What it does | Where |
|---|---|---|
| **Redirect Worker** | For a config with `whop: { bizId }`: counts Whop's own click signal as paid; writes a `whop` block (business, Whop's ids, landing URL with only Whop's parameters) into the KV click record; tags the **non-paid** landing with a signed `_ws`. Never on the money route. | `apps/redirect` |
| **White Worker** | Renders the business's pixel in `<head>` only when a request carries a valid `_ws`. Ordinary page view only. Uncacheable. | `apps/white` |
| **Article app** | The same, for normal funnel mode, where the non-paid landing is the plain article (`/a/:slug`). | `apps/article` |
| **Ingest** | A click with a `whop` block becomes a `provider = 'whop'` row, queued for Whop and never for CAPI. One row per visit and stage, so Analytics counts are unchanged. | `apps/api/.../events` |
| **Dispatch job** | Posts the event with ClickFlare's payload: landing URL, IP, user agent, Whop's ids, `fbclid`/`fbc`/`fbp`, `external_id` = click id, event id = click id. | `apps/worker/src/whop-dispatch.ts` |

**Event names** (ClickFlare's live mapping, the same three steps as our funnel):

| Our stage | Stored as | Whop event |
|---|---|---|
| lander (page viewed) | `ViewContent` | `view_content` |
| search (keyword clicked) | `AddToCart` | `add_to_cart` |
| adclick (Google ad clicked) | `Search` | `submit_application`, the event an ad group optimizes for |

**Switching it on** (nothing Whop-related happens until all of this is in place; unset anywhere = no pixel there):

1. Pick one long random value and set it as `WHOP_SCOPE_SECRET` in **three places**: the redirect Worker
   (`cd apps/redirect && pnpm dlx wrangler secret put WHOP_SCOPE_SECRET`), the white Worker on the **white**
   Cloudflare account (`cd apps/white && pnpm dlx wrangler secret put WHOP_SCOPE_SECRET`), and the article app's
   runtime environment. The value must be identical.
2. Deploy the white Worker and the article **before** a Whop config can carry `whop`, so a tagged link always
   lands on a page that can verify the tag. The redirect Worker needs a redeploy for the new code too.
3. A Whop campaign's KV config must include `whop: { bizId }` (phase 2 writes it from the launch flow; both
   builders in `launch.service.ts` must emit it).

**Checking it by hand** (after deploy): fetch a Whop campaign's go-link with no parameters and follow the
redirect. The final page's HTML must contain `t.whop.tw` and `whop.setScope("biz_…")`, with `cache-control:
private, no-store`. Then ask Whop the same question with the connection's key: `POST /events/validate_pixel`
with `{ "account_id": "biz_…", "url": "<the go-link>" }` must answer `installed: true`. A Facebook link must
show no pixel at all.

**Trade-offs** (full reasoning: D33 addendum): the white site's "no shared ID" rule has one narrow exception;
the business id is visible in that page's source to visitors who came through that business's link; and Whop's
check sees the white page, not the money page.

## What Phase 0 showed (sandbox, 2026-09-30)

| Question | Answer |
|---|---|
| Does Whop's pixel check accept our redirect link? | The check runs when an ad is created, draft or not: `POST /ads` answers 400 "The Whop pixel was not detected on <url>" until it passes. Whop loads the URL, follows redirects and reads the final page. Proven with the mock against our Workers; proving it against Whop itself needs the white page deployed. |
| Which event is the money event? | `submit_application`, as in ClickFlare's live setup. An ad group's `conversion_event` becomes the campaign's `result_event` (verified). |
| Is a server event attributed without the visitor cookie? | Documented by Whop and ClickFlare (landing-URL ids, `fbclid`, IP, user agent); the sandbox cannot confirm it because a draft ad gets no clicks. |
| Are events safe to retry? | Yes: a repeated `event_name` + `event_id` answers 200 with the same id. Older than 28 days answers 400. |
| Creative upload | Verified (phase 2): `POST /files` → PUT the bytes to the presigned URL (no auth header) → poll until `upload_status: ready`. |
| What do stats and statuses look like? | From Whop's public OpenAPI spec (phase 2; `https://api.whop.com/api/v1/openapi.json`), not assumptions: an ad's `submitted_applications` is Whop's last-click count of our money event whatever the ad group optimizes (`results` depends on the optimization goal and is null when goals differ, so it is not a weight); a campaign's `delivery_status` is one of payment_failed, in_appeal, all_ads_rejected, draft, no_ad_groups, no_ads, paused, processing, issues, scheduled, completed, ad_groups_off, active (an ad adds rejected, in_review, campaign_paused, ad_group_paused, learning, learning_limited); `status` also has in_review, flagged, payment_failed, inactive, stale; `time_zone` makes a bare stats date mean that zone's day (we send explicit instants, `stats_to` = the last second of the IST day); an `Idempotency-Key` replays for 24 h; `devices.operating_systems` are objects `{ os, minimum_version? }`; once a campaign is launched only `budget_amount` may change (`budget_type` and optimization are pre-launch only). |
| What does Whop answer for a deleted campaign? | Verified (phase 2, `sandbox-check`): reading it answers 404 (`not_found`) and it is gone from the campaign list, which is what the status sync's two-miss archive rests on. |
| Budget floor, video creatives, real delivery, review timing | Still not observable without a payment method and real delivery (see `OPEN_QUESTIONS.md` #15). |
| Launch gate order | Creative first ("Add a creative to these ads before launching: <ad>"), then the Facebook page ("Connect a Facebook page to launch these ads: <ad>"), then (from Whop's docs, not reached in the sandbox) the payment method and the agreement. |

Whop's responses also carry a `recommended_action` upsell worded as instructions to an AI agent (a paid
feature). The client strips it and nothing here ever acts on it.

## API

All routes are under `/api/ad-providers/whop` and need a signed-in user. Everything except `/status` answers 404
when Whop Ads is off for the caller.

| Route | What it does |
|---|---|
| `GET /status` | `{ enabled, allowSandbox }` for the caller. Never 404s: "off" is an answer. The dashboard uses it to show or hide the nav item and the Sandbox choice. |
| `GET /connections` | The caller's connections with their checklists |
| `GET /connections/all` | Every connection with its owner (super-admin only) |
| `POST /connections` | Verify the key, then store it. Body: `bizId`, `apiKey`, optional `label`, `environment` (`PRODUCTION` or `SANDBOX`) |
| `GET /connections/:id` | One connection |
| `POST /connections/:id/check` | Re-read everything from Whop and update the status |
| `DELETE /connections/:id` | Remove the connection and its stored key |
| `GET /connections/:id/pages` | The business's Facebook and Instagram pages, read live |
| `POST /connections/:id/pages/meta-connect` | Start Whop's Meta Business sign-in. Body: `redirectUrl` (must be on `WEB_DOMAIN`) |
| `POST /connections/:id/pages/create` | Create a Whop-managed page |
| `POST /connections/:id/pages/:pageId/refresh` | Re-check a page that shows an error |
| `POST /connections/:id/pixel-check` | Ask Whop whether it sees its pixel on a page. Body: optional `url` |

Campaigns use the ordinary campaign routes (`/api/campaigns/*`, `/api/internal/launch/:id`); they branch on
`campaign.adProvider`. A Whop campaign takes `adProvider: 'WHOP'`, `whopConnectionId` and `whopPageId` on create and update;
reads return `whopBusiness` / `whopPage` labels, `whopDeliveryStatus` and `whopIssues`. `POST /:id/launch` answers
`{ status, whopCampaignId }`; `POST /:id/test-launch` answers 409 for a Whop campaign.

Audit trail: `whop.connected`, `whop.disconnected`, `whop.meta_connect_started`, `whop.page_created`, and
`org.whop.updated` for the company switch; for campaigns `campaign.launched` (details `provider: WHOP`,
`whopCampaignId`), `campaign.paused` / `campaign.resumed`, `campaign.budget_updated` (details `provider: WHOP`), and
`whop.campaign_discarded` / `whop.campaign_orphaned` when a reopened campaign's Whop campaign was (or could not be)
deleted. Details hold the business ID, never the key.

## Where the code lives

| Piece | Path |
|---|---|
| Whop client, errors, rate limit, checklist, mock | `packages/whop` (rules in its `CLAUDE.md`) |
| Shared constants and checklist types | `packages/shared/src/whop.ts` |
| Tables and migration | `packages/db/prisma/schema.prisma`, `migrations/20260930092639_whop_connections` |
| API module | `apps/api/src/modules/whop` |
| Error mapping | `apps/api/src/lib/whop-errors.ts` |
| Dashboard page | `apps/web/app/dashboard/whop` |
| Pixel loader, event builder, scope token | `packages/whop/src/{pixel,funnel-event}.ts`; `apps/redirect/src/whop-scope.ts` (copies in `apps/white`, `apps/article`) |
| Edge: click capture, `_ws` tagging, pixel injection | `apps/redirect/src/{worker,whop-click}.ts`, `apps/white/src/worker.ts`, `apps/article/app/a/[slug]/page.tsx` |
| Ingest and dispatch | `apps/api/src/modules/events/events.service.ts`, `apps/worker/src/whop-dispatch.ts` |
| Ads API client (campaign / ad group / ad / file), request builders | `packages/whop/src/{ads,launch-map}.ts`; vocabulary in `packages/shared/src/whop-launch.ts`; `packages/shared/src/providers.ts` (`isLaunched`) |
| Launch, relaunch, pause / resume, budgets, reopen cleanup | `apps/api/src/modules/campaigns/{whop-launch,whop-controls,whop-cleanup,launch-routing}.service.ts` (routing in `launch.service.ts`), `apps/api/src/modules/whop/whop.internal.ts` |
| Status sync and spend | `apps/worker/src/jobs/whop-reconcile.ts`, `apps/worker/src/attribution/whop-stats.ts`, `packages/shared/src/whop-status.ts` |
| Wizard, campaign page, Analytics labels | `apps/web/components/campaign-wizard.tsx`, `apps/web/app/dashboard/campaigns/[id]/page.tsx`, `apps/web/app/dashboard/analytics/*` |
| Check the mock against Whop's real sandbox | `pnpm --filter @knn/whop sandbox-check` (reads `~/whop-sandbox.env`; creates and deletes clearly named drafts; never launches) |
