import { env } from '@knn/config';

/**
 * Origin → Cloudflare KV write-through sync (Phase 7/8). At launch the origin
 * writes each ad's redirect config to the edge Worker's KV namespace
 * (`redirect:{redirectId}`); the Worker reads it on the hot path. The value shape
 * is the contract with `apps/redirect/src/resolve.ts#RedirectConfig` (plain JSON).
 */
/** One weighted destination — an A/B split or (Phase E) a campaign PAID offer
 *  carrying its own AFS channel + offer id. Mirrors `resolve.ts#RedirectSplit`. */
export interface RedirectSplitPayload {
  url: string;
  weight: number;
  channel?: string;
  offerId?: string;
}

export interface RedirectConfigPayload {
  campaignId: string;
  active: boolean;
  articleUrl: string;
  channel?: string;
  /** referrerAdCreative (AFS `rc`) — the campaign-level Referrer Ad Creative. */
  adCreative?: string;
  /** Expected FB ad id (ad.fbAdId) — the cloaker verifies the click's `kaid` macro against it. */
  expectedAdId?: string;
  styleId?: string;
  fallbackUrl?: string;
  splits?: RedirectSplitPayload[];
  /**
   * Whop Ads campaigns only (D33): the Whop business this link belongs to. Makes the edge Worker recognise
   * a click on a Whop ad, record Whop's click parameters beside the click, and tag the non-paid landing
   * with a signed scope so that page carries the business's pixel. Absent for Facebook. Mirrors
   * `apps/redirect/src/resolve.ts#RedirectConfig.whop`. A Whop campaign's config is built ONLY by
   * `syncCampaignRedirectConfigs` (launch-routing.ts), which emits it, and never carries `expectedAdId`
   * (Whop hides the Meta ad id); the inline builder in `launchCampaign` is Facebook only.
   */
  whop?: { bizId: string };
}

export class KvNotConfiguredError extends Error {
  constructor() {
    super('Cloudflare KV not configured (CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID / CF_KV_NAMESPACE_ID)');
    this.name = 'KvNotConfiguredError';
  }
}

export function isKvConfigured(): boolean {
  return Boolean(env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID && env.CF_KV_NAMESPACE_ID);
}

function base(): string {
  return `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${env.CF_KV_NAMESPACE_ID}`;
}
const authHeader = (): Record<string, string> => ({ authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` });
const redirectKey = (redirectId: string): string => `redirect:${redirectId}`;

/** Bulk write/refresh redirect configs (one CF API call). No-op for an empty list. */
export async function writeRedirectConfigs(
  entries: { redirectId: string; config: RedirectConfigPayload }[],
): Promise<void> {
  if (entries.length === 0) return;
  if (!isKvConfigured()) throw new KvNotConfiguredError();
  const body = entries.map((e) => ({ key: redirectKey(e.redirectId), value: JSON.stringify(e.config) }));
  const res = await fetch(`${base()}/bulk`, {
    method: 'PUT',
    headers: { ...authHeader(), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`KV bulk write failed: ${res.status} ${await res.text().catch(() => '')}`);
}

/** Transient click record the edge Worker writes to KV (`click:{txid}`) on a paid
 *  click, read back at conversion time to resolve the ad + fbclid. */
export interface ClickRecord {
  redirectId: string;
  fbclid?: string;
  /** The offer the click was routed to (Phase E) — the per-offer attribution key. */
  offerId?: string;
  /** Click timestamp (unix ms) — the FB-ad-click time, used as `fbc`'s middle field. */
  ts: number;
  /** Synthesized `_fbp` browser id (`fb.1.<clickTimeMs>.<10digits>`), minted at the edge
   *  because pure-S2S has no in-browser pixel. Reused across every funnel event for this
   *  click so Facebook sees a stable browser id per visitor. Absent on legacy records
   *  written before this field was added — CAPI dispatch handles the missing case. */
  fbp?: string;
  /** Visitor's real IP at click time, captured at the Cloudflare edge via
   *  `CF-Connecting-IP`. This is the IP Facebook saw when issuing the fbclid, so it's
   *  the best match signal for CAPI's `client_ip_address`. Beacon-time `req.ip` (used
   *  as the fallback in events.service) can be a shared reverse-proxy IP, which is why
   *  we prefer this value. Absent on legacy records written before this field was
   *  added — the service layer falls back to the beacon-time IP. */
  clientIp?: string;
  /**
   * Whop Ads clicks only (D33), written by the edge Worker for a config that has a `whop` block: the business
   * the link belongs to, Whop's own click ids, and the landing URL Whop sent the visitor to (our go-link plus
   * Whop's parameters only). Whop resolves which ad drove a visit from those, so a conversion reports them
   * back. Absent on Facebook clicks and on legacy records.
   */
  whop?: {
    bizId: string;
    click?: {
      campaignId?: string;
      adGroupId?: string;
      adId?: string;
      metaCampaignId?: string;
      metaAdSetId?: string;
      metaAdId?: string;
      utm?: { source?: string; medium?: string; content?: string; adset?: string; placement?: string };
    };
    landing?: string;
  };
}

/** Read a click record by txid from KV. Returns null when the key is absent (404). */
export async function readClick(txid: string): Promise<ClickRecord | null> {
  if (!isKvConfigured()) throw new KvNotConfiguredError();
  const res = await fetch(`${base()}/values/${encodeURIComponent(`click:${txid}`)}`, { headers: authHeader() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`KV click read failed: ${res.status}`);
  try {
    return JSON.parse(await res.text()) as ClickRecord;
  } catch {
    return null;
  }
}

/** Delete a redirect config (on pause/stop) — 404 is treated as already-gone. */
export async function deleteRedirectConfig(redirectId: string): Promise<void> {
  if (!isKvConfigured()) throw new KvNotConfiguredError();
  const res = await fetch(`${base()}/values/${encodeURIComponent(redirectKey(redirectId))}`, {
    method: 'DELETE',
    headers: authHeader(),
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`KV delete failed: ${res.status}`);
  }
}
