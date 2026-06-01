import { withSystem } from '@knn/db';
import {
  type ArticleRow,
  type ArticleUsage,
  type ArticleUsageCampaign,
  type ChannelAssignmentSpan,
  type ChannelRow,
  type ChannelSummary,
  type ChannelUsage,
  type PlatformSettings,
  ROLES,
  centsToDollars,
  displayFillRate,
} from '@knn/shared';
import { writeAudit } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { runScoped } from '../../lib/scope.js';
import type { AuthContext } from '../../middleware/authenticate.js';

const usd = (minor: number): number => Math.round(centsToDollars(minor) * 100) / 100;

/** Next IST/calendar day for a "YYYY-MM-DD" string (UTC math; the string is a calendar day). */
function nextCalendarDay(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Collapse per-day assignment rows (one per IST day held) for a SINGLE group into
 * contiguous date spans. A gap (non-consecutive calendar day) starts a new span; a span
 * is `active` if any of its rows is still unreleased.
 */
function collapseDays(
  rows: { forDay: string; releasedAt: Date | null }[],
): { firstDay: string; lastDay: string; active: boolean }[] {
  if (rows.length === 0) return [];
  const sorted = [...rows].sort((a, b) => a.forDay.localeCompare(b.forDay));
  const out: { firstDay: string; lastDay: string; active: boolean }[] = [];
  let start = sorted[0]!.forDay;
  let prev = sorted[0]!.forDay;
  let active = sorted[0]!.releasedAt == null;
  for (let i = 1; i < sorted.length; i++) {
    const d = sorted[i]!.forDay;
    if (d === prev) {
      active = active || sorted[i]!.releasedAt == null;
    } else if (d === nextCalendarDay(prev)) {
      prev = d;
      active = active || sorted[i]!.releasedAt == null;
    } else {
      out.push({ firstDay: start, lastDay: prev, active });
      start = d;
      prev = d;
      active = sorted[i]!.releasedAt == null;
    }
  }
  out.push({ firstDay: start, lastDay: prev, active });
  return out;
}

/** Sum gross-USD revenue + AFS clicks + fill-rate counts from per-day rows in [firstDay, lastDay]. */
function sumRange(
  rows: { day: string; revenueUsdMinor: number; afsClicks: number; afsRequests: number; afsMatchedRequests: number }[],
  firstDay: string,
  lastDay: string,
): { revenueUsd: number; afsClicks: number; afsRequests: number; afsMatchedRequests: number } {
  let minor = 0;
  let clicks = 0;
  let requests = 0;
  let matched = 0;
  for (const r of rows) {
    if (r.day >= firstDay && r.day <= lastDay) {
      minor += r.revenueUsdMinor;
      clicks += r.afsClicks;
      requests += r.afsRequests;
      matched += r.afsMatchedRequests;
    }
  }
  return { revenueUsd: usd(minor), afsClicks: clicks, afsRequests: requests, afsMatchedRequests: matched };
}

/**
 * Super-admin platform surfaces (channel pool, articles, settings) + the revenue-cut
 * control. Channels + platform_settings are GLOBAL (no org scope / no RLS), so these
 * reads run under `withSystem`; routes guard them to SUPER_ADMIN. The articles list is
 * org-scoped (RLS) so a company-admin can list their own.
 */

const SETTING_KEYS = {
  compliancePrompt: 'compliance_prompt',
  articleDomain: 'article_domain',
  redirectDomain: 'redirect_domain',
} as const;

/** The global AdSense channel pool with the campaign currently holding each channel. */
export async function listChannels(): Promise<ChannelRow[]> {
  return withSystem(async (tx) => {
    // Cap the ops view — the pool can hold thousands of seeded AFS channels.
    const channels = await tx.channel.findMany({ orderBy: [{ status: 'asc' }, { createdAt: 'asc' }], take: 1000 });
    const campIds = channels.map((c) => c.currentCampaignId).filter((x): x is string => Boolean(x));
    const camps = campIds.length
      ? await tx.campaign.findMany({ where: { id: { in: campIds } }, select: { id: true, name: true } })
      : [];
    const nameById = new Map(camps.map((c) => [c.id, c.name]));
    return channels.map((c): ChannelRow => ({
      id: c.id,
      channelId: c.channelId,
      label: c.label,
      status: c.status,
      campaignId: c.currentCampaignId,
      campaignName: c.currentCampaignId ? (nameById.get(c.currentCampaignId) ?? null) : null,
      lockedForDay: c.lockedForDay,
    }));
  });
}

/** Accurate channel-pool counts (real totals + per-website breakdown), not a capped list. */
export async function getChannelSummary(): Promise<ChannelSummary> {
  return withSystem(async (tx) => {
    const [byStatus, byDomainTotal, byDomainAvail, domains] = await Promise.all([
      tx.channel.groupBy({ by: ['status'], _count: { _all: true } }),
      tx.channel.groupBy({ by: ['domainId'], _count: { _all: true } }),
      tx.channel.groupBy({ by: ['domainId'], where: { status: 'AVAILABLE' }, _count: { _all: true } }),
      tx.domain.findMany({ select: { id: true, host: true } }),
    ]);
    const total = byStatus.reduce((s, r) => s + r._count._all, 0);
    const available = byStatus.find((r) => r.status === 'AVAILABLE')?._count._all ?? 0;
    const assigned = byStatus.find((r) => r.status === 'ASSIGNED')?._count._all ?? 0;
    const untagged = byDomainTotal.find((r) => r.domainId === null)?._count._all ?? 0;
    const hostById = new Map(domains.map((d) => [d.id, d.host]));
    const availByDomain = new Map(byDomainAvail.map((r) => [r.domainId, r._count._all]));
    const byDomain = byDomainTotal
      .filter((r) => r.domainId !== null)
      .map((r) => ({
        domainId: r.domainId as string,
        host: hostById.get(r.domainId as string) ?? '(removed domain)',
        total: r._count._all,
        available: availByDomain.get(r.domainId) ?? 0,
      }))
      .sort((a, b) => b.total - a.total);
    return { total, available, assigned, untagged, byDomain };
  });
}

/** Articles in scope (super: all; company-admin: own org via RLS). */
export async function listArticles(auth: AuthContext): Promise<ArticleRow[]> {
  return runScoped(auth, async (tx) => {
    const articles = await tx.article.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: { id: true, title: true, slug: true, status: true, createdAt: true },
    });
    return articles.map((a): ArticleRow => ({
      id: a.id,
      title: a.title,
      slug: a.slug,
      status: a.status,
      createdAt: a.createdAt.toISOString(),
    }));
  });
}

