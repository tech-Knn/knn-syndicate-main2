import { afterAll, describe, expect, it } from 'vitest';
import { buildApp, closeRedis } from './app.js';

const app = buildApp();

describe('redirect engine', () => {
  afterAll(async () => {
    await closeRedis();
  });

  it('GET /health/live returns ok', async () => {
    const res = await app.request('/health/live');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('GET /go/:id issues a 302 redirect (placeholder)', async () => {
    const res = await app.request('/go/abc123');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBeTruthy();
  });
});
