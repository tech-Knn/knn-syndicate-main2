import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_WHOP_VERSION_DATE, WhopClient, buildUrl, stripAdvice } from './client.js';
import type { WhopApiError } from './errors.js';
import { type MockWhop, startMockWhop } from './testing/mock-whop.js';

let mock: MockWhop;
beforeAll(async () => {
  mock = await startMockWhop();
  mock.addBusiness({ bizId: 'biz_AAAAAA', apiKey: 'whop_key_full', title: 'Acme' });
});
afterAll(() => mock.close());
afterEach(() => {
  mock.requests.length = 0;
  mock.failures.length = 0;
});

const client = (over: Partial<ConstructorParameters<typeof WhopClient>[0]> = {}, slept: number[] = []) =>
  new WhopClient({ apiKey: 'whop_key_full', baseUrl: mock.baseUrl, limiter: false, jitter: 0, baseDelayMs: 10, sleep: async (ms) => void slept.push(ms), ...over });

describe('buildUrl', () => {
  it('repeats array params and skips null/undefined', () => {
    const u = new URL(buildUrl('https://x.test/api/v1/', '/ads', { ad_campaign_ids: ['a', 'b'], status: undefined, first: 5, flag: false, none: null }));
    expect(u.pathname).toBe('/api/v1/ads');
    expect(u.searchParams.getAll('ad_campaign_ids')).toEqual(['a', 'b']);
    expect(u.searchParams.get('first')).toBe('5');
    expect(u.searchParams.get('flag')).toBe('false');
    expect(u.searchParams.has('status')).toBe(false);
    expect(u.searchParams.has('none')).toBe(false);
  });
});

