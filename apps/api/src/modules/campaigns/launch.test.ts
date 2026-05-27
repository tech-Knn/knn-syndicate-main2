import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { env } from '@knn/config';
import { prisma, withSystem } from '@knn/db';
import { ROLES, USER_STATUS } from '@knn/shared';
import type { RedirectConfigPayload } from '../../lib/kv-sync.js';
import type { AuthContext } from '../../middleware/authenticate.js';

// Mock the Facebook network calls; keep the real error classes (instanceof in launch).
vi.mock('@knn/fb', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('@knn/fb')>();
  return {
    ...actual,
    decryptToken: vi.fn(() => 'tok'),
    createFbCampaign: vi.fn(async () => ({ id: 'fbcamp-1' })),
    createFbAdSet: vi.fn(async () => ({ id: 'fbadset-1' })),
    uploadFbAdImage: vi.fn(async () => 'imghash'),
    createFbAdCreative: vi.fn(async () => ({ id: 'fbcreative-1' })),
    createFbAd: vi.fn(async () => ({ id: 'fbad-1' })),
  };
});

const fb = await import('@knn/fb');
const { launchCampaign } = await import('./launch.service.js');

const suffix = Date.now().toString(36);
const storageKey = `launch-${suffix}.png`;
let orgId = '';
let buyerId = '';
let adAccountId = '';
let pageId = '';
let pixelId = '';
let channelRef = '';
let uploadId = '';

function auth(): AuthContext {
  return { userId: buyerId, orgId, role: ROLES.MEDIA_BUYER, status: USER_STATUS.ACTIVE };
}

async function makeCampaign(): Promise<string> {
  const c = await withSystem((tx) =>
    tx.campaign.create({
      data: {
        orgId,
        buyerId,
        name: `Launch ${Math.random()}`,
        status: 'PROCESSING',
        keywords: ['health insurance'],
        racValue: 'health insurance',
        adAccountId,
        pageId,
        channelId: channelRef,
        adSets: {
          create: [
            {
              orgId,
              name: 'US 25-54',
              dailyBudgetCents: 5000,
              countries: ['US'],
              pixelId,
              ads: {
                create: [
                  { orgId, name: 'Ad A', headline: 'Save on Health', primaryText: 'Compare plans now.', uploadId, redirectId: `r-${suffix}-${Math.random().toString(36).slice(2, 8)}` },
                ],
              },
            },
          ],
        },
      },
    }),
  );
  return c.id;
}

