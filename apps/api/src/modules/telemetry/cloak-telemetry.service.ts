import { withSystem } from '@knn/db';
import { type CloakStatRow, type CloakStats, addBusinessDays, currentBusinessDay } from '@knn/shared';

/**
 * Cloaker decision telemetry (observe-first ad-ID verification). The edge redirect beacons one
 * signal per click so we can SEE the money-vs-white split before any enforcement changes routing:
 *   route  = 'money' | 'white'  — where the click was ACTUALLY routed (today: by fbclid)
 *   verify = 'match'    — paid + the FB {{ad.id}} macro matched the expected ad id
 *            'mismatch' — paid + macro present but wrong (spoof/bot → safe to block on enforce)
 *            'missing'  — paid but no macro (enforcing would white-page these = revenue-loss signal)
 *            'na'       — not paid, or no expected id configured (legacy)
 * Aggregated per campaign per IST business day in `cloak_stat_daily`. Never throws (beacon path).
 */
export type CloakRoute = 'money' | 'white';
export type CloakVerify = 'match' | 'mismatch' | 'missing' | 'na';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function recordCloakSignal(input: { campaignId: string; route: CloakRoute; verify: CloakVerify }): Promise<void> {
  const campaignId = (input.campaignId ?? '').trim();
  if (!UUID_RE.test(campaignId)) return; // unknown/garbage redirect → nothing to attribute

  const inc = {
    money: input.route === 'money' ? 1 : 0,
    white: input.route === 'white' ? 1 : 0,
    verifiedMatch: input.verify === 'match' ? 1 : 0,
    verifiedMismatch: input.verify === 'mismatch' ? 1 : 0,
    macroMissing: input.verify === 'missing' ? 1 : 0,
  };
  const day = currentBusinessDay();
  const incrementData = {
    money: { increment: inc.money },
    white: { increment: inc.white },
    verifiedMatch: { increment: inc.verifiedMatch },
    verifiedMismatch: { increment: inc.verifiedMismatch },
    macroMissing: { increment: inc.macroMissing },
  };
  try {
    await withSystem((tx) =>
      tx.cloakStatDaily.upsert({
        where: { campaignId_day: { campaignId, day } },
        create: { campaignId, day, ...inc },
        update: incrementData,
      }),
    );
  } catch {
    // A concurrent create can race the upsert into a unique violation; retry as a pure increment.
    try {
      await withSystem((tx) => tx.cloakStatDaily.update({ where: { campaignId_day: { campaignId, day } }, data: incrementData }));
    } catch {
      /* observe-only telemetry: dropping one increment is acceptable, never surface */
    }
  }
}

/**
 * Super-admin cloaker rollup over [from, to] IST days (default last 7), per campaign + totals.
 * `enforceWouldWhite` = paid clicks that would flip to the white page if we enforced today
 * (mismatch = safely blocked spoof/bot; macroMissing = the genuine revenue-loss risk to watch).
 */
export async function getCloakStats(opts: { from?: string; to?: string } = {}): Promise<CloakStats> {
  const to = opts.to ?? currentBusinessDay();
  const from = opts.from ?? addBusinessDays(to, -6);

  const grouped = await withSystem((tx) =>
    tx.cloakStatDaily.groupBy({
      by: ['campaignId'],
      where: { day: { gte: from, lte: to } },
      _sum: { money: true, white: true, verifiedMatch: true, verifiedMismatch: true, macroMissing: true },
    }),
  );

  const ids = grouped.map((g) => g.campaignId);
  // Resolve campaign name + its owning media buyer + company in one pass, so the Cloaker page can
  // break the split down per buyer (and label each campaign with who owns it).
  const meta = ids.length
    ? await withSystem((tx) =>
        tx.campaign.findMany({
          where: { id: { in: ids } },
          select: {
            id: true,
            name: true,
            buyerId: true,
            buyer: { select: { name: true } },
            organization: { select: { name: true } },
          },
        }),
      )
    : [];
  const metaById = new Map(meta.map((c) => [c.id, c]));

  const rows: CloakStatRow[] = grouped
    .map((g): CloakStatRow => {
      const m = metaById.get(g.campaignId);
      return {
        campaignId: g.campaignId,
        name: m?.name ?? '(deleted campaign)',
        buyerId: m?.buyerId ?? '',
        buyerName: m?.buyer?.name ?? '—',
        companyName: m?.organization?.name ?? '—',
        money: g._sum.money ?? 0,
        white: g._sum.white ?? 0,
        verifiedMatch: g._sum.verifiedMatch ?? 0,
        verifiedMismatch: g._sum.verifiedMismatch ?? 0,
        macroMissing: g._sum.macroMissing ?? 0,
      };
    })
    .sort((a, b) => b.money + b.white - (a.money + a.white));

  const totals = rows.reduce(
    (t, r) => ({
      money: t.money + r.money,
      white: t.white + r.white,
      verifiedMatch: t.verifiedMatch + r.verifiedMatch,
      verifiedMismatch: t.verifiedMismatch + r.verifiedMismatch,
      macroMissing: t.macroMissing + r.macroMissing,
    }),
    { money: 0, white: 0, verifiedMatch: 0, verifiedMismatch: 0, macroMissing: 0 },
  );

  return { range: { from, to }, totals, rows };
}
