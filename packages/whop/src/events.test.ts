import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { whopApi } from './api.js';
import { WhopClient } from './client.js';
import { whopPixelTag } from './pixel.js';
import { type MockWhop, startMockWhop } from './testing/mock-whop.js';

let mock: MockWhop;
let site: ReturnType<typeof createServer>;
let siteUrl: string;

// A tiny website standing in for our white page / redirect link, so the mock's pixel check has something to fetch.
beforeAll(async () => {
  mock = await startMockWhop();
  mock.addBusiness({ bizId: 'biz_AAAAAA', apiKey: 'k_events', title: 'Acme' });
  mock.addBusiness({ bizId: 'biz_NOEVNT', apiKey: 'k_noevent', permissions: ['ad_campaign:basic:read'] });
  site = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://site');
    if (url.pathname === '/with-pixel') {
      res.writeHead(200, { 'content-type': 'text/html' }).end(`<html><head>${whopPixelTag(['biz_AAAAAA'])}</head><body>hello</body></html>`);
    } else if (url.pathname === '/with-wired-events') {
      res.writeHead(200, { 'content-type': 'text/html' }).end(`<html><head>${whopPixelTag(['biz_AAAAAA'])}<script>whop.track("lead")</script></head></html>`);
    } else if (url.pathname === '/redirect-to-pixel') {
      res.writeHead(302, { location: '/with-pixel' }).end();
    } else if (url.pathname === '/no-pixel') {
      res.writeHead(200, { 'content-type': 'text/html' }).end('<html><body>nothing here</body></html>');
    } else {
      res.writeHead(404).end('nope');
    }
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await mock.close();
  await new Promise((r) => site.close(r));
});

const api = (apiKey = 'k_events') => whopApi(new WhopClient({ apiKey, baseUrl: mock.baseUrl, limiter: false, jitter: 0, baseDelayMs: 1, sleep: async () => undefined }));
const biz = () => mock.businesses.get('biz_AAAAAA')!;

describe('server events', () => {
  it('stores an event and answers with <biz>:<event_id>', async () => {
    const res = await api().createEvent({ account_id: 'biz_AAAAAA', event_name: 'view_content', event_id: 'ev-1', action_source: 'website', url: 'https://go.test/a/x?wacid=adcamp_1&waid=ad_1', context: { ip_address: '203.0.113.9', ad_id: 'ad_1' } });
    expect(res).toEqual({ id: 'biz_AAAAAA:ev-1' });
    expect(biz().events.at(-1)!.input).toMatchObject({ event_name: 'view_content', context: { ad_id: 'ad_1' } });
  });

  it('keeps ONE copy when the same event is sent twice (a retry can never double count)', async () => {
    const before = biz().events.length;
    const a = await api().createEvent({ account_id: 'biz_AAAAAA', event_name: 'add_to_cart', event_id: 'dup-1' });
    const b = await api().createEvent({ account_id: 'biz_AAAAAA', event_name: 'add_to_cart', event_id: 'dup-1' });
    expect(b).toEqual(a);
    expect(biz().events.length).toBe(before + 1);
  });

  it('rejects an event older than 28 days and a purchase without a value', async () => {
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    await expect(api().createEvent({ account_id: 'biz_AAAAAA', event_name: 'view_content', event_id: 'old-1', event_time: old })).rejects.toMatchObject({ kind: 'validation', message: expect.stringContaining('28 days') });
    await expect(api().createEvent({ account_id: 'biz_AAAAAA', event_name: 'purchase', event_id: 'p-1' })).rejects.toMatchObject({ kind: 'validation' });
    const recent = new Date(Date.now() - 20 * 86_400_000).toISOString();
    await expect(api().createEvent({ account_id: 'biz_AAAAAA', event_name: 'view_content', event_id: 'ok-1', event_time: recent })).resolves.toMatchObject({ id: 'biz_AAAAAA:ok-1' });
  });

  it('names the missing permission when the key cannot create events', async () => {
    await expect(api('k_noevent').createEvent({ account_id: 'biz_NOEVNT', event_name: 'view_content', event_id: 'x' })).rejects.toMatchObject({ kind: 'permission', message: expect.stringContaining('event:create') });
  });

  it('lists events back by a hard identifier (diagnostics)', async () => {
    await api().createEvent({ account_id: 'biz_AAAAAA', event_name: 'view_content', event_id: 'ident-1', context: { fbp: 'fb.1.123.456' } });
    const list = await api().listEvents({ accountId: 'biz_AAAAAA', identifier: 'fb.1.123.456' });
    expect(list.data.map((e) => e.event_id)).toEqual(['ident-1']);
  });
});

describe('the pixel check (mock mirrors how Whop reads a destination)', () => {
  const check = (path: string) => api().validatePixel({ accountId: 'biz_AAAAAA', url: `${siteUrl}${path}` });

  it('finds the pixel in a page source', async () => {
    expect(await check('/with-pixel')).toMatchObject({ installed: true, reachable: true, native_tracking: false, page_events: [] });
  });

  it('follows redirects to the final page, as Whop does', async () => {
    expect(await check('/redirect-to-pixel')).toMatchObject({ installed: true, reachable: true });
  });

  it('lists the conversion events wired on the page (the page view is not one)', async () => {
    expect(await check('/with-wired-events')).toMatchObject({ installed: true, page_events: ['lead'] });
  });

  it('says not installed for a page without it, and unreachable for a dead one', async () => {
    expect(await check('/no-pixel')).toMatchObject({ installed: false, reachable: true });
    expect(await check('/missing')).toMatchObject({ installed: false, reachable: false });
  });

  it('treats a Whop-hosted page as native tracking', async () => {
    expect(await api().validatePixel({ accountId: 'biz_AAAAAA', url: 'https://whop.com/some-store' })).toMatchObject({ installed: true, native_tracking: true });
  });
});
