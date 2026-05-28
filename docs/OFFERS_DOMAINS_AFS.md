# Offers · Domains · AFS — architecture (proposed, pending build)

> How the tool monetizes systematically. Cost is on **Facebook** (per campaign/ad);
> revenue is on **AFS** (per website's AdSense account). A campaign routes its traffic
> across **offers**, each offer being a website that monetizes via its own AFS pubId +
> channel. This doc is the reference for the Offers/Domains/AFS build.

## Core concepts

- **AFS account** — a revenue source. Has an AFS **pubId** (`partner-pub-…`, used in the
  CSA ad code), an OAuth token (for revenue reporting), and a channel limit (some 500,
  some 100k). The platform can connect **several** AFS accounts (AFS 1, AFS 2, AFS 3…).
- **Domain (website)** — an article-serving host (e.g. `articles.x.com`). Maps to **one
  AFS account** → that's the pubId it renders. Has its **own channel-id allocation**
  (which ids this site may use; the rest are owned by other teams) + an AFS style + a
  live/verify status. Many domains can share one AFS account.
- **Channel** — an AFS custom-channel id, **scoped to a domain's allocation**, assigned
  to one offer for revenue attribution (`ch` in the CSA code).
- **Offer** — *within a campaign*: a `(domain, weight%, kind)` destination + an assigned
  channel. A campaign has **many** offers. `kind = PAID` (gets the weighted ad-traffic
  split) or `ORGANIC` (the non-ad / fallback destination, used conditionally).
- **Campaign** — the Facebook side (cost) + its set of offers (revenue routing).

### Worked example (1 campaign, 4 paid offers + 1 organic)
| Offer | Website | AFS account | Weight |
|-------|---------|-------------|--------|
| 1 | Website 1 | AFS 1 | 20% |
| 2 | Website 2 | AFS 1 | 25% |
| 3 | Website 3 | AFS 2 | 25% |
| 4 | Website 4 | AFS 3 | 30% |
| organic | (chosen site) | — | conditional (non-ad traffic) |

Each paid offer gets its own channel from its website's allocation, so we can see
**which offer/website monetizes best** — the whole point of offer testing.

## The funnel (per click)
```
FB ad → /go/:id (redirect)
      → weighted-pick a PAID offer (by offer weights)   [organic/bot → the ORGANIC offer]
      → 302 to https://{offer.domain.host}/a/{campaign.article.slug}?ch={offer.channel}&rc=&styleId=&txid=
      → article served ON that domain
      → article resolves ITS pubId + styleId from its host (GET /api/public/site-config?host=…)
      → CSA renders: pubId (the domain's AFS) + styleId + ch (the offer's channel)
      → AFS reports that channel's revenue (the domain's AFS account)
      → attributed to the OFFER → aggregated to the CAMPAIGN
```
**Cost** = Facebook spend (per ad, existing). **Revenue** = each offer's channel's AFS
earnings. Dashboard shows **per-offer ROI** (cost is campaign-level; revenue is per offer).

## Data model (deltas from today)
- **`AfsAccount`** (evolve the singleton `GoogleConnection` → multi-row): `label`,
  `afsPubId` (partner-pub-…), `adsenseAccount`/`adsenseAdClient`, encrypted token +
  refresh, `channelLimit`, default `styleId`, `status`.
- **`Domain`**: `host` (unique), `afsAccountId` → pubId, `channelRanges` (this site's
  allocation), `styleId`, `adsafe`, `status` (PENDING_DNS → VERIFYING → LIVE → ERROR),
  `verifyToken`, timestamps.
- **`Offer`**: `campaignId`, `domainId`, `weightPct`, `kind` (PAID|ORGANIC), `channelRef`
  (the assigned channel), optional per-offer notes. (Replaces the campaign's single
  `articleId`/`channelId` routing — the article content stays one per campaign; it's
  *served on each offer's domain*.)
- **`Channel`** (existing, becomes scoped): add `domainId` (the allocation it belongs to).
  Assignment happens **per offer** (each offer grabs an AVAILABLE channel from its
  domain's pool), not per campaign.
- **`Campaign`**: keeps FB config; gains `offers[]`. The redirect config (edge KV) per ad
  carries the offer split (domain article URLs + channels + weights).

## What changes vs today
| Today | Target |
|---|---|
| One pubId baked at build | pubId **per domain**, resolved from the article's host |
| `GoogleConnection` singleton | **`AfsAccount`** — many (pubId + token each) |
| Global channel pool, 1/campaign | channels **scoped per domain**, assigned **per offer** |
| Campaign → 1 article/channel | Campaign → **many offers** (domain + weight + channel) |
| Implicit single domain | **`Domain`** first-class + managed + DNS-verified |

## Super-admin management (new sections)
1. **Domains** — add / verify / manage: host, mapped AFS account, channel allocation,
   AFS style, status. Shows the exact **DNS record** to create + where, a **verify**
   check (resolves to us + serves a token), and AFS-approval status (Google's, external).
2. **AFS accounts** — connect multiple (each its own pubId + OAuth + channel ranges).
3. **Channels** — per-domain allocation view + pool health.

## Build phases (each tested + deployed)
- **A — Data model:** `AfsAccount` (multi) + `Domain` + `Offer` + channel→domain scoping.
- **B — AFS-account management** (multi-connect + per-account ranges; the range selector
  already built becomes the building block).
- **C — Domain management** (CRUD + DNS-verify UI + status).
- **D — Funnel rewire:** per-host pubId/style in the article (`site-config`); redirect
  splits across offers/domains.
- **E — Campaign → offers** (the wizard gains the offer table: domain + weight + channel;
  organic offer). Per-offer channel assignment from the domain pool.
- **F — Attribution & dashboards** across multiple AFS accounts → **per-offer** revenue/ROI.

## Open / external (not code)
- **DNS verification mechanics** — what record (CNAME/A) → which ingress; the verify token.
- **AFS approval** — Google approves each domain for AFS (invite/approval-gated).
- **The real inventory** — the platform's actual domains, their AFS accounts/pubIds, and
  the channel ranges WE own (the `00500–05000` ranges are all outsourced).
