import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { env } from '@knn/config';
import { prisma, withSystem } from '@knn/db';
import { closeQueues } from '@knn/queue';
import { GOOGLE_SIGNAL_LIMITS, ROLES, USER_STATUS, cleanTerms, classifyTerm } from '@knn/shared';
import { buildApp } from '../../app.js';
import { AppError } from '../../lib/errors.js';
import type { RedirectConfigPayload } from '../../lib/kv-sync.js';
import { hashPassword } from '../../lib/password.js';
import type { AuthContext } from '../../middleware/authenticate.js';
import { cloneCampaign } from './campaigns.service.js';
import { getGoogleSignals, updateGoogleSignals } from './google-signals.service.js';

/**
 * D27 — buyer-editable Google signals: the per-ad Referrer Ad Creative + the campaign's RSOC terms,
 * viewable and editable LIVE with no approval and no content rules (technical limits only).
 */

const suffix = Date.now().toString(36);
const PW = 'gs-pw-123';
const buyerEmail = `gs-b-${suffix}@a.com`;
const otherEmail = `gs-o-${suffix}@a.com`;
const AI_TERMS = ['nursing jobs in hospitals', 'hospital staff vacancies', 'ward assistant jobs near me'];

let app: FastifyInstance;
let orgId = '';
let buyerId = '';
let otherBuyerId = '';
let adminId = '';
let liveId = '';
let draftId = '';
let adA = '';
let adB = '';
let draftAd = '';
let articleSlug = '';

type Entries = { redirectId: string; config: RedirectConfigPayload }[];

const as = (userId: string, role: AuthContext['role'] = ROLES.MEDIA_BUYER): AuthContext => ({
  userId,
  orgId,
  role,
  status: USER_STATUS.ACTIVE,
});
const buyer = (): AuthContext => as(buyerId);

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await withSystem(async (tx) => {
    orgId = (await tx.organization.create({ data: { name: 'GS Co', slug: `gs-${suffix}` } })).id;
    const passwordHash = await hashPassword(PW);
    buyerId = (await tx.user.create({ data: { orgId, email: buyerEmail, name: 'B', passwordHash, role: ROLES.MEDIA_BUYER, status: USER_STATUS.ACTIVE } })).id;
    otherBuyerId = (await tx.user.create({ data: { orgId, email: otherEmail, name: 'O', passwordHash, role: ROLES.MEDIA_BUYER, status: USER_STATUS.ACTIVE } })).id;
    adminId = (await tx.user.create({ data: { orgId, email: `gs-a-${suffix}@a.com`, name: 'A', passwordHash, role: ROLES.COMPANY_ADMIN, status: USER_STATUS.ACTIVE } })).id;
    const channel = await tx.channel.create({ data: { channelId: `ch-gs-${suffix}`, status: 'ASSIGNED' } });
    articleSlug = `gs-art-${suffix}`;
    const article = await tx.article.create({
      data: {
        orgId,
        slug: articleSlug,
        title: 'Hospital Jobs Guide',
        rawContent: 'r',
        compliantContent: 'c',
        status: 'READY',
        query: 'hospital jobs',
        keywords: ['hospital jobs'],
        relatedSearchTerms: AI_TERMS,
      },
    });
    const upload = await tx.upload.create({
      data: { orgId, buyerId, kind: 'IMAGE', filename: 'nurse-creative.png', mimeType: 'image/png', sizeBytes: 4, storageKey: `gs-${suffix}.png` },
    });
    // A LAUNCHED campaign (fbCampaignId set) → edits re-sync its edge redirect configs.
    const live = await tx.campaign.create({
      data: {
        orgId,
        buyerId,
        name: 'Hospital Jobs',
        status: 'ACTIVE',
        keywords: ['hospital jobs'],
        racValue: 'Hospital jobs near you',
        fallbackUrl: 'https://fallback.example.com/',
        channelId: channel.id,
        articleId: article.id,
        fbCampaignId: `fbc-gs-${suffix}`,
        adSets: {
          create: [
            {
              orgId,
              name: 'IN 25-54',
              dailyBudgetCents: 5000,
              ads: {
                create: [
                  { orgId, name: 'Ad A', headline: 'h', primaryText: 'p', uploadId: upload.id, redirectId: `gs-a-${suffix}`, fbAdId: 'fbad-a' },
                  { orgId, name: 'Ad B', headline: 'h', primaryText: 'p', creativeType: 'VIDEO', redirectId: `gs-b-${suffix}`, fbAdId: 'fbad-b' },
                ],
              },
            },
          ],
        },
      },
      include: { adSets: { include: { ads: { orderBy: { name: 'asc' } } } } },
    });
    liveId = live.id;
    adA = live.adSets[0]!.ads[0]!.id;
    adB = live.adSets[0]!.ads[1]!.id;
    const draft = await tx.campaign.create({
      data: {
        orgId,
        buyerId,
        name: 'Draft',
        status: 'DRAFT',
        keywords: [],
        adSets: { create: [{ orgId, name: 's', ads: { create: [{ orgId, name: 'D', headline: 'h', primaryText: 'p', redirectId: `gs-d-${suffix}` }] } }] },
      },
      include: { adSets: { include: { ads: true } } },
    });
    draftId = draft.id;
    draftAd = draft.adSets[0]!.ads[0]!.id;
  });
});

