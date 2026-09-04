import { type FbRateLimiter, sharedRateLimiter } from './rate-limiter.js';
import { graphRequest } from './graph.js';

/**
 * Facebook Conversions API (CAPI) — server-side conversion events. The RSOC funnel
 * can't see the cross-origin AFS ad click, so the /search page infers it and beacons
 * the origin; the origin fires the conversion here, S2S, to the ad's pixel using the
 * owning buyer's token. Deduped by `event_id` (our click `txid`); attributed via `fbc`
 * (from the original `fbclid`). Goes through the shared Graph client (error
 * classification, backoff) like every other FB call (D12).
 */

export interface CapiUserData {
  /** fb.1.<unix_ms>.<fbclid> — the click identifier for attribution. */
  fbc?: string;
  fbp?: string;
  /** SHA-256 hex of a stable per-user id (we use the click id). Required by Facebook to
   *  be hashed even though the raw value isn't PII — sending it unhashed is a spec
   *  violation and Facebook silently discards the field. */
  external_id?: string;
  client_ip_address?: string;
  client_user_agent?: string;
}

export interface CapiEvent {
  /** Standard event name (e.g. 'Search'); MUST match the ad set's optimization event. */
  event_name: string;
  /** Unix time in SECONDS. */
  event_time: number;
  /** Dedup key (= our click txid). */
  event_id?: string;
  action_source?: string;
  event_source_url?: string;
  user_data: CapiUserData;
  custom_data?: { value?: number; currency?: string };
}

export interface SendConversionParams {
  /** The destination FB pixel id (from the ad set). */
  pixelId: string;
  /** An access token with access to that pixel (the buyer's connection token). */
  accessToken: string;
  event: CapiEvent;
  /** Events Manager "Test Events" code — set while validating (not in prod). */
  testEventCode?: string;
}

export interface CapiResult {
  events_received?: number;
  messages?: unknown[];
  fbtrace_id?: string;
}

/**
 * POST a single conversion event to `/{pixelId}/events`. Throws the classified FB
 * error (FbRateLimitError / FbConnectionBrokenError / FbApiError) on failure so the
 * caller (the CAPI dispatch worker) can retry/degrade appropriately.
 */
export async function sendConversionEvent(
  p: SendConversionParams,
  limiter: FbRateLimiter = sharedRateLimiter,
): Promise<CapiResult> {
  const params: Record<string, string> = { data: JSON.stringify([p.event]) };
  if (p.testEventCode) params.test_event_code = p.testEventCode;
  return graphRequest<CapiResult>(
    { path: `/${p.pixelId}/events`, method: 'POST', accessToken: p.accessToken, params },
    limiter,
  );
}
