import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma, withSystem } from '@knn/db';
import { AD_CLICK_EVENT_NAME, ROLES, USER_STATUS } from '@knn/shared';
import { type WhopAd, type WhopAdsApi, WhopApiError, createWhopClient, whopAdsApi } from '@knn/whop';
import { type MockWhop, startMockWhop } from '@knn/whop/testing';
import { allocateRevenueForCampaignDay } from './attribution.service.js';
import { type WhopStatsDeps, pullWhopStats } from './whop-stats.js';

const suffix = Date.now().toString(36);
const BIZ = 'biz_SPENDTEST01';
const KEY = 'whop_key_spend_test_88';
/** An IST business day and what falls inside it: [2026-09-28T18:30Z, 2026-09-29T18:30Z). */
const DAY = '2026-09-29';
const NEXT_DAY = '2026-09-30';
const AT_DAY = '2026-09-29T05:00:00Z';
const AT_NEXT_DAY = '2026-09-30T05:00:00Z';
const LAST_SECOND_OF_DAY_IST = '2026-09-29T18:29:30Z'; // 23:59:30 IST
const FIRST_SECOND_OF_NEXT_IST = '2026-09-29T18:30:10Z'; // 00:00:10 IST on the 30th

let mock: MockWhop;
let orgId = '';
let buyerId = '';
let connectionId = '';
/** Extra businesses (each with its own key) a test created, by biz id. */
const keyOfBiz = new Map<string, string>([[BIZ, KEY]]);

const apiFor = (key: string) => whopAdsApi(createWhopClient({ apiKey: key, baseUrl: mock.baseUrl, limiter: false, jitter: 0, baseDelayMs: 1, maxRetries: 1, sleep: async () => undefined }));
const api = () => apiFor(KEY);
const deps = (over: WhopStatsDeps = {}): WhopStatsDeps => ({
  enabled: () => true,
  // Only this test's businesses are served: the scan is global.
  adsFor: (conn) => {
    if (conn.orgId !== orgId) throw new Error('not this test’s business');
    return apiFor(keyOfBiz.get(conn.bizId) ?? KEY);
  },
  getRate: async (_tx, _day, currency) => (currency === 'EUR' ? 1.1 : 1),
  rand: () => 0,
  ...over,
});

interface Tree {
  campaignId: string;
  whopCampaignId: string;
  whopGroupId: string;
  whopAdIds: string[];
  adIds: string[];
}

async function launchedCampaign(ads = 2, status: 'ACTIVE' | 'PAUSED' | 'META_REJECTED' | 'ARCHIVED' | 'PROCESSING' = 'ACTIVE'): Promise<Tree> {
  const a = api();
  const camp = await a.createCampaign({ account_id: BIZ, title: `Spend ${Math.random()}`, platform: 'meta', objective: 'leads', idempotencyKey: randomUUID() });
  const group = await a.createAdGroup({ ad_campaign_id: camp.id, title: 'g', budget_amount: 25, conversion_location: 'website', conversion_event: 'submit_application', optimization_goal: 'conversions', idempotencyKey: randomUUID() });
  const whopAds: WhopAd[] = [];
  for (let i = 0; i < ads; i++) {
    whopAds.push(await a.createAd({ ad_group_id: group.id, title: `Ad ${i}`, url: 'https://whop.com/', headlines: [{ text: 'h' }], primary_texts: [{ text: 'p' }], idempotencyKey: randomUUID() }));
  }
  const c = await withSystem((tx) =>
    tx.campaign.create({
      data: {
        orgId,
        buyerId,
        name: `Spend ${camp.id}`,
        status,
        adProvider: 'WHOP',
        whopCampaignId: camp.id,
        whopBizId: BIZ,
        whopConnectionId: connectionId,
        keywords: [],
        adSets: {
          create: [
            {
              orgId,
              name: 'Set',
              whopAdGroupId: group.id,
              countries: ['US'],
              ads: { create: whopAds.map((w, i) => ({ orgId, name: `Ad ${i}`, headline: 'h', primaryText: 'p', redirectId: `sp-${suffix}-${randomUUID().slice(0, 8)}`, whopAdId: w.id })) },
            },
          ],
        },
      },
      include: { adSets: { include: { ads: true } } },
    }),
  );
  return { campaignId: c.id, whopCampaignId: camp.id, whopGroupId: group.id, whopAdIds: whopAds.map((w) => w.id), adIds: c.adSets[0]!.ads.map((x) => x.id) };
}

