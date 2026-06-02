/**
 * Pure, runtime-agnostic redirect decision (works identically on a Cloudflare
 * Worker, Node, or in tests — no I/O here). The Worker handles the KV lookup +
 * txid minting and delegates the actual routing to `resolveRedirect`.
 *
 * Funnel (D8/D9): a paid FB click on `/go/:redirectId` → 302 to the campaign's
 * content page with the AFS params (`rc` ad creative, `ch` channel, `rac`, optional
 * `styleId`) + our `txid` for attribution; organic/bot/paused → the fallback.
 */

/**
 * A weighted destination for a paid click. Plain A/B splits carry just `url` +
 * `weight`; Phase-E **offers** additionally carry the offer's own `channel` (its
 * AdSense channel, for per-offer attribution — overrides `config.channel`) and
 * `offerId` (logged so revenue can be attributed back to the offer).
 */
export interface RedirectSplit {
  /** The destination article URL on the offer's website (e.g. https://site2.com/a/slug). */
  url: string;
  weight: number;
  /** The offer's AFS channel; sets `ch` for this destination (overrides config.channel). */
  channel?: string;
  /** The offer this destination routes to (logged for per-offer attribution, Phase F). */
  offerId?: string;
}

/** Per-ad redirect config (stored in KV as `redirect:{redirectId}`). */
export interface RedirectConfig {
  campaignId: string;
  /** Campaign live? Paused/stopped → send to the fallback, not the monetized page. */
  active: boolean;
  /** Full content-page URL, precomputed by the origin (e.g. https://articles.x/a/slug). */
  articleUrl: string;
  /** AdSense channel for this campaign (the `ch` value → per-campaign attribution).
   *  Used when the picked split has no channel of its own (legacy / single-offer). */
  channel?: string;
  rac?: string;
  /** This ad's creative text — `referrerAdCreative` (required for paid traffic). */
  adCreative?: string;
  styleId?: string;
  /** Where non-ad (organic/bot) traffic goes; defaults to the article page itself.
   *  Phase E: the campaign's ORGANIC offer destination, when one is configured. */
  fallbackUrl?: string;
  /** Weighted destinations: A/B splits or the campaign's PAID offers (Phase E).
   *  Weights need not sum to 100 (normalized at pick time). */
  splits?: RedirectSplit[];
  /** Expected FB ad id (ad.fbAdId). When present + verifyMode 'enforce', a paid click must carry a
   *  matching `kaid` ({{ad.id}} macro) to reach the money page. Absent → legacy (base paid logic). */
  expectedAdId?: string;
  /** 'observe' (default): route exactly as today, only RECORD what verification would decide (zero
   *  revenue risk). 'enforce': require the ad-id match for paid traffic. Set globally by the Worker. */
  verifyMode?: 'observe' | 'enforce';
}

/** The cloak ad-id verification outcome for a click (observe-first telemetry). */
export type VerifyOutcome = 'match' | 'mismatch' | 'missing' | 'na';

/** Pure: did this paid click prove it came from the expected ad? `na` when not paid / no expected id. */
function verifyOutcome(config: RedirectConfig, query: QueryParams, basePaid: boolean): VerifyOutcome {
  if (!basePaid || !config.expectedAdId) return 'na';
  const kaid = query.kaid; // FB {{ad.id}} macro, stamped on real ad clicks via url_tags
  if (!kaid) return 'missing';
  return kaid === config.expectedAdId ? 'match' : 'mismatch';
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
export function pickSplit(splits: RedirectSplit[] | undefined, rand: number): RedirectSplit | undefined {
  if (!splits || splits.length === 0) return undefined;
  const total = splits.reduce((sum, s) => sum + Math.max(0, s.weight), 0);
  if (total <= 0) return splits[0];
  let r = rand * total;
  for (const s of splits) {
    r -= Math.max(0, s.weight);
    if (r < 0) return s;
  }
  return splits[splits.length - 1];
}

export interface RedirectDecision {
  location: string;
  paid: boolean;
  txid: string;
  /** The offer the click was routed to (Phase E), when splits carry offer ids. */
  offerId?: string;
  /** Cloaker telemetry: the actual route taken + the would-be-enforce ad-id verification outcome. */
  verify: { route: 'money' | 'white'; outcome: VerifyOutcome };
}

/**
 * Decide where a click goes. Paid + active → the weighted-picked offer/split content
 * page with AFS params + txid (the picked offer's channel wins over config.channel).
 * Organic/bot or inactive → the fallback (the ORGANIC offer, when configured).
 */
export function resolveRedirect(
  config: RedirectConfig,
  query: QueryParams,
  opts: { txid: string; rand?: number },
): RedirectDecision {
  const basePaid = isPaidTraffic(query);
  const outcome = verifyOutcome(config, query, basePaid);

  // Final routing. ENFORCE (only when an expected ad id is configured) requires the macro to match;
  // OBSERVE / legacy (no expected id) routes exactly as the base paid signal → zero revenue risk.
  const enforce = config.verifyMode === 'enforce' && Boolean(config.expectedAdId);
  const paid = enforce ? basePaid && outcome === 'match' : basePaid;

  if (!paid || !config.active) {
    return { location: config.fallbackUrl || config.articleUrl, paid, txid: opts.txid, verify: { route: 'white', outcome } };
  }

  const picked = pickSplit(config.splits, opts.rand ?? Math.random());
  const url = new URL(picked?.url ?? config.articleUrl);
  if (config.adCreative) url.searchParams.set('rc', config.adCreative);
  // The picked offer's channel takes precedence over the campaign-level channel.
  const channel = picked?.channel ?? config.channel;
  if (channel) url.searchParams.set('ch', channel);
  if (config.rac) url.searchParams.set('rac', config.rac);
  if (config.styleId) url.searchParams.set('styleId', config.styleId);
  url.searchParams.set('txid', opts.txid);
  return { location: url.toString(), paid, txid: opts.txid, offerId: picked?.offerId, verify: { route: 'money', outcome } };
}
