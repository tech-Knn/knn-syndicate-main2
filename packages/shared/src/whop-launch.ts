import { FUNNEL_STAGES, type FunnelStage } from './conversions.js';
import { WHOP_EVENT_FOR_STAGE, WHOP_MAIN_CONVERSION_EVENT } from './whop.js';

/**
 * Whop's launch vocabulary (D33, phase 2): how our campaign structure maps onto Whop's, and everything Whop
 * cannot express. Pure data and functions, shared by the API (which builds the requests), the wizard (which
 * offers only what Whop can do) and the submit gate (which refuses what it cannot).
 *
 * How the two models line up:
 *   our Campaign (the offer)  ->  a Whop ad CAMPAIGN   (objective; the budget when we run it campaign-level)
 *   our AdSet                 ->  a Whop AD GROUP      (targeting, placements, schedule, optimized event, budget)
 *   our Ad                    ->  a Whop AD            (copy, creative file, our redirect link as the destination)
 * Budget: `CAMPAIGN` mode (CBO) puts the budget on the Whop campaign, `AD_SET` mode on each ad group: exactly
 * Whop's own `budget_optimization`. Whop stores and bills in USD, so cents here are USD cents.
 *
 * Not everything we can say to Facebook exists at Whop. `whopLaunchProblems` lists each such thing so the buyer
 * is told before launch instead of the ad quietly going out different from what they built. The request bodies
 * themselves are built in `@knn/whop` (`launch-map.ts`).
 */

export type WhopObjectiveName = 'awareness' | 'traffic' | 'engagement' | 'leads' | 'sales';

export interface WhopLaunchCampaign {
  name: string;
  /** Our CampaignObjective enum (OUTCOME_*). */
  objective: string;
  /** Our special categories (HOUSING, EMPLOYMENT, CREDIT, ...). */
  specialAdCategories: readonly string[];
  budgetMode: 'CAMPAIGN' | 'AD_SET';
  dailyBudgetCents: number | null;
}

export interface WhopLaunchAdSet {
  name: string;
  dailyBudgetCents: number | null;
  countries: readonly string[];
  excludeCountries: readonly string[];
  ageMin: number;
  ageMax: number;
  /** 'male' / 'female'; empty = everyone. */
  genders: readonly string[];
  advantageAudience: boolean;
  /** 'automatic' or 'manual' (then `placements` lists our position keys). */
  placementMode: string;
  placements: readonly string[];
  languages: readonly string[];
  devicePlatforms: readonly string[];
  mobileOs: readonly string[];
  /** Our bid strategy key (LOWEST_COST_WITHOUT_CAP, COST_CAP, ...). */
  bidStrategy: string | null;
  costCapCents: number | null;
  startTime: Date | null;
  endTime: Date | null;
  /** Our funnel stage the ad set optimizes toward: 'adclick' (the money event) by default. */
  pxeEvent: string;
}

export interface WhopLaunchAd {
  name: string;
  headline: string;
  primaryText: string;
  description: string | null;
  /** Our CTA key, a Facebook enum such as LEARN_MORE. */
  cta: string;
}

/**
 * Whop's smallest daily budget, in USD cents, for a campaign (budget optimization on) or for an ad group (off). Whop refuses to launch below it
 * ("Budget must be greater than or equal to 5.0", "Daily budget must be at least $5.00"), so we say so while the buyer is still building.
 * The draft schema still accepts $1.00 so a half-built draft can be saved.
 */
export const WHOP_MIN_DAILY_BUDGET_CENTS = 500;

/**
 * Whop does not let a campaign with a special ad category narrow its audience's age: the range must be 18 to 65 (the top of our scale,
 * which Meta reads as "65+"). Whop says: "Special ad category campaigns must use minimum age 18 (cannot narrow age range)". Gender is not
 * checked here: Whop has not complained about it.
 */
export const WHOP_SPECIAL_AGE_MIN = 18;
export const WHOP_SPECIAL_AGE_MAX = 65;

/** Our objective → Whop's. Facebook's APP_PROMOTION has no Whop equivalent. */
export const WHOP_OBJECTIVE: Readonly<Record<string, WhopObjectiveName | undefined>> = {
  OUTCOME_LEADS: 'leads',
  OUTCOME_SALES: 'sales',
  OUTCOME_TRAFFIC: 'traffic',
  OUTCOME_ENGAGEMENT: 'engagement',
  OUTCOME_AWARENESS: 'awareness',
};