/**
 * Lineage for ONE channel (by channels.id OR the AFS `channelId` string): every campaign
 * it served, the article + domain host, the date span(s), and gross revenue. Keyed lookup —
 * resolves the single channel row then queries only its assignments (never scans the pool).
 */
export async function getChannelUsage(idOrChannelId: string): Promise<ChannelUsage | null> {
  return withSystem(async (tx) => {
    // The `id` column is a UUID; only match on it when the input is UUID-shaped, else
    // Prisma rejects a non-UUID string. Always allow matching the AFS `channelId` string.
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrChannelId);
    const ch = await tx.channel.findFirst({
      where: isUuid ? { OR: [{ id: idOrChannelId }, { channelId: idOrChannelId }] } : { channelId: idOrChannelId },
      select: { id: true, channelId: true, label: true, status: true, domainId: true },
    });
    if (!ch) return null;
    const poolHost = ch.domainId
      ? (await tx.domain.findUnique({ where: { id: ch.domainId }, select: { host: true } }))?.host ?? null
      : null;
    const base = { id: ch.id, channelId: ch.channelId, label: ch.label, status: ch.status, host: poolHost };

    const assigns = await tx.channelAssignment.findMany({
      where: { channelRef: ch.id },
      select: { campaignId: true, forDay: true, releasedAt: true },
    });
    if (assigns.length === 0) return { ...base, spans: [] };

    const campaignIds = [...new Set(assigns.map((a) => a.campaignId))];
    const [camps, offers, revRows] = await Promise.all([
      tx.campaign.findMany({ where: { id: { in: campaignIds } }, select: { id: true, name: true, orgId: true, articleId: true } }),
      tx.offer.findMany({ where: { channelRef: ch.id, campaignId: { in: campaignIds } }, select: { campaignId: true, domain: { select: { host: true } } } }),
      tx.offerRevenueDaily.findMany({ where: { channelRef: ch.id, campaignId: { in: campaignIds } }, select: { campaignId: true, day: true, revenueUsdMinor: true, afsClicks: true, afsRequests: true, afsMatchedRequests: true } }),
    ]);
    const campById = new Map(camps.map((c) => [c.id, c]));
    const orgs = await tx.organization.findMany({ where: { id: { in: [...new Set(camps.map((c) => c.orgId))] } }, select: { id: true, name: true } });
    const orgName = new Map(orgs.map((o) => [o.id, o.name]));
    const articleIds = [...new Set(camps.map((c) => c.articleId).filter((x): x is string => Boolean(x)))];
    const arts = articleIds.length
      ? await tx.article.findMany({ where: { id: { in: articleIds } }, select: { id: true, title: true, slug: true } })
      : [];
    const artById = new Map(arts.map((a) => [a.id, a]));
    const hostByCampaign = new Map(offers.map((o) => [o.campaignId, o.domain.host]));
    const revByCampaign = new Map<string, { day: string; revenueUsdMinor: number; afsClicks: number; afsRequests: number; afsMatchedRequests: number }[]>();
    for (const r of revRows) (revByCampaign.get(r.campaignId) ?? revByCampaign.set(r.campaignId, []).get(r.campaignId)!).push(r);
    const byCamp = new Map<string, { forDay: string; releasedAt: Date | null }[]>();
    for (const a of assigns) (byCamp.get(a.campaignId) ?? byCamp.set(a.campaignId, []).get(a.campaignId)!).push({ forDay: a.forDay, releasedAt: a.releasedAt });

    const spans: ChannelAssignmentSpan[] = [];
    for (const [campaignId, rows] of byCamp) {
      const camp = campById.get(campaignId);
      const art = camp?.articleId ? artById.get(camp.articleId) : undefined;
      const host = hostByCampaign.get(campaignId) ?? poolHost;
      const revList = revByCampaign.get(campaignId) ?? [];
      for (const s of collapseDays(rows)) {
        const agg = sumRange(revList, s.firstDay, s.lastDay);
        spans.push({
          campaignId,
          campaignName: camp?.name ?? null,
          companyName: camp ? orgName.get(camp.orgId) ?? null : null,
          articleId: camp?.articleId ?? null,
          articleTitle: art?.title ?? null,
          articleSlug: art?.slug ?? null,
          host: host ?? null,
          liveUrl: host && art ? `https://${host}/a/${art.slug}` : null,
          firstDay: s.firstDay,
          lastDay: s.lastDay,
          active: s.active,
          revenueUsd: agg.revenueUsd,
          afsClicks: agg.afsClicks,
          afsRequests: agg.afsRequests,
          afsMatchedRequests: agg.afsMatchedRequests,
          fillRate: displayFillRate(agg.afsMatchedRequests, agg.afsRequests),
        });
      }
    }
    spans.sort((a, b) => Number(b.active) - Number(a.active) || b.lastDay.localeCompare(a.lastDay));
    return { ...base, spans };
  });
}

