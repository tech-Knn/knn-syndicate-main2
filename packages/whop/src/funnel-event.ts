import { whopEventForStoredName } from '@knn/shared';
import type { WhopEventContext, WhopEventInput } from './api.js';

/**
 * Turns one funnel event we stored (lander / search / adclick) into the server event Whop expects.
 *
 * The shape follows what ClickFlare sends to Whop in production for the same job (its Whop Conversion API
 * integration): the landing URL with its query string, the visitor's IP and user agent, a stable event id,
 * plus Whop's own ad ids. Whop resolves which ad drove the visit from those, not from a cookie, because
 * the money page carries no Whop pixel: the pixel lives on the page Whop's check sees (see the white
 * Worker), and conversions arrive from here.
 *
 * Pure: no database, no network, no clock except what you pass in.
 */

/** Whop rejects events older than 28 days. Stop a day early so a late retry never crosses the line. */
export const WHOP_EVENT_MAX_AGE_MS = 27 * 86_400_000;

/** The Whop click fields the redirect Worker recorded (same names as `WhopClick` in `@knn/shared`). */
export interface WhopClickFields {
  campaignId?: string;
  adGroupId?: string;
  adId?: string;
  metaCampaignId?: string;
  metaAdSetId?: string;
  metaAdId?: string;
  utm?: { source?: string; medium?: string; content?: string; adset?: string; placement?: string };
}

export interface FunnelEventForWhop {
  /** The Whop business the ad runs under. */
  bizId: string;
  /** `conversion_events.event_name`: Facebook's names (ViewContent / AddToCart / Search), which Analytics keys on. */
  storedEventName: string;
  /** Our click id (txid). Unique per visit, so it is the event id: Whop keeps one copy per name + id. */
  clickId: string;
  occurredAt: Date;
  /** The URL the visitor landed on from the Whop ad (our redirect link plus Whop's own parameters). */
  landingUrl?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  fbclid?: string | null;
  fbc?: string | null;
  fbp?: string | null;
  click?: WhopClickFields | null;
  valueMinor?: number | null;
  currency?: string | null;
}

/** True when Whop would refuse the event for its age (or soon will): do not send, it can never succeed. */
export function whopEventTooOld(occurredAt: Date, now: Date = new Date()): boolean {
  return now.getTime() - occurredAt.getTime() > WHOP_EVENT_MAX_AGE_MS;
}

function compact<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')) as Partial<T>;
}

/** The Whop event for a stored funnel event, or null when the stored name is not one of the funnel's. */
export function buildWhopEvent(e: FunnelEventForWhop): WhopEventInput | null {
  const eventName = whopEventForStoredName(e.storedEventName);
  if (!eventName) return null;
  const click = e.click ?? {};
  const utm = click.utm ?? {};
  const context: WhopEventContext = compact({
    ad_campaign_id: click.campaignId,
    ad_set_id: click.adGroupId,
    ad_id: click.adId,
    fbclid: e.fbclid,
    fbc: e.fbc,
    fbp: e.fbp,
    ip_address: e.ipAddress,
    user_agent: e.userAgent,
    utm_source: utm.source,
    utm_medium: utm.medium,
    utm_content: utm.content,
  });
  return compact({
    account_id: e.bizId,
    event_name: eventName,
    event_id: e.clickId,
    event_time: e.occurredAt.toISOString(),
    action_source: 'website' as const,
    url: e.landingUrl,
    value: e.valueMinor != null && e.valueMinor > 0 ? e.valueMinor / 100 : undefined,
    currency: e.valueMinor != null && e.valueMinor > 0 ? (e.currency || 'USD').toLowerCase() : undefined,
    context: Object.keys(context).length ? context : undefined,
    // No visitor cookie exists on the money page, so the click id ties the visit's events together.
    user: { external_id: e.clickId },
  }) as WhopEventInput;
}