/** The objective a Whop campaign gets when the buyer has not chosen one: leads, the natural home of `submit_application`. */
export const WHOP_DEFAULT_OBJECTIVE: WhopObjectiveName = 'leads';

/** Our special ad categories → Whop's. Online gambling has none. */
export const WHOP_SPECIAL_CATEGORY: Readonly<Record<string, string | undefined>> = {
  HOUSING: 'housing',
  EMPLOYMENT: 'employment',
  CREDIT: 'financial_products',
  FINANCIAL_PRODUCTS_SERVICES: 'financial_products',
  ISSUES_ELECTIONS_POLITICS: 'politics',
};

/**
 * Our placement keys → Whop's `{ platform, position }`. `null` = Whop cannot target it (Facebook "video feeds"
 * and Messenger "inbox" are not in Whop's list of positions).
 */
export const WHOP_PLACEMENT: Readonly<Record<string, { platform: 'facebook' | 'instagram' | 'messenger' | 'audience_network'; position: string } | null>> = {
  facebook_feed: { platform: 'facebook', position: 'feed' },
  facebook_marketplace: { platform: 'facebook', position: 'marketplace' },
  facebook_video_feeds: null,
  facebook_right_hand_column: { platform: 'facebook', position: 'right_hand_column' },
  facebook_story: { platform: 'facebook', position: 'story' },
  facebook_reels: { platform: 'facebook', position: 'facebook_reels' },
  facebook_search: { platform: 'facebook', position: 'search' },
  instagram_stream: { platform: 'instagram', position: 'stream' },
  instagram_story: { platform: 'instagram', position: 'story' },
  instagram_explore: { platform: 'instagram', position: 'explore' },
  instagram_reels: { platform: 'instagram', position: 'reels' },
  instagram_search: { platform: 'instagram', position: 'ig_search' },
  messenger_inbox: null,
  messenger_story: { platform: 'messenger', position: 'story' },
  audience_network_classic: { platform: 'audience_network', position: 'classic' },
  audience_network_rewarded_video: { platform: 'audience_network', position: 'rewarded_video' },
};

/** The call-to-action values Whop accepts. Anything else falls back to `learn_more`. */
export const WHOP_CTAS: readonly string[] = [
  'apply_now', 'book_now', 'call_now', 'contact_us', 'download', 'get_directions', 'get_offer', 'get_quote', 'learn_more', 'listen_now',
  'message_page', 'no_button', 'open_link', 'order_now', 'request_time', 'see_details', 'see_menu', 'send_updates', 'shop_now', 'sign_up',
  'subscribe', 'watch_more',
];
export const WHOP_FALLBACK_CTA = 'learn_more';

export function whopCta(cta: string | null | undefined): string {
  const key = (cta ?? '').toLowerCase();
  return WHOP_CTAS.includes(key) ? key : WHOP_FALLBACK_CTA;
}

/** The stage our ad set optimizes toward → the Whop event that becomes the ad group's `result_event`. */
export function whopConversionEvent(pxeEvent: string | null | undefined): string {
  const stage = (pxeEvent ?? '').toLowerCase() as FunnelStage;
  return FUNNEL_STAGES.includes(stage) ? WHOP_EVENT_FOR_STAGE[stage] : WHOP_MAIN_CONVERSION_EVENT;
}

/**
 * What Whop cannot express AT ALL: an objective, a special ad category, a placement or a bid strategy it has no word for. Kept
 * apart from `whopLaunchProblems` because it answers a different question ("did a choice survive that Whop cannot run?", asked
 * when a buyer switches a Facebook campaign to Whop) from "is it filled in yet?".
 */
