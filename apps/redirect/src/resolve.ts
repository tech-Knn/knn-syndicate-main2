/**
 * Pure, runtime-agnostic redirect decision (works identically on a Cloudflare
 * Worker, Node, or in tests — no I/O here). The Worker handles the KV lookup +
 * txid minting and delegates the actual routing to `resolveRedirect`.
 *
 * Funnel (D8/D9): a paid FB click on `/go/:redirectId` → 302 to the campaign's
 * content page with the AFS params (`rc` ad creative, `ch` channel, `rac`, optional
 * `styleId`) + our `txid` for attribution; organic/bot/paused → the fallback.
 */

/** Per-ad redirect config (stored in KV as `redirect:{redirectId}`). */
export interface RedirectConfig {
  campaignId: string;
  /** Campaign live? Paused/stopped → send to the fallback, not the monetized page. */
  active: boolean;
  /** Full content-page URL, precomputed by the origin (e.g. https://articles.x/a/slug). */
  articleUrl: string;
  /** AdSense channel for this campaign (the `ch` value → per-campaign attribution). */
  channel?: string;
  rac?: string;
  /** This ad's creative text — `referrerAdCreative` (required for paid traffic). */
  adCreative?: string;
  styleId?: string;
  /** Where non-ad (organic/bot) traffic goes; defaults to the article page itself. */
  fallbackUrl?: string;
  /** Optional weighted destinations for A/B traffic split (weights need not sum to 100). */
  splits?: { url: string; weight: number }[];
}

export type QueryParams = Record<string, string | undefined>;

const PAID_SOURCES = new Set(['facebook', 'fb', 'ig', 'instagram', 'meta']);

/** Paid (FB ad) traffic? fbclid present OR a Facebook/Meta utm_source. */
export function isPaidTraffic(query: QueryParams): boolean {
  if (query.fbclid) return true;
  const src = (query.utm_source ?? '').toLowerCase();
  return PAID_SOURCES.has(src);
}

/** Weighted-random pick from `splits` using `rand` ∈ [0,1). Returns undefined if none. */
export function pickSplit(
  splits: { url: string; weight: number }[] | undefined,
  rand: number,
): string | undefined {
  if (!splits || splits.length === 0) return undefined;
  const total = splits.reduce((sum, s) => sum + Math.max(0, s.weight), 0);
  if (total <= 0) return splits[0]?.url;
  let r = rand * total;
  for (const s of splits) {
    r -= Math.max(0, s.weight);
    if (r < 0) return s.url;
  }
  return splits[splits.length - 1]?.url;
}

export interface RedirectDecision {
  location: string;
  paid: boolean;
  txid: string;
}

/**
 * Decide where a click goes. Paid + active → the (possibly split-selected) content
 * page with AFS params + txid. Organic/bot or inactive → the fallback.
 */
export function resolveRedirect(
  config: RedirectConfig,
  query: QueryParams,
  opts: { txid: string; rand?: number },
): RedirectDecision {
  const paid = isPaidTraffic(query);
  if (!paid || !config.active) {
    return { location: config.fallbackUrl || config.articleUrl, paid, txid: opts.txid };
  }

  const base = pickSplit(config.splits, opts.rand ?? Math.random()) ?? config.articleUrl;
  const url = new URL(base);
  if (config.adCreative) url.searchParams.set('rc', config.adCreative);
  if (config.channel) url.searchParams.set('ch', config.channel);
  if (config.rac) url.searchParams.set('rac', config.rac);
  if (config.styleId) url.searchParams.set('styleId', config.styleId);
  url.searchParams.set('txid', opts.txid);
  return { location: url.toString(), paid, txid: opts.txid };
}