/**
 * Lineage for ONE article: which campaigns use it, and per campaign the channel(s) +
 * domain host(s) it's live on, the date window, and gross revenue. Org-scoped (RLS): a
 * company-admin sees only their own; super-admin sees all.
 */
export async function getArticleUsage(auth: AuthContext, articleId: string): Promise<ArticleUsage | null> {
  return runScoped(auth, async (tx) => {
    const art = await tx.article.findUnique({
      where: { id: articleId },
      select: { id: true, title: true, slug: true, status: true, createdAt: true },
    });
    if (!art) return null;
    const header = { id: art.id, title: art.title, slug: art.slug, status: art.status, createdAt: art.createdAt.toISOString() };

    const camps = await tx.campaign.findMany({ where: { articleId }, select: { id: true, name: true, status: true, orgId: true } });
    if (camps.length === 0) return { ...header, liveHosts: [], totalRevenueUsd: 0, campaigns: [] };
    const campaignIds = camps.map((c) => c.id);
    const orgs = await tx.organization.findMany({ where: { id: { in: [...new Set(camps.map((c) => c.orgId))] } }, select: { id: true, name: true } });
    const orgName = new Map(orgs.map((o) => [o.id, o.name]));
    const offers = await tx.offer.findMany({
      where: { campaignId: { in: campaignIds }, channelRef: { not: null } },
      select: { campaignId: true, channelRef: true, domain: { select: { host: true } } },
    });
    const channelRefs = [...new Set(offers.map((o) => o.channelRef).filter((x): x is string => Boolean(x)))];
    const [channels, assigns, revRows] = await Promise.all([
      channelRefs.length ? tx.channel.findMany({ where: { id: { in: channelRefs } }, select: { id: true, channelId: true } }) : Promise.resolve([]),
      channelRefs.length ? tx.channelAssignment.findMany({ where: { campaignId: { in: campaignIds }, channelRef: { in: channelRefs } }, select: { campaignId: true, channelRef: true, forDay: true, releasedAt: true } }) : Promise.resolve([]),
      channelRefs.length ? tx.offerRevenueDaily.findMany({ where: { campaignId: { in: campaignIds }, channelRef: { in: channelRefs } }, select: { campaignId: true, channelRef: true, day: true, revenueUsdMinor: true, afsClicks: true, afsRequests: true, afsMatchedRequests: true } }) : Promise.resolve([]),
    ]);
    const chById = new Map(channels.map((c) => [c.id, c.channelId]));
    const liveHosts = new Set<string>();
    let totalRevenueUsd = 0;

    const campaigns: ArticleUsageCampaign[] = camps.map((c) => {
      const channelsOut = offers
        .filter((o) => o.campaignId === c.id)
        .map((o) => {
          const channelRef = o.channelRef as string;
          const host = o.domain.host;
          if (host) liveHosts.add(host);
          const aRows = assigns
            .filter((a) => a.campaignId === c.id && a.channelRef === channelRef)
            .map((a) => ({ forDay: a.forDay, releasedAt: a.releasedAt }));
          const sp = collapseDays(aRows);
          const rRows = revRows.filter((r) => r.campaignId === c.id && r.channelRef === channelRef);
          const revenueUsd = usd(rRows.reduce((s, r) => s + r.revenueUsdMinor, 0));
          totalRevenueUsd += revenueUsd;
          const afsRequests = rRows.reduce((s, r) => s + r.afsRequests, 0);
          const afsMatchedRequests = rRows.reduce((s, r) => s + r.afsMatchedRequests, 0);
          return {
            channelDbId: channelRef,
            channelId: chById.get(channelRef) ?? '(unknown)',
            host,
            liveUrl: host ? `https://${host}/a/${art.slug}` : null,
            firstDay: sp.length ? sp[0]!.firstDay : null,
            lastDay: sp.length ? sp[sp.length - 1]!.lastDay : null,
            active: sp.some((s) => s.active),
            revenueUsd,
            afsClicks: rRows.reduce((s, r) => s + r.afsClicks, 0),
            afsRequests,
            afsMatchedRequests,
            fillRate: displayFillRate(afsMatchedRequests, afsRequests),
          };
        });
      return { campaignId: c.id, campaignName: c.name, companyName: orgName.get(c.orgId) ?? null, status: c.status, channels: channelsOut };
    });

    return { ...header, liveHosts: [...liveHosts], totalRevenueUsd: Math.round(totalRevenueUsd * 100) / 100, campaigns };
  });
}