/** Another Whop business (its own connection row, key and mock state) with one launched campaign that delivered on DAY. */
async function otherBusiness(n: number, connId?: string): Promise<{ bizId: string; campaignId: string; adId: string }> {
  const bizId = `biz_SPENDX${n}${suffix}`.slice(0, 24);
  const apiKey = `whop_key_spend_x_${n}_${suffix}`;
  mock.addBusiness({ bizId, apiKey, title: `Spend X${n}` });
  keyOfBiz.set(bizId, apiKey);
  const a = apiFor(apiKey);
  const camp = await a.createCampaign({ account_id: bizId, title: `X${n}`, platform: 'meta', objective: 'leads', idempotencyKey: randomUUID() });
  const group = await a.createAdGroup({ ad_campaign_id: camp.id, title: 'g', budget_amount: 25, conversion_location: 'website', conversion_event: 'submit_application', optimization_goal: 'conversions', idempotencyKey: randomUUID() });
  const ad = await a.createAd({ ad_group_id: group.id, title: 'Ad', url: 'https://whop.com/', headlines: [{ text: 'h' }], primary_texts: [{ text: 'p' }], idempotencyKey: randomUUID() });
  mock.setStats(bizId, ad.id, { at: AT_DAY, spend: 3, link_clicks: 3, impressions: 30 });
  const conn = await withSystem((tx) =>
    tx.whopConnection.create({ data: { ...(connId ? { id: connId } : {}), orgId, userId: buyerId, bizId, apiKeyEnc: 'enc', apiKeyLast4: '0000', apiVersionDate: '2026-09-29', status: 'ACTIVE' } }),
  );
  const c = await withSystem((tx) =>
    tx.campaign.create({
      data: {
        orgId,
        buyerId,
        name: `SpendX ${camp.id}`,
        status: 'ACTIVE',
        adProvider: 'WHOP',
        whopCampaignId: camp.id,
        whopBizId: bizId,
        whopConnectionId: conn.id,
        keywords: [],
        adSets: { create: [{ orgId, name: 'Set', whopAdGroupId: group.id, countries: ['US'], ads: { create: [{ orgId, name: 'Ad', headline: 'h', primaryText: 'p', redirectId: `spx-${suffix}-${randomUUID().slice(0, 8)}`, whopAdId: ad.id }] } }] },
      },
      include: { adSets: { include: { ads: true } } },
    }),
  );
  return { bizId, campaignId: c.id, adId: c.adSets[0]!.ads[0]!.id };
}

const stats = (adId: string, day = DAY) => withSystem((tx) => tx.adStatsDaily.findUnique({ where: { adId_day: { adId, day } } }));
const ownEvent = (t: Tree, adIndex: number, at: string) =>
  withSystem((tx) =>
    tx.conversionEvent.create({
      data: { orgId, campaignId: t.campaignId, adId: t.adIds[adIndex]!, clickId: `tx-${randomUUID()}`, pixelFbId: '', eventName: AD_CLICK_EVENT_NAME, eventTime: new Date(at), createdAt: new Date(at), provider: 'whop', status: 'sent' },
    }),
  );

beforeAll(async () => {
  mock = await startMockWhop();
  await withSystem(async (tx) => {
    const org = await tx.organization.create({ data: { name: 'Spend Co', slug: `spend-${suffix}`, whopEnabled: true } });
    orgId = org.id;
    buyerId = (await tx.user.create({ data: { orgId, email: `spend-${suffix}@a.com`, name: 'B', passwordHash: 'x', role: ROLES.MEDIA_BUYER, status: USER_STATUS.ACTIVE } })).id;
    connectionId = (await tx.whopConnection.create({ data: { orgId, userId: buyerId, bizId: BIZ, apiKeyEnc: 'enc', apiKeyLast4: '8888', apiVersionDate: '2026-09-29', status: 'ACTIVE', reportingCurrency: 'usd' } })).id;
  });
});

afterAll(async () => {
  await withSystem(async (tx) => {
    await tx.adRevenueDaily.deleteMany({ where: { orgId } });
    await tx.campaignRevenueDaily.deleteMany({ where: { orgId } });
    await tx.adStatsDaily.deleteMany({ where: { orgId } });
    await tx.conversionEvent.deleteMany({ where: { orgId } });
    await tx.campaign.deleteMany({ where: { orgId } });
    await tx.organization.deleteMany({ where: { id: orgId } });
  });
  await mock.close();
  await prisma.$disconnect();
});

