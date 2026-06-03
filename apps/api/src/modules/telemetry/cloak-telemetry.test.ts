import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma, withSystem } from '@knn/db';
import { ROLES, USER_STATUS, currentBusinessDay } from '@knn/shared';
import { getCloakStats, recordCloakSignal } from './cloak-telemetry.service.js';

const day = currentBusinessDay();
// Fixed valid UUIDs (no FK on cloak_stat_daily.campaign_id, like the other revenue tables).
const campA = 'aaaaaaaa-aaaa-4aaa-aaaa-00000000ca01';
const campB = 'bbbbbbbb-bbbb-4bbb-bbbb-00000000cb01';

async function cleanup(): Promise<void> {
  await withSystem((tx) => tx.cloakStatDaily.deleteMany({ where: { campaignId: { in: [campA, campB] } } }));
}

beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe('recordCloakSignal', () => {
  it('increments money/white + the verify counters, keyed by (campaign, IST day)', async () => {
    await recordCloakSignal({ campaignId: campA, route: 'money', verify: 'match' });
    await recordCloakSignal({ campaignId: campA, route: 'money', verify: 'missing' });
    await recordCloakSignal({ campaignId: campA, route: 'white', verify: 'na' });

    const row = await withSystem((tx) => tx.cloakStatDaily.findUnique({ where: { campaignId_day: { campaignId: campA, day } } }));
    expect(row).not.toBeNull();
    expect(row!.money).toBe(2);
    expect(row!.white).toBe(1);
    expect(row!.verifiedMatch).toBe(1);
    expect(row!.macroMissing).toBe(1);
    expect(row!.verifiedMismatch).toBe(0);
  });

  it('ignores a non-uuid campaign id (garbage redirect → nothing attributed)', async () => {
    await recordCloakSignal({ campaignId: 'not-a-uuid', route: 'money', verify: 'match' });
    const rows = await withSystem((tx) => tx.cloakStatDaily.findMany({ where: { campaignId: { in: [campA, campB] } } }));
    expect(rows).toHaveLength(0);
  });
});

describe('getCloakStats', () => {
  it('rolls up money/white + verify outcomes per campaign', async () => {
    await withSystem((tx) =>
      tx.cloakStatDaily.createMany({
        data: [
          { campaignId: campA, day, money: 80, white: 20, verifiedMatch: 70, verifiedMismatch: 5, macroMissing: 5 },
          { campaignId: campB, day, money: 10, white: 90, verifiedMatch: 0, verifiedMismatch: 0, macroMissing: 10 },
        ],
      }),
    );
    const res = await getCloakStats({});
    // Assert on OUR fixtures only (other api tests share this table/day — never assert global totals).
    const a = res.rows.find((r) => r.campaignId === campA)!;
    const b = res.rows.find((r) => r.campaignId === campB)!;
    expect(a.money).toBe(80);
    expect(a.white).toBe(20);
    expect(a.macroMissing).toBe(5); // the revenue-loss-if-enforced signal
    expect(b.money).toBe(10);
    expect(b.macroMissing).toBe(10);
  });

  it('labels each row with the owning media buyer + company (drives the per-buyer breakdown)', async () => {
    const sfx = Date.now().toString(36);
    // A real org → buyer → campaign so the buyer/org join resolves (campA/campB above have no Campaign).
    const { orgId, buyerId, campaignId } = await withSystem(async (tx) => {
      const org = await tx.organization.create({ data: { name: `Cloak Co ${sfx}`, slug: `cloak-co-${sfx}` } });
      const buyer = await tx.user.create({
        data: { orgId: org.id, email: `cloak-${sfx}@example.com`, name: 'Cloak Buyer', passwordHash: 'x', role: ROLES.MEDIA_BUYER, status: USER_STATUS.ACTIVE },
      });
      const campaign = await tx.campaign.create({ data: { orgId: org.id, buyerId: buyer.id, name: `Cloak Camp ${sfx}` }, select: { id: true } });
      await tx.cloakStatDaily.create({ data: { campaignId: campaign.id, day, money: 7, white: 3, verifiedMatch: 7, verifiedMismatch: 0, macroMissing: 0 } });
      return { orgId: org.id, buyerId: buyer.id, campaignId: campaign.id };
    });
    try {
      const res = await getCloakStats({});
      const row = res.rows.find((r) => r.campaignId === campaignId)!;
      expect(row).toBeDefined();
      expect(row.name).toBe(`Cloak Camp ${sfx}`);
      expect(row.buyerId).toBe(buyerId);
      expect(row.buyerName).toBe('Cloak Buyer');
      expect(row.companyName).toBe(`Cloak Co ${sfx}`);
      expect(row.money).toBe(7);
    } finally {
      await withSystem(async (tx) => {
        await tx.cloakStatDaily.deleteMany({ where: { campaignId } });
        await tx.campaign.deleteMany({ where: { id: campaignId } });
        await tx.user.deleteMany({ where: { id: buyerId } });
        await tx.organization.deleteMany({ where: { id: orgId } });
      });
    }
  });
});