export async function getPlatformSettings(): Promise<PlatformSettings> {
  return withSystem(async (tx) => {
    const rows = await tx.platformSetting.findMany({ where: { key: { in: Object.values(SETTING_KEYS) } } });
    const map = new Map(rows.map((r) => [r.key, r.value]));
    return {
      compliancePrompt: map.get(SETTING_KEYS.compliancePrompt) ?? '',
      articleDomain: map.get(SETTING_KEYS.articleDomain) ?? '',
      redirectDomain: map.get(SETTING_KEYS.redirectDomain) ?? '',
    };
  });
}

export async function updatePlatformSettings(
  auth: AuthContext,
  input: Partial<PlatformSettings>,
): Promise<PlatformSettings> {
  await withSystem(async (tx) => {
    const entries: [string, string][] = [];
    if (input.compliancePrompt !== undefined) entries.push([SETTING_KEYS.compliancePrompt, input.compliancePrompt]);
    if (input.articleDomain !== undefined) entries.push([SETTING_KEYS.articleDomain, input.articleDomain]);
    if (input.redirectDomain !== undefined) entries.push([SETTING_KEYS.redirectDomain, input.redirectDomain]);
    for (const [key, value] of entries) {
      await tx.platformSetting.upsert({
        where: { key },
        create: { key, value, updatedBy: auth.userId },
        update: { value, updatedBy: auth.userId },
      });
    }
    await writeAudit(tx, {
      orgId: auth.orgId,
      actorId: auth.userId,
      action: 'platform.settings.updated',
      entityType: 'platform_settings',
      entityId: 'settings',
      details: { keys: entries.map((e) => e[0]) },
    });
  });
  return getPlatformSettings();
}

/** Set a company's platform revenue cut (0..1). Super-admin only. */
export async function setOrgRevenueCut(
  auth: AuthContext,
  orgId: string,
  pct: number,
): Promise<{ orgId: string; defaultRevenueCutPct: number }> {
  if (auth.role !== ROLES.SUPER_ADMIN) throw new AppError(403, 'Only the platform can set revenue cuts');
  if (!(pct >= 0 && pct <= 1)) throw new AppError(400, 'Revenue cut must be between 0 and 1');
  return withSystem(async (tx) => {
    const org = await tx.organization.findUnique({ where: { id: orgId }, select: { id: true } });
    if (!org) throw new AppError(404, 'Company not found');
    const updated = await tx.organization.update({
      where: { id: orgId },
      data: { defaultRevenueCutPct: pct },
      select: { id: true, defaultRevenueCutPct: true },
    });
    await writeAudit(tx, {
      orgId,
      actorId: auth.userId,
      action: 'org.revenue_cut.updated',
      entityType: 'organization',
      entityId: orgId,
      details: { pct },
    });
    return { orgId: updated.id, defaultRevenueCutPct: Number(updated.defaultRevenueCutPct) };
  });
}
