/**
 * Which ad network runs a campaign (D33). Facebook is every campaign that existed before Whop Ads; a Whop campaign
 * has no Facebook ids at all. The two never share columns: "no Facebook ids" must never be read as "not
 * launched", and a Whop id must never be stored in a Facebook column (the Facebook jobs are id-gated, and that
 * gate is what keeps them off Whop rows).
 */

export const AD_PROVIDERS = ['FACEBOOK', 'WHOP'] as const;
export type AdProvider = (typeof AD_PROVIDERS)[number];

export const AD_PROVIDER_LABEL: Readonly<Record<AdProvider, string>> = { FACEBOOK: 'Facebook', WHOP: 'Whop' };

export function isAdProvider(value: unknown): value is AdProvider {
  return value === 'FACEBOOK' || value === 'WHOP';
}

/** The fields the launched-ness helpers read; any row shape that carries them will do. */
export interface ProviderFields {
  adProvider?: string | null;
  fbCampaignId?: string | null;
  whopCampaignId?: string | null;
  status?: string | null;
}

/** Whop states in which a campaign has been launched at Whop at least once. */
const WHOP_LAUNCHED_STATUSES: ReadonlySet<string> = new Set(['ACTIVE', 'PAUSED', 'META_REJECTED']);

/**
 * Does the campaign exist at its ad network? Facebook: it was created there. Whop: it was created there too, but
 * only as a DRAFT until launch, so this is true from the first create call.
 */
export function hasProviderCampaign(c: ProviderFields): boolean {
  return c.adProvider === 'WHOP' ? c.whopCampaignId != null : c.fbCampaignId != null;
}

/**
 * Has the campaign been LAUNCHED (is it, or was it, live)? This is what every "launched" check should ask instead
 * of `fbCampaignId != null`, which is false for every Whop campaign. A Whop draft that failed its launch gates
 * exists at Whop (`hasProviderCampaign`) but is not launched.
 */
export function isLaunched(c: ProviderFields): boolean {
  if (c.adProvider === 'WHOP') return c.whopCampaignId != null && WHOP_LAUNCHED_STATUSES.has(String(c.status));
  return c.fbCampaignId != null;
}
