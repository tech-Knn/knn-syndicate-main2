import { WhopApiError, parseWhopErrorBody, retryAfterMs, whopErrorKind } from './errors.js';
import { type WhopRateLimiter, credentialFingerprint, operationKey, sharedWhopRateLimiter } from './rate-limit.js';

/**
 * Whop's API is versioned by date and breaking changes only ship in a new dated version, so we PIN
 * one. 2026-09-29 is the latest at the time of writing and includes everything the ads calls need
 * (language-tagged ad copy, the direct file-upload flow, account-level payment retry).
 */
export const DEFAULT_WHOP_VERSION_DATE = '2026-09-29';

/**
 * Whop adds a `recommended_action` field to its responses: marketing text for its paid "Economic
 * Intelligence" feature, worded as instructions to an AI agent. It is not data we use, so it is removed
 * at the door. That way it can never reach a log line, the database, the dashboard, or any agent that
 * later reads those. Nothing in this codebase may act on it (never PATCH the account's preferences).
 */
export function stripAdvice<T>(value: T): T {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'recommended_action' in value) {
    const { recommended_action: _advice, ...rest } = value as Record<string, unknown>;
    return rest as T;
  }
  return value;
}

export type QueryValue = string | number | boolean | null | undefined | readonly (string | number)[];

export interface WhopRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Path under the API root, e.g. `/ad_campaigns` or `/ads/ad_123/pause`. */
  path: string;
  /** Arrays repeat the parameter (`ad_campaign_ids=a&ad_campaign_ids=b`); null and undefined are skipped. */
  query?: Record<string, QueryValue>;
  body?: unknown;
  /**
   * Makes a POST safe to retry: Whop stores the response for 24 hours and replays it. A POST without a
   * key is NEVER retried by the client (a retry could create a second object).
   */
  idempotencyKey?: string;
  /**
   * For POSTs the API deduplicates by itself, so a retry can never create a second object: events
   * (`event_name` + `event_id` collapse to one, verified against the sandbox). Makes the POST retryable
   * without an `Idempotency-Key`.
   */
  naturallyIdempotent?: boolean;
  timeoutMs?: number;
}

export interface WhopClientOptions {
  apiKey: string;
  baseUrl?: string;
  versionDate?: string;
  fetch?: typeof fetch;
  /** Per attempt. Default 30s. */
  timeoutMs?: number;
  /** Retries after the first attempt, for 429 / 5xx / network / timeout. Default 3. */
  maxRetries?: number;
  baseDelayMs?: number;
  /** Longest wait we will sleep inside a call; a longer `Retry-After` is raised to the caller instead. */
  maxDelayMs?: number;
  /** 0..1 random extra delay on top of the exponential back-off. Default 0.2. */
  jitter?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Pass `false` to disable client-side pacing. Default: the process-wide shared limiter. */
  limiter?: WhopRateLimiter | false;
  userAgent?: string;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function buildUrl(baseUrl: string, path: string, query?: Record<string, QueryValue>): string {
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, String(item));
    else url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function isRetryable(err: WhopApiError, maxDelayMs: number): boolean {
  if (err.kind === 'rate_limited') return (err.retryAfterMs ?? 0) <= maxDelayMs;
  return err.kind === 'server' || err.kind === 'network' || err.kind === 'timeout';
}

/**
 * A small, dependency-free Whop API client. The API key lives in a private field, so printing or
 * serializing the client never reveals it, and it is never part of an error message.
 */
export class WhopClient {
  readonly baseUrl: string;
  readonly versionDate: string;
  readonly #apiKey: string;
  readonly #fingerprint: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #baseDelayMs: number;
  readonly #maxDelayMs: number;
  readonly #jitter: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #limiter: WhopRateLimiter | null;
  readonly #userAgent: string;

  constructor(opts: WhopClientOptions) {
    if (!opts.apiKey.trim()) throw new Error('WhopClient needs an API key');
    this.#apiKey = opts.apiKey.trim();
    this.#fingerprint = credentialFingerprint(this.#apiKey);
    this.baseUrl = opts.baseUrl ?? 'https://api.whop.com/api/v1';
    this.versionDate = opts.versionDate ?? DEFAULT_WHOP_VERSION_DATE;
    this.#fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = opts.timeoutMs ?? 30_000;
    this.#maxRetries = opts.maxRetries ?? 3;
    this.#baseDelayMs = opts.baseDelayMs ?? 500;
    this.#maxDelayMs = opts.maxDelayMs ?? 30_000;
    this.#jitter = opts.jitter ?? 0.2;
    this.#sleep = opts.sleep ?? defaultSleep;
    this.#limiter = opts.limiter === false ? null : (opts.limiter ?? sharedWhopRateLimiter);
    this.#userAgent = opts.userAgent ?? 'knn-syndicate-whop-client/1';
  }

  /** Send one request, retrying transient failures. Throws `WhopApiError` for every failure. */
  async request<T = unknown>(req: WhopRequest): Promise<T> {
    const url = buildUrl(this.baseUrl, req.path, req.query);
    const retriable = req.method !== 'POST' || Boolean(req.idempotencyKey) || req.naturallyIdempotent === true;
    const limiterKey = `${this.#fingerprint}:${operationKey(req.method, req.path)}`;
    for (let attempt = 0; ; attempt++) {
      if (this.#limiter) await this.#limiter.acquire(limiterKey);
      try {
        return await this.#once<T>(url, req);
      } catch (err) {
        if (!(err instanceof WhopApiError) || !retriable || attempt >= this.#maxRetries || !isRetryable(err, this.#maxDelayMs)) throw err;
        await this.#sleep(this.#delayFor(err, attempt));
      }
    }
  }

  #delayFor(err: WhopApiError, attempt: number): number {
    if (err.retryAfterMs !== undefined) return err.retryAfterMs;
    const backoff = Math.min(this.#maxDelayMs, this.#baseDelayMs * 2 ** attempt);
    return Math.round(backoff * (1 + this.#jitter * Math.random()));
  }

  async #once<T>(url: string, req: WhopRequest): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#apiKey}`,
      accept: 'application/json',
      'api-version-date': this.versionDate,
      'user-agent': this.#userAgent,
    };
    if (req.body !== undefined) headers['content-type'] = 'application/json';
    if (req.idempotencyKey && req.method === 'POST') headers['idempotency-key'] = req.idempotencyKey;
    const where = { method: req.method, path: req.path };

    let res: Response;
    let text: string;
    try {
      res = await this.#fetch(url, {
        method: req.method,
        headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        signal: AbortSignal.timeout(req.timeoutMs ?? this.#timeoutMs),
      });
      text = await res.text();
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new WhopApiError(timedOut ? 'timeout' : 'network', timedOut ? 'Whop did not answer in time.' : 'Could not reach Whop.', { status: 0, ...where });
    }

    if (res.ok) {
      if (!text) return undefined as T;
      try {
        return stripAdvice(JSON.parse(text)) as T;
      } catch {
        throw new WhopApiError('server', 'Whop returned an unreadable response.', { status: res.status, ...where });
      }
    }

    const parsed = parseWhopErrorBody(text);
    throw new WhopApiError(whopErrorKind(res.status), parsed.message ?? `Whop returned ${res.status}.`, {
      status: res.status,
      type: parsed.type,
      code: parsed.code,
      depositUrl: parsed.depositUrl,
      retryAfterMs: res.status === 429 ? retryAfterMs(res.headers, parsed.message) : undefined,
      ...where,
    });
  }
}

export function createWhopClient(opts: WhopClientOptions): WhopClient {
  return new WhopClient(opts);
}