export function whopUnsupportedProblems(campaign: Pick<WhopLaunchCampaign, 'objective' | 'specialAdCategories'>, adSets: readonly Pick<WhopLaunchAdSet, 'name' | 'placementMode' | 'placements' | 'bidStrategy'>[]): string[] {
  const out: string[] = [];
  if (campaign.objective && !WHOP_OBJECTIVE[campaign.objective]) out.push('Whop does not run app-promotion campaigns.');
  for (const c of campaign.specialAdCategories) if (!WHOP_SPECIAL_CATEGORY[c]) out.push(`Whop has no "${c.toLowerCase().replace(/_/g, ' ')}" special ad category.`);
  for (const set of adSets) {
    const label = adSets.length > 1 ? ` (ad set "${set.name}")` : '';
    if (set.placementMode === 'manual') {
      const missing = set.placements.filter((p) => WHOP_PLACEMENT[p] === null || WHOP_PLACEMENT[p] === undefined);
      if (missing.length) out.push(`Whop cannot target these placements${label}: ${missing.join(', ')}.`);
    }
    if (set.bidStrategy === 'LOWEST_COST_WITH_MIN_ROAS') out.push(`Whop has no ROAS-goal bid strategy${label}.`);
  }
  return out;
}

/** Everything in a campaign that Whop cannot express, or that is not filled in yet. Empty = it can be launched as built. */
export function whopLaunchProblems(campaign: WhopLaunchCampaign, adSets: readonly WhopLaunchAdSet[]): string[] {
  const out: string[] = whopUnsupportedProblems(campaign, adSets);
  for (const set of adSets) {
    const label = adSets.length > 1 ? ` (ad set "${set.name}")` : '';
    // Manual with nothing chosen is not "automatic": it is an ad set with nowhere to run, and Whop would be sent an empty list.
    if (set.placementMode === 'manual' && set.placements.length === 0) out.push(`Pick at least one placement${label}.`);
    if ((set.bidStrategy === 'COST_CAP' || set.bidStrategy === 'LOWEST_COST_WITH_BID_CAP') && !(set.costCapCents && set.costCapCents > 0)) out.push(`The bid strategy needs a cost or bid cap amount${label}.`);
    if (set.dailyBudgetCents != null && set.dailyBudgetCents <= 0) out.push(`The daily budget must be above zero${label}.`);
    if (set.countries.length === 0) out.push(`Pick at least one country${label}.`);
    // Whop: "Conversion event 'SUBMIT_APPLICATION' is not valid for objective 'sales'" (valid there: purchase, add to cart, content view,
    // search, ...). The ad click, our money event, is a submit_application, so a Sales campaign cannot optimize for it. Leads and Engagement can
    // (every Engagement campaign on staging launched with it).
    if (campaign.objective === 'OUTCOME_SALES' && whopConversionEvent(set.pxeEvent) === WHOP_MAIN_CONVERSION_EVENT) {
      out.push(`Whop does not accept optimizing for ad clicks on a Sales campaign: choose the Leads or Engagement objective${label}.`);
    }
    if (campaign.specialAdCategories.some((c) => WHOP_SPECIAL_CATEGORY[c]) && (set.ageMin !== WHOP_SPECIAL_AGE_MIN || set.ageMax < WHOP_SPECIAL_AGE_MAX)) {
      out.push(`Whop does not let a special ad category campaign narrow the age range: set ${WHOP_SPECIAL_AGE_MIN} to ${WHOP_SPECIAL_AGE_MAX}${label}.`);
    }
  }
  const floor = `$${(WHOP_MIN_DAILY_BUDGET_CENTS / 100).toFixed(2)}`;
  if (campaign.budgetMode === 'CAMPAIGN') {
    if (!(campaign.dailyBudgetCents && campaign.dailyBudgetCents > 0)) out.push('Set a daily budget for the campaign.');
    else if (campaign.dailyBudgetCents < WHOP_MIN_DAILY_BUDGET_CENTS) out.push(`Whop's minimum daily budget is ${floor}: raise the campaign budget.`);
  }
  if (campaign.budgetMode === 'AD_SET') {
    for (const set of adSets) {
      const label = adSets.length > 1 ? ` for ad set "${set.name}"` : '';
      if (!(set.dailyBudgetCents && set.dailyBudgetCents > 0)) out.push(`Set a daily budget${label}.`);
      else if (set.dailyBudgetCents < WHOP_MIN_DAILY_BUDGET_CENTS) out.push(`Whop's minimum daily budget is ${floor}: raise the budget${label}.`);
    }
  }
  return out;
}
