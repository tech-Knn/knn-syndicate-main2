/**
 * Facebook ad-launch option lists (parity with native Ads Manager). Stored as our
 * own stable keys; mapped to the exact Graph API values in the launch pipeline.
 */

/** FB Special Ad Categories — declared per campaign (empty = NONE). */
export const SPECIAL_AD_CATEGORIES = [
  'HOUSING',
  'EMPLOYMENT',
  'CREDIT',
  'ISSUES_ELECTIONS_POLITICS',
  'FINANCIAL_PRODUCTS_SERVICES',
  'ONLINE_GAMBLING_AND_GAMING',
] as const;
export type SpecialAdCategory = (typeof SPECIAL_AD_CATEGORIES)[number];

/** How conversions are reported back (drives ROAS): instant (no revenue) vs estimates. */
export const CONVERSION_TYPES = ['instant', 'estimates'] as const;
export type ConversionType = (typeof CONVERSION_TYPES)[number];

export const DEVICE_PLATFORMS = ['desktop', 'mobile'] as const; // empty = all
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

export const MOBILE_OS = ['ios', 'android'] as const; // empty = all
export type MobileOs = (typeof MOBILE_OS)[number];

/** Common FB attribution windows. */
export const ATTRIBUTION_WINDOWS = ['1d_view', '1d_click', '7d_click', '7d_click_1d_view'] as const;
export type AttributionWindow = (typeof ATTRIBUTION_WINDOWS)[number];

/** Bid strategies (friendly label → Graph value handled at launch). */
export const BID_STRATEGIES = [
  'LOWEST_COST_WITHOUT_CAP', // "Highest volume"
  'LOWEST_COST_WITH_BID_CAP', // "Bid cap"
  'COST_CAP', // "Cost per result goal"
  'LOWEST_COST_WITH_MIN_ROAS', // "ROAS goal"
] as const;
export type BidStrategy = (typeof BID_STRATEGIES)[number];

export interface LanguageOption {
  code: string;
  name: string;
}

/** Common targeting languages (ISO codes; mapped to FB locale ids at launch). */
export const LANGUAGES: LanguageOption[] = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'it', name: 'Italian' },
  { code: 'nl', name: 'Dutch' },
  { code: 'sv', name: 'Swedish' },
  { code: 'no', name: 'Norwegian' },
  { code: 'da', name: 'Danish' },
  { code: 'fi', name: 'Finnish' },
  { code: 'pl', name: 'Polish' },
  { code: 'cs', name: 'Czech' },
  { code: 'ro', name: 'Romanian' },
  { code: 'el', name: 'Greek' },
  { code: 'tr', name: 'Turkish' },
  { code: 'ru', name: 'Russian' },
  { code: 'uk', name: 'Ukrainian' },
  { code: 'ar', name: 'Arabic' },
  { code: 'he', name: 'Hebrew' },
  { code: 'hi', name: 'Hindi' },
  { code: 'id', name: 'Indonesian' },
  { code: 'ms', name: 'Malay' },
  { code: 'th', name: 'Thai' },
  { code: 'vi', name: 'Vietnamese' },
  { code: 'zh', name: 'Chinese' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
];

/** Granular placements (FB position keys), grouped by platform. */
export const PLACEMENT_OPTIONS = [
  { key: 'facebook_feed', platform: 'Facebook', label: 'Feed' },
  { key: 'facebook_marketplace', platform: 'Facebook', label: 'Marketplace' },
  { key: 'facebook_video_feeds', platform: 'Facebook', label: 'Video feeds' },
  { key: 'facebook_right_hand_column', platform: 'Facebook', label: 'Right column' },
  { key: 'facebook_story', platform: 'Facebook', label: 'Stories' },
  { key: 'facebook_reels', platform: 'Facebook', label: 'Reels' },
  { key: 'facebook_search', platform: 'Facebook', label: 'Search results' },
  { key: 'instagram_stream', platform: 'Instagram', label: 'Feed' },
  { key: 'instagram_story', platform: 'Instagram', label: 'Stories' },
  { key: 'instagram_explore', platform: 'Instagram', label: 'Explore' },
  { key: 'instagram_reels', platform: 'Instagram', label: 'Reels' },
  { key: 'instagram_search', platform: 'Instagram', label: 'Search' },
  { key: 'messenger_inbox', platform: 'Messenger', label: 'Inbox' },
  { key: 'messenger_story', platform: 'Messenger', label: 'Stories' },
  { key: 'audience_network_classic', platform: 'Audience Network', label: 'Native/banner' },
  { key: 'audience_network_rewarded_video', platform: 'Audience Network', label: 'Rewarded video' },
] as const;
export const PLACEMENT_KEYS = PLACEMENT_OPTIONS.map((p) => p.key) as unknown as readonly [
  string,
  ...string[],
];
export type PlacementKey = (typeof PLACEMENT_OPTIONS)[number]['key'];
