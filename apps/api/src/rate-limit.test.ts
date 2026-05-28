import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { isRateLimitExempt } from './app.js';

describe('rate-limit exemptions (Phase 11)', () => {
  it('exempts infra/edge paths and limits app paths', () => {
    const exempt = (url: string): boolean => isRateLimitExempt({ url } as never);
    // Infra/edge callers must never be throttled.
    expect(exempt('/health')).toBe(true);
    expect(exempt('/health/live')).toBe(true);
    expect(exempt('/api/public/site-config?host=x')).toBe(true);
    expect(exempt('/api/public/domain-allowed?domain=x')).toBe(true);
    expect(exempt('/api/internal/launch/abc')).toBe(true);
    expect(exempt('/admin/queues')).toBe(true);
    expect(exempt('/')).toBe(true);
    // User-facing API is limited.
    expect(exempt('/api/campaigns')).toBe(false);
    expect(exempt('/api/auth/login')).toBe(false);
    expect(exempt('/api/stats/summary')).toBe(false);
  });
});

describe('rate-limit behaviour (in-memory store)', () => {
  it('429s a limited route past the cap but never an exempt one', async () => {
    const app = Fastify();
    await app.register(rateLimit, { global: true, max: 2, timeWindow: '1 minute', allowList: isRateLimitExempt });
    app.get('/api/campaigns', async () => ({ ok: true }));
    app.get('/api/public/x', async () => ({ ok: true }));
    await app.ready();

    const hit = (url: string) => app.inject({ method: 'GET', url, remoteAddress: '203.0.113.7' });
    expect((await hit('/api/campaigns')).statusCode).toBe(200);
    expect((await hit('/api/campaigns')).statusCode).toBe(200);
    expect((await hit('/api/campaigns')).statusCode).toBe(429); // over the cap → throttled
    // The exempt path is never limited, however many times it's hit.
    for (let i = 0; i < 5; i++) expect((await hit('/api/public/x')).statusCode).toBe(200);

    await app.close();
  });
});