describe('WhopClient requests', () => {
  it('sends the bearer key, the pinned API version and an idempotency key on POST', async () => {
    await client().request({ method: 'POST', path: '/events/validate_pixel', body: { account_id: 'biz_AAAAAA' }, idempotencyKey: 'idem-1' });
    const sent = mock.requests.at(-1)!;
    expect(sent.headers.authorization).toBe('Bearer whop_key_full');
    expect(sent.headers['api-version-date']).toBe(DEFAULT_WHOP_VERSION_DATE);
    expect(sent.headers['idempotency-key']).toBe('idem-1');
    expect(sent.headers['content-type']).toBe('application/json');
    expect(sent.body).toEqual({ account_id: 'biz_AAAAAA' });
  });

  it('does not send an idempotency key on GET', async () => {
    await client().request({ method: 'GET', path: '/ad_campaigns', query: { account_id: 'biz_AAAAAA', first: 1 }, idempotencyKey: 'ignored' });
    expect(mock.requests.at(-1)!.headers['idempotency-key']).toBeUndefined();
    expect(mock.requests.at(-1)!.query).toMatchObject({ account_id: 'biz_AAAAAA', first: '1' });
  });

  it('maps 401 to an auth error and 403 to a permission error', async () => {
    await expect(client({ apiKey: 'wrong' }).request({ method: 'GET', path: '/ad_campaigns' })).rejects.toMatchObject({ kind: 'auth', status: 401 });
    mock.addBusiness({ bizId: 'biz_LIMITED', apiKey: 'whop_key_limited', permissions: ['social_account:read'] });
    await expect(client({ apiKey: 'whop_key_limited' }).request({ method: 'GET', path: '/ad_campaigns', query: { account_id: 'biz_LIMITED' } })).rejects.toMatchObject({
      kind: 'permission',
      status: 403,
      message: expect.stringContaining('ad_campaign:basic:read'),
    });
  });

  it('retries a 429 after the wait Whop asked for, then succeeds', async () => {
    const slept: number[] = [];
    mock.failures.push({ status: 429, body: { error: { type: 'rate_limit_exceeded', message: 'Try again in 3 seconds.' } } });
    const res = await client({}, slept).request<{ data: unknown[] }>({ method: 'GET', path: '/ad_campaigns', query: { account_id: 'biz_AAAAAA' } });
    expect(res.data).toEqual([]);
    expect(slept).toEqual([3000]);
    expect(mock.requests).toHaveLength(2);
  });

  it('raises a 429 whose wait is longer than we will sleep instead of blocking', async () => {
    const slept: number[] = [];
    mock.failures.push({ status: 429, headers: { 'retry-after': '300' } });
    await expect(client({ maxDelayMs: 30_000 }, slept).request({ method: 'GET', path: '/ad_campaigns' })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 300_000 });
    expect(slept).toEqual([]);
  });

  it('retries a 500 on GET with exponential back-off and gives up after maxRetries', async () => {
    const slept: number[] = [];
    mock.failures.push({ status: 500 }, { status: 502 }, { status: 503 }, { status: 500 });
    await expect(client({ maxRetries: 3 }, slept).request({ method: 'GET', path: '/ad_campaigns' })).rejects.toMatchObject({ kind: 'server' });
    expect(slept).toEqual([10, 20, 40]);
    expect(mock.requests).toHaveLength(4);
  });

  it('never retries a POST that has no idempotency key', async () => {
    mock.failures.push({ status: 503 }, { status: 503 });
    await expect(client().request({ method: 'POST', path: '/social_accounts', body: { account_id: 'biz_AAAAAA', platform: 'facebook' } })).rejects.toMatchObject({ kind: 'server' });
    expect(mock.requests).toHaveLength(1);
  });

  it('retries a POST that carries an idempotency key', async () => {
    mock.failures.push({ status: 503 });
    const page = await client().request<{ id: string }>({ method: 'POST', path: '/social_accounts', body: { account_id: 'biz_AAAAAA', platform: 'facebook' }, idempotencyKey: 'k-1' });
    expect(page.id).toMatch(/^sacc_/);
    expect(mock.requests).toHaveLength(2);
    expect(mock.requests.map((r) => r.headers['idempotency-key'])).toEqual(['k-1', 'k-1']);
  });

  it('does not retry validation, auth or permission errors', async () => {
    mock.failures.push({ status: 400, body: { error: { type: 'bad_request', message: 'A Facebook page is required' } } });
    await expect(client().request({ method: 'GET', path: '/ad_campaigns' })).rejects.toMatchObject({ kind: 'validation', message: 'A Facebook page is required' });
    expect(mock.requests).toHaveLength(1);
  });

  it('reports an unreachable Whop as a network error (after its retries)', async () => {
    const slept: number[] = [];
    const dead = new WhopClient({ apiKey: 'k', baseUrl: 'http://127.0.0.1:1/api/v1', limiter: false, jitter: 0, baseDelayMs: 1, maxRetries: 1, sleep: async (ms) => void slept.push(ms) });
    await expect(dead.request({ method: 'GET', path: '/x' })).rejects.toMatchObject({ kind: 'network', status: 0 });
    expect(slept).toHaveLength(1);
  });

  it('turns a slow answer into a timeout error', async () => {
    const slow = client({ fetch: (async (_u: unknown, init?: RequestInit) => new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('t'), { name: 'TimeoutError' }))))) as unknown as typeof fetch, timeoutMs: 20, maxRetries: 0 });
    await expect(slow.request({ method: 'GET', path: '/x' })).rejects.toMatchObject({ kind: 'timeout' });
  });

  it("strips Whop's agent-addressed upsell text from every response", async () => {
    const res = await client().request<Record<string, unknown>>({ method: 'GET', path: '/ad_campaigns', query: { account_id: 'biz_AAAAAA', first: 1 } });
    expect(res).not.toHaveProperty('recommended_action');
    expect(res).toHaveProperty('data');
    // The mock really does decorate its answers (as Whop does), so the test above proves the stripping.
    const raw = await fetch(`${mock.baseUrl}/ad_campaigns?account_id=biz_AAAAAA`, { headers: { authorization: 'Bearer whop_key_full' } });
    expect(await raw.json()).toHaveProperty('recommended_action');
    expect(stripAdvice([1, 2])).toEqual([1, 2]);
    expect(stripAdvice(null)).toBeNull();
    expect(stripAdvice({ a: 1, recommended_action: 'x' })).toEqual({ a: 1 });
  });

  it('retries a POST the API deduplicates by itself, even without an idempotency key', async () => {
    const slept: number[] = [];
    mock.failures.push({ status: 503 }, { status: 503 });
    const res = await client({}, slept).request<{ id: string }>({ method: 'POST', path: '/events', body: { account_id: 'biz_AAAAAA', event_name: 'view_content', event_id: 'nat-1' }, naturallyIdempotent: true });
    expect(res.id).toBe('biz_AAAAAA:nat-1');
    expect(slept).toHaveLength(2);
    // ...but a plain POST is still never retried.
    mock.failures.push({ status: 503 });
    await expect(client().request({ method: 'POST', path: '/events', body: { account_id: 'biz_AAAAAA', event_name: 'view_content', event_id: 'nat-2' } })).rejects.toMatchObject({ kind: 'server' });
  });

  it('keeps the API key out of errors, JSON and inspection', async () => {
    const c = client({ apiKey: 'whop_super_secret_value' });
    expect(JSON.stringify(c)).not.toContain('whop_super_secret_value');
    expect(String(Object.values(c))).not.toContain('whop_super_secret_value');
    const err = (await c.request({ method: 'GET', path: '/ad_campaigns' }).catch((e: unknown) => e)) as WhopApiError;
    expect(`${err.message} ${JSON.stringify(err)} ${err.stack}`).not.toContain('whop_super_secret_value');
  });

  it('refuses an empty key', () => {
    expect(() => new WhopClient({ apiKey: '  ' })).toThrow('API key');
  });
});
