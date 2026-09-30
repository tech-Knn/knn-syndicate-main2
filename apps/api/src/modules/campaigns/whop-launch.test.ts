import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The flags are read once when @knn/config loads, so set them before any import runs.
const { realFetch } = vi.hoisted(() => {
  process.env.WHOP_ADS_ENABLED = 'true';
  return { realFetch: globalThis.fetch };
});

import { env } from '@knn/config';
import { prisma, withSystem } from '@knn/db';
import { encryptToken } from '@knn/fb';
import { ROLES, USER_STATUS } from '@knn/shared';
import { type MockWhop, startMockWhop } from '@knn/whop/testing';
import type { RedirectConfigPayload } from '../../lib/kv-sync.js';
import type { AuthContext } from '../../middleware/authenticate.js';
import { reopenCampaign } from './campaigns.service.js';
import { type LaunchDeps, launchCampaign, relaunchCampaign, setCampaignActive, testLaunchCampaign, updateAdSetBudget, updateCampaignBudget } from './launch.service.js';
import { saveLaunched } from './whop-launch.service.js';

const suffix = Date.now().toString(36);
const BIZ = 'biz_LAUNCHTEST1';
const KEY = 'whop_test_key_launch_0011';
const PAGE = 'sacc_LaunchPage1';
const SLUG = `whop-launch-${suffix}`;
const storageKey = `whop-launch-${suffix}.png`;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);
const PIXEL_OK = { installed: true, reachable: true, last_seen_days: 0, page_events: [], host_events: [], native_tracking: false, last_fired_days: {}, firing_data_ok: true, url: null };
const PIXEL_MISSING = { ...PIXEL_OK, installed: false };
const REDIRECT_HOST = `go-${suffix}.example.com`;

let mock: MockWhop;
let orgId = '';
let buyerId = '';
let connectionId = '';
let channelRef = '';
let uploadId = '';
let articleId = '';
let missingUploadId = '';

const auth = (): AuthContext => ({ userId: buyerId, orgId, role: ROLES.MEDIA_BUYER, status: USER_STATUS.ACTIVE });
const notSleeping = vi.fn(async (_ms: number): Promise<void> => undefined);
const written: { redirectId: string; config: RedirectConfigPayload }[][] = [];
const deps = (over: Partial<LaunchDeps> = {}): LaunchDeps => ({
  generateArticle: vi.fn(async () => ({ slug: SLUG })),
  writeRedirectConfigs: vi.fn(async (entries) => void written.push(entries)),
  sleep: notSleeping,
  ...over,
});

interface CampaignOpts {
  budgetMode?: 'CAMPAIGN' | 'AD_SET';
  dailyBudgetCents?: number | null;
  adSets?: { name: string; dailyBudgetCents: number | null; ads: { name: string; uploadId: string }[] }[];
  status?: 'PROCESSING' | 'DRAFT' | 'BATCHED';
  whopConnectionId?: string | null;
}

async function makeCampaign(o: CampaignOpts = {}): Promise<string> {
  const sets = o.adSets ?? [{ name: 'US 35-65', dailyBudgetCents: 2500, ads: [{ name: 'Ad A', uploadId }] }];
  const c = await withSystem((tx) =>
    tx.campaign.create({
      data: {
        orgId,
        buyerId,
        name: `Whop Launch ${Math.random().toString(36).slice(2, 8)}`,
        status: o.status ?? 'PROCESSING',
        adProvider: 'WHOP',
        objective: 'OUTCOME_LEADS',
        keywords: ['senior suv deals'],
        racValue: 'senior suv deals',
        whopConnectionId: o.whopConnectionId === undefined ? connectionId : o.whopConnectionId,
        whopBizId: BIZ,
        whopPageId: PAGE,
        channelId: channelRef,
        articleId,
        budgetMode: o.budgetMode ?? 'AD_SET',
        dailyBudgetCents: o.dailyBudgetCents ?? null,
        adSets: {
          create: sets.map((s) => ({
            orgId,
            name: s.name,
            dailyBudgetCents: s.dailyBudgetCents,
            countries: ['US'],
            ads: {
              create: s.ads.map((a) => ({
                orgId,
                name: a.name,
                headline: 'Compare SUV deals',
                primaryText: 'See what you qualify for.',
                cta: 'LEARN_MORE',
                uploadId: a.uploadId,
                redirectId: `r-${suffix}-${Math.random().toString(36).slice(2, 9)}`,
              })),
            },
          })),
        },
      },
    }),
  );
  return c.id;
}

const load = (id: string) =>
  withSystem((tx) => tx.campaign.findUniqueOrThrow({ where: { id }, include: { adSets: { include: { ads: true }, orderBy: { createdAt: 'asc' } } } }));
const biz = () => mock.businesses.get(BIZ)!;
const whopCampaigns = () => [...biz().ads.campaigns.values()];
const whopGroups = () => [...biz().ads.groups.values()];
const whopAds = () => [...biz().ads.ads.values()];
const lastConfigs = () => written.at(-1)!;

