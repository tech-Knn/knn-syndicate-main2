# Whop Ads

A second ad provider next to the direct Facebook connection (decision **D32**, `docs/DECISIONS.md`).
Whop resells Meta advertising and owns the Meta ad account. A buyer connects their Whop business here with
its **business ID** and an **API key**; this page then checks everything Whop needs before ads can launch.

| Phase | What | State |
|---|---|---|
| 1 | **Connect:** add a Whop business, live checklist, Facebook-page step, pixel check, per-company switch | Built and tested |
| 0 | **Sandbox spike:** answers the unknowns in `OPEN_QUESTIONS.md` #15 | Ran 2026-09-30 (answers below; a few need real delivery) |
| 3a | **Tracking:** the pixel on the page Whop's check sees, server events for real conversions | Built and tested; waits for phase 2 to switch on |
| 2 | **Build and launch** campaigns on Whop (and write the `whop` block the tracking needs) | Next |
| 3b | **Stats:** spend and status sync in the IST day, "(Whop)" labels in Analytics | After phase 2 |
| 4 | **Operate:** webhooks, payment-failed banner, notifications, admin overview | Last |

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
| **Whop pixel** | Whop has seen its pixel. | Paste a page address into **Check the Whop pixel on a page**. Phase 3 puts the pixel on our article pages. | Yes |

`canDraft` (the key works) and `canLaunch` (key, permissions, agreement, payment, page and pixel all done) come from
this list. Phase 2 uses them: drafts need the first, launching needs the second.

Two steps can only be done by the Whop account owner, and the page links out to them: signing the agreement and
adding a payment method. The Meta Business sign-in is finished on Meta, then returns to our dashboard. The return
address must be on `WEB_DOMAIN`, never an arbitrary URL.

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

**Trade-offs** (full reasoning: D32 addendum): the white site's "no shared ID" rule has one narrow exception;
the business id is visible in that page's source to visitors who came through that business's link; and Whop's
check sees the white page, not the money page.

## What Phase 0 showed (sandbox, 2026-09-30)

| Question | Answer |
|---|---|
| Does Whop's pixel check accept our redirect link? | The check runs when an ad is created, draft or not: `POST /ads` answers 400 "The Whop pixel was not detected on <url>" until it passes. Whop loads the URL, follows redirects and reads the final page. Proven with the mock against our Workers; proving it against Whop itself needs the white page deployed. |
| Which event is the money event? | `submit_application`, as in ClickFlare's live setup. An ad group's `conversion_event` becomes the campaign's `result_event` (verified). |
| Is a server event attributed without the visitor cookie? | Documented by Whop and ClickFlare (landing-URL ids, `fbclid`, IP, user agent); the sandbox cannot confirm it because a draft ad gets no clicks. |
| Are events safe to retry? | Yes: a repeated `event_name` + `event_id` answers 200 with the same id. Older than 28 days answers 400. |
| Budget floor, video creatives, real delivery, review timing | Not observable on drafts; revisit in phase 2. |
| Launch gate order | A draft with no creative is refused first ("Add a creative to these ads before launching"); agreement, payment and page texts come after. |

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

Audit trail: `whop.connected`, `whop.disconnected`, `whop.meta_connect_started`, `whop.page_created`, and
`org.whop.updated` for the company switch. Details hold the business ID, never the key.

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
