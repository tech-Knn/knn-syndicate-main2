import { describe, expect, it } from 'vitest';
import { FbApiError, FbRateLimitError } from './errors.js';
import { FbRateLimiter } from './rate-limiter.js';

const instantSleep = (): Promise<void> => Promise.resolve();

describe('FbRateLimiter', () => {
  it('retries on FbRateLimitError, then succeeds', async () => {
    const limiter = new FbRateLimiter({ baseBackoffMs: 1, sleep: instantSleep });
    let calls = 0;
    const result = await limiter.run('act_1', async () => {
      calls += 1;
      if (calls < 3) throw new FbRateLimitError('slow down', { code: 80004 });
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('does not retry non-rate-limit errors', async () => {
    const limiter = new FbRateLimiter({ sleep: instantSleep });
    let calls = 0;
    await expect(
      limiter.run('act_1', async () => {
        calls += 1;
        throw new FbApiError('bad request', { code: 100 });
      }),
    ).rejects.toBeInstanceOf(FbApiError);
    expect(calls).toBe(1);
  });

  it('uses exponential backoff (or retryAfterMs)', async () => {
    const slept: number[] = [];
    const limiter = new FbRateLimiter({
      baseBackoffMs: 100,
      maxRetries: 10,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    let calls = 0;
    await limiter.run('act_1', async () => {
      calls += 1;
      if (calls === 1) throw new FbRateLimitError('x', { code: 17 }); // 100ms
      if (calls === 2) throw new FbRateLimitError('x', { code: 17 }); // 200ms
      if (calls === 3) throw new FbRateLimitError('x', { code: 17, retryAfterMs: 5000 }); // honored
      return 'done';
    });
    expect(slept).toEqual([100, 200, 5000]);
  });

  it('opens the circuit after the threshold of consecutive rate limits', async () => {
    let clock = 0;
    const limiter = new FbRateLimiter({
      breakerThreshold: 3,
      breakerCooldownMs: 1000,
      maxRetries: 100,
      sleep: instantSleep,
      now: () => clock,
    });
    let calls = 0;
    await expect(
      limiter.run('act_1', async () => {
        calls += 1;
        throw new FbRateLimitError('limited', { code: 80004 });
      }),
    ).rejects.toBeInstanceOf(FbRateLimitError);
    expect(calls).toBe(3); // tripped at the 3rd consecutive rate limit
    expect(limiter.isOpen('act_1')).toBe(true);

    // While open, calls are rejected fast without invoking fn.
    let called = false;
    await expect(
      limiter.run('act_1', async () => {
        called = true;
        return 'x';
      }),
    ).rejects.toBeInstanceOf(FbRateLimitError);
    expect(called).toBe(false);

    // After cooldown, the account is usable again.
    clock += 1001;
    expect(limiter.isOpen('act_1')).toBe(false);
    await expect(limiter.run('act_1', async () => 'recovered')).resolves.toBe('recovered');
  });

  it('caps concurrency per account', async () => {
    const limiter = new FbRateLimiter({ maxConcurrentPerAccount: 2, sleep: instantSleep });
    let active = 0;
    let peak = 0;
    const task = async (): Promise<void> => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active -= 1;
    };
    await Promise.all(Array.from({ length: 6 }, () => limiter.run('act_1', task)));
    expect(peak).toBeLessThanOrEqual(2);
  });
});
