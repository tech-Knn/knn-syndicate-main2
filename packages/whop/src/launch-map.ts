import {
  WHOP_OBJECTIVE,
  WHOP_DEFAULT_OBJECTIVE,
  WHOP_PLACEMENT,
  WHOP_SPECIAL_CATEGORY,
  type WhopLaunchAd,
  type WhopLaunchAdSet,
  type WhopLaunchCampaign,
  whopConversionEvent,
  whopCta,
} from '@knn/shared';
import type { CreateAdCampaignInput, CreateAdGroupInput, CreateAdInput, WhopDemographics, WhopDevices, WhopPlacements, WhopRegions } from './ads.js';

/**
 * Our campaign structure -> Whop's REQUEST BODIES (D33, phase 2). Pure: plain data in, bodies out, no database and
 * no network, so every translation is unit-tested and the launch service only loads rows and calls Whop. The
 * vocabulary (objective, placement and category tables, what Whop cannot express) lives in `@knn/shared`
 * (`whop-launch.ts`) so the wizard and the submit gate use the very same tables.
 */

// The vocabulary is part of this package's public surface too.
export {
  WHOP_CTAS,
  WHOP_DEFAULT_OBJECTIVE,
  WHOP_FALLBACK_CTA,
  WHOP_OBJECTIVE,
  WHOP_PLACEMENT,
  WHOP_SPECIAL_CATEGORY,
  type WhopLaunchAd,
  type WhopLaunchAdSet,
  type WhopLaunchCampaign,
  whopConversionEvent,
  whopCta,
  whopLaunchProblems,
} from '@knn/shared';

const usd = (cents: number): number => Math.round(cents) / 100;

export function whopCampaignBody(c: WhopLaunchCampaign, accountId: string, idempotencyKey: string): CreateAdCampaignInput {
  const categories = c.specialAdCategories.map((x) => WHOP_SPECIAL_CATEGORY[x]).filter((x): x is string => Boolean(x));
  const cbo = c.budgetMode === 'CAMPAIGN';
  return {
    account_id: accountId,
    title: c.name,
    platform: 'meta',
    objective: WHOP_OBJECTIVE[c.objective] ?? WHOP_DEFAULT_OBJECTIVE,
    ...(categories.length ? { special_ad_categories: [...new Set(categories)] } : {}),
    ...(cbo && c.dailyBudgetCents ? { budget_optimization: 'ad_campaign' as const, budget_amount: usd(c.dailyBudgetCents), budget_type: 'daily' as const } : {}),
    idempotencyKey,
  };
}

function regions(set: WhopLaunchAdSet): WhopRegions {
  return {
    include: { countries: [...set.countries] },
    ...(set.excludeCountries.length ? { exclude: { countries: [...set.excludeCountries] } } : {}),
  };
}

function demographics(set: WhopLaunchAdSet): WhopDemographics {
  const male = set.genders.includes('male');
  const female = set.genders.includes('female');
  return {
    automatic: set.advantageAudience,
    minimum_age: set.ageMin,
    maximum_age: set.ageMax,
    gender: male && !female ? 'male' : female && !male ? 'female' : 'all',
  };
}

function placements(set: WhopLaunchAdSet): WhopPlacements {
  if (set.placementMode !== 'manual' || set.placements.length === 0) return 'automatic';
  const byPlatform = new Map<string, string[]>();
  for (const key of set.placements) {
    const p = WHOP_PLACEMENT[key];
    if (!p) continue;
    byPlatform.set(p.platform, [...(byPlatform.get(p.platform) ?? []), p.position]);
  }
  return [...byPlatform].map(([platform, positions]) => ({ platform: platform as 'facebook' | 'instagram' | 'messenger' | 'audience_network', positions }));
}

