import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma, withSystem } from '@knn/db';
import { ROLES, USER_STATUS } from '@knn/shared';
import type { AuthContext } from '../../middleware/authenticate.js';
import { getArticleUsage, getChannelUsage } from './platform.service.js';

const suffix = Date.now().toString(36);
let orgId = '';
let buyerId = '';
let articleId = '';
let campaignId = '';
let channelDbId = '';
const channelId = `usage-ch-${suffix}`;
const host = `usage-${suffix}.example.com`;

function buyerAuth(): AuthContext {
  return { userId: buyerId, orgId, role: ROLES.MEDIA_BUYER, status: USER_STATUS.ACTIVE };
}

beforeAll(async () => {
  await withSystem(async (tx) => {
    const org = await tx.organization.create({ data: { name: 'Usage Co', slug: `usage-${suffix}` } });
    orgId = org.id;
    buyerId = (await tx.user.create({ data: { orgId, email: `usage-${suffix}@a.com`, name: 'B', passwordHash: 'x', role: ROLES.MEDIA_BUYER, status: USER_STATUS.ACTIVE } })).id;
    const afs = await tx.googleConnection.create({ data: { accessTokenEnc: 'enc', tokenExpiresAt: new Date(Date.now() + 3_600_000), adsenseAccount: `acc-${suffix}`, adsenseAdClient: `adc-${suffix}`, afsPubId: `pub-${suffix}`, label: 'AFS', status: 'ACTIVE' } });
    const domain = await tx.domain.create({ data: { host, afsAccountId: afs.id, status: 'LIVE', verifyToken: `v-${suffix}` } });
    const channel = await tx.channel.create({ data: { channelId, domainId: domain.id, status: 'ASSIGNED' } });
    channelDbId = channel.id;
    const article = await tx.article.create({ data: { orgId, slug: `usage-article-${suffix}`, title: 'Usage Article', rawContent: 'raw', compliantContent: 'clean' } });
    articleId = article.id;
    const campaign = await tx.campaign.create({ data: { orgId, buyerId, name: `Usage Camp ${suffix}`, status: 'ACTIVE', keywords: ['x'], articleId } });
    campaignId = campaign.id;
    const offer = await tx.offer.create({ data: { orgId, campaignId, domainId: domain.id, weightPct: 100, kind: 'PAID', channelRef: channel.id } });
    // Two CONSECUTIVE held days (28 released, 29 active) → collapse to one active span;
    // plus a GAP day (31 released) → a second span.
    await tx.channelAssignment.createMany({
      data: [
        { orgId, channelRef: channel.id, campaignId, forDay: '2026-05-28', releasedAt: new Date() },
        { orgId, channelRef: channel.id, campaignId, forDay: '2026-05-29', releasedAt: null },
        { orgId, channelRef: channel.id, campaignId, forDay: '2026-05-31', releasedAt: new Date() },
      ],
    });
    await tx.offerRevenueDaily.create({ data: { orgId, offerId: offer.id, campaignId, channelRef: channel.id, day: '2026-05-29', revenueUsdMinor: 1234, afsClicks: 5 } });
  });
});

afterAll(async () => {
  await withSystem(async (tx) => {
    await tx.campaign.deleteMany({ where: { orgId } }); // cascades offers
    await tx.channelAssignment.deleteMany({ where: { orgId } });
    await tx.offerRevenueDaily.deleteMany({ where: { orgId } });
    await tx.article.deleteMany({ where: { orgId } });
    await tx.channel.deleteMany({ where: { channelId } });
    await tx.domain.deleteMany({ where: { host } });
    await tx.organization.deleteMany({ where: { id: orgId } });
  });
  await prisma.$disconnect();
});

describe('getChannelUsage', () => {
  it('resolves by AFS channel id, collapses days into spans, and attributes revenue', async () => {
    const u = await getChannelUsage(channelId);
    expect(u).not.toBeNull();
    expect(u!.channelId).toBe(channelId);
    expect(u!.host).toBe(host);
    // 28+29 collapse (consecutive) → one span; 31 (gap) → a second span.
    expect(u!.spans).toHaveLength(2);
    const active = u!.spans.find((s) => s.active)!;
    expect(active.firstDay).toBe('2026-05-28');
    expect(active.lastDay).toBe('2026-05-29');
    expect(active.campaignId).toBe(campaignId);
    expect(active.articleSlug).toBe(`usage-article-${suffix}`);
    expect(active.liveUrl).toBe(`https://${host}/a/usage-article-${suffix}`);
    expect(active.revenueUsd).toBe(12.34); // 1234 minor on the 29th, inside [28,29]
    expect(active.afsClicks).toBe(5);
    expect(active.rpc).toBeCloseTo(2.468, 3); // 12.34 / 5 clicks (≥ floor)
    const gap = u!.spans.find((s) => !s.active)!;
    expect(gap.firstDay).toBe('2026-05-31');
    expect(gap.revenueUsd).toBe(0); // no revenue on the 31st
    expect(gap.rpc).toBeNull(); // 0 clicks → below the RPC floor → "—"
  });

  it('also resolves by the channels.id uuid', async () => {
    const u = await getChannelUsage(channelDbId);
    expect(u?.channelId).toBe(channelId);
  });

  it('returns null for an unknown channel', async () => {
    expect(await getChannelUsage(`no-such-${suffix}`)).toBeNull();
  });
});

describe('getArticleUsage', () => {
  it('returns the article lineage (campaign → channel → domain + window + revenue)', async () => {
    const u = await getArticleUsage(buyerAuth(), articleId);
    expect(u).not.toBeNull();
    expect(u!.slug).toBe(`usage-article-${suffix}`);
    expect(u!.liveHosts).toContain(host);
    expect(u!.totalRevenueUsd).toBe(12.34);
    expect(u!.campaigns).toHaveLength(1);
    const camp = u!.campaigns[0]!;
    expect(camp.campaignId).toBe(campaignId);
    expect(camp.channels).toHaveLength(1);
    const ch = camp.channels[0]!;
    expect(ch.channelId).toBe(channelId);
    expect(ch.host).toBe(host);
    expect(ch.active).toBe(true);
    expect(ch.firstDay).toBe('2026-05-28');
    expect(ch.lastDay).toBe('2026-05-31'); // overall window across spans
    expect(ch.revenueUsd).toBe(12.34);
    expect(ch.rpc).toBeCloseTo(2.468, 3); // 12.34 / 5 clicks
  });

  it('returns null for an unknown article', async () => {
    expect(await getArticleUsage(buyerAuth(), randomUUID())).toBeNull();
  });
});