beforeEach(async () => {
  mock.businesses.clear();
  mock.requests.length = 0;
  mock.failures.length = 0;
  keyOfBiz.clear();
  keyOfBiz.set(BIZ, KEY);
  mock.addBusiness({ bizId: BIZ, apiKey: KEY, title: 'Spend Biz' });
  await withSystem(async (tx) => {
    await tx.adRevenueDaily.deleteMany({ where: { orgId } });
    await tx.campaignRevenueDaily.deleteMany({ where: { orgId } });
    await tx.adStatsDaily.deleteMany({ where: { orgId } });
    await tx.conversionEvent.deleteMany({ where: { orgId } });
    await tx.campaign.deleteMany({ where: { orgId } });
    await tx.whopConnection.deleteMany({ where: { orgId, id: { not: connectionId } } });
    await tx.whopConnection.update({ where: { id: connectionId }, data: { status: 'ACTIVE', lastError: null } });
  });
});

describe('pullWhopStats', () => {
  it('writes each ad\'s day from Whop: link clicks, impressions, spend in cents and USD, and Whop\'s count of the money event when we recorded none', async () => {
    const t = await launchedCampaign(2);
    mock.setStats(BIZ, t.whopAdIds[0]!, { at: AT_DAY, spend: 12.34, link_clicks: 40, clicks: 55, impressions: 1000, results: 5, result_event: 'submit_application' });
    mock.setStats(BIZ, t.whopAdIds[1]!, { at: AT_DAY, spend: 7.5, link_clicks: 20, impressions: 600, results: 2, result_event: 'submit_application' });

    const res = await pullWhopStats(DAY, DAY, deps());
    expect(res.rows).toBe(2);
    expect(await stats(t.adIds[0]!)).toMatchObject({ campaignId: t.campaignId, impressions: 1000, clicks: 40, conversions: 5, spendMinor: 1234, spendUsdMinor: 1234, currency: 'USD' });
    expect(await stats(t.adIds[1]!)).toMatchObject({ impressions: 600, clicks: 20, conversions: 2, spendMinor: 750 });
    // The business day is read in Whop's terms: the window was asked for in IST.
    const asked = mock.requests.find((r) => r.method === 'GET' && r.path === '/ads')!;
    expect(asked.query.time_zone).toBe('Asia/Kolkata');
    expect(asked.query.stats_from).toBe('2026-09-28T18:30:00.000Z');
    expect(asked.query.stats_to).toBe('2026-09-29T18:29:59.000Z');
  });

  it('is idempotent and follows a figure Whop revises, but writes no row for an idle ad', async () => {
    const t = await launchedCampaign(2);
    mock.setStats(BIZ, t.whopAdIds[0]!, { at: AT_DAY, spend: 10, link_clicks: 10, impressions: 100, results: 1, result_event: 'submit_application' });
    await pullWhopStats(DAY, DAY, deps());
    await pullWhopStats(DAY, DAY, deps());
    expect(await withSystem((tx) => tx.adStatsDaily.count({ where: { campaignId: t.campaignId, day: DAY } }))).toBe(1); // the idle ad has no row
    expect(await stats(t.adIds[1]!)).toBeNull();

    // Whop revises the day (its attribution catches up): the row follows, up or down.
    const samples = mock.businesses.get(BIZ)!.ads.stats;
    samples[0]!.spend = 8;
    samples[0]!.submitted_applications = 3;
    await pullWhopStats(DAY, DAY, deps());
    expect(await stats(t.adIds[0]!)).toMatchObject({ spendMinor: 800, conversions: 3 });
  });

  it('never erases recorded spend: a day Whop reads as all zeroes is left alone, and a relaunched ad (new Whop id, no history) does not wipe the old one', async () => {
    const t = await launchedCampaign(1);
    mock.setStats(BIZ, t.whopAdIds[0]!, { at: AT_DAY, spend: 10, link_clicks: 10, impressions: 100, results: 2, result_event: 'submit_application' });
    await pullWhopStats(DAY, DAY, deps());
    expect(await stats(t.adIds[0]!)).toMatchObject({ spendMinor: 1000, conversions: 2 });

    mock.businesses.get(BIZ)!.ads.stats.length = 0; // Whop now reports nothing for that day
    await pullWhopStats(DAY, DAY, deps());
    expect(await stats(t.adIds[0]!)).toMatchObject({ spendMinor: 1000, impressions: 100, conversions: 2 });

    // A relaunch: our ad row now points at a NEW Whop ad, which has no history for DAY. The old figures stay.
    const fresh = await api().createAd({ ad_group_id: t.whopGroupId, title: 'Relaunched', url: 'https://whop.com/', headlines: [{ text: 'h' }], primary_texts: [{ text: 'p' }], idempotencyKey: randomUUID() });
    await withSystem((tx) => tx.ad.update({ where: { id: t.adIds[0]! }, data: { whopAdId: fresh.id } }));
    await pullWhopStats(DAY, DAY, deps());
    expect(await stats(t.adIds[0]!)).toMatchObject({ spendMinor: 1000, impressions: 100, conversions: 2 });

    // What the new ad delivers lands on the day it happened; the old day is still intact.
    mock.setStats(BIZ, fresh.id, { at: AT_NEXT_DAY, spend: 4, link_clicks: 4, impressions: 40 });
    await pullWhopStats(DAY, NEXT_DAY, deps());
    expect(await stats(t.adIds[0]!, DAY)).toMatchObject({ spendMinor: 1000 });
    expect(await stats(t.adIds[0]!, NEXT_DAY)).toMatchObject({ spendMinor: 400 });
  });

  it('never erases recorded spend on a day we hold conversions for, either: OUR events must not make an idle Whop day look reported', async () => {
    const t = await launchedCampaign(1);
    mock.setStats(BIZ, t.whopAdIds[0]!, { at: AT_DAY, spend: 10, link_clicks: 10, impressions: 100 });
    await ownEvent(t, 0, AT_DAY);
    await pullWhopStats(DAY, DAY, deps());
    expect(await stats(t.adIds[0]!)).toMatchObject({ spendMinor: 1000, impressions: 100, clicks: 10, conversions: 1 });

    // Relaunch: the row now points at a NEW Whop ad with no history for DAY, while our own events for DAY are still there
    // (and one more arrives late). Whop reports numeric zeroes for the new ad; the day's spend must survive.
    mock.businesses.get(BIZ)!.ads.stats.length = 0;
    const fresh = await api().createAd({ ad_group_id: t.whopGroupId, title: 'Relaunched', url: 'https://whop.com/', headlines: [{ text: 'h' }], primary_texts: [{ text: 'p' }], idempotencyKey: randomUUID() });
    await withSystem((tx) => tx.ad.update({ where: { id: t.adIds[0]! }, data: { whopAdId: fresh.id } }));
    await ownEvent(t, 0, AT_DAY);
    await pullWhopStats(DAY, DAY, deps());
    // Delivery is untouched; the conversion count (ours, and what revenue is weighed by) is current.
    expect(await stats(t.adIds[0]!)).toMatchObject({ spendMinor: 1000, spendUsdMinor: 1000, impressions: 100, clicks: 10, conversions: 2 });

    // And it stays that way on every later pass (each finalization re-pull revisits the last few days).
    await pullWhopStats(DAY, DAY, deps());
    expect(await stats(t.adIds[0]!)).toMatchObject({ spendMinor: 1000, impressions: 100, conversions: 2 });
  });

  it('keeps the revenue weights even before Whop reports anything: a conversions-only row, with no spend invented', async () => {
    const t = await launchedCampaign(2);
    // Whop has reported nothing for either ad yet (attribution and delivery lag), but we already recorded ad clicks.
    await ownEvent(t, 0, AT_DAY);
    await ownEvent(t, 0, AT_DAY);
    await ownEvent(t, 1, AT_DAY);
    const res = await pullWhopStats(DAY, DAY, deps());
    expect(res.rows).toBe(2);
    expect(await stats(t.adIds[0]!)).toMatchObject({ conversions: 2, spendMinor: 0, spendUsdMinor: 0, impressions: 0, clicks: 0 });
    expect(await stats(t.adIds[1]!)).toMatchObject({ conversions: 1, spendMinor: 0 });

    // Delivery arrives later: the same rows are completed, not duplicated.
    mock.setStats(BIZ, t.whopAdIds[0]!, { at: AT_DAY, spend: 6, link_clicks: 6, impressions: 60 });
    await pullWhopStats(DAY, DAY, deps());
    expect(await withSystem((tx) => tx.adStatsDaily.count({ where: { campaignId: t.campaignId, day: DAY } }))).toBe(2);
    expect(await stats(t.adIds[0]!)).toMatchObject({ conversions: 2, spendMinor: 600, impressions: 60 });
  });

  it('counts our events by the same day Analytics does (createdAt), and only for this campaign and this provider', async () => {
    const t = await launchedCampaign(1);
    const other = await launchedCampaign(1);
    mock.setStats(BIZ, t.whopAdIds[0]!, { at: AT_DAY, spend: 2, link_clicks: 2, impressions: 20 });
    await ownEvent(t, 0, AT_DAY);
    await ownEvent(t, 0, LAST_SECOND_OF_DAY_IST);
    await ownEvent(t, 0, FIRST_SECOND_OF_NEXT_IST); // the next IST day: not this one
    await ownEvent(other, 0, AT_DAY); // another campaign's
    await withSystem((tx) =>
      tx.conversionEvent.create({
        data: { orgId, campaignId: t.campaignId, adId: t.adIds[0]!, clickId: `fb-${randomUUID()}`, pixelFbId: 'px', eventName: AD_CLICK_EVENT_NAME, eventTime: new Date(AT_DAY), createdAt: new Date(AT_DAY), provider: 'facebook', status: 'sent' },
      }),
    ); // a Facebook-provider event: not ours to count
    await pullWhopStats(DAY, DAY, deps());
    expect((await stats(t.adIds[0]!))?.conversions).toBe(2);
  });

  it('assigns spend to the IST day it happened in (the edges of the day)', async () => {
    const t = await launchedCampaign(1);
    mock.setStats(BIZ, t.whopAdIds[0]!, { at: LAST_SECOND_OF_DAY_IST, spend: 3, link_clicks: 3, impressions: 30 });
    mock.setStats(BIZ, t.whopAdIds[0]!, { at: FIRST_SECOND_OF_NEXT_IST, spend: 4, link_clicks: 4, impressions: 40 });
    await pullWhopStats(DAY, NEXT_DAY, deps());
    expect(await stats(t.adIds[0]!, DAY)).toMatchObject({ spendMinor: 300, impressions: 30 });
    expect(await stats(t.adIds[0]!, NEXT_DAY)).toMatchObject({ spendMinor: 400, impressions: 40 });
  });

  it('weighs revenue by our OWN first-party conversions: every ad has its own go-link, so the count is exact', async () => {
    const t = await launchedCampaign(2);
    mock.setStats(BIZ, t.whopAdIds[0]!, { at: AT_DAY, spend: 10, link_clicks: 10, impressions: 100 }); // Whop has not attributed anything yet
    mock.setStats(BIZ, t.whopAdIds[1]!, { at: AT_DAY, spend: 10, link_clicks: 10, impressions: 100 });
    for (let i = 0; i < 3; i++) await ownEvent(t, 0, AT_DAY);
    await ownEvent(t, 1, AT_DAY);
    await ownEvent(t, 1, AT_NEXT_DAY); // another day: not counted

    await pullWhopStats(DAY, DAY, deps());
    expect((await stats(t.adIds[0]!))?.conversions).toBe(3);
    expect((await stats(t.adIds[1]!))?.conversions).toBe(1);
  });

  it('uses one scale per campaign-day: our own events for every ad when we have any, Whop\'s count only when we have none', async () => {
    const t = await launchedCampaign(2);
    // Day one: Whop credits ad 0 and nothing for ad 1, while our own events say the opposite. Ours are exact.
    mock.setStats(BIZ, t.whopAdIds[0]!, { at: AT_DAY, spend: 5, link_clicks: 5, impressions: 50, results: 4, result_event: 'submit_application' });
    mock.setStats(BIZ, t.whopAdIds[1]!, { at: AT_DAY, spend: 5, link_clicks: 5, impressions: 50 });
    for (let i = 0; i < 10; i++) await ownEvent(t, 1, AT_DAY);
    // Day two: nothing of ours, so Whop's own count is the fallback, for both ads.
    mock.setStats(BIZ, t.whopAdIds[0]!, { at: AT_NEXT_DAY, spend: 5, link_clicks: 5, impressions: 50, results: 6, result_event: 'submit_application' });
    mock.setStats(BIZ, t.whopAdIds[1]!, { at: AT_NEXT_DAY, spend: 1, link_clicks: 1, impressions: 10 });

    await pullWhopStats(DAY, NEXT_DAY, deps());
    expect((await stats(t.adIds[0]!, DAY))?.conversions).toBe(0);
    expect((await stats(t.adIds[1]!, DAY))?.conversions).toBe(10);
    expect((await stats(t.adIds[0]!, NEXT_DAY))?.conversions).toBe(6);
    expect((await stats(t.adIds[1]!, NEXT_DAY))?.conversions).toBe(0);
  });

  it('falls back to Whop\'s own count of the money event (submitted_applications), never to a result of some other event', async () => {
    const t = await launchedCampaign(2);
    // `results` counts whatever the ad group optimizes (here a view): only `submitted_applications` is our money event.
    mock.setStats(BIZ, t.whopAdIds[0]!, { at: AT_DAY, spend: 5, link_clicks: 5, impressions: 50, results: 99, result_event: 'view_content', submitted_applications: 3 });
    mock.setStats(BIZ, t.whopAdIds[1]!, { at: AT_DAY, spend: 5, link_clicks: 5, impressions: 50, results: 50, result_event: 'view_content' });
    await pullWhopStats(DAY, DAY, deps());
    expect((await stats(t.adIds[0]!))?.conversions).toBe(3);
    expect((await stats(t.adIds[1]!))?.conversions).toBe(0);
  });

  it('converts spend in another currency with that day\'s rate', async () => {
    const t = await launchedCampaign(1);
    mock.setStats(BIZ, t.whopAdIds[0]!, { at: AT_DAY, spend: 10, link_clicks: 1, impressions: 10, spend_currency: 'eur' });
    await pullWhopStats(DAY, DAY, deps());
    expect(await stats(t.adIds[0]!)).toMatchObject({ currency: 'EUR', spendMinor: 1000, spendUsdMinor: 1100 });
  });

  it('feeds the revenue split: a campaign\'s AdSense revenue is shared across its Whop ads by their conversions', async () => {
    const t = await launchedCampaign(2);
    mock.setStats(BIZ, t.whopAdIds[0]!, { at: AT_DAY, spend: 10, link_clicks: 10, impressions: 100, results: 3, result_event: 'submit_application' });
    mock.setStats(BIZ, t.whopAdIds[1]!, { at: AT_DAY, spend: 10, link_clicks: 10, impressions: 100, results: 1, result_event: 'submit_application' });
    await pullWhopStats(DAY, DAY, deps());
    await withSystem(async (tx) => {
      await tx.campaignRevenueDaily.create({ data: { orgId, campaignId: t.campaignId, channelRef: randomUUID(), day: DAY, afsClicks: 40, revenueMinor: 10_000, revenueUsdMinor: 10_000, currency: 'USD', suppressed: false } });
      await allocateRevenueForCampaignDay(tx, t.campaignId, DAY);
    });
    const rows = await withSystem((tx) => tx.adRevenueDaily.findMany({ where: { campaignId: t.campaignId, day: DAY } }));
    const byAd = new Map(rows.map((r) => [r.adId, r.allocatedUsdMinor]));
    expect(byAd.get(t.adIds[0]!)).toBe(7_500);
    expect(byAd.get(t.adIds[1]!)).toBe(2_500);
    expect([...byAd.values()].reduce((a, b) => a + b, 0)).toBe(10_000); // the split sums exactly
  });

  it('reads paused and rejected campaigns too (their spend still lands) and recent archived ones, not a half-launched one or one archived long ago', async () => {
    const paused = await launchedCampaign(1, 'PAUSED');
    const rejected = await launchedCampaign(1, 'META_REJECTED');
    const archived = await launchedCampaign(1, 'ARCHIVED');
    const halfLaunched = await launchedCampaign(1, 'PROCESSING'); // has Whop ids but never went live
    const longGone = await launchedCampaign(1, 'ARCHIVED');
    await withSystem((tx) => tx.$executeRaw`UPDATE campaigns SET updated_at = now() - interval '30 days' WHERE id = ${longGone.campaignId}::uuid`);
    for (const t of [paused, rejected, archived, halfLaunched, longGone]) mock.setStats(BIZ, t.whopAdIds[0]!, { at: AT_DAY, spend: 2, link_clicks: 2, impressions: 20 });
    mock.requests.length = 0;
    await pullWhopStats(DAY, DAY, deps());
    expect((await stats(paused.adIds[0]!))?.spendMinor).toBe(200);
    expect((await stats(rejected.adIds[0]!))?.spendMinor).toBe(200);
    // The archived campaign was archived just now, so its window still overlaps.
    expect((await stats(archived.adIds[0]!))?.spendMinor).toBe(200);
    expect(await stats(halfLaunched.adIds[0]!)).toBeNull();
    expect(await stats(longGone.adIds[0]!)).toBeNull();
    const asked = mock.requests.find((r) => r.method === 'GET' && r.path === '/ads')!;
    const ids = [asked.query.ad_campaign_ids].flat();
    expect(ids).toEqual(expect.arrayContaining([paused.whopCampaignId, rejected.whopCampaignId, archived.whopCampaignId]));
    expect(ids).not.toContain(halfLaunched.whopCampaignId);
    expect(ids).not.toContain(longGone.whopCampaignId);
  });

  it('asks Whop only about campaigns it still has: one deleted there cannot make the read refuse the others', async () => {
    const gone = await launchedCampaign(1);
    const kept = await launchedCampaign(1);
    mock.setStats(BIZ, kept.whopAdIds[0]!, { at: AT_DAY, spend: 2, link_clicks: 2, impressions: 20 });
    await api().deleteCampaign(gone.whopCampaignId);
    mock.requests.length = 0;

    const res = await pullWhopStats(DAY, DAY, deps());
    expect(res.rows).toBe(1);
    expect((await stats(kept.adIds[0]!))?.spendMinor).toBe(200);
    const asked = mock.requests.find((r) => r.method === 'GET' && r.path === '/ads')!;
    expect([asked.query.ad_campaign_ids].flat()).toEqual([kept.whopCampaignId]);
  });

  it('contains every failure: a rejected key breaks that connection, an outage skips it, neither throws', async () => {
    const t = await launchedCampaign(1);
    mock.setStats(BIZ, t.whopAdIds[0]!, { at: AT_DAY, spend: 2, link_clicks: 2, impressions: 20 });
    mock.failures.push({ status: 401 });
    await expect(pullWhopStats(DAY, DAY, deps())).resolves.toMatchObject({ rows: 0 });
    expect((await withSystem((tx) => tx.whopConnection.findUniqueOrThrow({ where: { id: connectionId } }))).status).toBe('BROKEN');
    // A broken connection is not read again: no request at all this time.
    mock.requests.length = 0;
    await pullWhopStats(DAY, DAY, deps());
    expect(mock.requests).toHaveLength(0);

    await withSystem((tx) => tx.whopConnection.update({ where: { id: connectionId }, data: { status: 'ACTIVE' } }));
    mock.failures.push({ status: 503 }, { status: 503 }, { status: 503 });
    await expect(pullWhopStats(DAY, DAY, deps())).resolves.toMatchObject({ rows: 0 });
    expect(await stats(t.adIds[0]!)).toBeNull();
    // An outage is nobody's fault: the connection stays ACTIVE.
    expect((await withSystem((tx) => tx.whopConnection.findUniqueOrThrow({ where: { id: connectionId } }))).status).toBe('ACTIVE');
  });

  it('breaks the connection when Whop says the key may not read the ads (403), naming why', async () => {
    const t = await launchedCampaign(1);
    mock.setStats(BIZ, t.whopAdIds[0]!, { at: AT_DAY, spend: 2, link_clicks: 2, impressions: 20 });
    mock.failures.push({ status: 403 });
    await pullWhopStats(DAY, DAY, deps());
    const conn = await withSystem((tx) => tx.whopConnection.findUniqueOrThrow({ where: { id: connectionId } }));
    expect(conn.status).toBe('BROKEN');
    expect(conn.lastError).toMatch(/permission/i);
    expect(await stats(t.adIds[0]!)).toBeNull();
  });

  it('stops starting new businesses once its time budget is spent, and says so by leaving them for the next run', async () => {
    const one = await otherBusiness(1);
    const two = await otherBusiness(2);
    let clock = 0;
    const res = await pullWhopStats(DAY, DAY, {
      ...deps({ budgetMs: 60_000, clock: () => clock }),
      // Reading the first business takes "ten minutes".
      adsFor: (conn) => {
        if (conn.orgId !== orgId) throw new Error('foreign');
        clock += 10 * 60_000;
        return apiFor(keyOfBiz.get(conn.bizId) ?? KEY);
      },
    });
    expect(res.rows).toBe(1);
    const written = [await stats(one.adId), await stats(two.adId)].filter(Boolean);
    expect(written).toHaveLength(1);
  });

  it('gives up for this pass after three businesses in a row fail to answer, instead of waiting on a dead Whop', async () => {
    const all = [await otherBusiness(1), await otherBusiness(2), await otherBusiness(3), await otherBusiness(4)];
    let asked = 0;
    const res = await pullWhopStats(DAY, DAY, {
      ...deps(),
      adsFor: (conn) => {
        if (conn.orgId !== orgId) throw new Error('foreign');
        asked += 1;
        const real = apiFor(keyOfBiz.get(conn.bizId) ?? KEY);
        return { ...real, listCampaigns: async () => { throw new WhopApiError('server', 'Whop is down', { status: 503 }); } } as WhopAdsApi;
      },
    });
    expect(res.rows).toBe(0);
    expect(asked).toBe(3); // the fourth business was never even tried
    for (const b of all) expect(await stats(b.adId)).toBeNull();
    // Nobody's fault: no connection is marked broken.
    expect(await withSystem((tx) => tx.whopConnection.count({ where: { orgId, status: 'BROKEN' } }))).toBe(0);
  });

  it('counts only businesses that failed to ANSWER towards "Whop is down": a rate limit is Whop answering, so the fourth is still read', async () => {
    const ids = [1, 2, 3, 4].map((n) => `0000000${n}-0000-4000-8000-000000000000`);
    for (const [i, id] of ids.entries()) await otherBusiness(i + 1, id);
    const behaviors = ['limited', 'limited', 'limited', 'ok'] as const;
    let call = 0;
    const res = await pullWhopStats(DAY, DAY, {
      ...deps(),
      adsFor: (conn) => {
        if (conn.orgId !== orgId) throw new Error('foreign');
        const behavior = behaviors[call++]!;
        const real = apiFor(keyOfBiz.get(conn.bizId) ?? KEY);
        if (behavior === 'ok') return real;
        return { ...real, listCampaigns: async () => { throw new WhopApiError('rate_limited', 'slow down', { status: 429 }); } } as WhopAdsApi;
      },
    });
    expect(call).toBe(4);
    expect(res.rows).toBe(1);
  });

  it('a run of failures is CONSECUTIVE: outage, outage, rejected key, outage does not stop the pass', async () => {
    const ids = [1, 2, 3, 4].map((n) => `0000000${n}-0000-4000-8000-000000000000`);
    for (const [i, id] of ids.entries()) await otherBusiness(i + 1, id);
    const behaviors = [503, 503, 401, 503] as const;
    let call = 0;
    await pullWhopStats(DAY, DAY, {
      ...deps(),
      adsFor: (conn) => {
        if (conn.orgId !== orgId) throw new Error('foreign');
        const status = behaviors[call++]!;
        const real = apiFor(keyOfBiz.get(conn.bizId) ?? KEY);
        const err = status === 401 ? new WhopApiError('auth', 'bad key', { status }) : new WhopApiError('server', 'Whop is down', { status });
        return { ...real, listCampaigns: async () => { throw err; } } as WhopAdsApi;
      },
    });
    expect(call).toBe(4); // the 401 showed Whop is up, so the count started again and the fourth was tried
  });

  it('gives every business its turn: a pass that stops early does not leave the same ones unread every time', async () => {
    const ids = [1, 2, 3, 4].map((n) => `0000000${n}-0000-4000-8000-000000000000`);
    const failing = [await otherBusiness(1, ids[0]), await otherBusiness(2, ids[1]), await otherBusiness(3, ids[2])];
    const healthy = await otherBusiness(4, ids[3]);
    expect(failing).toHaveLength(3);
    const run = async (rand: number): Promise<boolean> => {
      let healthyRead = false;
      await pullWhopStats(DAY, DAY, {
        ...deps({ rand: () => rand }),
        adsFor: (conn) => {
          if (conn.orgId !== orgId) throw new Error('foreign');
          const real = apiFor(keyOfBiz.get(conn.bizId) ?? KEY);
          if (conn.bizId === healthy.bizId) {
            healthyRead = true;
            return real;
          }
          return { ...real, listCampaigns: async () => { throw new WhopApiError('server', 'Whop is down', { status: 503 }); } } as WhopAdsApi;
        },
      });
      return healthyRead;
    };
    // In a fixed order the three failing businesses come first, the pass stops, and the healthy one is never read.
    expect(await run(0)).toBe(false);
    // Rotated starts reach it (and do not always: the point is that each business gets its turn over time).
    const reads: boolean[] = [];
    for (let k = 0; k < 20; k++) reads.push(await run(k / 20));
    expect(reads.some(Boolean)).toBe(true);
    expect(reads.some((r) => !r)).toBe(true);
  });

  it('does nothing while Whop Ads is off', async () => {
    const t = await launchedCampaign(1);
    mock.setStats(BIZ, t.whopAdIds[0]!, { at: AT_DAY, spend: 2, link_clicks: 2, impressions: 20 });
    mock.requests.length = 0; // forget building the fixture
    expect(await pullWhopStats(DAY, DAY, deps({ enabled: () => false }))).toEqual({ campaigns: 0, rows: 0 });
    expect(mock.requests).toHaveLength(0);
  });
});