beforeAll(async () => {
  await mkdir(env.UPLOAD_DIR, { recursive: true });
  await writeFile(join(env.UPLOAD_DIR, storageKey), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await withSystem(async (tx) => {
    const org = await tx.organization.create({ data: { name: 'Launch Co', slug: `launch-${suffix}` } });
    orgId = org.id;
    const buyer = await tx.user.create({ data: { orgId, email: `launch-${suffix}@a.com`, name: 'B', passwordHash: 'x', role: ROLES.MEDIA_BUYER, status: USER_STATUS.ACTIVE } });
    buyerId = buyer.id;
    const conn = await tx.fbConnection.create({ data: { orgId, userId: buyerId, fbUserId: 'fb', accessTokenEnc: 'enc', tokenExpiresAt: new Date(Date.now() + 60 * 86_400_000) } });
    const acc = await tx.fbAdAccount.create({ data: { orgId, connectionId: conn.id, fbAccountId: 'act_1', name: 'M', currency: 'USD', timezone: 'Asia/Kolkata', status: '1' } });
    adAccountId = acc.id;
    pageId = (await tx.fbPage.create({ data: { orgId, connectionId: conn.id, fbPageId: 'pg', name: 'P' } })).id;
    pixelId = (await tx.fbPixel.create({ data: { orgId, adAccountId: acc.id, fbPixelId: 'px', name: 'X' } })).id;
    channelRef = (await tx.channel.create({ data: { channelId: `ch-launch-${suffix}`, status: 'ASSIGNED' } })).id;
    uploadId = (await tx.upload.create({ data: { orgId, buyerId, kind: 'IMAGE', filename: 'c.png', mimeType: 'image/png', sizeBytes: 4, storageKey } })).id;
  });
});

afterEach(() => {
  vi.mocked(fb.createFbCampaign).mockClear();
});

afterAll(async () => {
  await withSystem(async (tx) => {
    await tx.channel.deleteMany({ where: { channelId: { startsWith: `ch-launch-${suffix}` } } });
    await tx.organization.deleteMany({ where: { id: orgId } });
  });
  await prisma.$disconnect();
});

describe('launchCampaign (Phase 8)', () => {
  it('launches: ensures article, writes KV configs, creates on FB ACTIVE, → ACTIVE', async () => {
    const campaignId = await makeCampaign();
    const generateArticle = vi.fn(async () => ({ slug: 'health-2026' }));
    const writeRedirectConfigs = vi.fn(
      async (_entries: { redirectId: string; config: RedirectConfigPayload }[]): Promise<void> => {},
    );

    const result = await launchCampaign(auth(), campaignId, { generateArticle, writeRedirectConfigs });

    expect(result.status).toBe('ACTIVE');
    expect(result.fbCampaignId).toBe('fbcamp-1');
    expect(generateArticle).toHaveBeenCalledTimes(1); // no articleId → generated

    // KV got a redirect config pointing at the article with the channel + ad creative.
    expect(writeRedirectConfigs).toHaveBeenCalledTimes(1);
    const entries = writeRedirectConfigs.mock.calls[0]![0];
    expect(entries).toHaveLength(1);
    expect(entries[0]!.config).toMatchObject({
      active: true,
      articleUrl: `${env.ARTICLE_DOMAIN}/a/health-2026`,
      channel: `ch-launch-${suffix}`,
      rac: 'health insurance',
    });
    expect(String(entries[0]!.config.adCreative)).toContain('Save on Health');

    const campaign = await withSystem((tx) => tx.campaign.findUnique({ where: { id: campaignId }, select: { status: true, fbCampaignId: true, adSets: { select: { fbAdSetId: true, ads: { select: { fbAdId: true } } } } } }));
    expect(campaign?.status).toBe('ACTIVE');
    expect(campaign?.fbCampaignId).toBe('fbcamp-1');
    expect(campaign?.adSets[0]?.fbAdSetId).toBe('fbadset-1');
    expect(campaign?.adSets[0]?.ads[0]?.fbAdId).toBe('fbad-1');
  });

  it('parks the campaign in BATCHED on a Facebook rate-limit error', async () => {
    const campaignId = await makeCampaign();
    vi.mocked(fb.createFbCampaign).mockImplementationOnce(async () => {
      throw new fb.FbRateLimitError('rate limited', { code: 17 });
    });

    const result = await launchCampaign(auth(), campaignId, {
      generateArticle: vi.fn(async () => ({ slug: 's' })),
      writeRedirectConfigs: vi.fn(async () => undefined),
    });

    expect(result.status).toBe('BATCHED');
    const c = await withSystem((tx) => tx.campaign.findUnique({ where: { id: campaignId }, select: { status: true } }));
    expect(c?.status).toBe('BATCHED');
  });

  it('is idempotent — an already-launched campaign returns ACTIVE without re-creating', async () => {
    const campaignId = await makeCampaign();
    await withSystem((tx) => tx.campaign.update({ where: { id: campaignId }, data: { fbCampaignId: 'existing' } }));
    const generateArticle = vi.fn(async () => ({ slug: 's' }));
    const result = await launchCampaign(auth(), campaignId, { generateArticle, writeRedirectConfigs: vi.fn(async () => undefined) });
    expect(result).toEqual({ status: 'ACTIVE', fbCampaignId: 'existing' });
    expect(generateArticle).not.toHaveBeenCalled();
  });

  it('refuses to launch a campaign with no channel (409)', async () => {
    const c = await withSystem((tx) => tx.campaign.create({ data: { orgId, buyerId, name: 'No chan', status: 'APPROVED', keywords: ['x'] } }));
    await expect(
      launchCampaign(auth(), c.id, { generateArticle: vi.fn(async () => ({ slug: 's' })), writeRedirectConfigs: vi.fn(async () => undefined) }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});
