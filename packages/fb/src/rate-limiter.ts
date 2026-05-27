import { FbRateLimitError } from './errors.js';

/**
 * Facebook rate-limit handling (DECISION D12). BUC limits are per ad account, so
 * every call is run through a per-account gate that:
 *   - caps concurrency per account,
 *   - retries FbRateLimitError with exponential backoff (honoring retryAfterMs),
 *   - trips a circuit breaker after N consecutive rate-limit errors, pausing the
 *     account for a cooldown (the basis of the `BATCHED` state).
 * The official SDK does none of this — we build it here.
 */
export interface RateLimiterOptions {
  maxConcurrentPerAccount?: number;
  maxRetries?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  breakerThreshold?: number;
  breakerCooldownMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface AccountState {
  active: number;
  waiters: Array<() => void>;
  consecutiveRateLimits: number;
  openUntil: number;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class FbRateLimiter {
  private readonly maxConcurrent: number;
  private readonly maxRetries: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly breakerThreshold: number;
  private readonly breakerCooldownMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly accounts = new Map<string, AccountState>();

  constructor(opts: RateLimiterOptions = {}) {
    this.maxConcurrent = opts.maxConcurrentPerAccount ?? 4;
    this.maxRetries = opts.maxRetries ?? 5;
    this.baseBackoffMs = opts.baseBackoffMs ?? 1_000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 60_000;
    this.breakerThreshold = opts.breakerThreshold ?? 5;
    this.breakerCooldownMs = opts.breakerCooldownMs ?? 5 * 60_000;
    this.sleep = opts.sleep ?? realSleep;
    this.now = opts.now ?? Date.now;
  }

  private stateFor(accountId: string): AccountState {
    let s = this.accounts.get(accountId);
    if (!s) {
      s = { active: 0, waiters: [], consecutiveRateLimits: 0, openUntil: 0 };
      this.accounts.set(accountId, s);
    }
    return s;
  }

  private async acquire(s: AccountState): Promise<void> {
    if (s.active >= this.maxConcurrent) {
      await new Promise<void>((resolve) => s.waiters.push(resolve));
    }
    s.active += 1;
  }

  private release(s: AccountState): void {
    s.active -= 1;
    const next = s.waiters.shift();
    if (next) next();
  }

  isOpen(accountId: string): boolean {
    const s = this.accounts.get(accountId);
    return s !== undefined && s.openUntil > this.now();
  }

  async run<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
    const s = this.stateFor(accountId);

    if (s.openUntil > this.now()) {
      throw new FbRateLimitError('Circuit open for ad account (rate-limited)', {
        retryAfterMs: s.openUntil - this.now(),
      });
    }

    await this.acquire(s);
    try {
      for (let attempt = 0; ; attempt += 1) {
        try {
          const result = await fn();
          s.consecutiveRateLimits = 0;
          return result;
        } catch (err) {
          if (!(err instanceof FbRateLimitError)) throw err;
          s.consecutiveRateLimits += 1;
          const tripped = s.consecutiveRateLimits >= this.breakerThreshold;
          if (tripped) s.openUntil = this.now() + this.breakerCooldownMs;
          if (tripped || attempt >= this.maxRetries) throw err;
          const backoff = err.retryAfterMs ?? Math.min(this.baseBackoffMs * 2 ** attempt, this.maxBackoffMs);
          await this.sleep(backoff);
        }
      }
    } finally {
      this.release(s);
    }
  }
}

/** Process-wide limiter used by the graph client for real calls. */
export const sharedRateLimiter = new FbRateLimiter();
