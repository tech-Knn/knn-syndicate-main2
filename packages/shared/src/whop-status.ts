/**
 * What Whop reports about a launched campaign, and what the status sync does with it (D32, phase 2). Pure, so the
 * worker's reconcile job and its tests share one table, like `campaign-status.ts` does for our own states.
 *
 * Whop has two words per entity. `status` is the configured lifecycle (active, paused, draft, in_review, flagged, ...;
 * a billing failure keeps active/paused here). `delivery_status` is whether it is delivering right now and why not
 * (payment_failed, in_appeal, all_ads_rejected, draft, no_ad_groups, no_ads, paused, processing, issues, scheduled,
 * completed, ad_groups_off, active). Whop's ad review is Meta's: a rejection arrives as `rejected` on an ad (and
 * `all_ads_rejected` on the campaign) some time AFTER launch, so, exactly like Facebook's DISAPPROVED, it has to be
 * polled (there is no webhook).
 */

export interface WhopRunFields {
  status?: string | null;
  delivery_status?: string | null;
}

/** What the sync should do to the campaign's own status. `null` = leave it alone. */
export type WhopSyncTarget = 'ACTIVE' | 'PAUSED' | 'META_REJECTED' | null;

const lower = (v: string | null | undefined): string => (v ?? '').toLowerCase();

/** An ad Meta rejected (or an ad whose rejection is being appealed). */
export function whopAdRejected(ad: WhopRunFields): boolean {
  const s = lower(ad.status);
  const d = lower(ad.delivery_status);
  return s === 'rejected' || d === 'rejected' || d === 'in_appeal';
}

/**
 * The campaign status to mirror from what Whop reports. Order matters and mirrors the Facebook reconcile:
 *  1. A rejection wins: any ad rejected, or Whop's own `all_ads_rejected` / `in_appeal`. It is the most actionable
 *     state and the only one that must release the channel and stop the redirect.
 *  2. Paused in Whop (campaign level) -> PAUSED; active in Whop -> ACTIVE. Everything else (a draft, an ended
 *     campaign, `ad_groups_off`, a review or flag state we do not know) is left alone: we only mirror what we are
 *     sure of, because a wrong flip re-routes live traffic.
 * A billing failure is not a state change (Whop keeps active/paused and stops delivering); `whopBillingFailed` says so.
 */
export function whopSyncTarget(campaign: WhopRunFields, ads: readonly WhopRunFields[]): WhopSyncTarget {
  const d = lower(campaign.delivery_status);
  if (d === 'all_ads_rejected' || d === 'in_appeal' || ads.some(whopAdRejected)) return 'META_REJECTED';
  const s = lower(campaign.status);
  if (s === 'paused' || d === 'paused') return 'PAUSED';
  if (s === 'active') return 'ACTIVE';
  return null;
}

export function whopBillingFailed(campaign: WhopRunFields): boolean {
  // Whop's spec says a billing failure keeps active / paused in `status` and sets delivery_status, but it also lists
  // `payment_failed` among the statuses: honour both.
  return lower(campaign.delivery_status) === 'payment_failed' || lower(campaign.status) === 'payment_failed';
}

/**
 * Whop's word -> the vocabulary the dashboard's status badges already colour (Facebook's effective_status), so a Whop
 * ad set or ad shows with the same tones. A word with no equivalent is shown as itself, upper-cased (the badge
 * humanizes it). Display only: nothing acts on these.
 */
const EFFECTIVE: Readonly<Record<string, string>> = {
  active: 'ACTIVE',
  learning: 'ACTIVE',
  paused: 'PAUSED',
  campaign_paused: 'CAMPAIGN_PAUSED',
  ad_group_paused: 'ADSET_PAUSED',
  ad_groups_off: 'ADSET_PAUSED',
  in_review: 'PENDING_REVIEW',
  in_appeal: 'PENDING_REVIEW',
  processing: 'IN_PROCESS',
  rejected: 'DISAPPROVED',
  all_ads_rejected: 'DISAPPROVED',
  issues: 'WITH_ISSUES',
  payment_failed: 'PENDING_BILLING_INFO',
  deleted: 'DELETED',
};

export function whopEffectiveStatus(raw: string | null | undefined): string | null {
  const w = lower(raw).trim();
  if (!w) return null;
  return EFFECTIVE[w] ?? w.toUpperCase();
}

/** An ad's display status: paused by us or the buyer wins over what review says about it. */
export function whopAdEffectiveStatus(ad: WhopRunFields): string | null {
  if (lower(ad.status) === 'paused') return 'PAUSED';
  if (lower(ad.status) === 'rejected') return 'DISAPPROVED';
  return whopEffectiveStatus(ad.delivery_status ?? ad.status);
}

/**
 * An ad group's display status from its ads' (Whop's bulk reads carry ads, not ad groups). A problem anywhere
 * shows; otherwise an ad group delivering any ad is ACTIVE; all paused is PAUSED.
 */
export function whopAdGroupEffectiveStatus(adStatuses: readonly (string | null)[]): string | null {
  const s = adStatuses.filter((x): x is string => Boolean(x));
  if (s.length === 0) return null;
  for (const bad of ['DISAPPROVED', 'WITH_ISSUES']) if (s.includes(bad)) return bad;
  if (s.includes('ACTIVE')) return 'ACTIVE';
  for (const wait of ['PENDING_REVIEW', 'IN_PROCESS']) if (s.includes(wait)) return wait;
  return s.every((x) => x === 'PAUSED') ? 'PAUSED' : s[0]!;
}