beforeAll(async () => {
  mock = await startMockWhop();
  // Send the real client's calls to Whop's hosts to the local mock; everything else passes through.
  vi.stubGlobal('fetch', (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input).replace(/^https:\/\/(sandbox-)?api\.whop\.com\/api\/v1/, mock.baseUrl);
    return realFetch(url, init);
  });
  await mkdir(env.UPLOAD_DIR, { recursive: true });
  await writeFile(join(env.UPLOAD_DIR, storageKey), PNG);
  await withSystem(async (tx) => {
    const org = await tx.organization.create({ data: { name: 'Whop Launch Co', slug: `whop-launch-${suffix}`, whopEnabled: true } });
    orgId = org.id;
    buyerId = (await tx.user.create({ data: { orgId, email: `whop-launch-${suffix}@a.com`, name: 'B', passwordHash: 'x', role: ROLES.MEDIA_BUYER, status: USER_STATUS.ACTIVE } })).id;
    const conn = await tx.whopConnection.create({
      data: { orgId, userId: buyerId, bizId: BIZ, label: 'Launch Biz', apiKeyEnc: encryptToken(KEY), apiKeyLast4: KEY.slice(-4), apiVersionDate: env.WHOP_API_VERSION_DATE, status: 'ACTIVE' },
    });
    connectionId = conn.id;
    await tx.whopSocialAccount.create({ data: { orgId, connectionId, whopId: PAGE, platform: 'facebook', name: 'Launch Page' } });
    channelRef = (await tx.channel.create({ data: { channelId: `ch-wl-${suffix}`, status: 'ASSIGNED' } })).id;
    uploadId = (await tx.upload.create({ data: { orgId, buyerId, kind: 'IMAGE', filename: 'creative.png', mimeType: 'image/png', sizeBytes: PNG.length, storageKey } })).id;
    missingUploadId = (await tx.upload.create({ data: { orgId, buyerId, kind: 'IMAGE', filename: 'gone.png', mimeType: 'image/png', sizeBytes: 4, storageKey: `whop-launch-missing-${suffix}.png` } })).id;
    articleId = (await tx.article.create({ data: { orgId, slug: SLUG, title: 'SUV deals', rawContent: 'r', compliantContent: 'c', status: 'READY' } })).id;
    // Company-exclusive redirect host, so the test is isolated from any pool in the shared dev database.
    await tx.redirectDomain.create({ data: { host: REDIRECT_HOST, mode: 'NORMAL', isActive: true, healthy: true, ownerOrgId: orgId } });
  });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await withSystem(async (tx) => {
    await tx.auditLog.deleteMany({ where: { orgId } });
    await tx.campaign.deleteMany({ where: { orgId } });
    await tx.article.deleteMany({ where: { orgId } });
    await tx.redirectDomain.deleteMany({ where: { host: REDIRECT_HOST } });
    await tx.channel.deleteMany({ where: { channelId: { startsWith: `ch-wl-${suffix}` } } });
    await tx.organization.deleteMany({ where: { id: orgId } });
  });
  await rm(join(env.UPLOAD_DIR, storageKey), { force: true });
  await mock.close();
  await prisma.$disconnect();
});

beforeEach(async () => {
  mock.businesses.clear();
  mock.requests.length = 0;
  mock.failures.length = 0;
  mock.addBusiness({
    bizId: BIZ,
    apiKey: KEY,
    title: 'Launch Biz',
    pages: [{ id: PAGE, platform: 'facebook', name: 'Launch Page', username: 'lp', external_id: '1', url: 'https://facebook.com/lp', verified: true, error: null }],
    pixelForAnyUrl: PIXEL_OK,
  });
  written.length = 0;
  notSleeping.mockClear();
  await withSystem(async (tx) => {
    await tx.organization.update({ where: { id: orgId }, data: { whopEnabled: true } });
    await tx.whopConnection.update({ where: { id: connectionId }, data: { status: 'ACTIVE', lastError: null } });
  });
});

