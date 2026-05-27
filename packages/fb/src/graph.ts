import { env } from '@knn/config';
import { classifyFbError, type FbErrorBody } from './errors.js';
import { sharedRateLimiter, type FbRateLimiter } from './rate-limiter.js';

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

/** Derive a backoff hint from Facebook's rate-limit headers, if present. */
function parseRetryAfterMs(headers: Headers): number | undefined {
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
  if (req.accessToken) headers.Authorization = `Bearer ${req.accessToken}`;

  const init: RequestInit = { method, headers };
  if (method === 'GET') {
    for (const [k, v] of Object.entries(req.params ?? {})) url.searchParams.set(k, v);
  } else {
    init.body = new URLSearchParams(req.params ?? {});
  }

  const res = await fetch(url, init);
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
