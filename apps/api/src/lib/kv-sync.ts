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
  styleId?: string;
  fallbackUrl?: string;
  splits?: RedirectSplitPayload[];
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
  /** Click timestamp (unix ms) — used for the `fbc` identifier. */
  ts: number;
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
