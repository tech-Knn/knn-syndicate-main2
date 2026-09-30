import { createHash } from 'node:crypto';

/**
 * Client-side pacing for Whop's limit of 600 requests per minute PER OPERATION and API credential.
 * We stay under it (default 500) so a stats pass never trips a 429 in the first place; a real 429 is
 * still handled by the client's retry. One limiter is shared in-process across client instances,
 * because the API builds a client per call from the stored key.
 */
export interface RateLimiterOptions {
  maxPerWindow?: number;
  windowMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class WhopRateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly max: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: RateLimiterOptions = {}) {
    this.max = opts.maxPerWindow ?? 500;
    this.windowMs = opts.windowMs ?? 60_000;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  /** Resolve when a request under `key` may be sent; waits if the window is full. */
  async acquire(key: string): Promise<void> {
    for (;;) {
      const t = this.now();
      const list = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
      if (list.length < this.max) {
        list.push(t);
        this.hits.set(key, list);
        return;
      }
      if (list.length === 0) this.hits.delete(key);
      const wait = Math.max(1, (list[0] ?? t) + this.windowMs - t);
      await this.sleep(wait);
    }
  }
}

export const sharedWhopRateLimiter = new WhopRateLimiter();

/** `GET /ads/ad_abc/pause` → `GET /ads/{id}/pause`: limits are per operation, not per object. */
export function operationKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path.replace(/\/[a-z]{2,10}_[A-Za-z0-9]+/g, '/{id}')}`;
}

/** A short, non-reversible id for a credential, so limiter state never holds the key itself. */
export function credentialFingerprint(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 12);
}