describe('launching a campaign on Whop', () => {
  it('builds the whole tree draft-first, activates it, and persists every Whop id', async () => {
    const id = await makeCampaign({ adSets: [{ name: 'US 35-65', dailyBudgetCents: 2500, ads: [{ name: 'Ad A', uploadId }, { name: 'Ad B', uploadId }] }] });
    const d = deps();
    const res = await launchCampaign(auth(), id, d);

    expect(res.status).toBe('ACTIVE');
    expect(res.whopCampaignId).toMatch(/^adcamp_/);
    expect(res.fbCampaignId).toBeUndefined();
    expect(d.generateArticle).not.toHaveBeenCalled(); // the campaign already has its article

    // What Whop now holds: one launched campaign, one ad group optimizing the money event, two ads under it.
    expect(whopCampaigns()).toHaveLength(1);
    const wc = whopCampaigns()[0]!;
    expect(wc).toMatchObject({ title: expect.stringContaining('Whop Launch'), status: 'active', objective: 'leads', platform: 'meta' });
    expect(whopGroups()).toHaveLength(1);
    expect(whopGroups()[0]).toMatchObject({ budget_amount: 25, conversion_event: 'submit_application', ad_campaign: { id: wc.id } });
    const row = await load(id);
    expect(whopAds()).toHaveLength(2);
    for (const ad of whopAds()) {
      const ours = row.adSets[0]!.ads.find((a) => ad.url.endsWith(`/go/${a.redirectId}`))!;
      expect(ours).toBeTruthy();
      expect(ad.url).toBe(`https://${REDIRECT_HOST}/go/${ours.redirectId}`);
      expect(ad.headlines).toEqual([{ text: 'Compare SUV deals' }]);
      expect(ad.social_accounts).toEqual([{ id: PAGE }]);
      expect(ad.creatives).toHaveLength(1);
      expect(ad.call_to_action).toBe('learn_more');
    }
    // The creative bytes really reached Whop's storage.
    expect([...biz().ads.files.values()].every((f) => f.upload_status === 'ready' && f.received?.byteLength === PNG.length)).toBe(true);

    // Our rows: every Whop id persisted, no Facebook column touched.
    expect(row.status).toBe('ACTIVE');
    expect(row).toMatchObject({ whopCampaignId: wc.id, whopBizId: BIZ, redirectDomainHost: REDIRECT_HOST, fbCampaignId: null });
    expect(row.whopDeliveryStatus).toBe('processing');
    expect(row.adSets[0]!.whopAdGroupId).toBe(whopGroups()[0]!.id);
    expect(row.adSets[0]!.ads.map((a) => a.whopAdId).sort()).toEqual(whopAds().map((a) => a.id).sort());
    expect(row.adSets[0]!.ads.every((a) => a.whopFileId && a.fbAdId === null)).toBe(true);

    const audit = await withSystem((tx) => tx.auditLog.findFirst({ where: { entityId: id, action: 'campaign.launched' } }));
    expect(audit?.details).toMatchObject({ provider: 'WHOP', whopCampaignId: wc.id });
  });

  it('writes the edge config ACTIVE, with the Whop business, before Whop looks at the go-link', async () => {
    const id = await makeCampaign();
    const whopRequestsAtWrite: number[] = [];
    const d = deps({
      writeRedirectConfigs: vi.fn(async (entries) => {
        whopRequestsAtWrite.push(mock.requests.length);
        written.push(entries);
      }),
    });
    await launchCampaign(auth(), id, d);

    // The first write happened before Whop had been asked anything at all (its pixel check, and every ad creation, come later).
    expect(whopRequestsAtWrite[0]).toBe(0);
    const first = written[0]!;
    expect(first).toHaveLength(1);
    expect(first[0]!.config).toMatchObject({ campaignId: id, active: true, channel: `ch-wl-${suffix}`, articleUrl: expect.stringContaining(`/a/${SLUG}`), whop: { bizId: BIZ } });
    // Whop hides the Meta ad id and never gets our kaid macro: nothing may ever stand in for it.
    expect(first[0]!.config.expectedAdId).toBeUndefined();
    // After launch the status derives `active` itself, and the Whop block is still there (a resync must not drop it).
    expect(lastConfigs()[0]!.config).toMatchObject({ active: true, whop: { bizId: BIZ } });
    expect(lastConfigs()[0]!.config.expectedAdId).toBeUndefined();
  });

  it('is idempotent: launching a launched campaign creates nothing', async () => {
    const id = await makeCampaign();
    const first = await launchCampaign(auth(), id, deps());
    const requests = mock.requests.length;
    const second = await launchCampaign(auth(), id, deps());
    expect(second).toEqual({ status: 'ACTIVE', whopCampaignId: first.whopCampaignId });
    expect(mock.requests).toHaveLength(requests);
    expect(whopCampaigns()).toHaveLength(1);
  });

  it('two launches at once create exactly one Whop campaign (single-writer claim)', async () => {
    const id = await makeCampaign();
    const results = await Promise.allSettled([launchCampaign(auth(), id, deps()), launchCampaign(auth(), id, deps())]);
    expect(results.some((r) => r.status === 'fulfilled' && r.value.status === 'ACTIVE')).toBe(true);
    expect(whopCampaigns()).toHaveLength(1);
    expect(whopAds()).toHaveLength(1);
    for (const r of results) if (r.status === 'rejected') expect((r.reason as Error).message).toMatch(/already being launched/);
  });

  it('generates the article when the campaign has none', async () => {
    const id = await makeCampaign();
    await withSystem((tx) => tx.campaign.update({ where: { id }, data: { articleId: null } }));
    const d = deps({
      generateArticle: vi.fn(async () => {
        await withSystem((tx) => tx.campaign.update({ where: { id }, data: { articleId } }));
        return { slug: SLUG };
      }),
    });
    await launchCampaign(auth(), id, d);
    expect(d.generateArticle).toHaveBeenCalledTimes(1);
    expect((await load(id)).status).toBe('ACTIVE');
  });

  it('uses the campaign budget under CBO and the ad group budget under ABO, in USD', async () => {
    const cbo = await makeCampaign({ budgetMode: 'CAMPAIGN', dailyBudgetCents: 4250, adSets: [{ name: 'Only', dailyBudgetCents: null, ads: [{ name: 'A', uploadId }] }] });
    await launchCampaign(auth(), cbo, deps());
    expect(whopCampaigns()[0]).toMatchObject({ budget_optimization: 'ad_campaign', budget_amount: 42.5 });
    expect(whopGroups()[0]!.budget_amount).toBeNull();
  });
});

describe('preconditions', () => {
  it('refuses, before touching anything, when Whop Ads is switched off for the company', async () => {
    const id = await makeCampaign();
    await withSystem((tx) => tx.organization.update({ where: { id: orgId }, data: { whopEnabled: false } }));
    const d = deps();
    await expect(launchCampaign(auth(), id, d)).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/isn't switched on/) });
    expect(d.generateArticle).not.toHaveBeenCalled();
    expect(written).toHaveLength(0);
    expect(mock.requests).toHaveLength(0);
    expect((await load(id)).status).toBe('PROCESSING');
  });

  it('refuses when the connection is broken or gone, telling the buyer what to do', async () => {
    const id = await makeCampaign();
    await withSystem((tx) => tx.whopConnection.update({ where: { id: connectionId }, data: { status: 'BROKEN', lastError: 'key revoked' } }));
    await expect(launchCampaign(auth(), id, deps())).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/needs attention.*key revoked/s) });
    const orphan = await makeCampaign({ whopConnectionId: null });
    await withSystem((tx) => tx.campaign.update({ where: { id: orphan }, data: { whopBizId: 'biz_NOBODYHOME1' } }));
    await expect(launchCampaign(auth(), orphan, deps())).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/no longer connected/) });
    expect(mock.requests).toHaveLength(0);
  });

  it('finds the connection by business when its row was replaced (disconnect, then reconnect)', async () => {
    const id = await makeCampaign({ whopConnectionId: '00000000-0000-4000-8000-000000000000' });
    const res = await launchCampaign(auth(), id, deps());
    expect(res.status).toBe('ACTIVE');
  });

  it('refuses a campaign that is not complete, has no channel, or is not launchable yet', async () => {
    const incomplete = await makeCampaign({ adSets: [{ name: 'No ads', dailyBudgetCents: 2500, ads: [] }] });
    await expect(launchCampaign(auth(), incomplete, deps())).rejects.toMatchObject({ statusCode: 422 });
    const noChannel = await makeCampaign();
    await withSystem((tx) => tx.campaign.update({ where: { id: noChannel }, data: { channelId: null } }));
    await expect(launchCampaign(auth(), noChannel, deps())).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/no channel/i) });
    const draft = await makeCampaign({ status: 'DRAFT' });
    const d = deps();
    await expect(launchCampaign(auth(), draft, d)).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/draft/) });
    expect(d.generateArticle).not.toHaveBeenCalled();
    expect(mock.requests).toHaveLength(0);
  });

  it('refuses when the chosen Facebook page is no longer on the business', async () => {
    const id = await makeCampaign();
    await withSystem((tx) => tx.whopSocialAccount.deleteMany({ where: { connectionId } }));
    await expect(launchCampaign(auth(), id, deps())).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/page/i) });
    await withSystem((tx) => tx.whopSocialAccount.create({ data: { orgId, connectionId, whopId: PAGE, platform: 'facebook', name: 'Launch Page' } }));
  });

  it('never runs a Facebook test launch on a Whop campaign', async () => {
    const id = await makeCampaign();
    await expect(testLaunchCampaign(auth(), id)).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/Facebook campaigns/) });
    expect(mock.requests).toHaveLength(0);
  });
});

