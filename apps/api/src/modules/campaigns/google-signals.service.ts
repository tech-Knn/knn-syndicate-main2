import type { TxClient } from '@knn/db';
import {
  CAMPAIGN_STATUS,
  type GoogleSignalsArticleTerms,
  type GoogleSignalsView,
  effectiveRac,
  googleSignalsUpdateSchema,
  normalizeCustomTerms,
  resolvePublisherTerms,
} from '@knn/shared';
import { writeAudit } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { runScoped } from '../../lib/scope.js';
import type { AuthContext } from '../../middleware/authenticate.js';
import { loadOwnedCampaign } from './campaigns.service.js';
import { type LaunchDeps, syncCampaignRedirectConfigs } from './launch.service.js';

/**
 * Buyer-editable Google signals (D27): see EXACTLY what each paid article view sends Google — the
 * per-ad Referrer Ad Creative and the RSOC `terms` — and change it on a LIVE campaign without
 * approval. Owner-scoped like every campaign read/write (a buyer: their own; an admin: their org).
 * Buyer text is stored and sent as entered; the only checks are technical (`googleSignalsUpdateSchema`).
 */

type Campaign = Awaited<ReturnType<typeof loadOwnedCampaign>>;

/** A launched campaign has redirect configs at the edge → an edit must re-sync them. */
function isLive(c: Pick<Campaign, 'fbCampaignId'>): boolean {
  return Boolean(c.fbCampaignId);
}

function keywordsOf(json: unknown): string[] {
  return Array.isArray(json) ? json.filter((k): k is string => typeof k === 'string') : [];
}

function trimOrNull(v: string | null | undefined): string | null {
  const t = (v ?? '').trim();
  return t ? t : null;
}

async function buildView(tx: TxClient, c: Campaign): Promise<GoogleSignalsView> {
  const ads = c.adSets.flatMap((s) => s.ads.map((a) => ({ ad: a, adSetName: s.name })));
  const uploadIds = ads.map((x) => x.ad.uploadId).filter((u): u is string => Boolean(u));
  const uploads = uploadIds.length
    ? await tx.upload.findMany({ where: { id: { in: uploadIds } }, select: { id: true, filename: true } })
    : [];
  const fileById = new Map(uploads.map((u) => [u.id, u.filename]));

  // The landing articles actually routed to: the campaign default + any per-offer variants.
  const offers = await tx.offer.findMany({ where: { campaignId: c.id, kind: 'PAID' }, select: { articleId: true } });
  const articleIds = [...new Set([c.articleId, ...offers.map((o) => o.articleId)].filter((x): x is string => Boolean(x)))];
  const articles = articleIds.length
    ? await tx.article.findMany({
        where: { id: { in: articleIds } },
        select: { id: true, slug: true, title: true, relatedSearchTerms: true, keywords: true, query: true },
      })
    : [];

  const articleTerms: GoogleSignalsArticleTerms[] = articles.map((a) => {
    const base = { articleTerms: a.relatedSearchTerms, keywords: keywordsOf(a.keywords), query: a.query };
    const sent = resolvePublisherTerms({ ...base, custom: c.termsOverride });
    const ai = resolvePublisherTerms(base);
    return { articleId: a.id, slug: a.slug, title: a.title, source: sent.source, sent: sent.terms, aiTerms: ai.terms };
  });

  return {
    campaignId: c.id,
    status: c.status,
    live: isLive(c),
    racValue: c.racValue,
    ads: ads.map(({ ad, adSetName }) => ({
      id: ad.id,
      name: ad.name,
      adSetName,
      creativeType: ad.creativeType,
      fileName: ad.uploadId ? fileById.get(ad.uploadId) ?? null : null,
      racValue: ad.racValue,
      effectiveRac: effectiveRac(ad.racValue, c.racValue),
    })),
    customTerms: normalizeCustomTerms(c.termsOverride),
    articles: articleTerms,
  };
}

/** GET /api/campaigns/:id/google-signals — what Google receives for this campaign right now. */
export async function getGoogleSignals(auth: AuthContext, campaignId: string): Promise<GoogleSignalsView> {
  return runScoped(auth, async (tx) => buildView(tx, await loadOwnedCampaign(tx, auth, campaignId)));
}

/**
 * PUT /api/campaigns/:id/google-signals — edit the campaign-default rc, per-ad rc overrides and the
 * custom terms. No approval. A launched campaign's edge redirect configs are re-synced right away,
 * so NEW paid clicks carry the new values (a visitor already on the page keeps the old token).
 */
export async function updateGoogleSignals(
  auth: AuthContext,
  campaignId: string,
  body: unknown,
  deps: Pick<LaunchDeps, 'writeRedirectConfigs'> | undefined = undefined,
): Promise<GoogleSignalsView> {
  const parsed = googleSignalsUpdateSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError(400, parsed.error.issues.map((i) => i.message).join('; '));
  }
  const input = parsed.data;

  const live = await runScoped(auth, async (tx) => {
    const c = await loadOwnedCampaign(tx, auth, campaignId);
    const adIds = new Set(c.adSets.flatMap((s) => s.ads.map((a) => a.id)));
    for (const a of input.ads ?? []) {
      if (!adIds.has(a.adId)) throw new AppError(400, `Ad ${a.adId} does not belong to this campaign`);
    }
    // Technical, not content: the draft editor deletes + recreates ads on every save, which would
    // silently drop a per-ad override. The campaign default + terms are fine on a draft.
    if (c.status === CAMPAIGN_STATUS.DRAFT && (input.ads?.length ?? 0) > 0) {
      throw new AppError(409, 'Per-ad Referrer Ad Creative is available once the campaign is submitted (the draft editor recreates ads on save). Set the campaign default in the editor for now.');
    }

    const before = {
      racValue: c.racValue,
      terms: normalizeCustomTerms(c.termsOverride),
      ads: c.adSets.flatMap((s) => s.ads.map((a) => ({ adId: a.id, racValue: a.racValue }))),
    };
    const after: Record<string, unknown> = {};

    if (input.racValue !== undefined || input.terms !== undefined) {
      const data: { racValue?: string | null; termsOverride?: string[] } = {};
      if (input.racValue !== undefined) data.racValue = after.racValue = trimOrNull(input.racValue);
      if (input.terms !== undefined) data.termsOverride = (after.terms = normalizeCustomTerms(input.terms)) as string[];
      await tx.campaign.update({ where: { id: c.id }, data });
    }
    if (input.ads?.length) {
      const changed: { adId: string; racValue: string | null }[] = [];
      for (const a of input.ads) {
        const racValue = trimOrNull(a.racValue);
        await tx.ad.update({ where: { id: a.adId }, data: { racValue } });
        changed.push({ adId: a.adId, racValue });
      }
      after.ads = changed;
    }

    await writeAudit(tx, {
      orgId: c.orgId,
      actorId: auth.userId,
      action: 'campaign.google_signals.updated',
      entityType: 'campaign',
      entityId: c.id,
      details: { before, after } as never,
    });
    return isLive(c);
  });

  // Push the new values to the edge so the next paid click carries them (tolerates an unconfigured
  // edge, like every other resync). A real KV failure surfaces — the save is committed, and a retry
  // of the same PUT is idempotent.
  if (live) {
    await syncCampaignRedirectConfigs(campaignId, deps ?? undefined);
  }
  const view = await getGoogleSignals(auth, campaignId);
  return { ...view, synced: live };
}
