/**
 * Whop's click parameters, read at the edge. A click on a Whop ad lands on our go-link with `wacid`,
 * `wasid`, `waid` (Whop's campaign / ad group / ad ids) and Whop's utm set. The Worker records them
 * beside the click so the later conversion can be reported back to Whop (see the `whop` block of the
 * KV click record), and uses them to recognise a Whop click.
 *
 * ⚠️ This Worker must stay dependency-free (no `@knn/shared`), so this is a deliberate copy of
 * `extractWhopClick` in `packages/shared/src/whop.ts`. `whop-click.test.ts` runs both on the same inputs
 * and fails if they ever disagree. Pure string work, safe on the hot path.
 */

export interface WhopClickFields {
  campaignId?: string;
  adGroupId?: string;
  adId?: string;
  metaCampaignId?: string;
  metaAdSetId?: string;
  metaAdId?: string;
  utm: { source?: string; medium?: string; content?: string; adset?: string; placement?: string };
}

const CAMPAIGN_ID_RE = /^adcamp_[A-Za-z0-9]{6,40}$/;
const AD_GROUP_ID_RE = /^adgrp_[A-Za-z0-9]{6,40}$/;
const AD_ID_RE = /^ad_[A-Za-z0-9]{6,40}$/;
const META_ID_RE = /^[0-9]{6,30}$/;

const clip = (v: string | null, max = 200): string | undefined => {
  if (!v) return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
};

/** Whop's ids and flag from a landing query; null unless at least one is valid. Every value is validated and capped. */
export function extractWhopClick(q: URLSearchParams): WhopClickFields | null {
  const campaignId = CAMPAIGN_ID_RE.test(q.get('wacid') ?? '') ? q.get('wacid')! : undefined;
  const adGroupId = AD_GROUP_ID_RE.test(q.get('wasid') ?? '') ? q.get('wasid')! : undefined;
  const adId = AD_ID_RE.test(q.get('waid') ?? '') ? q.get('waid')! : undefined;
  const flagged = (q.get('utm_whop') ?? '').toLowerCase() === 'true';
  if (!campaignId && !adGroupId && !adId && !flagged) return null;
  const meta = (name: string): string | undefined => (META_ID_RE.test(q.get(name) ?? '') ? q.get(name)! : undefined);
  return {
    campaignId,
    adGroupId,
    adId,
    metaCampaignId: meta('utm_meta_campaign_id'),
    metaAdSetId: meta('utm_meta_adset_id'),
    metaAdId: meta('utm_meta_ad_id'),
    utm: {
      source: clip(q.get('utm_source'), 40),
      medium: clip(q.get('utm_medium'), 40),
      content: clip(q.get('utm_content')),
      adset: clip(q.get('utm_adset')),
      placement: clip(q.get('utm_placement'), 60),
    },
  };
}

/** A click from a Whop ad: a valid Whop id, or Whop's own `utm_whop=true` flag. */
export function hasWhopSignal(query: Record<string, string | undefined>): boolean {
  return (
    CAMPAIGN_ID_RE.test(query.wacid ?? '') ||
    AD_GROUP_ID_RE.test(query.wasid ?? '') ||
    AD_ID_RE.test(query.waid ?? '') ||
    (query.utm_whop ?? '').toLowerCase() === 'true'
  );
}

/** The parameters Whop attributes a click from: its own ids and utm set, plus Meta's `fbclid`. Nothing else is kept. */
const LANDING_PARAMS = [
  'wacid',
  'wasid',
  'waid',
  'utm_whop',
  'utm_meta_ad_id',
  'utm_meta_adset_id',
  'utm_meta_campaign_id',
  'utm_source',
  'utm_placement',
  'utm_medium',
  'utm_content',
  'utm_adset',
  'fbclid',
] as const;

/**
 * The landing URL as Whop sent the visitor (our go-link plus Whop's parameters). Whop resolves which ad
 * drove a visit from the query string of this URL, so a conversion reports it back whole. Only the
 * allow-listed parameters survive (values capped): our own routing params and anything a stranger appended
 * are never passed on.
 */
export function whopLandingUrl(url: URL): string {
  const keep = new URLSearchParams();
  for (const name of LANDING_PARAMS) {
    const value = url.searchParams.get(name);
    if (!value) continue;
    // Whop's ids keep their shape: a malformed one is dropped here, exactly as `extractWhopClick` drops it.
    const shape = ID_SHAPE[name];
    if (shape && !shape.test(value)) continue;
    keep.set(name, value.slice(0, 300));
  }
  const qs = keep.toString();
  return `${url.origin}${url.pathname}${qs ? `?${qs}` : ''}`;
}

const ID_SHAPE: Record<string, RegExp | undefined> = {
  wacid: CAMPAIGN_ID_RE,
  wasid: AD_GROUP_ID_RE,
  waid: AD_ID_RE,
  utm_meta_ad_id: META_ID_RE,
  utm_meta_adset_id: META_ID_RE,
  utm_meta_campaign_id: META_ID_RE,
};