describe('the pixel preflight', () => {
  it('stops before creating anything when Whop cannot see its pixel, and rolls the edge config back', async () => {
    const id = await makeCampaign();
    biz().pixelForAnyUrl = PIXEL_MISSING;
    await expect(launchCampaign(auth(), id, deps())).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/pixel was not found/) });
    expect(whopCampaigns()).toHaveLength(0); // nothing was created
    expect(notSleeping.mock.calls.map((c) => c[0])).toEqual([4000, 8000, 12000, 16000, 20000, 25000]); // ~85 s of patience
    const row = await load(id);
    expect(row.status).toBe('PROCESSING');
    expect(row.whopIssues).toEqual([expect.objectContaining({ id: 'knn-launch', message: expect.stringMatching(/pixel/) })]);
    expect(lastConfigs()[0]!.config.active).toBe(false); // back to what PROCESSING means
  });

  it('keeps trying while the config reaches the edge, then goes ahead', async () => {
    const id = await makeCampaign();
    biz().pixelForAnyUrl = PIXEL_MISSING;
    let waits = 0;
    const res = await launchCampaign(
      auth(),
      id,
      deps({
        sleep: async () => {
          waits += 1;
          if (waits === 2) biz().pixelForAnyUrl = PIXEL_OK;
        },
      }),
    );
    expect(res.status).toBe('ACTIVE');
    expect(waits).toBe(2);
  });

  it('says the page could not be loaded when Whop could not reach it', async () => {
    const id = await makeCampaign();
    biz().pixelForAnyUrl = { ...PIXEL_MISSING, reachable: false };
    await expect(launchCampaign(auth(), id, deps())).rejects.toMatchObject({ message: expect.stringMatching(/could not load/) });
  });

  it('steps aside when Whop\'s own checker is down (creating the ad runs the same check)', async () => {
    const id = await makeCampaign();
    mock.failures.push({ status: 503 });
    const res = await launchCampaign(auth(), id, deps());
    expect(res.status).toBe('ACTIVE');
  });
});

describe('when Whop stops a launch', () => {
  it('reports Whop\'s own words for a missing payment method, keeps the draft, and resumes later without duplicates', async () => {
    const id = await makeCampaign();
    biz().payment = { primary: null, backup: null };
    await expect(launchCampaign(auth(), id, deps())).rejects.toMatchObject({
      statusCode: 409,
      message: 'Whop would not launch this campaign: Connect an ads payment method before launching',
    });
    let row = await load(id);
    expect(row.status).toBe('PROCESSING'); // the claim was given back
    expect(row.whopCampaignId).toMatch(/^adcamp_/); // and what Whop holds is remembered
    expect(row.whopIssues).toEqual([expect.objectContaining({ message: expect.stringMatching(/payment method/) })]);
    expect(lastConfigs()[0]!.config.active).toBe(false);
    expect(whopCampaigns()).toHaveLength(1);
    expect(whopCampaigns()[0]!.status).toBe('draft'); // nothing spent

    const notified = vi.spyOn(console, 'log');
    // The buyer fixes it in Whop and launches again: same objects, now live.
    biz().payment = { primary: { type: 'card', id: 'payt_1', card_brand: 'visa', last4: '4242' }, backup: null } as never;
    const res = await launchCampaign(auth(), id, deps());
    notified.mockRestore();
    expect(res.status).toBe('ACTIVE');
    expect(res.whopCampaignId).toBe(row.whopCampaignId);
    expect(whopCampaigns()).toHaveLength(1);
    expect(whopGroups()).toHaveLength(1);
    expect(whopAds()).toHaveLength(1);
    expect([...biz().ads.files.values()]).toHaveLength(1); // the creative was not uploaded twice
    row = await load(id);
    expect(row.status).toBe('ACTIVE');
    expect(row.whopIssues).toEqual([]); // the stale launch error is gone
  });

  it('resumes after a failure mid-way without re-creating or re-uploading what exists', async () => {
    const id = await makeCampaign({ adSets: [{ name: 'Set', dailyBudgetCents: 2500, ads: [{ name: 'Good', uploadId }, { name: 'Broken', uploadId: missingUploadId }] }] });
    await expect(launchCampaign(auth(), id, deps())).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/"Broken".*missing on the server/) });
    expect(whopCampaigns()).toHaveLength(1);
    expect(whopGroups()).toHaveLength(1);
    expect(whopAds()).toHaveLength(1); // the good ad was created before the broken one failed
    const created = mock.requests.filter((r) => r.method === 'POST' && ['/ad_campaigns', '/ad_groups', '/ads', '/files'].includes(r.path)).length;
    expect(created).toBe(4); // campaign, group, file, ad

    await withSystem((tx) => tx.ad.updateMany({ where: { adSet: { campaignId: id }, name: 'Broken' }, data: { uploadId } }));
    const res = await launchCampaign(auth(), id, deps());
    expect(res.status).toBe('ACTIVE');
    expect(whopCampaigns()).toHaveLength(1);
    expect(whopGroups()).toHaveLength(1);
    expect(whopAds()).toHaveLength(2);
    expect([...biz().ads.files.values()]).toHaveLength(2); // one upload per ad, none repeated
  });

  it('marks the connection broken and explains it when Whop rejects the key', async () => {
    const id = await makeCampaign();
    mock.failures.push({ status: 401 }); // the first Whop call of the launch: the pixel preflight
    await expect(launchCampaign(auth(), id, deps())).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/rejected the API key/) });
    const conn = await withSystem((tx) => tx.whopConnection.findUniqueOrThrow({ where: { id: connectionId } }));
    expect(conn.status).toBe('BROKEN');
    expect((await load(id)).status).toBe('PROCESSING');
  });

  it('parks the campaign in BATCHED when Whop is rate-limiting, keeping what it built', async () => {
    const id = await makeCampaign();
    // The preflight consumes the first answer and steps aside; the campaign create gets the second.
    mock.failures.push({ status: 429, headers: { 'retry-after': '600' } }, { status: 429, headers: { 'retry-after': '600' } });
    const res = await launchCampaign(auth(), id, deps());
    expect(res.status).toBe('BATCHED');
    expect((await load(id)).status).toBe('BATCHED');
    // BATCHED is launchable again.
    expect((await launchCampaign(auth(), id, deps())).status).toBe('ACTIVE');
    expect(whopCampaigns()).toHaveLength(1);
  });

  it('rebuilds under new keys when Whop no longer knows the stored campaign (deleted in Whop)', async () => {
    const id = await makeCampaign();
    await withSystem((tx) => tx.campaign.update({ where: { id }, data: { whopCampaignId: 'adcamp_DeletedInWhop' } }));
    const res = await launchCampaign(auth(), id, deps());
    expect(res.status).toBe('ACTIVE');
    expect(res.whopCampaignId).not.toBe('adcamp_DeletedInWhop');
    expect(whopCampaigns()).toHaveLength(1);
    expect(whopAds()).toHaveLength(1);
    expect((await load(id)).whopKeyEpoch).toBe(1); // the rebuilt tree has keys of its own
  });

  it('does not launch again a campaign whose earlier activation landed but whose answer was lost', async () => {
    const id = await makeCampaign();
    const first = await launchCampaign(auth(), id, deps());
    // Simulate the lost answer: our row went back to PROCESSING although Whop has it active.
    await withSystem((tx) => tx.campaign.update({ where: { id }, data: { status: 'PROCESSING' } }));
    const patchesBefore = mock.requests.filter((r) => r.method === 'PATCH').length;
    const res = await launchCampaign(auth(), id, deps());
    expect(res).toEqual({ status: 'ACTIVE', whopCampaignId: first.whopCampaignId });
    expect(mock.requests.filter((r) => r.method === 'PATCH')).toHaveLength(patchesBefore); // no second activation
    expect(whopCampaigns()).toHaveLength(1);
  });
});

