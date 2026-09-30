import { env } from '@knn/config';
import { withSystem } from '@knn/db';
import { CAMPAIGN_STATUS, type FunnelMode, effectiveFunnelMode, effectiveRac, normalizeCustomTerms } from '@knn/shared';
import { AppError } from '../../lib/errors.js';
import { KvNotConfiguredError, type RedirectConfigPayload, writeRedirectConfigs } from '../../lib/kv-sync.js';
import { campaignInclude } from './campaigns.service.js';

/**
 * Routing helpers shared by the Facebook launch (`launch.service.ts`) and the Whop launch
 * (`whop-launch.service.ts`): which funnel mode a buyer runs, which redirect (go.*) and white domains a
 * campaign rotates onto, how the buyer's custom terms ride on the money URL, and the rebuild of a campaign's
 * edge (KV) redirect configs. Moved here verbatim from launch.service.ts so neither launch has to import the
 * other; launch.service.ts re-exports `withCustomTerms` and `syncCampaignRedirectConfigs` for existing callers.
 */

/**
 * The buyer's effective funnel mode (org gate + org default + per-buyer override), resolved by the
 * shared `effectiveFunnelMode`. CLOAKER buyers rotate onto CLOAKER redirect domains (and, Phase 2,
 * get the white-site fallback + display link); NORMAL buyers run the straight monetized redirect.
 */
export async function resolveBuyerFunnelMode(orgId: string, buyerId: string): Promise<FunnelMode> {
  const [org, user] = await withSystem((tx) =>
    Promise.all([
      tx.organization.findUnique({ where: { id: orgId }, select: { cloakingEnabled: true, defaultFunnelMode: true } }),
      tx.user.findUnique({ where: { id: buyerId }, select: { funnelMode: true } }),
    ]),
  );
  return effectiveFunnelMode({
    cloakingEnabled: org?.cloakingEnabled ?? false,
    defaultFunnelMode: org?.defaultFunnelMode ?? 'NORMAL',
    userFunnelMode: user?.funnelMode ?? null,
  });
}

/**
 * Pick the redirect (go.*) base URL for a launch, ROTATING across the eligible pool. Eligible =
 * domains whose `mode` matches the buyer, that are active + healthy, and either company-exclusive to
 * this org or in the shared pool (exclusive wins). Chooses the LEAST-loaded host (fewest campaigns
 * already on it) so a flagged domain has minimal blast radius. Falls back to the legacy default, then
 * env `REDIRECT_DOMAIN`, so launches never break before the super-admin has populated the pool.
 * Returns both the base URL and the bare host (recorded on the campaign).
 */
export async function resolveRedirectBase(mode: FunnelMode, orgId: string): Promise<{ base: string; host: string }> {
  const eligible = await withSystem((tx) =>
    tx.redirectDomain.findMany({
      where: { mode, isActive: true, healthy: true, OR: [{ ownerOrgId: orgId }, { ownerOrgId: null }] },
      select: { host: true, ownerOrgId: true },
    }),
  );
  const exclusive = eligible.filter((d) => d.ownerOrgId === orgId);
  const pool = (exclusive.length ? exclusive : eligible).map((d) => d.host);
  if (pool.length > 0) {
    // Least-loaded rotation: spread campaigns evenly so one flagged host affects the fewest.
    const loads = await withSystem((tx) =>
      tx.campaign.groupBy({ by: ['redirectDomainHost'], where: { redirectDomainHost: { in: pool } }, _count: { _all: true } }),
    );
    const loadByHost = new Map(loads.map((l) => [l.redirectDomainHost, l._count._all]));
    pool.sort((a, b) => (loadByHost.get(a) ?? 0) - (loadByHost.get(b) ?? 0));
    const host = pool[0]!;
    return { base: `https://${host}`, host };
  }
  // Backward-compat fallback: the legacy default domain, then env REDIRECT_DOMAIN.
  const def = await withSystem((tx) => tx.redirectDomain.findFirst({ where: { isDefault: true }, select: { host: true } }));
  if (def?.host) return { base: `https://${def.host}`, host: def.host };
  const base = env.REDIRECT_DOMAIN;
  let host = base;
  try {
    host = new URL(base).host;
  } catch {
    /* env may already be a bare host */
  }
  return { base, host };
}

