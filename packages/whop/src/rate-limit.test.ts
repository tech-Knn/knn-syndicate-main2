import { describe, expect, it } from 'vitest';
import { WhopRateLimiter, credentialFingerprint, operationKey } from './rate-limit.js';

describe('WhopRateLimiter', () => {
  it('lets requests through under the limit without waiting', async () => {
    const slept: number[] = [];
    const lim = new WhopRateLimiter({ maxPerWindow: 3, windowMs: 1000, now: () => 0, sleep: async (ms) => void slept.push(ms) });
    await lim.acquire('k');
    await lim.acquire('k');
    await lim.acquire('k');
    expect(slept).toEqual([]);
  });

  it('waits until the oldest hit leaves the window when full', async () => {
    let t = 0;
    const slept: number[] = [];
    const lim = new WhopRateLimiter({
      maxPerWindow: 2,
      windowMs: 1000,
      now: () => t,
      sleep: async (ms) => {
        slept.push(ms);
        t += ms;
      },
    });
    await lim.acquire('k'); // t=0
    t = 100;
    await lim.acquire('k'); // t=100
    t = 200;
    await lim.acquire('k'); // full: oldest (0) leaves at 1000 → wait 800
    expect(slept).toEqual([800]);
  });

  it('keeps separate budgets per key', async () => {
    const slept: number[] = [];
    const lim = new WhopRateLimiter({ maxPerWindow: 1, windowMs: 1000, now: () => 0, sleep: async (ms) => void slept.push(ms) });
    await lim.acquire('a');
    await lim.acquire('b');
    expect(slept).toEqual([]);
  });
});

describe('operationKey', () => {
  it('collapses object ids so limits are per operation', () => {
    expect(operationKey('get', '/ads')).toBe('GET /ads');
    expect(operationKey('POST', '/ads/ad_AbC123/pause')).toBe('POST /ads/{id}/pause');
    expect(operationKey('GET', '/accounts/biz_XyZ789/preferences')).toBe('GET /accounts/{id}/preferences');
  });
});

describe('credentialFingerprint', () => {
  it('is stable, short and does not contain the key', () => {
    const fp = credentialFingerprint('whop_secret_key_123');
    expect(fp).toBe(credentialFingerprint('whop_secret_key_123'));
    expect(fp).toHaveLength(12);
    expect(fp).not.toContain('secret');
  });
});
