import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma, withSystem } from '@knn/db';
import { ROLES, USER_STATUS } from '@knn/shared';
import type { AuthContext } from '../../middleware/authenticate.js';
import {
  type ArticleAiDeps,
  generateArticleForCampaign,
  getPublicArticleBySlug,
} from './articles.service.js';

const suffix = Date.now().toString(36);
let orgId = '';
let buyerId = '';
let otherBuyerId = '';

/** A 1536-d unit vector with a single 1 at index `i` (cosine: same→1, distinct→0). */
function unit(i: number): number[] {
  return Array.from({ length: 1536 }, (_, k) => (k === i ? 1 : 0));
}

function deps(vector: number[]): ArticleAiDeps & {
  embedText: ReturnType<typeof vi.fn>;
  generateArticle: ReturnType<typeof vi.fn>;
  complianceRewrite: ReturnType<typeof vi.fn>;
} {
  return {
    embedText: vi.fn().mockResolvedValue(vector),
    generateArticle: vi.fn().mockResolvedValue({
      title: 'Health Plans 2026',
      content: 'Raw body paragraph.',
      relatedSearchTerms: ['medicare advantage plans', 'health insurance quotes'],
    }),
    complianceRewrite: vi.fn().mockResolvedValue('Compliant body paragraph.'),
  };
}

function authFor(userId: string): AuthContext {
  return { userId, orgId, role: ROLES.MEDIA_BUYER, status: USER_STATUS.ACTIVE };
}

async function makeCampaign(keywords: string[], ownerId = buyerId): Promise<string> {
  const c = await withSystem((tx) =>
    tx.campaign.create({ data: { orgId, buyerId: ownerId, name: `C-${Math.random()}`, keywords } }),
  );
  return c.id;
}

beforeAll(async () => {
  await withSystem(async (tx) => {
    const org = await tx.organization.create({ data: { name: 'Art Co', slug: `art-${suffix}` } });
    orgId = org.id;
    const buyer = await tx.user.create({
      data: { orgId, email: `art-buyer-${suffix}@a.com`, name: 'Buyer', passwordHash: 'x', role: ROLES.MEDIA_BUYER, status: USER_STATUS.ACTIVE },
    });
    buyerId = buyer.id;
    const other = await tx.user.create({
      data: { orgId, email: `art-other-${suffix}@a.com`, name: 'Other', passwordHash: 'x', role: ROLES.MEDIA_BUYER, status: USER_STATUS.ACTIVE },
    });
    otherBuyerId = other.id;
  });
});

afterAll(async () => {
  await withSystem(async (tx) => {
    await tx.auditLog.deleteMany({ where: { orgId } });
    await tx.article.deleteMany({ where: { orgId } });
    await tx.organization.deleteMany({ where: { id: orgId } });
  });
  await prisma.$disconnect();
});

describe('article engine', () => {
  let firstArticleId = '';
  let firstSlug = '';

  it('generates + compliance-rewrites a new article and attaches it (stores raw + compliant)', async () => {
    const campaignId = await makeCampaign(['health insurance', 'medicare']);
    const d = deps(unit(0));
    const result = await generateArticleForCampaign(authFor(buyerId), campaignId, d);

    expect(result.reused).toBe(false);
    expect(result.title).toBe('Health Plans 2026');
    expect(d.generateArticle).toHaveBeenCalledTimes(1);
    expect(d.complianceRewrite).toHaveBeenCalledTimes(1);
    firstArticleId = result.id;
    firstSlug = result.slug;

    const stored = await withSystem((tx) =>
      tx.article.findUnique({
        where: { id: result.id },
        select: { rawContent: true, compliantContent: true, relatedSearchTerms: true },
      }),
    );
    expect(stored?.rawContent).toBe('Raw body paragraph.');
    expect(stored?.compliantContent).toBe('Compliant body paragraph.');
    // The AI-generated high-CPC related-search terms are persisted (→ CSA `terms`).
    expect(stored?.relatedSearchTerms).toEqual(['medicare advantage plans', 'health insurance quotes']);

    const campaign = await withSystem((tx) =>
      tx.campaign.findUnique({ where: { id: campaignId }, select: { articleId: true } }),
    );
    expect(campaign?.articleId).toBe(result.id);

    // The embedding was persisted (pgvector column not null).
    const rows = await withSystem((tx) =>
      tx.$queryRawUnsafe<{ has: boolean }[]>(
        'SELECT (embedding IS NOT NULL) AS has FROM articles WHERE id = $1::uuid',
        result.id,
      ),
    );
    expect(rows[0]?.has).toBe(true);
  });

  it('is idempotent — re-running returns the attached article without re-generating', async () => {
    const campaignId = await makeCampaign(['health insurance', 'medicare']);
    const first = await generateArticleForCampaign(authFor(buyerId), campaignId, deps(unit(0)));
    const again = deps(unit(0));
    const second = await generateArticleForCampaign(authFor(buyerId), campaignId, again);
    expect(second.id).toBe(first.id);
    expect(second.reused).toBe(true);
    expect(again.generateArticle).not.toHaveBeenCalled();
    expect(again.embedText).not.toHaveBeenCalled();
  });

  it('reuses a similar existing article (cosine ≥ threshold) without generating', async () => {
    const campaignId = await makeCampaign(['health cover', 'medicare advantage']);
    const d = deps(unit(0)); // same embedding as the first article → cosine 1.0
    const result = await generateArticleForCampaign(authFor(buyerId), campaignId, d);
    expect(result.reused).toBe(true);
    expect(result.id).toBe(firstArticleId);
    expect(d.generateArticle).not.toHaveBeenCalled();
  });

  it('generates a fresh article when nothing is similar enough', async () => {
    const campaignId = await makeCampaign(['car insurance']);
    const d = deps(unit(5)); // orthogonal to unit(0) → cosine 0 < 0.70
    const result = await generateArticleForCampaign(authFor(buyerId), campaignId, d);
    expect(result.reused).toBe(false);
    expect(result.id).not.toBe(firstArticleId);
    expect(d.generateArticle).toHaveBeenCalledTimes(1);
  });

  it('rejects a campaign with no keywords (422)', async () => {
    const campaignId = await makeCampaign([]);
    await expect(generateArticleForCampaign(authFor(buyerId), campaignId, deps(unit(0)))).rejects.toMatchObject({
      statusCode: 422,
    });
  });

  it("won't let a buyer generate for another buyer's campaign (404)", async () => {
    const campaignId = await makeCampaign(['health insurance'], buyerId);
    await expect(
      generateArticleForCampaign(authFor(otherBuyerId), campaignId, deps(unit(0))),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('serves a READY article publicly by slug (compliant content only)', async () => {
    const article = await getPublicArticleBySlug(firstSlug);
    expect(article?.title).toBe('Health Plans 2026');
    expect(article?.compliantContent).toBe('Compliant body paragraph.');
    // The AI related-search terms are served (→ the content-page CSA `terms`).
    expect(article?.relatedSearchTerms).toEqual(['medicare advantage plans', 'health insurance quotes']);
    // The raw draft is never exposed on the public shape.
    expect(article && 'rawContent' in article).toBe(false);
  });

  it('returns null for an unknown slug', async () => {
    expect(await getPublicArticleBySlug('does-not-exist-xyz')).toBeNull();
  });
});
