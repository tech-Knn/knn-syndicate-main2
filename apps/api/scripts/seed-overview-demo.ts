/**
 * Dev-only seed for in-browser verification of the Phase 10 Overview dashboard.
 * Creates a demo org + a loggable MEDIA_BUYER with three campaigns and ~14 days of
 * ad_stats_daily / ad_revenue_daily so the KPI tiles, chart, and performance table
 * render with real-shaped data. Idempotent: drops & recreates the demo org each run.
 *
 *   pnpm --filter @knn/api exec tsx scripts/seed-overview-demo.ts
 *
 * Login: overview@demo.knn / OverviewDemo123
 */
import bcrypt from 'bcryptjs';
import { withSystem } from '@knn/db';
import { ROLES, USER_STATUS, addBusinessDays, currentBusinessDay } from '@knn/shared';

const EMAIL = 'overview@demo.knn';
const PASSWORD = 'OverviewDemo123';
const SLUG = 'demo-overview';
const DAYS = 14;

type AdSpec = { name: string; baseSpendMinor: number; revMult: number; convRate: number; seed: number };
type CampaignSpec = { name: string; channelLabel: string; adSets: { name: string; ads: AdSpec[] }[] };

const SPECS: CampaignSpec[] = [
  {
    name: 'Auto Insurance — US',
    channelLabel: 'auto-us-01',
    adSets: [
      { name: 'US · 25-54 · Mobile', ads: [
        { name: 'Save $500/yr', baseSpendMinor: 4200, revMult: 1.9, convRate: 0.05, seed: 0.3 },
        { name: 'Compare 12 Insurers', baseSpendMinor: 3100, revMult: 1.7, convRate: 0.04, seed: 1.1 },
      ] },
      { name: 'US · 55+ · Desktop', ads: [
        { name: 'Senior Drivers Save', baseSpendMinor: 2600, revMult: 2.2, convRate: 0.06, seed: 2.0 },
      ] },
    ],
  },
  {
    name: 'Medicare Advantage — US',
    channelLabel: 'medicare-us-04',
    adSets: [
      { name: 'US · 64+ · Broad', ads: [
        { name: '$0 Premium Plans', baseSpendMinor: 5200, revMult: 2.7, convRate: 0.07, seed: 0.8 },
        { name: 'New 2026 Benefits', baseSpendMinor: 3800, revMult: 2.4, convRate: 0.05, seed: 1.7 },
      ] },
    ],
  },
  {
    name: 'Solar Quotes — CA',
    channelLabel: 'solar-ca-09',
    adSets: [
      { name: 'CA · Homeowners', ads: [
        { name: 'Free Solar Estimate', baseSpendMinor: 4800, revMult: 0.95, convRate: 0.03, seed: 2.6 },
      ] },
    ],
  },
];

function wobble(day: number, seed: number): number {
  return 0.72 + 0.5 * Math.abs(Math.sin(day * 0.65 + seed)) + 0.12 * Math.abs(Math.cos(day * 0.31 + seed));
}

async function main(): Promise<void> {
  const today = currentBusinessDay();
  const days = Array.from({ length: DAYS }, (_, i) => addBusinessDays(today, -(DAYS - 1 - i)));

  await withSystem(async (tx) => {
    await tx.channel.deleteMany({ where: { channelId: { startsWith: `demo-${SLUG}-` } } });
    await tx.organization.deleteMany({ where: { slug: SLUG } });
    const org = await tx.organization.create({ data: { name: 'Demo Co', slug: SLUG } });
    const hash = await bcrypt.hash(PASSWORD, 12);
    const buyer = await tx.user.create({
      data: { orgId: org.id, email: EMAIL, name: 'Dana Buyer', passwordHash: hash, role: ROLES.MEDIA_BUYER, status: USER_STATUS.ACTIVE },
    });
    // A second buyer (no campaigns) + a pending buyer, so the Team members table has variety.
    await tx.user.create({
      data: { orgId: org.id, email: 'sam@demo.knn', name: 'Sam Buyer', passwordHash: hash, role: ROLES.MEDIA_BUYER, status: USER_STATUS.PENDING },
    });
    await tx.user.create({
      data: { orgId: org.id, email: 'admin@demo.knn', name: 'Avery Admin', passwordHash: hash, role: ROLES.COMPANY_ADMIN, status: USER_STATUS.ACTIVE },
    });
    await tx.user.create({
      data: { orgId: org.id, email: 'super@demo.knn', name: 'Sky Super', passwordHash: hash, role: ROLES.SUPER_ADMIN, status: USER_STATUS.ACTIVE },
    });

    for (const spec of SPECS) {
      // No global Channel rows: `channels` has no org scoping, so seeded channels would
      // pollute the worker's cross-org channel-pool tests. (channelLabel is API-tested.)
      const campaign = await tx.campaign.create({
        data: { orgId: org.id, buyerId: buyer.id, name: spec.name, status: 'ACTIVE' },
      });

      for (const setSpec of spec.adSets) {
        const adSet = await tx.adSet.create({ data: { orgId: org.id, campaignId: campaign.id, name: setSpec.name } });
        for (const adSpec of setSpec.ads) {
          const ad = await tx.ad.create({
            data: {
              orgId: org.id,
              adSetId: adSet.id,
              name: adSpec.name,
              headline: adSpec.name,
              primaryText: 'Demo creative.',
              redirectId: `demo-${campaign.id.slice(0, 8)}-${Math.random().toString(36).slice(2, 8)}`,
            },
          });
          for (let d = 0; d < days.length; d++) {
            const w = wobble(d, adSpec.seed);
            const spendMinor = Math.round(adSpec.baseSpendMinor * w);
            const impressions = Math.round(spendMinor * 8 * (0.9 + 0.2 * w));
            const clicks = Math.round(impressions * 0.03 * w);
            const conversions = Math.max(0, Math.round(clicks * adSpec.convRate));
            const allocated = Math.round(spendMinor * adSpec.revMult * (0.85 + 0.3 * w));
            const margin = Math.round(allocated * 0.2);
            const visible = allocated - margin;
            await tx.adStatsDaily.create({
              data: {
                orgId: org.id, campaignId: campaign.id, adId: ad.id, day: days[d]!,
                spendUsdMinor: spendMinor, spendMinor, currency: 'USD',
                impressions, clicks, conversions, finalized: d < days.length - 1,
              },
            });
            await tx.adRevenueDaily.create({
              data: {
                orgId: org.id, campaignId: campaign.id, adId: ad.id, day: days[d]!,
                conversions, allocatedUsdMinor: allocated, visibleUsdMinor: visible, marginUsdMinor: margin,
                basis: conversions > 0 ? 'conversions' : 'clicks',
              },
            });
          }
        }
      }
    }
  });

  // eslint-disable-next-line no-console
  console.log(
    `Seeded demo org "${SLUG}" with 3 campaigns × ${DAYS} days.\n` +
      `Logins (password ${PASSWORD}):\n` +
      `  buyer  ${EMAIL}\n  admin  admin@demo.knn\n  super  super@demo.knn`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
