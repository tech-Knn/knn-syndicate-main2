# @knn/white — the WHITE site (cloaker fallback + FB display link)

A clean, legitimate-looking content publication (Hono on Cloudflare Workers). It is what
organic / bot / **FB-reviewer** traffic sees when a click does NOT prove it came from a paid ad
(the redirect's fallback), and it's the **display link** shown on the FB ad. Serves the SAME
articles as the money domains — but as plain editorial content, **no AFS / ad code, no Google/FB
IDs** — so a reviewer landing here sees a normal site.

## The whole point: UNLINKABILITY from the money infra
- Deploy ONLY to the **separate Cloudflare account** holding the white zones (the money/redirect
  account = same nameserver pair = linkable via `dig NS`). Set `account_id` in `wrangler.toml`.
- It is a **distinct Worker with its own theme** on purpose — reusing the money article app would
  give the two sites identical templates (a content-fingerprint link).
- Article TEXT is fetched from our public API **server-side** (invisible to external scanners);
  only the white domain's DNS/IP/cert/content/IDs are inspectable, and those are all clean.
- Never add Google Analytics / AdSense / a FB pixel / any shared ID here.
  - **The one exception (D33, Whop Ads):** Whop will not create an ad until it finds *its* pixel on the ad's
    destination. It loads the go-link, follows the redirect to this site and reads the HTML. So a page carries
    the Whop pixel **only** when the request has a valid signed `_ws` scope (`src/whop-scope.ts`, minted by the
    redirect Worker for a Whop link): a direct visit, a crawler or a forged link sees the same clean page as
    ever. Never make it static or global, never add a second ID, and keep the variant uncacheable
    (`private, no-store`). The business id then appears in that page's source, but only to visitors who came
    through that business's link. It fires the ordinary page view only; conversions never come from here.
    Needs the `WHOP_SCOPE_SECRET` Worker secret (the same value as the redirect Worker's); unset = no pixel.

## Routes
`/` (recent-articles index, from `GET /api/public/articles/recent`) · `/a/:slug` (the article,
clean) · `/about` `/contact` `/privacy` `/terms` (legitimacy) · `/robots.txt` · `/health/live`.

## Deploy (to the white account, NOT the money one)
```
cd apps/white
# wrangler.toml: set account_id to the white account's id
wrangler login              # to the WHITE account (or use a scoped CLOUDFLARE_API_TOKEN for it)
pnpm dlx wrangler deploy    # provisions the 3 custom domains + certs
```
`API_BASE` (the public API host) is a `[vars]` entry. Keep this package lean — no `@knn/shared`,
no money-side imports. Tests: `pnpm --filter @knn/white test` (vitest; `whop-scope.ts` and `whop-pixel.ts`
are verbatim copies, guarded by tests in `apps/redirect` and `packages/whop`).
