import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Whop Ads is off unless the flag is on, and @knn/config reads it once at import: set it first.
vi.hoisted(() => {
  process.env.WHOP_ADS_ENABLED = 'true';
});

import { WhopConnectionStatus, prisma, withSystem } from '@knn/db';
import { ROLES, USER_STATUS } from '@knn/shared';
import { type ClickRecord } from '../../lib/kv-sync.js';
import { type ConversionDeps, recordConversion, whopJobId } from './events.service.js';

const suffix = Date.now().toString(36);
const BIZ = 'biz_5kCAsGozVBmEm1';
let orgId = '';
let otherOrgId = '';
let buyerId = '';
let otherBuyerId = '';
let n = 0;

async function seedAd(): Promise<string> {
  const redirectId = randomUUID();
  await withSystem(async (tx) => {
    const campaign = await tx.campaign.create({ data: { orgId, buyerId, name: `wh ${n++}`, status: 'ACTIVE', keywords: [] } });
    const adSet = await tx.adSet.create({ data: { orgId, campaignId: campaign.id, name: 'set', pxeEvent: 'adclick' } });
    await tx.ad.create({ data: { orgId, adSetId: adSet.id, name: 'ad', headline: 'h', primaryText: 'p', redirectId } });
  });
  return redirectId;
}

const whopClick = (redirectId: string, over: Partial<NonNullable<ClickRecord['whop']>> = {}): ClickRecord => ({
  redirectId,
  fbclid: 'IwAR0x',
  ts: 1_790_000_000_000,
  fbp: 'fb.1.1790000000000.1234567890',
  clientIp: '203.0.113.9',
  whop: {
    bizId: BIZ,
    click: { campaignId: 'adcamp_ARRzXWlc8gt', adGroupId: 'adgrp_adGTsobtDlzz', adId: 'ad_I2YRNtEkImoX5qB', utm: { source: 'fb' } },
    landing: 'https://go.test/go/abc?waid=ad_I2YRNtEkImoX5qB&fbclid=IwAR0x',
    ...over,
  },
});

const deps = (click: ClickRecord | null, capi = vi.fn(async () => {}), whop = vi.fn(async () => {})): ConversionDeps & { capi: typeof capi; whop: typeof whop } => ({
  readClick: async () => click,
  enqueueDispatch: capi,
  enqueueWhopDispatch: whop,
  capi,
  whop,
});

const connect = (org: string, user: string, status: WhopConnectionStatus = WhopConnectionStatus.ACTIVE, bizId = BIZ) =>
  withSystem((tx) =>
    tx.whopConnection.create({ data: { orgId: org, userId: user, bizId, apiKeyEnc: 'enc', apiKeyLast4: '0001', apiVersionDate: '2026-09-29', status } }),
  );

beforeAll(async () => {
  await withSystem(async (tx) => {
    const org = await tx.organization.create({ data: { name: 'WH Co', slug: `wh-${suffix}` } });
    orgId = org.id;
    const other = await tx.organization.create({ data: { name: 'WH Other', slug: `who-${suffix}` } });
    otherOrgId = other.id;
    buyerId = (await tx.user.create({ data: { orgId, email: `wh-${suffix}@a.com`, name: 'B', passwordHash: 'x', role: ROLES.MEDIA_BUYER, status: USER_STATUS.ACTIVE } })).id;
    otherBuyerId = (await tx.user.create({ data: { orgId: otherOrgId, email: `who-${suffix}@a.com`, name: 'O', passwordHash: 'x', role: ROLES.MEDIA_BUYER, status: USER_STATUS.ACTIVE } })).id;
  });
});

beforeEach(async () => {
  await withSystem(async (tx) => {
    await tx.conversionEvent.deleteMany({ where: { orgId: { in: [orgId, otherOrgId] } } });
    await tx.whopConnection.deleteMany({ where: { orgId: { in: [orgId, otherOrgId] } } });
  });
});