afterAll(async () => {
  await withSystem(async (tx) => {
    await tx.campaign.deleteMany({ where: { orgId } });
    await tx.article.deleteMany({ where: { orgId } });
    await tx.upload.deleteMany({ where: { orgId } });
    await tx.channel.deleteMany({ where: { channelId: `ch-gs-${suffix}` } });
    await tx.auditLog.deleteMany({ where: { orgId } });
    await tx.user.deleteMany({ where: { orgId } });
    await tx.organization.deleteMany({ where: { id: orgId } });
  });
  await app.close();
  await closeQueues();
  await prisma.$disconnect();
});

describe('GET google signals (D27)', () => {
  it('shows exactly what Google gets: per-ad rc (default fallback) and the article terms via the page resolver', async () => {
    const v = await getGoogleSignals(buyer(), liveId);
    expect(v).toMatchObject({ campaignId: liveId, status: 'ACTIVE', live: true, racValue: 'Hospital jobs near you', customTerms: [] });
    // (Ads created in one transaction share created_at → compare order-insensitively.)
    expect(v.ads.map((a) => [a.name, a.racValue, a.effectiveRac]).sort()).toEqual([
      ['Ad A', null, 'Hospital jobs near you'],
      ['Ad B', null, 'Hospital jobs near you'],
    ]);
    const a = v.ads.find((x) => x.id === adA)!;
    expect(a).toMatchObject({ adSetName: 'IN 25-54', creativeType: 'IMAGE', fileName: 'nurse-creative.png' });
    expect(v.ads.find((x) => x.id === adB)!).toMatchObject({ creativeType: 'VIDEO', fileName: null });

    // The AI path is byte-identical to what the article page sent before D27.
    const vertical = ['hospital jobs'].map((p) => classifyTerm(p).vertical).find(Boolean) ?? null;
    const expected = cleanTerms(AI_TERMS, { contextVertical: vertical, max: 6 });
    expect(v.articles).toHaveLength(1);
    expect(v.articles[0]).toMatchObject({ slug: articleSlug, title: 'Hospital Jobs Guide', source: 'article', sent: expected, aiTerms: expected });
  });

  it("is owner-scoped: another buyer gets 404; the company admin can see it", async () => {
    await expect(getGoogleSignals(as(otherBuyerId), liveId)).rejects.toMatchObject({ statusCode: 404 });
    const v = await getGoogleSignals(as(adminId, ROLES.COMPANY_ADMIN), liveId);
    expect(v.campaignId).toBe(liveId);
  });
});