/**
 * Pick a white domain from the active + healthy pool, rotating LEAST-LOADED (fewest campaigns already
 * on it) so cloaker ads spread across the pool instead of all sharing one display URL. Returns the
 * host, or undefined when the pool is empty → no white auto-fill (the buyer's own display/fallback stand).
 */
export async function pickWhiteDomain(): Promise<string | undefined> {
  const pool = await withSystem((tx) => tx.whiteDomain.findMany({ where: { isActive: true, healthy: true }, select: { host: true } }));
  const hosts = pool.map((d) => d.host);
  if (hosts.length === 0) return undefined;
  const loads = await withSystem((tx) =>
    tx.campaign.groupBy({ by: ['whiteDomainHost'], where: { whiteDomainHost: { in: hosts } }, _count: { _all: true } }),
  );
  const loadByHost = new Map(loads.map((l) => [l.whiteDomainHost, l._count._all]));
  hosts.sort((a, b) => (loadByHost.get(a) ?? 0) - (loadByHost.get(b) ?? 0));
  return hosts[0]!;
}

/**
 * D27: the buyer's custom RSOC terms ride on the MONEY-page URL as `terms=` — the go.* Worker signs
 * every destination param into the cloak token, so they reach the article page (and are sent to
 * Google as entered) with no Worker change. Never added to fallback/white URLs. No-op when empty.
 */
export function withCustomTerms(url: string, termsOverride: readonly string[] | null | undefined): string {
  const custom = normalizeCustomTerms(termsOverride);
  if (!custom.length) return url;
  const u = new URL(url);
  u.searchParams.set('terms', custom.join(','));
  return u.toString();
}

/**
 * Rebuild + write each ad's redirect config to edge KV from the campaign's CURRENT
 * offers / channel / article variants — **without touching Facebook**. The FB creative
 * carries only the stable `/go/{redirectId}` link, so rewriting KV reroutes live traffic
 * on the next click with zero ad republish. This is the engine behind post-launch offer
 * rebalancing (weights, article A/B, add/remove). System-scoped (the caller authorizes;
 * also called by the worker after it assigns/releases channels). Mirrors the split-build
 * in `launchCampaign` (kept in sync deliberately — launch stays inline to avoid coupling
 * the critical, stress-tested launch path to this helper).
 *
 * `forceActive` writes `active: true` whatever the status says. The Whop launch (D32) needs it: Whop loads the
 * go-link while the ads are being created, before the campaign is ACTIVE, and the config must already look the way
 * it will when real clicks arrive. A failed launch rewrites it without the flag, which derives `active` from the
 * (reverted) status again.
 *
 * A Whop campaign's config carries a `whop` block (its business), which makes the edge recognise a click on a
 * Whop ad and tag the non-paid landing with the signed pixel scope. Its `expectedAdId` is ALWAYS absent: Whop hides
 * the Meta ad id and never gets our `kaid` macro, so nothing Whop-side may ever stand in for `fbAdId`.
 */
