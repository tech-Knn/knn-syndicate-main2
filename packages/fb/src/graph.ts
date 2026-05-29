import { createHmac } from 'node:crypto';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { env } from '@knn/config';
import { classifyFbError, type FbErrorBody } from './errors.js';
import { sharedRateLimiter, type FbRateLimiter } from './rate-limiter.js';

/**
 * Optional egress proxy for outbound Facebook calls only (env `FB_HTTPS_PROXY`). Lets all
 * Graph traffic exit from a chosen region/IP (e.g. India) so server-side ad creation isn't
 * flagged as foreign-IP access from the EU host — without touching any other outbound call.
 * Built lazily + once; undefined when unconfigured → normal direct fetch.
 */
let fbProxyResolved = false;
let fbProxyAgent: ProxyAgent | undefined;
function getFbProxyAgent(): ProxyAgent | undefined {
  if (!fbProxyResolved) {
    fbProxyResolved = true;
    if (env.FB_HTTPS_PROXY) fbProxyAgent = new ProxyAgent(env.FB_HTTPS_PROXY);
  }
  return fbProxyAgent;
}

/**
 * `appsecret_proof` = HMAC-SHA256(access_token, app_secret), hex. Sent on every Graph
 * call made with a user/page token: it proves to Facebook the request genuinely
 * originates from OUR app's server (possession of the app secret), not a replayed/stolen
 * token. This is the single strongest signal against the "someone may have tried to
 * access your account" / pending-action security checkpoints on server-to-server ad
 * calls (which look suspicious precisely because they're a token used from a datacenter
 * IP). Pure + exported so it's unit-testable without env.
 */
export function computeAppSecretProof(accessToken: string, appSecret: string): string {
  return createHmac('sha256', appSecret).update(accessToken).digest('hex');
}

/**
 * Thin fetch-based Facebook Graph API client. We use fetch (not the official
 * SDK) so every call flows through our own rate-limit/backoff/circuit-breaker
 * layer and error classification (the SDK provides none of that). Calls scoped
 * to an `accountId` are gated per ad account (DECISION D12).
 */
export interface GraphRequest {
  path: string;
  method?: 'GET' | 'POST';
  params?: Record<string, string>;
  accessToken?: string;
  accountId?: string;
}

function graphBase(): string {
  return `https://graph.facebook.com/${env.FB_API_VERSION}`;
}

/** Derive a backoff hint from Facebook's rate-limit headers, if present. (Minimal header
 *  shape so it works for both the global fetch Response and undici's when proxied.) */
function parseRetryAfterMs(headers: { get(name: string): string | null }): number | undefined {
  const buc = headers.get('x-business-use-case-usage') ?? headers.get('x-app-usage');
  if (buc) {
    try {
      const parsed = JSON.parse(buc) as Record<string, Array<{ estimated_time_to_regain_access?: number }>>;
      const minutes = Object.values(parsed)
        .flat()
        .reduce((max, u) => Math.max(max, u.estimated_time_to_regain_access ?? 0), 0);
      if (minutes > 0) return minutes * 60_000;
    } catch {
      // not JSON; fall through
    }
  }
  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (!Number.isNaN(seconds)) return seconds * 1_000;
  }
  return undefined;
}

async function doRequest<T>(req: GraphRequest): Promise<T> {
  const url = new URL(graphBase() + req.path);
  const method = req.method ?? 'GET';
  const headers: Record<string, string> = {};
  const params: Record<string, string> = { ...(req.params ?? {}) };
  if (req.accessToken) {
    headers.Authorization = `Bearer ${req.accessToken}`;
    // Prove the call comes from our app's server (reduces token-replay security flags).
    if (env.FB_APP_SECRET) params.appsecret_proof = computeAppSecretProof(req.accessToken, env.FB_APP_SECRET);
  }

  const init: RequestInit = { method, headers };
  if (method === 'GET') {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  } else {
    init.body = new URLSearchParams(params);
  }

  // Debug: log the exact ad-build POSTs (campaign/adset/image/creative/ad) with secrets
  // and the image blob redacted, so we can reproduce the precise sequence. Gated on
  // FB_DEBUG_LOG so it's off unless explicitly enabled.
  if (env.FB_DEBUG_LOG && method === 'POST' && /\/(campaigns|adsets|ads|adimages|adcreatives)$/.test(req.path)) {
    const redacted: Record<string, string> = {};
    for (const [k, v] of Object.entries(params)) {
      redacted[k] = k === 'access_token' || k === 'appsecret_proof' ? '***' : k === 'bytes' ? `<base64 image, ${v.length} chars>` : v;
    }
    console.log(`[fb-call] POST ${graphBase()}${req.path} :: ${JSON.stringify(redacted)}`);
  }

  // Route FB calls through the egress proxy when configured (undici dispatcher); else
  // direct global fetch (unchanged path — what the tests stub).
  const proxy = getFbProxyAgent();
  const res = proxy
    ? await undiciFetch(url, { method, headers, body: init.body as URLSearchParams | undefined, dispatcher: proxy })
    : await fetch(url, init);
  const text = await res.text();
  let json: unknown = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }

  const errBody = (json as { error?: FbErrorBody }).error;
  if (!res.ok || errBody) {
    throw classifyFbError(errBody ?? { message: `HTTP ${res.status}` }, res.status, parseRetryAfterMs(res.headers));
  }
  return json as T;
}

export function graphRequest<T>(req: GraphRequest, limiter: FbRateLimiter = sharedRateLimiter): Promise<T> {
  if (req.accountId) return limiter.run(req.accountId, () => doRequest<T>(req));
  return doRequest<T>(req);
}
