import { withSystem } from '@knn/db';
import { type ArticleRow, type ChannelRow, type PlatformSettings, ROLES } from '@knn/shared';
import { writeAudit } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { runScoped } from '../../lib/scope.js';
import type { AuthContext } from '../../middleware/authenticate.js';

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
    const channels = await tx.channel.findMany({ orderBy: [{ status: 'asc' }, { createdAt: 'asc' }] });
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