function devices(set: WhopLaunchAdSet): WhopDevices | undefined {
  const platforms = set.devicePlatforms.filter((p): p is 'mobile' | 'desktop' => p === 'mobile' || p === 'desktop');
  const operating_systems = set.mobileOs.filter((o): o is 'ios' | 'android' => o === 'ios' || o === 'android').map((os) => ({ os }));
  if (!platforms.length && !operating_systems.length) return undefined;
  return { ...(platforms.length ? { platforms } : {}), ...(operating_systems.length ? { operating_systems } : {}) };
}

export function whopAdGroupBody(set: WhopLaunchAdSet, adCampaignId: string, budgetMode: 'CAMPAIGN' | 'AD_SET', idempotencyKey: string): CreateAdGroupInput {
  const dev = devices(set);
  const cap = set.costCapCents && set.costCapCents > 0 ? usd(set.costCapCents) : undefined;
  const bid =
    set.bidStrategy === 'COST_CAP' && cap !== undefined
      ? { bid_type: 'average_target' as const, desired_cost_per_result: cap }
      : set.bidStrategy === 'LOWEST_COST_WITH_BID_CAP' && cap !== undefined
        ? { bid_type: 'maximum_target' as const, desired_cost_per_result: cap }
        : {};
  return {
    ad_campaign_id: adCampaignId,
    title: set.name,
    ...(budgetMode === 'AD_SET' && set.dailyBudgetCents ? { budget_amount: usd(set.dailyBudgetCents), budget_type: 'daily' as const } : {}),
    conversion_location: 'website',
    conversion_event: whopConversionEvent(set.pxeEvent),
    optimization_goal: 'conversions',
    ...bid,
    regions: regions(set),
    demographics: demographics(set),
    placements: placements(set),
    ...(dev ? { devices: dev } : {}),
    ...(set.languages.length ? { languages: [...set.languages] } : {}),
    ...(set.startTime ? { starts_at: set.startTime.toISOString() } : {}),
    ...(set.endTime ? { ends_at: set.endTime.toISOString() } : {}),
    idempotencyKey,
  };
}

export function whopAdBody(
  ad: WhopLaunchAd,
  ctx: { adGroupId: string; /** Our go-link for this ad. Whop loads it, follows the redirect and looks for its pixel. */ url: string; fileId: string | null; pageId: string | null },
  idempotencyKey: string,
): CreateAdInput {
  return {
    ad_group_id: ctx.adGroupId,
    title: ad.name,
    url: ctx.url,
    headlines: [{ text: ad.headline }],
    primary_texts: [{ text: ad.primaryText }],
    ...(ad.description ? { descriptions: [{ text: ad.description }] } : {}),
    call_to_action: whopCta(ad.cta),
    ...(ctx.fileId ? { creatives: [{ id: ctx.fileId }] } : {}),
    ...(ctx.pageId ? { social_accounts: [{ id: ctx.pageId }] } : {}),
    // Whop defaults this to ON, which lets Meta crop the creative and show the ad beside other advertisers'.
    // We launch with it OFF, like our Facebook ads.
    multi_advertiser_ads: false,
    idempotencyKey,
  };
}

/**
 * The keys that make each create safe to replay (Whop keeps them 24 h), always derived from our own row ids.
 * The EPOCH is part of the key from 1 on: Whop replays a repeated key, so once a Whop tree has been discarded
 * (reopen, relaunch, deleted in Whop) the next tree must use new keys, or Whop would answer with the objects we
 * just threw away. Epoch 0, every campaign's first tree, carries no suffix.
 */
const withEpoch = (key: string, epoch: number): string => (epoch > 0 ? `${key}-e${epoch}` : key);
export const whopKeys = {
  campaign: (campaignId: string, epoch = 0): string => withEpoch(`knn-camp-${campaignId}`, epoch),
  adGroup: (adSetId: string, epoch = 0): string => withEpoch(`knn-grp-${adSetId}`, epoch),
  ad: (adId: string, epoch = 0): string => withEpoch(`knn-ad-${adId}`, epoch),
  file: (adId: string, epoch = 0): string => withEpoch(`knn-file-${adId}`, epoch),
};
