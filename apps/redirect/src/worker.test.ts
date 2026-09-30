import { describe, expect, it } from 'vitest';
import type { RedirectConfig } from './resolve.js';
import { worker } from './worker.js';
import { verifyWhopScope } from './whop-scope.js';

const SCOPE_SECRET = 'scope-secret-0123456789abcdef0123456789abcdef';
const CLOAK_SECRET = 'cloak-secret-0123456789abcdef0123456789abcdef';
const BIZ = 'biz_5kCAsGozVBmEm1';

// A Workers-KV stand-in that records writes, plus an execution context that lets us await waitUntil work.
function fakeKv(seed: Record<string, string>) {
  const store = new Map(Object.entries(seed));
  const puts: { key: string; value: string; ttl?: number }[] = [];
  return {
    store,
    puts,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string, o?: { expirationTtl?: number }) => {
      store.set(k, v);
      puts.push({ key: k, value: v, ttl: o?.expirationTtl });
    },
  };
}
function fakeCtx() {
  const pending: Promise<unknown>[] = [];
  return { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => undefined, props: {}, flush: () => Promise.all(pending) };
}

const base: RedirectConfig = {
  campaignId: '11111111-1111-4111-8111-111111111111',
  active: true,
  articleUrl: 'https://articles.test/a/slug',
  channel: '05173',
  adCreative: 'Compare Backyard Apartments',
  fallbackUrl: 'https://white.test/a/slug',
};
const fb = base;
const whop: RedirectConfig = { ...base, whop: { bizId: BIZ } };

const WHOP_CLICK =
  'wacid=adcamp_ARRzXWlc8gt&wasid=adgrp_adGTsobtDlzz&waid=ad_I2YRNtEkImoX5qB&utm_meta_ad_id=120215678901234567&utm_source=fb&utm_medium=paid_social&utm_whop=true&fbclid=IwAR0example';

async function click(query: string, config: RedirectConfig, env: Record<string, string> = {}) {
  const kv = fakeKv({ 'redirect:abc123': JSON.stringify(config) });
  const ctx = fakeCtx();
  const res = await worker.request(`https://go.test/go/abc123${query ? `?${query}` : ''}`, { headers: { 'cf-connecting-ip': '203.0.113.9' } }, { REDIRECTS: kv, ...env }, ctx);
  await ctx.flush();
  const clickPut = kv.puts.find((p) => p.key.startsWith('click:'));
  return { res, location: res.headers.get('location') ?? '', kv, record: clickPut ? (JSON.parse(clickPut.value) as Record<string, unknown>) : undefined, clickPut };
}

describe('redirect Worker: Facebook traffic is unchanged', () => {
  it('sends a paid Facebook click to the money page and records a click without any whop block', async () => {
    const { res, location, record, clickPut } = await click('fbclid=IwAR0x&utm_source=facebook', fb, { WHOP_SCOPE_SECRET: SCOPE_SECRET });
    expect(res.status).toBe(302);
    expect(location.startsWith('https://articles.test/a/slug?')).toBe(true);
    expect(new URL(location).searchParams.get('txid')).toBeTruthy();
    expect(record).toMatchObject({ redirectId: 'abc123', fbclid: 'IwAR0x', clientIp: '203.0.113.9' });
    expect(record).not.toHaveProperty('whop');
    expect(clickPut?.ttl).toBe(604_800);
  });

  it('sends non-paid traffic to the white page with nothing added, even when a scope secret is set', async () => {
    const { location, record } = await click('', fb, { WHOP_SCOPE_SECRET: SCOPE_SECRET });
    expect(location).toBe('https://white.test/a/slug');
    expect(record).toBeUndefined();
  });

  it('does not treat Whop\'s flag as a paid signal on a Facebook campaign', async () => {
    const { location, record } = await click('utm_whop=true&waid=ad_I2YRNtEkImoX5qB', fb);
    expect(location).toBe('https://white.test/a/slug');
    expect(record).toBeUndefined();
  });
});

