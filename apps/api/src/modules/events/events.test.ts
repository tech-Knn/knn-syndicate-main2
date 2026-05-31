import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma, withSystem } from '@knn/db';
import { ROLES, USER_STATUS } from '@knn/shared';
import { type ClickRecord } from '../../lib/kv-sync.js';
import { type ConversionDeps, capiJobId, recordConversion } from './events.service.js';

const suffix = Date.now().toString(36);
let orgId = '';
let buyerId = '';
let connId = '';
let accountId = '';
let pixelRowId = '';
let n = 0;

/** Seed a campaign→adset→ad; returns the ad's redirectId (+ whether it has a pixel). */
async function seedAd(withPixel: boolean): Promise<string> {
  const redirectId = randomUUID();
  await withSystem(async (tx) => {
    const campaign = await tx.campaign.create({
      data: { orgId, buyerId, name: `cv ${n++}`, status: 'ACTIVE', keywords: [], fbCampaignId: `fbc-${redirectId}` },
    });
    const adSet = await tx.adSet.create({
      data: { orgId, campaignId: campaign.id, name: 'set', pxeEvent: 'search', pixelId: withPixel ? pixelRowId : null },
    });
    await tx.ad.create({
      data: { orgId, adSetId: adSet.id, name: 'ad', headline: 'h', primaryText: 'p', redirectId },
    });
  });
  return redirectId;
}

function deps(click: ClickRecord | null, enqueue: ReturnType<typeof vi.fn>): ConversionDeps {
  return { readClick: async () => click, enqueueDispatch: enqueue };
}

beforeAll(async () => {
  await withSystem(async (tx) => {
    const org = await tx.organization.create({ data: { name: 'CV Co', slug: `cv-${suffix}` } });
    orgId = org.id;
    buyerId = (await tx.user.create({ data: { orgId, email: `cv-${suffix}@a.com`, name: 'B', passwordHash: 'x', role: ROLES.MEDIA_BUYER, status: USER_STATUS.ACTIVE } })).id;
    connId = (await tx.fbConnection.create({ data: { orgId, userId: buyerId, fbUserId: 'fb', accessTokenEnc: 'enc', tokenExpiresAt: new Date(Date.now() + 60 * 86_400_000) } })).id;
    accountId = (await tx.fbAdAccount.create({ data: { orgId, connectionId: connId, fbAccountId: 'act_cv', name: 'Acct', currency: 'USD', timezone: 'Asia/Kolkata', status: '1' } })).id;
    pixelRowId = (await tx.fbPixel.create({ data: { orgId, adAccountId: accountId, fbPixelId: 'PX_999', name: 'Pixel' } })).id;
  });
});

beforeEach(async () => {
  await withSystem((tx) => tx.conversionEvent.deleteMany({ where: { orgId } }));
});

afterAll(async () => {
  await withSystem(async (tx) => {
    await tx.conversionEvent.deleteMany({ where: { orgId } });
    await tx.organization.deleteMany({ where: { id: orgId } });
  });
  await prisma.$disconnect();
});

describe('capiJobId (BullMQ de-dupe key)', () => {
  it('is colon-free — BullMQ rejects a custom job id containing ":"', () => {
    // Regression: `capi:${id}` throws "Custom Id cannot contain :" on bullmq >=5.7x,
    // which silently broke CAPI dispatch (every conversion beacon failed to enqueue).
    const id = '7c1f2e3a-0000-4444-8888-abcabcabcabc';
    expect(capiJobId(id)).toBe(`capi-${id}`);
    expect(capiJobId(id)).not.toContain(':');
  });
});

describe('recordConversion', () => {
  it('resolves the click → ad → pixel, records pending, and enqueues CAPI dispatch', async () => {
    const redirectId = await seedAd(true);
    const enqueue = vi.fn(async () => {});
    const res = await recordConversion(
      { clickId: 'tx-1', valueMinor: 5, currency: 'USD', clientIp: '1.2.3.4', clientUa: 'UA', url: 'https://articles.x/search' },
      deps({ redirectId, fbclid: 'FBCL1', ts: 1779950000000 }, enqueue),
    );
    expect(res).toEqual({ recorded: true, deduped: false, dispatched: true });

    const ev = await withSystem((tx) => tx.conversionEvent.findFirst({ where: { clickId: 'tx-1' } }));
    expect(ev).toMatchObject({
      pixelFbId: 'PX_999',
      eventName: 'Search', // default stage = adclick → Search (the main conversion)
      fbclid: 'FBCL1',
      valueMinor: 5,
      currency: 'USD',
      clientIp: '1.2.3.4',
      status: 'pending',
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(ev!.id);
  });

  it('is idempotent on click id — second call dedups, does not re-enqueue', async () => {
    const redirectId = await seedAd(true);
    const enqueue = vi.fn(async () => {});
    const d = deps({ redirectId, fbclid: 'X', ts: 1 }, enqueue);
    await recordConversion({ clickId: 'tx-dup' }, d);
    const second = await recordConversion({ clickId: 'tx-dup' }, d);
    expect(second).toEqual({ recorded: true, deduped: true, dispatched: false });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(await withSystem((tx) => tx.conversionEvent.count({ where: { clickId: 'tx-dup' } }))).toBe(1);
  });

  it('drops an unknown click (no KV record)', async () => {
    const enqueue = vi.fn(async () => {});
    const res = await recordConversion({ clickId: 'nope' }, deps(null, enqueue));
    expect(res).toEqual({ recorded: false, reason: 'unknown_click' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('records but skips dispatch when the ad set has no pixel (still a first-party signal)', async () => {
    const redirectId = await seedAd(false);
    const enqueue = vi.fn(async () => {});
    const res = await recordConversion({ clickId: 'tx-nopx' }, deps({ redirectId, ts: 1 }, enqueue));
    expect(res).toEqual({ recorded: true, deduped: false, dispatched: false });
    const ev = await withSystem((tx) => tx.conversionEvent.findFirst({ where: { clickId: 'tx-nopx' } }));
    expect(ev).toMatchObject({ pixelFbId: '', status: 'skipped' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('records the funnel: one click fires lander/search/adclick as distinct FB events', async () => {
    const redirectId = await seedAd(true);
    const enqueue = vi.fn(async () => {});
    const d = deps({ redirectId, fbclid: 'F', ts: 1 }, enqueue);
    await recordConversion({ clickId: 'tx-funnel', stage: 'lander' }, d);
    await recordConversion({ clickId: 'tx-funnel', stage: 'search' }, d);
    await recordConversion({ clickId: 'tx-funnel', stage: 'adclick' }, d);
    // The same stage again dedups (composite unique on clickId+eventName).
    await recordConversion({ clickId: 'tx-funnel', stage: 'adclick' }, d);
    const evs = await withSystem((tx) => tx.conversionEvent.findMany({ where: { clickId: 'tx-funnel' } }));
    expect(evs.map((e) => e.eventName).sort()).toEqual(['AddToCart', 'Search', 'ViewContent']);
    expect(enqueue).toHaveBeenCalledTimes(3); // 3 distinct events, the 4th deduped
  });
});