afterAll(async () => {
  await withSystem(async (tx) => {
    await tx.conversionEvent.deleteMany({ where: { orgId: { in: [orgId, otherOrgId] } } });
    await tx.organization.deleteMany({ where: { id: { in: [orgId, otherOrgId] } } });
  });
  await prisma.$disconnect();
});

describe('whopJobId (BullMQ de-dupe key)', () => {
  it('is colon-free, because BullMQ rejects a custom job id containing ":"', () => {
    const id = '7c1f2e3a-0000-4444-8888-abcabcabcabc';
    expect(whopJobId(id)).toBe(`whop-${id}`);
    expect(whopJobId(id)).not.toContain(':');
  });
});

describe('recordConversion for a Whop click', () => {
  it('records a pending Whop event with what dispatch needs, and queues it for Whop only', async () => {
    const redirectId = await seedAd();
    await connect(orgId, buyerId);
    const d = deps(whopClick(redirectId));
    const res = await recordConversion({ clickId: 'w-1', clientUa: 'UA', url: 'https://articles.x/a/slug?t=secrettoken' }, d);
    expect(res).toEqual({ recorded: true, deduped: false, dispatched: true });

    const ev = await withSystem((tx) => tx.conversionEvent.findFirst({ where: { clickId: 'w-1' } }));
    expect(ev).toMatchObject({
      provider: 'whop',
      status: 'pending',
      pixelFbId: '', // no Facebook pixel is involved
      eventName: 'Search', // Analytics keys on the stored (Facebook) names, unchanged by the provider
      fbclid: 'IwAR0x',
      clientIp: '203.0.113.9',
      clientUa: 'UA',
      fbp: 'fb.1.1790000000000.1234567890',
      eventSourceUrl: 'https://articles.x/a/slug?t=secrettoken', // untouched: the Websites tab parses it (D30)
      providerContext: { bizId: BIZ, landing: 'https://go.test/go/abc?waid=ad_I2YRNtEkImoX5qB&fbclid=IwAR0x', click: { adId: 'ad_I2YRNtEkImoX5qB' } },
    });
    expect(ev!.clickTimeMs).toBe(BigInt(1_790_000_000_000));
    expect(d.whop).toHaveBeenCalledWith(ev!.id);
    expect(d.capi).not.toHaveBeenCalled();
  });

  it('records one row per funnel stage, each a Whop send, named the way Analytics counts them', async () => {
    const redirectId = await seedAd();
    await connect(orgId, buyerId);
    for (const stage of ['lander', 'search', 'adclick'] as const) await recordConversion({ clickId: 'w-funnel', stage }, deps(whopClick(redirectId)));
    const rows = await withSystem((tx) => tx.conversionEvent.findMany({ where: { clickId: 'w-funnel' }, orderBy: { createdAt: 'asc' } }));
    expect(rows.map((r) => [r.eventName, r.provider, r.status])).toEqual([
      ['ViewContent', 'whop', 'pending'],
      ['AddToCart', 'whop', 'pending'],
      ['Search', 'whop', 'pending'],
    ]);
  });

  it('is idempotent: a repeat does not queue a second send', async () => {
    const redirectId = await seedAd();
    await connect(orgId, buyerId);
    const d = deps(whopClick(redirectId));
    await recordConversion({ clickId: 'w-dup' }, d);
    expect(await recordConversion({ clickId: 'w-dup' }, d)).toEqual({ recorded: true, deduped: true, dispatched: false });
    expect(d.whop).toHaveBeenCalledTimes(1);
    expect(await withSystem((tx) => tx.conversionEvent.count({ where: { clickId: 'w-dup' } }))).toBe(1);
  });

  it('records but skips when the company has no live connection for that business', async () => {
    const redirectId = await seedAd();
    const d = deps(whopClick(redirectId));
    expect(await recordConversion({ clickId: 'w-noconn' }, d)).toEqual({ recorded: true, deduped: false, dispatched: false });
    expect(await withSystem((tx) => tx.conversionEvent.findFirst({ where: { clickId: 'w-noconn' } }))).toMatchObject({ provider: 'whop', status: 'skipped' });
    expect(d.whop).not.toHaveBeenCalled();
  });

  it('skips when the connection is broken (no point sending with a key Whop rejected)', async () => {
    const redirectId = await seedAd();
    await connect(orgId, buyerId, WhopConnectionStatus.BROKEN);
    await recordConversion({ clickId: 'w-broken' }, deps(whopClick(redirectId)));
    expect(await withSystem((tx) => tx.conversionEvent.findFirst({ where: { clickId: 'w-broken' } }))).toMatchObject({ status: 'skipped' });
  });

  it('never uses another company\'s connection, even for the same business id', async () => {
    const redirectId = await seedAd();
    await connect(otherOrgId, otherBuyerId);
    const d = deps(whopClick(redirectId));
    await recordConversion({ clickId: 'w-tenant' }, d);
    expect(await withSystem((tx) => tx.conversionEvent.findFirst({ where: { clickId: 'w-tenant' } }))).toMatchObject({ status: 'skipped' });
    expect(d.whop).not.toHaveBeenCalled();
  });

  it('skips a click whose business id is not a business id, and keeps the junk out of the row', async () => {
    const redirectId = await seedAd();
    await connect(orgId, buyerId);
    await recordConversion({ clickId: 'w-junk' }, deps(whopClick(redirectId, { bizId: '"); DROP TABLE x; --' })));
    const ev = await withSystem((tx) => tx.conversionEvent.findFirst({ where: { clickId: 'w-junk' } }));
    expect(ev).toMatchObject({ provider: 'whop', status: 'skipped', providerContext: { bizId: null } });
  });

  it('leaves a Facebook click exactly as it was: a CAPI row, queued for CAPI only', async () => {
    // No `whop` block on the click record → the Facebook path, even with Whop Ads switched on.
    const redirectId = randomUUID();
    let pixelRowId = '';
    await withSystem(async (tx) => {
      const conn = await tx.fbConnection.create({ data: { orgId, userId: buyerId, fbUserId: `fb-${suffix}`, accessTokenEnc: 'enc', tokenExpiresAt: new Date(Date.now() + 60 * 86_400_000) } });
      const acct = await tx.fbAdAccount.create({ data: { orgId, connectionId: conn.id, fbAccountId: `act_${suffix}`, name: 'A', currency: 'USD', timezone: 'Asia/Kolkata', status: '1' } });
      pixelRowId = (await tx.fbPixel.create({ data: { orgId, adAccountId: acct.id, fbPixelId: 'PX_FB1', name: 'P' } })).id;
      const campaign = await tx.campaign.create({ data: { orgId, buyerId, name: 'fb', status: 'ACTIVE', keywords: [], fbCampaignId: `fbc-${redirectId}`, adAccountId: acct.id } });
      const adSet = await tx.adSet.create({ data: { orgId, campaignId: campaign.id, name: 'set', pxeEvent: 'adclick', pixelId: pixelRowId } });
      await tx.ad.create({ data: { orgId, adSetId: adSet.id, name: 'ad', headline: 'h', primaryText: 'p', redirectId } });
    });
    const d = deps({ redirectId, fbclid: 'F', ts: 1 });
    await recordConversion({ clickId: 'w-fb' }, d);
    expect(await withSystem((tx) => tx.conversionEvent.findFirst({ where: { clickId: 'w-fb' } }))).toMatchObject({ provider: 'facebook', pixelFbId: 'PX_FB1', status: 'pending', providerContext: null });
    expect(d.capi).toHaveBeenCalledTimes(1);
    expect(d.whop).not.toHaveBeenCalled();
    await withSystem(async (tx) => {
      await tx.conversionEvent.deleteMany({ where: { orgId } });
      await tx.campaign.deleteMany({ where: { orgId, name: 'fb' } });
    });
  });
});
