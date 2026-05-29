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
    updateFbCampaignStatus: vi.fn(async () => ({ success: true })),
  };
});

const fb = await import('@knn/fb');
const { launchCampaign, setCampaignActive } = await import('./launch.service.js');
const { reopenCampaign } = await import('./campaigns.service.js');

const suffix = Date.now().toString(36);
const storageKey = `launch-${suffix}.png`;
let orgId = '';
let buyerId = '';
let adAccountId = '';
let pageId = '';
let pixelId = '';
let channelRef = '';
let uploadId = '';
let afsId = '';
let domA = '';
let domB = '';
const domAHost = `la-${suffix}.example.com`;
const domBHost = `lb-${suffix}.example.com`;

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
    afsId = (await tx.googleConnection.create({ data: { accessTokenEnc: 'enc', tokenExpiresAt: new Date(Date.now() + 3_600_000), adsenseAccount: `acc-${suffix}`, adsenseAdClient: `adc-${suffix}`, afsPubId: `partner-pub-${suffix}`, label: 'AFS', status: 'ACTIVE' } })).id;
    domA = (await tx.domain.create({ data: { host: domAHost, afsAccountId: afsId, status: 'LIVE', verifyToken: `a-${suffix}` } })).id;
    domB = (await tx.domain.create({ data: { host: domBHost, afsAccountId: afsId, status: 'LIVE', verifyToken: `b-${suffix}` } })).id;
  });
});

afterEach(() => {
  vi.mocked(fb.createFbCampaign).mockClear();
});

