import { type Prisma } from '@knn/db';
import { ROLES, campaignDraftSchema } from '@knn/shared';
import { AppError } from '../../lib/errors.js';
import { runScoped } from '../../lib/scope.js';
import type { AuthContext } from '../../middleware/authenticate.js';
import { type CampaignWithChildren, createCampaign, getCampaign, toDraft } from './campaigns.service.js';
import { type OfferInput, setOffers } from './offers.service.js';

/**
 * Launcher PRESETS — save a campaign's full config (the draft: objective / budget / targeting /
 * ad sets / ads, PLUS its offers) as a reusable template, then spin up a fresh editable DRAFT
 * from it in one click. Backed by the `launcher_presets` table (RLS-isolated; config is the
 * serialized draft + offers). Buyer-scoped: a MEDIA_BUYER sees/applies only their own presets.
 * Reuses the same building blocks as clone (toDraft → createCampaign → setOffers).
 */
export interface PresetRow {
  id: string;
  name: string;
  createdAt: string;
}

/** Stored shape of `launcher_presets.config`. */
interface PresetConfig {
  draft: unknown;
  offers: OfferInput[];
}

export async function listPresets(auth: AuthContext): Promise<PresetRow[]> {
  const rows = await runScoped(auth, (tx) =>
    tx.launcherPreset.findMany({
      where: auth.role === ROLES.MEDIA_BUYER ? { buyerId: auth.userId } : undefined,
      orderBy: { updatedAt: 'desc' },
      select: { id: true, name: true, createdAt: true },
    }),
  );
  return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.createdAt.toISOString() }));
}

/** Save a campaign's config (+ offers) as a named preset owned by the actor. */
export async function savePreset(auth: AuthContext, campaignId: string, name: string): Promise<PresetRow> {
  const trimmed = name.trim();
  if (!trimmed) throw new AppError(422, 'Preset name is required');
  const campaign = await getCampaign(auth, campaignId); // 404 if not owned
  const offers = await runScoped(auth, (tx) =>
    tx.offer.findMany({
      where: { campaignId },
      orderBy: { createdAt: 'asc' },
      select: { domainId: true, weightPct: true, kind: true, articleId: true },
    }),
  );
  const config: PresetConfig = {
    draft: toDraft(campaign),
    offers: offers.map((o) => ({ domainId: o.domainId, weightPct: o.weightPct, kind: o.kind, articleId: o.articleId })),
  };
  const preset = await runScoped(auth, (tx) =>
    tx.launcherPreset.create({
      data: { orgId: auth.orgId, buyerId: auth.userId, name: trimmed, config: config as unknown as Prisma.InputJsonValue },
    }),
  );
  return { id: preset.id, name: preset.name, createdAt: preset.createdAt.toISOString() };
}

/** Spin up a fresh editable DRAFT campaign from a preset (new redirect ids per ad). */
export async function applyPreset(auth: AuthContext, presetId: string): Promise<CampaignWithChildren> {
  const raw = await runScoped(auth, async (tx) => {
    const preset = await tx.launcherPreset.findUnique({ where: { id: presetId } });
    if (!preset || (auth.role === ROLES.MEDIA_BUYER && preset.buyerId !== auth.userId)) {
      throw new AppError(404, 'Preset not found');
    }
    return preset.config as unknown as PresetConfig;
  });
  // Re-validate the stored draft (schema may have tightened since it was saved).
  const draft = campaignDraftSchema.parse(raw.draft);
  const offers = Array.isArray(raw.offers) ? raw.offers : [];
  const created = await createCampaign(auth, draft);
  if (offers.length === 0) return created;
  await setOffers(auth, created.id, offers);
  return getCampaign(auth, created.id);
}

export async function deletePreset(auth: AuthContext, presetId: string): Promise<void> {
  await runScoped(auth, async (tx) => {
    const preset = await tx.launcherPreset.findUnique({ where: { id: presetId }, select: { id: true, buyerId: true } });
    if (!preset || (auth.role === ROLES.MEDIA_BUYER && preset.buyerId !== auth.userId)) {
      throw new AppError(404, 'Preset not found');
    }
    await tx.launcherPreset.delete({ where: { id: presetId } });
  });
}
