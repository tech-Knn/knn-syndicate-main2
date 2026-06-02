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
    // Default: no separate LAUNCH app (single-app) → writes resolve to the DATA token.
    // A specific test flips this to exercise the LAUNCH-token resolution.
    hasLaunchApp: vi.fn(() => false),
    // Default: the launch app can see all assets. A specific test returns a gap.
    checkAssetAccess: vi.fn(async () => ({ missingAccountIds: [], missingPageIds: [], missingPixelIds: [], ok: true })),
    createFbCampaign: vi.fn(async () => ({ id: 'fbcamp-1' })),
    createFbAdSet: vi.fn(async () => ({ id: 'fbadset-1' })),
    uploadFbAdImage: vi.fn(async () => 'imghash'),
    createFbAdCreative: vi.fn(async () => ({ id: 'fbcreative-1' })),
    createFbAd: vi.fn(async () => ({ id: 'fbad-1' })),
    updateFbCampaignStatus: vi.fn(async () => ({ success: true })),
    updateFbCampaignBudget: vi.fn(async () => ({ success: true })),
    updateFbAdSetBudget: vi.fn(async () => ({ success: true })),
  };
});

const fb = await import('@knn/fb');
const { launchCampaign, setCampaignActive, updateCampaignBudget, updateAdSetBudget } = await import('./launch.service.js');
const { reopenCampaign } = await import('./campaigns.service.js');
const { bulkSetActive } = await import('./bulk.service.js');

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
    await tx.article.deleteMany({ where: { orgId } });
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
    const artSlug = `health-${suffix}`;
    // Mirror the REAL generateArticle: persist the article + link it to the campaign. The post-launch
    // resync (which reloads campaign.articleId to route) needs this — the old stub returned only a
    // slug, leaving the resync with no article to find.
    const generateArticle = vi.fn(async () => {
      const art = await withSystem((tx) =>
        tx.article.create({
          data: { orgId, slug: artSlug, title: 'Health 2026', rawContent: 'r', compliantContent: 'c', status: 'READY' },
        }),
      );
      await withSystem((tx) => tx.campaign.update({ where: { id: campaignId }, data: { articleId: art.id } }));
      return { slug: artSlug };
    });
    const writeRedirectConfigs = vi.fn(
      async (_entries: { redirectId: string; config: RedirectConfigPayload }[]): Promise<void> => {},
    );

    const result = await launchCampaign(auth(), campaignId, { generateArticle, writeRedirectConfigs });

    expect(result.status).toBe('ACTIVE');
    expect(result.fbCampaignId).toBe('fbcamp-1');
    expect(generateArticle).toHaveBeenCalledTimes(1); // no articleId → generated (and persisted+linked)

    // KV is written TWICE: first BEFORE the FB ads exist (no ad id yet), then a RE-SYNC after
    // creation carrying expectedAdId = the FB ad id — so the cloak ad-id check (kaid={{ad.id}})
    // has something to match. Without the resync, expectedAdId is permanently empty (the bug).
    expect(writeRedirectConfigs).toHaveBeenCalledTimes(2);
    expect(writeRedirectConfigs.mock.calls[0]![0][0]!.config.expectedAdId).toBeUndefined(); // pre-creation: no id yet
    const entries = writeRedirectConfigs.mock.calls.at(-1)![0]; // the post-launch resync
    expect(entries).toHaveLength(1);
    expect(entries[0]!.config).toMatchObject({
      active: true,
      articleUrl: `${env.ARTICLE_DOMAIN}/a/${artSlug}`,
      channel: `ch-launch-${suffix}`,
      // referrerAdCreative (AFS `rc`) is now the campaign-level Referrer Ad Creative (racValue),
      // shared by all the campaign's ads — no longer derived from each ad's headline/text.
      adCreative: 'health insurance',
      // The resync maps the real FB ad id → cloaker verifies the click's kaid against it (enforce).
      expectedAdId: 'fbad-1',
    });

    const campaign = await withSystem((tx) => tx.campaign.findUnique({ where: { id: campaignId }, select: { status: true, fbCampaignId: true, adSets: { select: { fbAdSetId: true, ads: { select: { fbAdId: true } } } } } }));
    expect(campaign?.status).toBe('ACTIVE');
    expect(campaign?.fbCampaignId).toBe('fbcamp-1');
    expect(campaign?.adSets[0]?.fbAdSetId).toBe('fbadset-1');
    expect(campaign?.adSets[0]?.ads[0]?.fbAdId).toBe('fbad-1');
  });

  it('does NOT create two FB campaigns when launched CONCURRENTLY (atomic claim — the duplicate-launch bug)', async () => {
    const campaignId = await makeCampaign();
    vi.mocked(fb.createFbCampaign).mockClear();
    const gen = vi.fn(async () => ({ slug: `concur-${suffix}` }));
    const kv = vi.fn(async (_e: { redirectId: string; config: RedirectConfigPayload }[]): Promise<void> => {});

    // Two triggers fire at once (auto-launch + a manual click). Exactly ONE FB campaign must be created.
    const results = await Promise.allSettled([
      launchCampaign(auth(), campaignId, { generateArticle: gen, writeRedirectConfigs: kv }),
      launchCampaign(auth(), campaignId, { generateArticle: gen, writeRedirectConfigs: kv }),
    ]);

    expect(fb.createFbCampaign).toHaveBeenCalledTimes(1); // ← the fix: not twice
    const camp = await withSystem((tx) => tx.campaign.findUnique({ where: { id: campaignId }, select: { fbCampaignId: true, status: true } }));
    expect(camp?.fbCampaignId).toBe('fbcamp-1');
    expect(camp?.status).toBe('ACTIVE');
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
  });

  it('refuses to launch a campaign already in LAUNCHING — never a second FB campaign', async () => {
    const campaignId = await makeCampaign();
    await withSystem((tx) => tx.campaign.update({ where: { id: campaignId }, data: { status: 'LAUNCHING' } }));
    vi.mocked(fb.createFbCampaign).mockClear();
    await expect(
      launchCampaign(auth(), campaignId, { generateArticle: vi.fn(async () => ({ slug: 's' })), writeRedirectConfigs: vi.fn(async () => undefined) }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(fb.createFbCampaign).not.toHaveBeenCalled();
  });

  it('sets the FB display link (link_data.caption) from the ad displayLink, normalized to https — destination unchanged', async () => {
    const campaignId = await makeCampaign();
    // A bare-domain display link on the ad — the visible URL, separate from the /go redirect.
    await withSystem((tx) => tx.ad.updateMany({ where: { adSet: { campaignId } }, data: { displayLink: 'creatorrule.com' } }));
    await launchCampaign(auth(), campaignId, {
      generateArticle: vi.fn(async () => ({ slug: 's' })),
      writeRedirectConfigs: vi.fn(async () => undefined),
    });
    const spec = vi.mocked(fb.createFbAdCreative).mock.calls.at(-1)![2].objectStorySpec as {
      link_data: { caption?: string; link: string };
    };
    expect(spec.link_data.caption).toBe('https://creatorrule.com'); // bare domain → https URL (FB requires a URL)
    expect(spec.link_data.link).toContain(`/go/`); // destination is still the cloaked redirect, untouched
  });

  it('omits empty headline/primary text from the FB creative (both optional on Facebook)', async () => {
    const campaignId = await makeCampaign();
    await withSystem((tx) => tx.ad.updateMany({ where: { adSet: { campaignId } }, data: { headline: '', primaryText: '' } }));
    await launchCampaign(auth(), campaignId, {
      generateArticle: vi.fn(async () => ({ slug: 's' })),
      writeRedirectConfigs: vi.fn(async () => undefined),
    });
    const spec = vi.mocked(fb.createFbAdCreative).mock.calls.at(-1)![2].objectStorySpec as { link_data: Record<string, unknown> };
    expect('name' in spec.link_data).toBe(false); // headline omitted
    expect('message' in spec.link_data).toBe(false); // primary text omitted
    expect(spec.link_data.link).toContain('/go/'); // destination still present
  });

  it('two-app: writes use the same person\'s LAUNCH connection (short-lived token) when configured', async () => {
    // A separate LAUNCH app is configured, and this person has a usable LAUNCH connection
    // for the SAME FB profile (fbUserId "fb") that owns the ad account → ad writes must go
    // through the LAUNCH token, so every create carries appKind 'LAUNCH' (for appsecret_proof).
    const launchConn = await withSystem((tx) =>
      tx.fbConnection.create({
        // Different fb_user_id than the DATA fixture ('fb') — FB issues a per-app ASID, so a
        // real LAUNCH connection never shares the DATA connection's fb_user_id. Match is by userId.
        data: { orgId, userId: buyerId, fbUserId: 'fb-launch-asid', appKind: 'LAUNCH', accessTokenEnc: 'enc-launch', tokenExpiresAt: new Date(Date.now() + 3_600_000), status: 'ACTIVE' },
      }),
    );
    vi.mocked(fb.hasLaunchApp).mockReturnValue(true);
    vi.mocked(fb.createFbCampaign).mockClear();
    try {
      const campaignId = await makeCampaign();
      const result = await launchCampaign(auth(), campaignId, {
        generateArticle: vi.fn(async () => ({ slug: 'health-2026' })),
        writeRedirectConfigs: vi.fn(async () => undefined),
      });
      expect(result.status).toBe('ACTIVE');
      // 4th arg = appKind. With a usable LAUNCH connection it must be 'LAUNCH', not 'DATA'.
      expect(fb.createFbCampaign).toHaveBeenCalledWith('act_1', 'tok', expect.any(Object), 'LAUNCH');
      expect(fb.createFbAd).toHaveBeenCalledWith('act_1', 'tok', expect.any(Object), 'LAUNCH');
    } finally {
      vi.mocked(fb.hasLaunchApp).mockReturnValue(false);
      await withSystem((tx) => tx.fbConnection.delete({ where: { id: launchConn.id } }));
    }
  });

  it('two-app: a launch app missing the pixel fails fast with a clear 409 before any FB object is created', async () => {
    const launchConn = await withSystem((tx) =>
      tx.fbConnection.create({
        // Different fb_user_id than the DATA fixture ('fb') — FB issues a per-app ASID, so a
        // real LAUNCH connection never shares the DATA connection's fb_user_id. Match is by userId.
        data: { orgId, userId: buyerId, fbUserId: 'fb-launch-asid', appKind: 'LAUNCH', accessTokenEnc: 'enc-launch', tokenExpiresAt: new Date(Date.now() + 3_600_000), status: 'ACTIVE' },
      }),
    );
    vi.mocked(fb.hasLaunchApp).mockReturnValue(true);
    // The launch app wasn't granted this campaign's pixel.
    vi.mocked(fb.checkAssetAccess).mockResolvedValueOnce({ missingAccountIds: [], missingPageIds: [], missingPixelIds: ['px'], ok: false });
    vi.mocked(fb.createFbCampaign).mockClear();
    try {
      const campaignId = await makeCampaign();
      await expect(
        launchCampaign(auth(), campaignId, { generateArticle: vi.fn(async () => ({ slug: 's' })), writeRedirectConfigs: vi.fn(async () => undefined) }),
      ).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('pixel px') });
      // Failed BEFORE building anything on Facebook → no orphan campaign.
      expect(fb.createFbCampaign).not.toHaveBeenCalled();
      const c = await withSystem((tx) => tx.campaign.findUnique({ where: { id: campaignId }, select: { status: true } }));
      expect(c?.status).toBe('PROCESSING');
    } finally {
      vi.mocked(fb.hasLaunchApp).mockReturnValue(false);
      await withSystem((tx) => tx.fbConnection.delete({ where: { id: launchConn.id } }));
    }
  });

  it('two-app: an EXPIRED launch token yields a clear reconnect-launch 409 (no silent DATA fallback)', async () => {
    const launchConn = await withSystem((tx) =>
      tx.fbConnection.create({
        data: { orgId, userId: buyerId, fbUserId: 'fb', appKind: 'LAUNCH', accessTokenEnc: 'enc-launch', tokenExpiresAt: new Date(Date.now() - 1_000), status: 'ACTIVE' },
      }),
    );
    vi.mocked(fb.hasLaunchApp).mockReturnValue(true);
    try {
      const campaignId = await makeCampaign();
      await expect(
        launchCampaign(auth(), campaignId, { generateArticle: vi.fn(async () => ({ slug: 's' })), writeRedirectConfigs: vi.fn(async () => undefined) }),
      ).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('launch-app connection needs reconnecting') });
    } finally {
      vi.mocked(fb.hasLaunchApp).mockReturnValue(false);
      await withSystem((tx) => tx.fbConnection.delete({ where: { id: launchConn.id } }));
    }
  });

  it('three-app (Advanced Access): a VERIFY-owned account publishes with its OWN token — no LAUNCH connection required', async () => {
    // The Advanced-Access VERIFY app is self-sufficient: its long-lived ads_management token both
    // syncs assets AND publishes. So a VERIFY-owned ad account launches directly with appKind 'VERIFY'
    // — even when a separate LAUNCH app is configured and this person has NO launch connection (which
    // would otherwise 409). Flip the owning connection to VERIFY and prove it bypasses the LAUNCH path.
    await withSystem((tx) => tx.fbConnection.updateMany({ where: { userId: buyerId, fbUserId: 'fb' }, data: { appKind: 'VERIFY' } }));
    vi.mocked(fb.hasLaunchApp).mockReturnValue(true); // a launch app exists, but VERIFY must ignore it
    vi.mocked(fb.createFbCampaign).mockClear();
    try {
      const campaignId = await makeCampaign();
      const result = await launchCampaign(auth(), campaignId, {
        generateArticle: vi.fn(async () => ({ slug: 'health-2026' })),
        writeRedirectConfigs: vi.fn(async () => undefined),
      });
      expect(result.status).toBe('ACTIVE'); // launched — NOT a "reconnect launch app" 409
      // 4th arg = appKind. A VERIFY-owned account writes with appKind 'VERIFY' (for appsecret_proof).
      expect(fb.createFbCampaign).toHaveBeenCalledWith('act_1', 'tok', expect.any(Object), 'VERIFY');
      expect(fb.createFbAd).toHaveBeenCalledWith('act_1', 'tok', expect.any(Object), 'VERIFY');
    } finally {
      vi.mocked(fb.hasLaunchApp).mockReturnValue(false);
      await withSystem((tx) => tx.fbConnection.updateMany({ where: { userId: buyerId, fbUserId: 'fb' }, data: { appKind: 'DATA' } }));
    }
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

  it('reverts LAUNCHING → PROCESSING (not stuck) on a non-rate-limit FB error + rolls the edge KV back to active:false (B1)', async () => {
    const campaignId = await makeCampaign();
    // A persisted article (as a real launched campaign has) so the rollback resync can rebuild the config.
    await withSystem(async (tx) => {
      const art = await tx.article.create({ data: { orgId, slug: `revert-art-${suffix}`, title: 'T', rawContent: 'r', compliantContent: 'c' } });
      await tx.campaign.update({ where: { id: campaignId }, data: { articleId: art.id } });
    });
    vi.mocked(fb.createFbCampaign).mockImplementationOnce(async () => {
      throw new fb.FbApiError('Invalid objective/optimization combination', { code: 100 });
    });
    const writeRedirectConfigs = vi.fn(async (_e: { redirectId: string; config: RedirectConfigPayload }[]): Promise<void> => {});
    await expect(
      launchCampaign(auth(), campaignId, { generateArticle: vi.fn(async () => ({ slug: 's' })), writeRedirectConfigs }),
    ).rejects.toThrow('Invalid objective');
    const c = await withSystem((tx) => tx.campaign.findUnique({ where: { id: campaignId }, select: { status: true } }));
    expect(c?.status).toBe('PROCESSING'); // retryable, not stuck at LAUNCHING
    // B1: KV was written active:true at launch (before the FB build); the failure must roll it back to
    // active:false so residual paid clicks don't keep hitting a monetized page with no live ads behind it.
    expect(writeRedirectConfigs.mock.calls.at(-1)![0][0]!.config.active).toBe(false);
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

  it('returns a clear 409 (not a 500) when the ad creative file is missing on disk', async () => {
    // Simulate a creative whose DB row points at a file that no longer exists (e.g. the
    // uploads dir was wiped before it lived on a persistent volume).
    const badUploadId = (
      await withSystem((tx) =>
        tx.upload.create({ data: { orgId, buyerId, kind: 'IMAGE', filename: 'gone.png', mimeType: 'image/png', sizeBytes: 4, storageKey: `missing-${suffix}.png` } }),
      )
    ).id;
    const campaignId = await withSystem((tx) =>
      tx.campaign
        .create({
          data: {
            orgId, buyerId, name: `Missing ${Math.random()}`, status: 'PROCESSING', keywords: ['x'], racValue: 'x', adAccountId, pageId, channelId: channelRef,
            adSets: { create: [{ orgId, name: 'S', dailyBudgetCents: 5000, countries: ['US'], pixelId, ads: { create: [{ orgId, name: 'NoFile', headline: 'H', primaryText: 'P', uploadId: badUploadId, redirectId: `rm-${suffix}-${Math.random().toString(36).slice(2, 8)}` }] } }] },
          },
        })
        .then((c) => c.id),
    );

    await expect(
      launchCampaign(auth(), campaignId, { generateArticle: vi.fn(async () => ({ slug: 's' })), writeRedirectConfigs: vi.fn(async () => undefined) }),
    ).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('missing') });
    const c = await withSystem((tx) => tx.campaign.findUnique({ where: { id: campaignId }, select: { status: true } }));
    expect(c?.status).toBe('PROCESSING'); // reverted, relaunchable after re-upload
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

  it('per-offer article VARIANT (A/B): each offer split serves its own article slug, others the campaign default', async () => {
    const campaignId = await makeCampaign();
    let variantId = '';
    await withSystem(async (tx) => {
      await tx.campaign.update({ where: { id: campaignId }, data: { channelId: null } });
      // A second READY article = the B variant; offer A serves it, offer B serves the default.
      variantId = (await tx.article.create({ data: { orgId, slug: `variant-b-${suffix}`, title: 'Variant B', rawContent: 'r', compliantContent: 'c', status: 'READY' } })).id;
      const chA = await tx.channel.create({ data: { channelId: `oc-va-${suffix}`, domainId: domA, status: 'ASSIGNED', currentCampaignId: campaignId } });
      const chB = await tx.channel.create({ data: { channelId: `oc-vb-${suffix}`, domainId: domB, status: 'ASSIGNED', currentCampaignId: campaignId } });
      await tx.offer.create({ data: { orgId, campaignId, domainId: domA, weightPct: 50, kind: 'PAID', channelRef: chA.id, articleId: variantId } });
      await tx.offer.create({ data: { orgId, campaignId, domainId: domB, weightPct: 50, kind: 'PAID', channelRef: chB.id } }); // no variant → default
    });

    const writeRedirectConfigs = vi.fn(async (_e: { redirectId: string; config: RedirectConfigPayload }[]): Promise<void> => {});
    // The campaign's default article slug is 'health-2026' (generateArticle stub).
    const result = await launchCampaign(auth(), campaignId, { generateArticle: vi.fn(async () => ({ slug: 'health-2026' })), writeRedirectConfigs });
    expect(result.status).toBe('ACTIVE');

    const cfg = writeRedirectConfigs.mock.calls[0]![0][0]!.config;
    const byHost = Object.fromEntries((cfg.splits ?? []).map((s) => [new URL(s.url).host, s.url]));
    expect(byHost[domAHost]).toBe(`https://${domAHost}/a/variant-b-${suffix}`); // offer A → its variant
    expect(byHost[domBHost]).toBe(`https://${domBHost}/a/health-2026`); // offer B → campaign default
  });

  it('refuses to launch a campaign with no channel (409)', async () => {
    const c = await withSystem((tx) => tx.campaign.create({ data: { orgId, buyerId, name: 'No chan', status: 'APPROVED', keywords: ['x'] } }));
    await expect(
      launchCampaign(auth(), c.id, { generateArticle: vi.fn(async () => ({ slug: 's' })), writeRedirectConfigs: vi.fn(async () => undefined) }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('setCampaignActive — edge KV stays in sync with status (B1)', () => {
  it('pause → republishes the redirect config active:false; resume → active:true', async () => {
    const campaignId = await makeCampaign();
    // ACTIVE campaign with a persisted article (sync re-reads articleId from the DB) + an fb id so
    // the (mocked) FB pause/resume call runs. Mirrors a real launched campaign's state.
    await withSystem(async (tx) => {
      const art = await tx.article.create({ data: { orgId, slug: `pause-art-${suffix}`, title: 'T', rawContent: 'r', compliantContent: 'c' } });
      await tx.campaign.update({ where: { id: campaignId }, data: { articleId: art.id, status: 'ACTIVE', fbCampaignId: 'fbcamp-pause' } });
    });

    // Pause: the resync must publish active:false so the redirect stops monetizing residual clicks.
    const pauseWrite = vi.fn(async (_e: { redirectId: string; config: RedirectConfigPayload }[]): Promise<void> => {});
    const paused = await setCampaignActive(auth(), campaignId, false, { writeRedirectConfigs: pauseWrite });
    expect(paused.status).toBe('PAUSED');
    expect(pauseWrite).toHaveBeenCalledTimes(1);
    expect(pauseWrite.mock.calls[0]![0][0]!.config.active).toBe(false);

    // Resume: active:true again.
    const resumeWrite = vi.fn(async (_e: { redirectId: string; config: RedirectConfigPayload }[]): Promise<void> => {});
    const resumed = await setCampaignActive(auth(), campaignId, true, { writeRedirectConfigs: resumeWrite });
    expect(resumed.status).toBe('ACTIVE');
    expect(resumeWrite.mock.calls[0]![0][0]!.config.active).toBe(true);
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
    expect(fb.updateFbCampaignStatus).toHaveBeenCalledWith('fbcamp-pr', 'act_1', 'tok', 'PAUSED', 'DATA');
    expect((await withSystem((tx) => tx.campaign.findUnique({ where: { id: c.id }, select: { status: true } })))?.status).toBe('PAUSED');

    const resumed = await setCampaignActive(auth(), c.id, true);
    expect(resumed.status).toBe('ACTIVE');
    expect(fb.updateFbCampaignStatus).toHaveBeenLastCalledWith('fbcamp-pr', 'act_1', 'tok', 'ACTIVE', 'DATA');
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

describe('updateCampaignBudget — live budget edit (M1 ceiling-breaker)', () => {
  it('CBO: pushes the new daily budget to the FB campaign + persists it', async () => {
    const c = await withSystem((tx) =>
      tx.campaign.create({ data: { orgId, buyerId, name: 'CBO live', status: 'ACTIVE', keywords: ['x'], adAccountId, fbCampaignId: 'fbcamp-b1', budgetMode: 'CAMPAIGN', dailyBudgetCents: 300 } }),
    );
    vi.mocked(fb.updateFbCampaignBudget).mockClear();
    vi.mocked(fb.updateFbAdSetBudget).mockClear();

    const res = await updateCampaignBudget(auth(), c.id, { dailyBudgetCents: 1500 });
    expect(res).toMatchObject({ id: c.id, dailyBudgetCents: 1500 });
    expect(fb.updateFbCampaignBudget).toHaveBeenCalledWith('fbcamp-b1', 'act_1', 'tok', 1500, 'DATA');
    expect(fb.updateFbAdSetBudget).not.toHaveBeenCalled();
    const after = await withSystem((tx) => tx.campaign.findUnique({ where: { id: c.id }, select: { dailyBudgetCents: true, status: true } }));
    expect(after).toMatchObject({ dailyBudgetCents: 1500, status: 'ACTIVE' });
  });

  it('ABO (single ad set): pushes the budget to the FB ad set + persists it on the ad set', async () => {
    const c = await withSystem(async (tx) => {
      const camp = await tx.campaign.create({ data: { orgId, buyerId, name: 'ABO live', status: 'PAUSED', keywords: ['x'], adAccountId, fbCampaignId: 'fbcamp-b2', budgetMode: 'AD_SET' } });
      await tx.adSet.create({ data: { orgId, campaignId: camp.id, name: 'set-1', fbAdSetId: 'fbadset-b2', dailyBudgetCents: 300 } });
      return camp;
    });
    vi.mocked(fb.updateFbCampaignBudget).mockClear();
    vi.mocked(fb.updateFbAdSetBudget).mockClear();

    const res = await updateCampaignBudget(auth(), c.id, { dailyBudgetCents: 2500 });
    expect(res).toMatchObject({ id: c.id, dailyBudgetCents: 2500 });
    expect(fb.updateFbAdSetBudget).toHaveBeenCalledWith('fbadset-b2', 'act_1', 'tok', 2500, 'DATA');
    expect(fb.updateFbCampaignBudget).not.toHaveBeenCalled();
    const set = await withSystem((tx) => tx.adSet.findFirst({ where: { campaignId: c.id }, select: { dailyBudgetCents: true } }));
    expect(set?.dailyBudgetCents).toBe(2500);
  });

  it('does NOT release the campaign’s channel (budget edit must not touch routing)', async () => {
    const c = await withSystem(async (tx) => {
      const camp = await tx.campaign.create({ data: { orgId, buyerId, name: 'Keep channel', status: 'ACTIVE', keywords: ['x'], adAccountId, fbCampaignId: 'fbcamp-b3', budgetMode: 'CAMPAIGN', dailyBudgetCents: 300 } });
      const ch = await tx.channel.create({ data: { channelId: `budg-keep-${suffix}`, domainId: domA, status: 'ASSIGNED', currentCampaignId: camp.id } });
      await tx.campaign.update({ where: { id: camp.id }, data: { channelId: ch.id } });
      return { id: camp.id, channelRef: ch.id };
    });

    await updateCampaignBudget(auth(), c.id, { dailyBudgetCents: 999 });

    const ch = await withSystem((tx) => tx.channel.findUnique({ where: { id: c.channelRef }, select: { status: true, currentCampaignId: true } }));
    expect(ch).toMatchObject({ status: 'ASSIGNED', currentCampaignId: c.id });
    const camp = await withSystem((tx) => tx.campaign.findUnique({ where: { id: c.id }, select: { channelId: true } }));
    expect(camp?.channelId).toBe(c.channelRef);
  });

  it('rejects a budget below the $2.00 Facebook floor (422) and writes nothing', async () => {
    const c = await withSystem((tx) =>
      tx.campaign.create({ data: { orgId, buyerId, name: 'Floor', status: 'ACTIVE', keywords: ['x'], adAccountId, fbCampaignId: 'fbcamp-b4', budgetMode: 'CAMPAIGN', dailyBudgetCents: 300 } }),
    );
    vi.mocked(fb.updateFbCampaignBudget).mockClear();
    await expect(updateCampaignBudget(auth(), c.id, { dailyBudgetCents: 100 })).rejects.toMatchObject({ statusCode: 422 });
    expect(fb.updateFbCampaignBudget).not.toHaveBeenCalled();
    const after = await withSystem((tx) => tx.campaign.findUnique({ where: { id: c.id }, select: { dailyBudgetCents: true } }));
    expect(after?.dailyBudgetCents).toBe(300); // unchanged
  });

  it('refuses a non-live (DRAFT) campaign (409)', async () => {
    const c = await withSystem((tx) => tx.campaign.create({ data: { orgId, buyerId, name: 'Draft budget', status: 'DRAFT', keywords: ['x'], budgetMode: 'CAMPAIGN', dailyBudgetCents: 300 } }));
    await expect(updateCampaignBudget(auth(), c.id, { dailyBudgetCents: 500 })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("forbids another buyer from editing someone else's budget (404)", async () => {
    const c = await withSystem((tx) => tx.campaign.create({ data: { orgId, buyerId, name: 'Mine budget', status: 'ACTIVE', keywords: ['x'], adAccountId, fbCampaignId: 'fbcamp-b5', budgetMode: 'CAMPAIGN', dailyBudgetCents: 300 } }));
    const stranger = { userId: '00000000-0000-0000-0000-000000000000', orgId, role: ROLES.MEDIA_BUYER, status: USER_STATUS.ACTIVE };
    await expect(updateCampaignBudget(stranger, c.id, { dailyBudgetCents: 500 })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('refuses multi-ad-set ABO (won’t silently re-distribute money) (409)', async () => {
    const c = await withSystem(async (tx) => {
      const camp = await tx.campaign.create({ data: { orgId, buyerId, name: 'ABO multi', status: 'ACTIVE', keywords: ['x'], adAccountId, fbCampaignId: 'fbcamp-b6', budgetMode: 'AD_SET' } });
      await tx.adSet.create({ data: { orgId, campaignId: camp.id, name: 'a', fbAdSetId: 'fbadset-m1', dailyBudgetCents: 300 } });
      await tx.adSet.create({ data: { orgId, campaignId: camp.id, name: 'b', fbAdSetId: 'fbadset-m2', dailyBudgetCents: 300 } });
      return camp;
    });
    await expect(updateCampaignBudget(auth(), c.id, { dailyBudgetCents: 500 })).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('updateAdSetBudget — per-ad-set live budget (multi-ad-set ABO)', () => {
  it('pushes the new budget to the specific FB ad set + persists it', async () => {
    const { campId, setId } = await withSystem(async (tx) => {
      const camp = await tx.campaign.create({ data: { orgId, buyerId, name: 'ABO per-set', status: 'ACTIVE', keywords: ['x'], adAccountId, fbCampaignId: 'fbcamp-as1', budgetMode: 'AD_SET' } });
      const setA = await tx.adSet.create({ data: { orgId, campaignId: camp.id, name: 'A', fbAdSetId: 'fbadset-as-a', dailyBudgetCents: 300 } });
      await tx.adSet.create({ data: { orgId, campaignId: camp.id, name: 'B', fbAdSetId: 'fbadset-as-b', dailyBudgetCents: 400 } });
      return { campId: camp.id, setId: setA.id };
    });
    vi.mocked(fb.updateFbAdSetBudget).mockClear();

    const res = await updateAdSetBudget(auth(), campId, setId, { dailyBudgetCents: 1200 });
    expect(res).toMatchObject({ id: campId, adSetId: setId, dailyBudgetCents: 1200 });
    expect(fb.updateFbAdSetBudget).toHaveBeenCalledWith('fbadset-as-a', 'act_1', 'tok', 1200, 'DATA');
    const sets = await withSystem((tx) => tx.adSet.findMany({ where: { campaignId: campId }, orderBy: { createdAt: 'asc' }, select: { dailyBudgetCents: true } }));
    expect(sets.map((s) => s.dailyBudgetCents)).toEqual([1200, 400]); // only set A changed
  });

  it('refuses on a CBO campaign (use the campaign budget instead) (409)', async () => {
    const { campId, setId } = await withSystem(async (tx) => {
      const camp = await tx.campaign.create({ data: { orgId, buyerId, name: 'CBO not per-set', status: 'ACTIVE', keywords: ['x'], adAccountId, fbCampaignId: 'fbcamp-as2', budgetMode: 'CAMPAIGN', dailyBudgetCents: 500 } });
      const set = await tx.adSet.create({ data: { orgId, campaignId: camp.id, name: 'A', fbAdSetId: 'fbadset-as-c' } });
      return { campId: camp.id, setId: set.id };
    });
    await expect(updateAdSetBudget(auth(), campId, setId, { dailyBudgetCents: 800 })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('rejects an ad set that does not belong to the campaign (404)', async () => {
    const { campId, otherSetId } = await withSystem(async (tx) => {
      const camp = await tx.campaign.create({ data: { orgId, buyerId, name: 'ABO scope', status: 'ACTIVE', keywords: ['x'], adAccountId, fbCampaignId: 'fbcamp-as3', budgetMode: 'AD_SET' } });
      const other = await tx.campaign.create({ data: { orgId, buyerId, name: 'Other', status: 'ACTIVE', keywords: ['x'], adAccountId, fbCampaignId: 'fbcamp-as4', budgetMode: 'AD_SET' } });
      const otherSet = await tx.adSet.create({ data: { orgId, campaignId: other.id, name: 'X', fbAdSetId: 'fbadset-as-x', dailyBudgetCents: 300 } });
      return { campId: camp.id, otherSetId: otherSet.id };
    });
    await expect(updateAdSetBudget(auth(), campId, otherSetId, { dailyBudgetCents: 800 })).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('bulkSetActive — batch pause/resume (M1 velocity)', () => {
  it('pauses the valid campaigns and reports the invalid one (partial success)', async () => {
    const ids = await withSystem(async (tx) => {
      const a = await tx.campaign.create({ data: { orgId, buyerId, name: 'Bulk A', status: 'ACTIVE', keywords: ['x'], adAccountId, fbCampaignId: 'fbcamp-bk1' } });
      const b = await tx.campaign.create({ data: { orgId, buyerId, name: 'Bulk B', status: 'ACTIVE', keywords: ['x'], adAccountId, fbCampaignId: 'fbcamp-bk2' } });
      const draft = await tx.campaign.create({ data: { orgId, buyerId, name: 'Bulk Draft', status: 'DRAFT', keywords: ['x'] } });
      return { a: a.id, b: b.id, draft: draft.id };
    });

    const res = await bulkSetActive(auth(), [ids.a, ids.b, ids.draft], false);
    expect(res.succeeded.sort()).toEqual([ids.a, ids.b].sort());
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0]!.id).toBe(ids.draft); // DRAFT can't be paused → reported, not thrown

    const statuses = await withSystem((tx) => tx.campaign.findMany({ where: { id: { in: [ids.a, ids.b] } }, select: { status: true } }));
    for (const s of statuses) expect(s.status).toBe('PAUSED');
  });

  it('rejects an empty selection (400)', async () => {
    await expect(bulkSetActive(auth(), [], false)).rejects.toMatchObject({ statusCode: 400 });
  });
});