describe('PUT google signals (D27) — live, no approval, no content rules', () => {
  it('saves per-ad rc + custom terms exactly as typed and re-syncs the LIVE redirect configs', async () => {
    const writeRedirectConfigs = vi.fn(async (_e: Entries): Promise<void> => undefined);
    const v = await updateGoogleSignals(
      buyer(),
      liveId,
      {
        // Single words, "job" phrasing, other scripts — all accepted; no rewording, no filtering.
        ads: [{ adId: adB, racValue: '  हॉस्पिटल में नौकरियां — Apply Today  ' }],
        terms: ['Hospital Job', 'Job', 'free money', 'Hospital Job', 'nurse, ward boy'],
      },
      { writeRedirectConfigs },
    );

    expect(v.synced).toBe(true);
    expect(v.status).toBe('ACTIVE'); // no re-approval
    expect(v.ads.find((a) => a.id === adA)!.effectiveRac).toBe('Hospital jobs near you'); // untouched → default
    expect(v.ads.find((a) => a.id === adB)!).toMatchObject({
      racValue: 'हॉस्पिटल में नौकरियां — Apply Today',
      effectiveRac: 'हॉस्पिटल में नौकरियां — Apply Today',
    });
    // Normalization only: case-insensitive dedupe + a comma can't split a term. Order kept, not capped at 6.
    const sentTerms = ['Hospital Job', 'Job', 'free money', 'nurse ward boy'];
    expect(v.customTerms).toEqual(sentTerms);
    expect(v.articles[0]).toMatchObject({ source: 'custom', sent: sentTerms });
    expect(v.articles[0]!.aiTerms.length).toBeGreaterThan(0); // the AI terms stay visible for "start from AI"

    // The edge got the new values: each ad's own rc, terms on the MONEY url only.
    expect(writeRedirectConfigs).toHaveBeenCalledTimes(1);
    const entries = writeRedirectConfigs.mock.calls[0]![0];
    const byRedirect = Object.fromEntries(entries.map((e) => [e.redirectId, e.config]));
    expect(byRedirect[`gs-a-${suffix}`]!.adCreative).toBe('Hospital jobs near you');
    expect(byRedirect[`gs-b-${suffix}`]!.adCreative).toBe('हॉस्पिटल में नौकरियां — Apply Today');
    for (const cfg of Object.values(byRedirect)) {
      const url = new URL(cfg.articleUrl);
      expect(`${url.origin}${url.pathname}`).toBe(`${env.ARTICLE_DOMAIN}/a/${articleSlug}`);
      expect(url.searchParams.get('terms')).toBe(sentTerms.join(','));
      expect(cfg.fallbackUrl).toBe('https://fallback.example.com/'); // never carries terms
      expect(cfg.active).toBe(true);
    }

    const row = await withSystem((tx) => tx.campaign.findUnique({ where: { id: liveId }, select: { termsOverride: true, status: true } }));
    expect(row).toEqual({ termsOverride: sentTerms, status: 'ACTIVE' });
  });

  it('writes an audit entry with before/after', async () => {
    const log = await withSystem((tx) =>
      tx.auditLog.findFirst({ where: { orgId, action: 'campaign.google_signals.updated', entityId: liveId }, orderBy: { createdAt: 'desc' } }),
    );
    expect(log?.actorId).toBe(buyerId);
    const details = log?.details as { before: { terms: string[] }; after: { terms: string[]; ads: unknown[] } };
    expect(details.before.terms).toEqual([]);
    expect(details.after.terms).toEqual(['Hospital Job', 'Job', 'free money', 'nurse ward boy']);
    expect(details.after.ads).toEqual([{ adId: adB, racValue: 'हॉस्पिटल में नौकरियां — Apply Today' }]);
  });

  it('changing the campaign default moves every ad without its own text; clearing reverts to AI terms', async () => {
    const writeRedirectConfigs = vi.fn(async (_e: Entries): Promise<void> => undefined);
    const v = await updateGoogleSignals(buyer(), liveId, { racValue: 'Jobs', terms: [], ads: [{ adId: adB, racValue: null }] }, { writeRedirectConfigs });
    expect(v.racValue).toBe('Jobs'); // a single word is fine
    expect(v.ads.map((a) => a.effectiveRac)).toEqual(['Jobs', 'Jobs']);
    expect(v.customTerms).toEqual([]);
    expect(v.articles[0]!.source).toBe('article');
    const cfgs = writeRedirectConfigs.mock.calls[0]![0].map((e) => e.config);
    expect(cfgs.every((c) => c.adCreative === 'Jobs')).toBe(true);
    expect(cfgs.every((c) => new URL(c.articleUrl).searchParams.has('terms') === false)).toBe(true);
  });

  it('a blank campaign default sends no rc at all (the buyer decides)', async () => {
    const writeRedirectConfigs = vi.fn(async (_e: Entries): Promise<void> => undefined);
    const v = await updateGoogleSignals(buyer(), liveId, { racValue: '   ' }, { writeRedirectConfigs });
    expect(v.racValue).toBeNull();
    expect(v.ads.every((a) => a.effectiveRac === null)).toBe(true);
    expect(writeRedirectConfigs.mock.calls[0]![0].every((e) => e.config.adCreative === undefined)).toBe(true);
    await updateGoogleSignals(buyer(), liveId, { racValue: 'Hospital jobs near you' }, { writeRedirectConfigs });
  });

  it('rejects only oversized values (400), never wording', async () => {
    const writeRedirectConfigs = vi.fn(async (_e: Entries): Promise<void> => undefined);
    await expect(
      updateGoogleSignals(buyer(), liveId, { racValue: 'x'.repeat(GOOGLE_SIGNAL_LIMITS.racMaxChars + 1) }, { writeRedirectConfigs }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      updateGoogleSignals(buyer(), liveId, { terms: Array.from({ length: GOOGLE_SIGNAL_LIMITS.termsMaxCount + 1 }, (_, i) => `t${i}`) }, { writeRedirectConfigs }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(writeRedirectConfigs).not.toHaveBeenCalled();
  });

  it("rejects an ad id from another campaign (400) and another buyer's edit (404)", async () => {
    const writeRedirectConfigs = vi.fn(async (_e: Entries): Promise<void> => undefined);
    await expect(
      updateGoogleSignals(buyer(), liveId, { ads: [{ adId: draftAd, racValue: 'x y' }] }, { writeRedirectConfigs }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      updateGoogleSignals(as(otherBuyerId), liveId, { terms: ['hijack'] }, { writeRedirectConfigs }),
    ).rejects.toBeInstanceOf(AppError);
    const row = await withSystem((tx) => tx.campaign.findUnique({ where: { id: liveId }, select: { termsOverride: true } }));
    expect(row?.termsOverride).toEqual([]);
    expect(writeRedirectConfigs).not.toHaveBeenCalled();
  });

  it('a DRAFT takes the campaign default + terms (no resync — nothing is live) but not per-ad text (409)', async () => {
    const writeRedirectConfigs = vi.fn(async (_e: Entries): Promise<void> => undefined);
    await expect(
      updateGoogleSignals(buyer(), draftId, { ads: [{ adId: draftAd, racValue: 'x' }] }, { writeRedirectConfigs }),
    ).rejects.toMatchObject({ statusCode: 409 });
    const v = await updateGoogleSignals(buyer(), draftId, { racValue: 'Draft rc', terms: ['draft term'] }, { writeRedirectConfigs });
    expect(v).toMatchObject({ live: false, synced: false, racValue: 'Draft rc', customTerms: ['draft term'] });
    expect(writeRedirectConfigs).not.toHaveBeenCalled();
  });
});

describe('google signals routes', () => {
  const login = async (email: string): Promise<Record<string, string>> => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PW } });
    return { authorization: `Bearer ${res.json<{ accessToken: string }>().accessToken}` };
  };

  it('GET/PUT return { signals } for the owner and 404 for another buyer', async () => {
    const headers = await login(buyerEmail);
    const get = await app.inject({ method: 'GET', url: `/api/campaigns/${draftId}/google-signals`, headers });
    expect(get.statusCode).toBe(200);
    expect(get.json<{ signals: { campaignId: string } }>().signals.campaignId).toBe(draftId);

    // DRAFT → not live → no edge write from the route.
    const put = await app.inject({ method: 'PUT', url: `/api/campaigns/${draftId}/google-signals`, headers, payload: { terms: ['a', 'b'] } });
    expect(put.statusCode).toBe(200);
    expect(put.json<{ signals: { customTerms: string[]; synced: boolean } }>().signals).toMatchObject({ customTerms: ['a', 'b'], synced: false });

    const bad = await app.inject({ method: 'PUT', url: `/api/campaigns/${draftId}/google-signals`, headers, payload: { terms: 'not-an-array' } });
    expect(bad.statusCode).toBe(400);

    const other = await app.inject({ method: 'GET', url: `/api/campaigns/${draftId}/google-signals`, headers: await login(otherEmail) });
    expect(other.statusCode).toBe(404);

    const anon = await app.inject({ method: 'GET', url: `/api/campaigns/${draftId}/google-signals` });
    expect(anon.statusCode).toBe(401);
  });
});

describe('clone (D27)', () => {
  it('a clone keeps the custom terms (campaign config) but not per-ad rc (the draft editor recreates ads)', async () => {
    const writeRedirectConfigs = vi.fn(async (_e: Entries): Promise<void> => undefined);
    await updateGoogleSignals(buyer(), liveId, { terms: ['Hospital Job', 'Job'], ads: [{ adId: adA, racValue: 'Ad A own text' }] }, { writeRedirectConfigs });
    const clone = await cloneCampaign(buyer(), liveId);
    const row = await withSystem((tx) =>
      tx.campaign.findUnique({ where: { id: clone.id }, select: { status: true, termsOverride: true, racValue: true, adSets: { select: { ads: { select: { racValue: true } } } } } }),
    );
    expect(row).toMatchObject({ status: 'DRAFT', termsOverride: ['Hospital Job', 'Job'], racValue: 'Hospital jobs near you' });
    expect(row!.adSets.flatMap((s) => s.ads.map((a) => a.racValue))).toEqual([null, null]);
  });
});