afterAll(async () => {
  await withSystem(async (tx) => {
    await tx.campaign.deleteMany({ where: { orgId } }); // cascades offers
    await tx.channel.deleteMany({ where: { channelId: { startsWith: `ch-launch-${suffix}` } } });
    await tx.channel.deleteMany({ where: { channelId: { startsWith: `oc-` } } });
    await tx.domain.deleteMany({ where: { afsAccountId: afsId } });
    await tx.googleConnection.deleteMany({ where: { id: afsId } });
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

  it('reverts LAUNCHING → PROCESSING (not stuck) on a non-rate-limit FB error', async () => {
    const campaignId = await makeCampaign();
    vi.mocked(fb.createFbCampaign).mockImplementationOnce(async () => {
      throw new fb.FbApiError('Invalid objective/optimization combination', { code: 100 });
    });
    await expect(
      launchCampaign(auth(), campaignId, { generateArticle: vi.fn(async () => ({ slug: 's' })), writeRedirectConfigs: vi.fn(async () => undefined) }),
    ).rejects.toThrow('Invalid objective');
    const c = await withSystem((tx) => tx.campaign.findUnique({ where: { id: campaignId }, select: { status: true } }));
    expect(c?.status).toBe('PROCESSING'); // retryable, not stuck at LAUNCHING
  });

  it('on FB account restriction (368): reverts to PROCESSING + surfaces an actionable 409 (no blind retry)', async () => {
    const campaignId = await makeCampaign();
    vi.mocked(fb.createFbCampaign).mockImplementationOnce(async () => {
      throw new fb.FbAccountRestrictedError('The action attempted has been deemed abusive or is otherwise disallowed', {
        code: 368,
        checkpointUrl: 'https://www.facebook.com/checkpoint/xyz',
      });
    });
    await expect(
      launchCampaign(auth(), campaignId, { generateArticle: vi.fn(async () => ({ slug: 's' })), writeRedirectConfigs: vi.fn(async () => undefined) }),
    ).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('authenticate your account') });
    const c = await withSystem((tx) => tx.campaign.findUnique({ where: { id: campaignId }, select: { status: true } }));
    expect(c?.status).toBe('PROCESSING'); // not stuck; relaunchable once the owner authenticates
    // The token is fine — a restriction must NOT mark the connection broken.
    const conn = await withSystem((tx) => tx.fbConnection.findFirst({ where: { orgId }, select: { status: true } }));
    expect(conn?.status).not.toBe('CONNECTION_BROKEN');
  });

  it('on a token break (190) during launch: marks the connection broken + reverts to PROCESSING', async () => {
    const campaignId = await makeCampaign();
    vi.mocked(fb.createFbCampaign).mockImplementationOnce(async () => {
      throw new fb.FbConnectionBrokenError('Error validating access token', { code: 190, subcode: 460 });
    });
    await expect(
      launchCampaign(auth(), campaignId, { generateArticle: vi.fn(async () => ({ slug: 's' })), writeRedirectConfigs: vi.fn(async () => undefined) }),
    ).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('reconnect') });
    const c = await withSystem((tx) => tx.campaign.findUnique({ where: { id: campaignId }, select: { status: true } }));
    expect(c?.status).toBe('PROCESSING');
    const conn = await withSystem((tx) => tx.fbConnection.findFirst({ where: { orgId }, select: { status: true } }));
    expect(conn?.status).toBe('CONNECTION_BROKEN');
    // Restore the shared connection fixture so later tests in this file still launch.
    await withSystem((tx) => tx.fbConnection.updateMany({ where: { orgId }, data: { status: 'ACTIVE', lastError: null } }));
  });

  it('is idempotent — an already-launched campaign returns ACTIVE without re-creating', async () => {
    const campaignId = await makeCampaign();
    await withSystem((tx) => tx.campaign.update({ where: { id: campaignId }, data: { fbCampaignId: 'existing' } }));
    const generateArticle = vi.fn(async () => ({ slug: 's' }));
    const result = await launchCampaign(auth(), campaignId, { generateArticle, writeRedirectConfigs: vi.fn(async () => undefined) });
    expect(result).toEqual({ status: 'ACTIVE', fbCampaignId: 'existing' });
    expect(generateArticle).not.toHaveBeenCalled();
  });

  it('an offers campaign builds a weighted split: per-offer host + channel + offerId, organic fallback', async () => {
    const campaignId = await makeCampaign();
    let offerAId = '';
    await withSystem(async (tx) => {
      // Offers campaign: clear the legacy single channel; give each PAID offer its own channel.
      await tx.campaign.update({ where: { id: campaignId }, data: { channelId: null } });
      const chA = await tx.channel.create({ data: { channelId: `oc-a-${suffix}`, domainId: domA, status: 'ASSIGNED', currentCampaignId: campaignId } });
      const chB = await tx.channel.create({ data: { channelId: `oc-b-${suffix}`, domainId: domB, status: 'ASSIGNED', currentCampaignId: campaignId } });
      offerAId = (await tx.offer.create({ data: { orgId, campaignId, domainId: domA, weightPct: 60, kind: 'PAID', channelRef: chA.id } })).id;
      await tx.offer.create({ data: { orgId, campaignId, domainId: domB, weightPct: 40, kind: 'PAID', channelRef: chB.id } });
      await tx.offer.create({ data: { orgId, campaignId, domainId: domA, weightPct: 0, kind: 'ORGANIC' } });
    });

    const writeRedirectConfigs = vi.fn(async (_e: { redirectId: string; config: RedirectConfigPayload }[]): Promise<void> => {});
    const result = await launchCampaign(auth(), campaignId, { generateArticle: vi.fn(async () => ({ slug: 'health-2026' })), writeRedirectConfigs });
    expect(result.status).toBe('ACTIVE');

    const cfg = writeRedirectConfigs.mock.calls[0]![0][0]!.config;
    expect(cfg.channel).toBeUndefined(); // offers campaign: no single campaign-level channel
    expect(cfg.splits).toHaveLength(2);
    const byHost = Object.fromEntries((cfg.splits ?? []).map((s) => [new URL(s.url).host, s]));
    expect(byHost[domAHost]).toMatchObject({ weight: 60, channel: `oc-a-${suffix}`, offerId: offerAId, url: `https://${domAHost}/a/health-2026` });
    expect(byHost[domBHost]).toMatchObject({ weight: 40, channel: `oc-b-${suffix}` });
    // The ORGANIC offer is the non-ad fallback destination.
    expect(cfg.fallbackUrl).toBe(`https://${domAHost}/a/health-2026`);
  });

  it('refuses to launch a campaign with no channel (409)', async () => {
    const c = await withSystem((tx) => tx.campaign.create({ data: { orgId, buyerId, name: 'No chan', status: 'APPROVED', keywords: ['x'] } }));
    await expect(
      launchCampaign(auth(), c.id, { generateArticle: vi.fn(async () => ({ slug: 's' })), writeRedirectConfigs: vi.fn(async () => undefined) }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('reopenCampaign (edit/relaunch a stuck pre-launch campaign)', () => {
  it('reopens a PROCESSING campaign to DRAFT and releases its single channel', async () => {
    const campaignId = await makeCampaign(); // PROCESSING, channelId = channelRef
    await withSystem((tx) =>
      tx.channel.update({ where: { id: channelRef }, data: { status: 'ASSIGNED', currentCampaignId: campaignId, lockedForDay: '2026-05-29' } }),
    );

    const reopened = await reopenCampaign(auth(), campaignId);
    expect(reopened.status).toBe('DRAFT');
    expect(reopened.channelId).toBeNull();

    // The channel is back in the pool, free for the next campaign.
    const ch = await withSystem((tx) => tx.channel.findUnique({ where: { id: channelRef }, select: { status: true, currentCampaignId: true, lockedForDay: true } }));
    expect(ch).toMatchObject({ status: 'AVAILABLE', currentCampaignId: null, lockedForDay: null });
  });

  it('releases every PAID offer channel when reopening an offers campaign', async () => {
    const campaignId = await makeCampaign();
    let chAId = '';
    let chBId = '';
    await withSystem(async (tx) => {
      await tx.campaign.update({ where: { id: campaignId }, data: { channelId: null } });
      const chA = await tx.channel.create({ data: { channelId: `oc-reopen-a-${suffix}`, domainId: domA, status: 'ASSIGNED', currentCampaignId: campaignId } });
      const chB = await tx.channel.create({ data: { channelId: `oc-reopen-b-${suffix}`, domainId: domB, status: 'ASSIGNED', currentCampaignId: campaignId } });
      chAId = chA.id;
      chBId = chB.id;
      await tx.offer.create({ data: { orgId, campaignId, domainId: domA, weightPct: 60, kind: 'PAID', channelRef: chA.id } });
      await tx.offer.create({ data: { orgId, campaignId, domainId: domB, weightPct: 40, kind: 'PAID', channelRef: chB.id } });
    });

    const reopened = await reopenCampaign(auth(), campaignId);
    expect(reopened.status).toBe('DRAFT');

    // Both offer channels released; the offers no longer point at a channel.
    const chans = await withSystem((tx) => tx.channel.findMany({ where: { id: { in: [chAId, chBId] } }, select: { status: true, currentCampaignId: true } }));
    for (const ch of chans) expect(ch).toMatchObject({ status: 'AVAILABLE', currentCampaignId: null });
    const offers = await withSystem((tx) => tx.offer.findMany({ where: { campaignId }, select: { channelRef: true } }));
    for (const o of offers) expect(o.channelRef).toBeNull();
  });

  it('refuses to reopen a live (ACTIVE) campaign — must pause first (409)', async () => {
    const c = await withSystem((tx) => tx.campaign.create({ data: { orgId, buyerId, name: 'Live no-reopen', status: 'ACTIVE', keywords: ['x'], adAccountId, fbCampaignId: 'fbcamp-active' } }));
    await expect(reopenCampaign(auth(), c.id)).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('setCampaignActive (pause/resume optimization)', () => {
  it('pauses an ACTIVE campaign on FB and locally, then resumes it', async () => {
    const c = await withSystem((tx) =>
      tx.campaign.create({ data: { orgId, buyerId, name: 'Live', status: 'ACTIVE', keywords: ['x'], adAccountId, fbCampaignId: 'fbcamp-pr' } }),
    );
    vi.mocked(fb.updateFbCampaignStatus).mockClear();

    const paused = await setCampaignActive(auth(), c.id, false);
    expect(paused.status).toBe('PAUSED');
    expect(fb.updateFbCampaignStatus).toHaveBeenCalledWith('fbcamp-pr', 'act_1', 'tok', 'PAUSED');
    expect((await withSystem((tx) => tx.campaign.findUnique({ where: { id: c.id }, select: { status: true } })))?.status).toBe('PAUSED');

    const resumed = await setCampaignActive(auth(), c.id, true);
    expect(resumed.status).toBe('ACTIVE');
    expect(fb.updateFbCampaignStatus).toHaveBeenLastCalledWith('fbcamp-pr', 'act_1', 'tok', 'ACTIVE');
  });

  it('refuses to pause a non-launched (DRAFT) campaign', async () => {
    const c = await withSystem((tx) => tx.campaign.create({ data: { orgId, buyerId, name: 'Draft', status: 'DRAFT', keywords: ['x'] } }));
    await expect(setCampaignActive(auth(), c.id, false)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("forbids another buyer from pausing someone else's campaign (404)", async () => {
    const c = await withSystem((tx) => tx.campaign.create({ data: { orgId, buyerId, name: 'Mine', status: 'ACTIVE', keywords: ['x'], adAccountId, fbCampaignId: 'fbcamp-pr2' } }));
    const stranger = { userId: '00000000-0000-0000-0000-000000000000', orgId, role: ROLES.MEDIA_BUYER, status: USER_STATUS.ACTIVE };
    await expect(setCampaignActive(stranger, c.id, false)).rejects.toMatchObject({ statusCode: 404 });
  });
});
