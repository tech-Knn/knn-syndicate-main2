import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma, withSystem } from '@knn/db';
import { ensureFxRatesForDays } from './fx.service.js';

/** A day nothing else in the suite uses, so the rows below are ours alone. */
const DAY = '2001-02-03';
const fetchesFor = (rates: Record<string, number>): { fetch: typeof fetch; urls: URL[] } => {
  const urls: URL[] = [];
  const fake = (async (input: URL | string) => {
    urls.push(new URL(String(input)));
    return { ok: true, status: 200, json: async () => ({ rates }) } as Response;
  }) as typeof fetch;
  return { fetch: fake, urls };
};

const clean = () =>
  withSystem(async (tx) => {
    await tx.adStatsDaily.deleteMany({ where: { day: DAY } });
    await tx.fxRate.deleteMany({ where: { day: DAY } });
  });

beforeEach(clean);
afterAll(async () => {
  await clean();
  await prisma.$disconnect();
});

describe('ensureFxRatesForDays', () => {
  it('fetches a rate for a currency that only appears in the spend already stored for these days (Whop reports each ad in the currency it was charged in)', async () => {
    await withSystem((tx) => tx.adStatsDaily.create({ data: { orgId: randomUUID(), adId: randomUUID(), campaignId: randomUUID(), day: DAY, currency: 'CHF', spendMinor: 100, spendUsdMinor: 100 } }));
    const { fetch: fake, urls } = fetchesFor({ CHF: 0.9 });
    await ensureFxRatesForDays([DAY], { fetch: fake });
    expect(urls).toHaveLength(1);
    expect(urls[0]!.searchParams.get('symbols')).toContain('CHF');
    const stored = await withSystem((tx) => tx.fxRate.findUnique({ where: { day_currency: { day: DAY, currency: 'CHF' } } }));
    expect(Number(stored?.rate)).toBeCloseTo(1 / 0.9, 6); // stored as USD per unit, the inverse of what the provider quotes
  });

  it('does not go looking for a currency in stats of days it was not asked about', async () => {
    await withSystem((tx) => tx.adStatsDaily.create({ data: { orgId: randomUUID(), adId: randomUUID(), campaignId: randomUUID(), day: DAY, currency: 'CHF', spendMinor: 100, spendUsdMinor: 100 } }));
    const { fetch: fake, urls } = fetchesFor({ CHF: 0.9 });
    await ensureFxRatesForDays(['2001-02-04'], { fetch: fake });
    for (const u of urls) expect(u.searchParams.get('symbols') ?? '').not.toContain('CHF');
  });

  it('swallows a provider failure: a missing rate degrades to the last known one, it never fails the run', async () => {
    await withSystem((tx) => tx.adStatsDaily.create({ data: { orgId: randomUUID(), adId: randomUUID(), campaignId: randomUUID(), day: DAY, currency: 'CHF', spendMinor: 100, spendUsdMinor: 100 } }));
    const failing = (async () => ({ ok: false, status: 503, json: async () => ({}) }) as Response) as typeof fetch;
    await expect(ensureFxRatesForDays([DAY], { fetch: failing })).resolves.toBeUndefined();
  });
});
