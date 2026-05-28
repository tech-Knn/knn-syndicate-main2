/**
 * Conversion-tracking shared types/helpers (RSOC final ad-click → Facebook CAPI).
 * The ad set's `pxeEvent` selects which standard Facebook event the conversion maps
 * to. The CAPI `event_name` MUST match the event the ad set optimizes toward (its
 * `promoted_object.custom_event_type`), or Facebook records the conversion but won't
 * use it for delivery optimization.
 */

/** pxe → the standard Facebook event name used for both CAPI and ad-set optimization. */
const PXE_TO_FB_EVENT: Record<string, string> = {
  search: 'Search',
  lander: 'ViewContent',
  adclick: 'Lead',
};

/** Map an ad set's `pxeEvent` to its Facebook standard event name (default 'Search'). */
export function pxeToFbEvent(pxe: string | null | undefined): string {
  return PXE_TO_FB_EVENT[(pxe ?? '').toLowerCase()] ?? 'Search';
}

/** Build the Facebook `fbc` click identifier from an `fbclid` + the click timestamp
 *  (ms). Format: `fb.1.<unix_ms>.<fbclid>`. Returns undefined without an fbclid. */
export function buildFbc(fbclid: string | null | undefined, clickTimeMs: number): string | undefined {
  if (!fbclid) return undefined;
  return `fb.1.${clickTimeMs}.${fbclid}`;
}

/** The conversion-beacon body the /search page sends to /api/events. */
export interface ConversionBeacon {
  /** The redirect click id (txid). */
  clickId: string;
  /** Optional conversion value in minor units (cents) + currency. */
  valueMinor?: number;
  currency?: string;
  /** The page the conversion happened on (event_source_url). */
  url?: string;
}