export async function syncCampaignRedirectConfigs(
  campaignId: string,
  deps: { writeRedirectConfigs: typeof writeRedirectConfigs } = { writeRedirectConfigs },
  opts: { forceActive?: boolean } = {},
): Promise<{ ads: number }> {
  const campaign = await withSystem((tx) => tx.campaign.findUnique({ where: { id: campaignId }, include: campaignInclude }));
  if (!campaign) throw new AppError(404, 'Campaign not found');

  // Campaign default article slug.
  let slug: string | null = null;
  if (campaign.articleId) {
    const a = await withSystem((tx) => tx.article.findUnique({ where: { id: campaign.articleId! }, select: { slug: true } }));
    slug = a?.slug ?? null;
  }
  if (!slug) throw new AppError(409, 'Campaign has no article yet — nothing to route');

  // CLOAKER campaigns route white (non-ad) traffic to the white domain assigned at launch.
  const whiteFallbackUrl = campaign.whiteDomainHost ? `https://${campaign.whiteDomainHost}/a/${slug}` : undefined;

  const offers = await withSystem((tx) =>
    tx.offer.findMany({ where: { campaignId }, include: { domain: { select: { host: true } } } }),
  );
  const paidOffers = offers.filter((o) => o.kind === 'PAID' && o.channelRef);

  let articleUrl = `${env.ARTICLE_DOMAIN}/a/${slug}`;
  let channel: string | undefined;
  let splits: RedirectConfigPayload['splits'];
  let organicFallbackUrl: string | undefined;

  if (paidOffers.length > 0) {
    const chRows = await withSystem((tx) =>
      tx.channel.findMany({ where: { id: { in: paidOffers.map((o) => o.channelRef!) } }, select: { id: true, channelId: true } }),
    );
    const chById = new Map(chRows.map((c) => [c.id, c.channelId]));
    const variantIds = [...new Set(offers.map((o) => o.articleId).filter((x): x is string => Boolean(x)))];
    const variantRows = variantIds.length
      ? await withSystem((tx) => tx.article.findMany({ where: { id: { in: variantIds } }, select: { id: true, slug: true } }))
      : [];
    const slugByArticle = new Map(variantRows.map((a) => [a.id, a.slug]));
    const slugFor = (articleId: string | null): string => (articleId ? slugByArticle.get(articleId) ?? slug! : slug!);
    splits = paidOffers.map((o) => ({
      url: withCustomTerms(`https://${o.domain.host}/a/${slugFor(o.articleId)}`, campaign.termsOverride),
      weight: o.weightPct,
      channel: chById.get(o.channelRef!),
      offerId: o.id,
    }));
    const organic = offers.find((o) => o.kind === 'ORGANIC');
    organicFallbackUrl = organic ? `https://${organic.domain.host}/a/${slugFor(organic.articleId)}` : undefined;
    articleUrl = splits[0]?.url ?? articleUrl;
  } else if (campaign.channelId) {
    const ch = await withSystem((tx) => tx.channel.findUnique({ where: { id: campaign.channelId! }, select: { channelId: true } }));
    channel = ch?.channelId;
    articleUrl = withCustomTerms(articleUrl, campaign.termsOverride);
  }

  const entries = campaign.adSets.flatMap((set) =>
    set.ads
      .filter((ad) => ad.redirectId)
      .map((ad) => ({
        redirectId: ad.redirectId,
        config: {
          campaignId: campaign.id,
          active: opts.forceActive === true || campaign.status === CAMPAIGN_STATUS.ACTIVE,
          articleUrl,
          channel,
          splits,
          // Cloak verification: the click must carry kaid={{ad.id}} matching this id (enforce mode).
          expectedAdId: ad.fbAdId ?? undefined,
          ...(campaign.adProvider === 'WHOP' && campaign.whopBizId ? { whop: { bizId: campaign.whopBizId } } : {}),
          // referrerAdCreative (the AFS `rc`): the ad's own override, else the campaign default (D27).
          adCreative: effectiveRac(ad.racValue, campaign.racValue) ?? undefined,
          // CLOAKER: white domain is the fallback (white page); else organic offer → ad → campaign.
          fallbackUrl: whiteFallbackUrl ?? organicFallbackUrl ?? ad.fallbackUrl ?? campaign.fallbackUrl ?? undefined,
        } satisfies RedirectConfigPayload,
      })),
  );
  try {
    await deps.writeRedirectConfigs(entries);
  } catch (err) {
    // Tolerate an unconfigured edge (mirrors launchCampaign) — never throw on the rebalance path.
    if (err instanceof KvNotConfiguredError) {
      console.warn(`[resync] Cloudflare KV not configured — redirect configs not synced for ${campaignId}`);
    } else {
      throw err;
    }
  }
  return { ads: entries.length };
}
