/**
 * Conversion-tracking shared types/helpers (RSOC funnel → Facebook CAPI).
 *
 * The funnel fires THREE standard Facebook events as a paid visitor moves down it, so
 * Facebook sees the full shape and can optimize toward the deepest (money) event:
 *
 *   stage      fires when…                        → Facebook event   custom_event_type
 *   ─────────  ─────────────────────────────────  ────────────────   ─────────────────
 *   lander     the article page is viewed         → ViewContent      VIEW_CONTENT
 *   search     the /search results page is hit     → AddToCart        ADD_TO_CART
 *   adclick ★  a monetized AFS ad is clicked       → Search           SEARCH   ← MAIN
 *
 * `adclick` (the real ad click = AdSense revenue) is the MAIN conversion the ad set
 * optimizes toward (`promoted_object.custom_event_type = SEARCH`). The CAPI `event_name`
 * must equal the standard event for the stage, or Facebook records but won't optimize.
 */

/** The funnel stages, shallow → deep. `adclick` is the main (optimized) conversion. */
export const FUNNEL_STAGES = ['lander', 'search', 'adclick'] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

/** The stage the campaign optimizes toward (the deepest / money event). */
export const MAIN_CONVERSION_STAGE: FunnelStage = 'adclick';

/** Funnel stage → the standard Facebook event name (CAPI `event_name`). */
const PXE_TO_FB_EVENT: Record<string, string> = {
  lander: 'ViewContent',
  search: 'AddToCart',
  adclick: 'Search',
};

/** Map a funnel stage / pxe to its Facebook standard event name (default = the main, 'Search'). */
export function pxeToFbEvent(pxe: string | null | undefined): string {
  return PXE_TO_FB_EVENT[(pxe ?? '').toLowerCase()] ?? 'Search';
}

/** Map a funnel stage / pxe to the Facebook ad-set `custom_event_type` enum value. */
const PXE_TO_CUSTOM_EVENT_TYPE: Record<string, string> = {
  lander: 'VIEW_CONTENT',
  search: 'ADD_TO_CART',
  adclick: 'SEARCH',
};

/** Map a funnel stage / pxe to the Facebook `custom_event_type` (default = the main, 'SEARCH'). */
export function pxeToCustomEventType(pxe: string | null | undefined): string {
  return PXE_TO_CUSTOM_EVENT_TYPE[(pxe ?? '').toLowerCase()] ?? 'SEARCH';
}

/** Build the Facebook `fbc` click identifier from an `fbclid` + the click timestamp
 *  (ms). Format: `fb.1.<unix_ms>.<fbclid>`. Returns undefined without an fbclid. */
export function buildFbc(fbclid: string | null | undefined, clickTimeMs: number): string | undefined {
  if (!fbclid) return undefined;
  return `fb.1.${clickTimeMs}.${fbclid}`;
}

/** The conversion-beacon body the article funnel sends to /api/events. */
export interface ConversionBeacon {
  /** The redirect click id (txid). */
  clickId: string;
  /** Which funnel stage fired (lander | search | adclick) → maps to the FB event. */
  stage?: FunnelStage;
  /** Optional conversion value in minor units (cents) + currency. */
  valueMinor?: number;
  currency?: string;
  /** The page the conversion happened on (event_source_url). */
  url?: string;
}