describe('pause, resume and budgets of a live Whop campaign', () => {
  it('pauses at Whop first, then locally, and stops routing paid clicks', async () => {
    const id = await makeCampaign();
    await launchCampaign(auth(), id, deps());
    const wcId = whopCampaigns()[0]!.id;

    const paused = await setCampaignActive(auth(), id, false, { writeRedirectConfigs: deps().writeRedirectConfigs });
    expect(paused).toMatchObject({ id, status: 'PAUSED' });
    expect(whopCampaigns()[0]!.status).toBe('paused');
    expect((await load(id)).status).toBe('PAUSED');
    expect(lastConfigs()[0]!.config).toMatchObject({ active: false, whop: { bizId: BIZ } });
    expect(mock.requests.some((r) => r.method === 'POST' && r.path === `/ad_campaigns/${wcId}/pause`)).toBe(true);

    const resumed = await setCampaignActive(auth(), id, true, { writeRedirectConfigs: deps().writeRedirectConfigs });
    expect(resumed.status).toBe('ACTIVE');
    expect(whopCampaigns()[0]!.status).toBe('active');
    expect(lastConfigs()[0]!.config.active).toBe(true);
  });

  it('leaves our status alone when Whop refuses the pause (it must never say paused while Whop spends)', async () => {
    const id = await makeCampaign();
    await launchCampaign(auth(), id, deps());
    mock.failures.push({ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 });
    await expect(setCampaignActive(auth(), id, false, { writeRedirectConfigs: deps().writeRedirectConfigs })).rejects.toMatchObject({ statusCode: 502 });
    expect((await load(id)).status).toBe('ACTIVE');
    expect(whopCampaigns()[0]!.status).toBe('active');
  });

  it('takes "already paused in Whop" as done', async () => {
    const id = await makeCampaign();
    await launchCampaign(auth(), id, deps());
    biz().ads.campaigns.get(whopCampaigns()[0]!.id)!.status = 'paused'; // paused in Whop's own dashboard
    const res = await setCampaignActive(auth(), id, false, { writeRedirectConfigs: deps().writeRedirectConfigs });
    expect(res.status).toBe('PAUSED');
  });

  it('only acts on an active or paused campaign and on its owner\'s campaign', async () => {
    const id = await makeCampaign();
    await expect(setCampaignActive(auth(), id, true, { writeRedirectConfigs: deps().writeRedirectConfigs })).rejects.toMatchObject({ statusCode: 409 });
    const stranger: AuthContext = { ...auth(), userId: '00000000-0000-4000-8000-000000000001' };
    await expect(setCampaignActive(stranger, id, false, { writeRedirectConfigs: deps().writeRedirectConfigs })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('edits the ad group budget of a single-ad-set ABO campaign, in USD, with no Facebook floor', async () => {
    const id = await makeCampaign();
    await launchCampaign(auth(), id, deps());
    const out = await updateCampaignBudget(auth(), id, { dailyBudgetCents: 150 }); // $1.50: under Facebook's $2 floor, fine here
    expect(out).toEqual({ id, dailyBudgetCents: 150 });
    expect(whopGroups()[0]!.budget_amount).toBe(1.5);
    expect((await load(id)).adSets[0]!.dailyBudgetCents).toBe(150);
    const audit = await withSystem((tx) => tx.auditLog.findFirst({ where: { entityId: id, action: 'campaign.budget_updated' } }));
    expect(audit?.details).toMatchObject({ provider: 'WHOP', fromCents: 2500, toCents: 150 });
    // The same number again is a no-op: no Whop write.
    const writes = mock.requests.filter((r) => r.method === 'PATCH').length;
    await updateCampaignBudget(auth(), id, { dailyBudgetCents: 150 });
    expect(mock.requests.filter((r) => r.method === 'PATCH')).toHaveLength(writes);
  });

  it('edits the campaign budget under CBO', async () => {
    const id = await makeCampaign({ budgetMode: 'CAMPAIGN', dailyBudgetCents: 4000, adSets: [{ name: 'Only', dailyBudgetCents: null, ads: [{ name: 'A', uploadId }] }] });
    await launchCampaign(auth(), id, deps());
    await updateCampaignBudget(auth(), id, { dailyBudgetCents: 6000 });
    expect(whopCampaigns()[0]!.budget_amount).toBe(60);
    expect((await load(id)).dailyBudgetCents).toBe(6000);
    await expect(updateAdSetBudget(auth(), id, (await load(id)).adSets[0]!.id, { dailyBudgetCents: 1000 })).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/CBO/) });
  });

  it('edits one ad set of a multi-ad-set ABO campaign and refuses the ambiguous campaign-level edit', async () => {
    const id = await makeCampaign({
      adSets: [
        { name: 'A', dailyBudgetCents: 2000, ads: [{ name: 'A1', uploadId }] },
        { name: 'B', dailyBudgetCents: 3000, ads: [{ name: 'B1', uploadId }] },
      ],
    });
    await launchCampaign(auth(), id, deps());
    await expect(updateCampaignBudget(auth(), id, { dailyBudgetCents: 5000 })).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/individually/) });
    const row = await load(id);
    const b = row.adSets.find((s) => s.name === 'B')!;
    await updateAdSetBudget(auth(), id, b.id, { dailyBudgetCents: 3500 });
    expect(whopGroups().find((g) => g.id === b.whopAdGroupId)!.budget_amount).toBe(35);
    expect(whopGroups().find((g) => g.id !== b.whopAdGroupId)!.budget_amount).toBe(20); // the other is untouched
    await expect(updateAdSetBudget(auth(), id, '00000000-0000-4000-8000-0000000000aa', { dailyBudgetCents: 100 })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('refuses a budget that is not a whole number of cents, and a budget edit on a draft', async () => {
    const id = await makeCampaign();
    await expect(updateCampaignBudget(auth(), id, { dailyBudgetCents: 0 })).rejects.toMatchObject({ statusCode: 422 });
    await expect(updateCampaignBudget(auth(), id, { dailyBudgetCents: 12.5 })).rejects.toMatchObject({ statusCode: 422 });
    await expect(updateCampaignBudget(auth(), id, { dailyBudgetCents: 500 })).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('relaunch', () => {
  it('pauses the old Whop campaign, builds a fresh one with the current config and reuses the uploaded creatives', async () => {
    const id = await makeCampaign();
    await launchCampaign(auth(), id, deps());
    const old = whopCampaigns()[0]!;
    const oldFile = (await load(id)).adSets[0]!.ads[0]!.whopFileId;

    const res = await relaunchCampaign(auth(), id, deps());
    expect(res.status).toBe('ACTIVE');
    expect(res.whopCampaignId).not.toBe(old.id);
    expect(whopCampaigns()).toHaveLength(2);
    expect(biz().ads.campaigns.get(old.id)!.status).toBe('paused'); // the stale one stops delivering
    const row = await load(id);
    expect(row.whopCampaignId).toBe(res.whopCampaignId);
    expect(row.adSets[0]!.ads[0]!.whopFileId).toBe(oldFile); // not uploaded again
    expect([...biz().ads.files.values()]).toHaveLength(1);
    expect(row.status).toBe('ACTIVE');
  });
});

describe('taking a half-launched campaign back to a draft', () => {
  it('forgets the Whop ids and deletes the Whop campaign', async () => {
    const id = await makeCampaign();
    biz().payment = { primary: null, backup: null };
    await expect(launchCampaign(auth(), id, deps())).rejects.toBeTruthy(); // built, but Whop refused to launch
    expect(whopCampaigns()).toHaveLength(1);

    const reopened = await reopenCampaign(auth(), id);
    expect(reopened.status).toBe('DRAFT');
    expect(reopened.whopCampaignId).toBeNull();
    expect(whopCampaigns()).toHaveLength(0); // deleted at Whop (cascades to its groups and ads)
    expect(whopAds()).toHaveLength(0);
    const row = await load(id);
    expect(row.adSets[0]!.whopAdGroupId).toBeNull();
    expect(row.adSets[0]!.ads[0]).toMatchObject({ whopAdId: null, whopFileId: null });
  });

  it('builds the next tree under new idempotency keys, so Whop cannot replay the one that was discarded', async () => {
    const id = await makeCampaign();
    biz().payment = { primary: null, backup: null };
    await expect(launchCampaign(auth(), id, deps())).rejects.toBeTruthy();
    const discarded = (await load(id)).whopCampaignId!;
    await reopenCampaign(auth(), id);
    expect(whopCampaigns()).toHaveLength(0);
    expect((await load(id)).whopKeyEpoch).toBe(1);

    // Edited, re-approved, launched again within Whop's 24 h idempotency window.
    biz().payment = { primary: { type: 'card', id: 'payt_1', card_brand: 'visa', last4: '4242' }, backup: null } as never;
    await withSystem((tx) => tx.campaign.update({ where: { id }, data: { status: 'PROCESSING', channelId: channelRef } }));
    const res = await launchCampaign(auth(), id, deps());
    expect(res.status).toBe('ACTIVE');
    expect(res.whopCampaignId).not.toBe(discarded); // a fresh campaign, not the deleted one handed back
    expect(whopCampaigns()).toHaveLength(1);
    expect(whopAds()).toHaveLength(1);
  });

  it('still reopens when Whop cannot be reached, and says which Whop campaign to delete by hand', async () => {
    const id = await makeCampaign();
    biz().payment = { primary: null, backup: null };
    await expect(launchCampaign(auth(), id, deps())).rejects.toBeTruthy();
    const whopId = (await load(id)).whopCampaignId!;
    await withSystem((tx) => tx.whopConnection.delete({ where: { id: connectionId } })); // no way to reach Whop

    const reopened = await reopenCampaign(auth(), id);
    expect(reopened.status).toBe('DRAFT');
    expect(reopened.whopCampaignId).toBeNull(); // our rows are clean either way
    const audit = await withSystem((tx) => tx.auditLog.findFirst({ where: { entityId: id, action: 'whop.campaign_orphaned' } }));
    expect(audit?.details).toMatchObject({ whopCampaignId: whopId });

    // restore the connection for the remaining tests
    const conn = await withSystem((tx) =>
      tx.whopConnection.create({ data: { orgId, userId: buyerId, bizId: BIZ, label: 'Launch Biz', apiKeyEnc: encryptToken(KEY), apiKeyLast4: KEY.slice(-4), apiVersionDate: env.WHOP_API_VERSION_DATE, status: 'ACTIVE' } }),
    );
    connectionId = conn.id;
    await withSystem((tx) => tx.whopSocialAccount.create({ data: { orgId, connectionId, whopId: PAGE, platform: 'facebook', name: 'Launch Page' } }));
  });
});

describe('the activation is never taken at its word', () => {
  it('finishes a launch whose activation landed but whose answer was lost (the client retries into an already-live campaign)', async () => {
    const id = await makeCampaign();
    mock.loseResponses.push({ method: 'PATCH', path: /^\/ad_campaigns\/adcamp_/ });
    const res = await launchCampaign(auth(), id, deps());
    expect(res.status).toBe('ACTIVE');
    expect(whopCampaigns()).toHaveLength(1);
    expect(whopCampaigns()[0]!.status).toBe('active');
    // The retry happened and was refused ("only a draft can be launched"): that refusal was checked against Whop, not believed.
    expect(mock.requests.filter((r) => r.method === 'PATCH').length).toBeGreaterThanOrEqual(2);
    const row = await load(id);
    expect(row.status).toBe('ACTIVE');
    expect(row.whopIssues).toEqual([]);
    expect(lastConfigs()[0]!.config.active).toBe(true);
  });

  it('does NOT give the claim back, or switch the edge off, when it cannot tell whether Whop launched it', async () => {
    const id = await makeCampaign();
    // After the activation is lost, every retry of it AND every read of the campaign fails.
    mock.loseResponses.push({ method: 'PATCH', path: /^\/ad_campaigns\/adcamp_/, after: () => mock.failures.push(...Array.from({ length: 9 }, () => ({ status: 503 }))) });
    await expect(launchCampaign(auth(), id, deps())).rejects.toMatchObject({ statusCode: 502, message: expect.stringMatching(/did not confirm/) });
    mock.failures.length = 0;
    const row = await load(id);
    expect(biz().ads.campaigns.get(row.whopCampaignId!)!.status).toBe('active'); // Whop IS running it
    expect(row.status).toBe('LAUNCHING'); // so the claim was kept: nothing else may act on it, the status sync decides
    expect(lastConfigs()[0]!.config.active).toBe(true); // and paid clicks still reach the money page
  }, 30_000);

  it('saves the result with retries, and never gives the claim back once Whop is live', async () => {
    const id = await makeCampaign();
    let calls = 0;
    const flaky: typeof saveLaunched = async (...args) => {
      if (++calls === 1) throw new Error('database hiccup');
      return saveLaunched(...args);
    };
    expect((await launchCampaign(auth(), id, deps({ saveLaunched: flaky }))).status).toBe('ACTIVE');
    expect(calls).toBe(2);
    expect((await load(id)).status).toBe('ACTIVE');

    const stuck = await makeCampaign();
    const down: typeof saveLaunched = async () => {
      throw new Error('database down');
    };
    await expect(launchCampaign(auth(), stuck, deps({ saveLaunched: down }))).rejects.toMatchObject({ statusCode: 502, message: expect.stringMatching(/do not launch it again/) });
    const row = await load(stuck);
    expect(biz().ads.campaigns.get(row.whopCampaignId!)!.status).toBe('active');
    expect(row.status).toBe('LAUNCHING');
    expect(lastConfigs()[0]!.config.active).toBe(true);

    // Even if it is put back (as a recovery that did not ask Whop would), the next launch recognises a LIVE Whop campaign
    // before anything else, and does not depend on the pixel preflight.
    await withSystem((tx) => tx.campaign.update({ where: { id: stuck }, data: { status: 'PROCESSING' } }));
    biz().pixelForAnyUrl = PIXEL_MISSING;
    const before = mock.requests.length;
    expect((await launchCampaign(auth(), stuck, deps())).status).toBe('ACTIVE');
    expect(mock.requests.slice(before).some((r) => r.path === '/events/validate_pixel')).toBe(false);
    expect((await load(stuck)).status).toBe('ACTIVE');
  });

  it('repairs a tree whose ad group was deleted in Whop by rebuilding it once, under new keys, and deleting what is left', async () => {
    const id = await makeCampaign({ adSets: [{ name: 'Set', dailyBudgetCents: 2500, ads: [{ name: 'Good', uploadId }, { name: 'Late', uploadId: missingUploadId }] }] });
    await expect(launchCampaign(auth(), id, deps())).rejects.toMatchObject({ statusCode: 409 }); // the second creative is missing
    const first = await load(id);
    const oldCampaign = first.whopCampaignId!;
    // Someone tidies up in Whop's dashboard: the ad group (and with it its ad) is gone.
    biz().ads.groups.delete(first.adSets[0]!.whopAdGroupId!);
    for (const a of [...biz().ads.ads.values()]) biz().ads.ads.delete(a.id);
    await withSystem((tx) => tx.ad.updateMany({ where: { adSet: { campaignId: id }, name: 'Late' }, data: { uploadId } }));

    const res = await launchCampaign(auth(), id, deps());
    expect(res.status).toBe('ACTIVE');
    expect(res.whopCampaignId).not.toBe(oldCampaign);
    expect(biz().ads.campaigns.has(oldCampaign)).toBe(false); // the damaged Whop campaign was deleted, not left behind
    expect(whopCampaigns()).toHaveLength(1);
    expect(whopGroups()).toHaveLength(1);
    expect(whopAds()).toHaveLength(2);
    expect((await load(id)).whopKeyEpoch).toBe(1);
  });
});

describe('controls on a campaign Whop is running', () => {
  it('pauses even after Whop Ads was switched off for the company (an emergency stop), and will not resume then', async () => {
    const id = await makeCampaign();
    await launchCampaign(auth(), id, deps());
    await withSystem((tx) => tx.organization.update({ where: { id: orgId }, data: { whopEnabled: false } }));
    const d = deps();
    expect((await setCampaignActive(auth(), id, false, { writeRedirectConfigs: d.writeRedirectConfigs })).status).toBe('PAUSED');
    expect(whopCampaigns()[0]!.status).toBe('paused');
    await expect(setCampaignActive(auth(), id, true, { writeRedirectConfigs: d.writeRedirectConfigs })).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/isn't switched on/) });
  });

  it('pauses a campaign Meta rejected: its other ads may still be running', async () => {
    const id = await makeCampaign();
    await launchCampaign(auth(), id, deps());
    await withSystem((tx) => tx.campaign.update({ where: { id }, data: { status: 'META_REJECTED' } }));
    const res = await setCampaignActive(auth(), id, false, { writeRedirectConfigs: deps().writeRedirectConfigs });
    expect(res.status).toBe('PAUSED');
    expect(whopCampaigns()[0]!.status).toBe('paused');
    await withSystem((tx) => tx.campaign.update({ where: { id }, data: { status: 'META_REJECTED' } }));
    await expect(setCampaignActive(auth(), id, true, { writeRedirectConfigs: deps().writeRedirectConfigs })).rejects.toMatchObject({ statusCode: 409 }); // resuming a rejected one is not allowed
  });

  it('sends only the amount on a budget edit: Whop allows changing a budget TYPE only before launch', async () => {
    const id = await makeCampaign();
    await launchCampaign(auth(), id, deps());
    await updateCampaignBudget(auth(), id, { dailyBudgetCents: 4000 });
    const patch = mock.requests.filter((r) => r.method === 'PATCH' && r.path.startsWith('/ad_groups/')).at(-1)!;
    expect(Object.keys(patch.body as object)).toEqual(['budget_amount']);
    expect((patch.body as { budget_amount: number }).budget_amount).toBe(40);
  });
});

describe('relaunch is strict about the old campaign', () => {
  it('changes nothing when the old campaign cannot be shown to be stopped, and works on the next try', async () => {
    const id = await makeCampaign();
    await launchCampaign(auth(), id, deps());
    const before = await load(id);
    mock.failures.push({ status: 500 }); // the pause is a keyless POST: never retried by the client
    await expect(relaunchCampaign(auth(), id, deps())).rejects.toMatchObject({ statusCode: 502 });
    const after = await load(id);
    expect(after).toMatchObject({ status: 'ACTIVE', whopCampaignId: before.whopCampaignId, whopKeyEpoch: before.whopKeyEpoch });
    expect(whopCampaigns()).toHaveLength(1); // no second campaign was built beside a possibly-running one
    expect(whopCampaigns()[0]!.status).toBe('active');

    const res = await relaunchCampaign(auth(), id, deps());
    expect(res.status).toBe('ACTIVE');
    expect(whopCampaigns()).toHaveLength(2);
    expect(biz().ads.campaigns.get(before.whopCampaignId!)!.status).toBe('paused');
  });

  it('treats an old campaign that is already paused or deleted in Whop as stopped', async () => {
    const id = await makeCampaign();
    await launchCampaign(auth(), id, deps());
    const old = (await load(id)).whopCampaignId!;
    biz().ads.campaigns.get(old)!.status = 'paused'; // paused in Whop's own dashboard: the keyless pause POST is refused, Whop says paused
    expect((await relaunchCampaign(auth(), id, deps())).status).toBe('ACTIVE');
    const again = (await load(id)).whopCampaignId!;
    biz().ads.campaigns.delete(again); // deleted in Whop
    expect((await relaunchCampaign(auth(), id, deps())).status).toBe('ACTIVE');
  });

  it('refuses a campaign that is mid-launch or finished', async () => {
    const id = await makeCampaign();
    for (const status of ['LAUNCHING', 'ARCHIVED'] as const) {
      await withSystem((tx) => tx.campaign.update({ where: { id }, data: { status } }));
      await expect(relaunchCampaign(auth(), id, deps())).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/cannot be relaunched/) });
    }
    expect(mock.requests).toHaveLength(0);
  });
});

describe('reopening always moves to a new key epoch', () => {
  it('even when a Whop create was lost before its id could be saved', async () => {
    const id = await makeCampaign(); // PROCESSING, no Whop id saved
    expect((await load(id)).whopKeyEpoch).toBe(0);
    await reopenCampaign(auth(), id);
    expect((await load(id)).whopKeyEpoch).toBe(1); // the edited draft will not get a replay of an old `knn-camp-<id>` create
  });
});