describe('redirect Worker: Whop campaigns', () => {
  it('routes a real Whop ad click to the money page and records Whop\'s ids and landing URL beside it', async () => {
    const { res, location, record } = await click(WHOP_CLICK, whop, { WHOP_SCOPE_SECRET: SCOPE_SECRET });
    expect(res.status).toBe(302);
    const loc = new URL(location);
    expect(loc.origin + loc.pathname).toBe('https://articles.test/a/slug');
    // The money page never carries the Whop scope (the pixel lives only on the non-paid landing).
    expect(loc.searchParams.has('_ws')).toBe(false);
    expect(record).toMatchObject({
      redirectId: 'abc123',
      fbclid: 'IwAR0example',
      whop: {
        bizId: BIZ,
        click: { campaignId: 'adcamp_ARRzXWlc8gt', adGroupId: 'adgrp_adGTsobtDlzz', adId: 'ad_I2YRNtEkImoX5qB', metaAdId: '120215678901234567', utm: { source: 'fb', medium: 'paid_social' } },
      },
    });
    const landing = new URL((record!.whop as { landing: string }).landing);
    expect(landing.origin + landing.pathname).toBe('https://go.test/go/abc123');
    expect(landing.searchParams.get('waid')).toBe('ad_I2YRNtEkImoX5qB');
    expect(landing.searchParams.get('fbclid')).toBe('IwAR0example');
  });

  it('recognises a Whop click that lacks an fbclid, from Whop\'s own ids', async () => {
    const { location, record } = await click('wacid=adcamp_ARRzXWlc8gt&waid=ad_I2YRNtEkImoX5qB&utm_whop=true&utm_source=msg', whop);
    expect(location.startsWith('https://articles.test/a/slug?')).toBe(true);
    expect(record).toMatchObject({ whop: { bizId: BIZ, click: { adId: 'ad_I2YRNtEkImoX5qB' } } });
  });

  it('still records the business for a paid click that carries no Whop ids, so the conversion goes to Whop', async () => {
    const { record } = await click('fbclid=IwAR0x', whop);
    expect(record).toMatchObject({ whop: { bizId: BIZ } });
    expect((record!.whop as { click?: unknown }).click).toBeUndefined();
  });

  it('keeps hostile values out of the record', async () => {
    const { record } = await click(`waid=%3Cscript%3E&wacid=adcamp_ARRzXWlc8gt&fbclid=IwAR0x&evil=1&rc=stolen&utm_content=${'x'.repeat(4000)}`, whop);
    const w = record!.whop as { click: { adId?: string; utm: { content?: string } }; landing: string };
    expect(w.click.adId).toBeUndefined();
    expect(w.click.utm.content).toHaveLength(200);
    expect(w.landing).not.toContain('script');
    expect(w.landing).not.toContain('evil');
    expect(w.landing).not.toContain('stolen');
  });

  it('tags the non-paid landing with a signed scope naming the business, so that page can carry the pixel', async () => {
    // This is what Whop's ad check sees: a plain fetch of the go-link, no params.
    const { res, location, record } = await click('', whop, { WHOP_SCOPE_SECRET: SCOPE_SECRET });
    expect(res.status).toBe(302);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const loc = new URL(location);
    expect(loc.origin + loc.pathname).toBe('https://white.test/a/slug');
    expect(await verifyWhopScope(loc.searchParams.get('_ws'), SCOPE_SECRET)).toBe(BIZ);
    expect(record).toBeUndefined();
  });

  it('keeps the destination\'s own query when it adds the scope', async () => {
    const { location } = await click('', { ...whop, fallbackUrl: 'https://white.test/a/slug?x=1' }, { WHOP_SCOPE_SECRET: SCOPE_SECRET });
    const loc = new URL(location);
    expect(loc.searchParams.get('x')).toBe('1');
    expect(await verifyWhopScope(loc.searchParams.get('_ws'), SCOPE_SECRET)).toBe(BIZ);
  });

  it('adds nothing when no scope secret is configured (feature off, click never blocked)', async () => {
    const { location } = await click('', whop);
    expect(location).toBe('https://white.test/a/slug');
  });

  it('tags the white landing of an inactive Whop campaign too, and records no click', async () => {
    const { location, record } = await click(WHOP_CLICK, { ...whop, active: false }, { WHOP_SCOPE_SECRET: SCOPE_SECRET });
    expect(new URL(location).origin).toBe('https://white.test');
    expect(await verifyWhopScope(new URL(location).searchParams.get('_ws'), SCOPE_SECRET)).toBe(BIZ);
    expect(record).toBeUndefined();
  });

  it('never puts the scope on a money route, including when the cloak token is on', async () => {
    const { location } = await click(WHOP_CLICK, whop, { WHOP_SCOPE_SECRET: SCOPE_SECRET, CLOAK_TOKEN_SECRET: CLOAK_SECRET });
    const loc = new URL(location);
    expect(loc.searchParams.has('t')).toBe(true);
    expect(loc.searchParams.has('_ws')).toBe(false);
    // The record is written either way: the token only changes the Location.
  });

  it('leaves an unknown redirect id on the generic fallback, untagged', async () => {
    const kv = fakeKv({});
    const ctx = fakeCtx();
    const res = await worker.request('https://go.test/go/nope', {}, { REDIRECTS: kv, WHOP_SCOPE_SECRET: SCOPE_SECRET }, ctx);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://articles.10linesabout.com/');
  });

  it('survives a malformed business id in a config: the click goes through, untagged', async () => {
    const { res, location } = await click('', { ...base, whop: { bizId: 'not-a-biz-id' } }, { WHOP_SCOPE_SECRET: SCOPE_SECRET });
    expect(res.status).toBe(302);
    expect(location).toBe('https://white.test/a/slug');
  });
});
