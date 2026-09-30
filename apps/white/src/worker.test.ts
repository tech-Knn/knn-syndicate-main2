import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { white } from './worker.js';
import { signWhopScope } from './whop-scope.js';
import { whopPixelTag } from './whop-pixel.js';

const SECRET = 'scope-secret-0123456789abcdef0123456789abcdef';
const BIZ = 'biz_5kCAsGozVBmEm1';
const ENV = { API_BASE: 'https://api.test', WHOP_SCOPE_SECRET: SECRET };
const PIXEL_ORIGIN = 'https://t.whop.tw';

// The white site pulls its article text from our public API; serve a fixed one.
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith('/api/public/articles/recent?limit=24')) return Response.json({ articles: [{ slug: 'slug', title: 'A Title', snippet: 'A snippet' }] });
      if (url.endsWith('/api/public/articles/slug')) return Response.json({ article: { slug: 'slug', title: 'A Title', compliantContent: 'Some clean editorial text.' } });
      return new Response('not found', { status: 404 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const get = (path: string, env: Record<string, string | undefined> = ENV) => white.request(path, { headers: { host: 'readoranow.com' } }, env);
const scopeParam = async (biz = BIZ, secret = SECRET) => `_ws=${encodeURIComponent(await signWhopScope(biz, secret))}`;
const scriptCount = (html: string) => (html.match(/<script/g) ?? []).length;

describe('white site: clean by default', () => {
  it('renders no script and no third-party origin on any page', async () => {
    for (const path of ['/', '/a/slug', '/about', '/privacy']) {
      const html = await (await get(path)).text();
      expect(scriptCount(html), path).toBe(0);
      expect(html, path).not.toContain(PIXEL_ORIGIN);
      expect(html, path).not.toContain('biz_');
    }
  });

  it('keeps its usual headers: noindex, and the 5-minute public cache on articles', async () => {
    const res = await get('/a/slug');
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
  });

  it('answers the health probe and robots.txt untouched', async () => {
    expect((await get('/health/live')).status).toBe(200);
    expect(await (await get('/robots.txt')).text()).toBe('User-agent: *\nAllow: /\n');
  });
});

describe('white site: the Whop pixel, only behind a verified scope', () => {
  it('carries the business\'s pixel in <head> when the redirect Worker tagged the hop', async () => {
    const res = await get(`/a/slug?${await scopeParam()}`);
    const html = await res.text();
    expect(res.status).toBe(200);
    const head = html.slice(0, html.indexOf('</head>'));
    expect(head).toContain(PIXEL_ORIGIN);
    expect(head).toContain(`whop.setScope("${BIZ}");`);
    expect(head).toContain('whop.track("page");');
    expect(scriptCount(html)).toBe(1);
    // The page is still the clean, noindexed white page.
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(html).toContain('Some clean editorial text.');
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    // A page that varies per request must never be shared from a cache.
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('inserts the snippet verbatim, just before </head>', async () => {
    const html = await (await get(`/a/slug?${await scopeParam()}`)).text();
    expect(html).toContain(`${whopPixelTag(BIZ)}</head>`);
    expect(html.split(whopPixelTag(BIZ))).toHaveLength(2); // exactly once
  });

  it('fires only the ordinary page view: no conversion event is wired on the page', async () => {
    const html = await (await get(`/a/slug?${await scopeParam()}`)).text();
    expect(html.match(/whop\.track\(/g)).toHaveLength(1);
  });

  it('works on the homepage too, and marks the variant uncacheable', async () => {
    const res = await get(`/?${await scopeParam()}`);
    expect(await res.text()).toContain(`whop.setScope("${BIZ}")`);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('puts the pixel on a 404 page as well, without changing its status', async () => {
    const res = await get(`/a/missing?${await scopeParam()}`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain(PIXEL_ORIGIN);
  });

  it('renders no pixel for a forged, swapped, malformed or empty scope', async () => {
    const good = await signWhopScope(BIZ, SECRET);
    const sig = good.slice(good.indexOf('.') + 1);
    const swapped = `${btoa('biz_VICTIM123456').replace(/=+$/, '')}.${sig}`;
    const wrongSecret = await signWhopScope(BIZ, 'another-secret-0123456789abcdef0123456789');
    for (const token of [swapped, wrongSecret, BIZ, 'garbage', '', `${good}x`]) {
      const res = await get(`/a/slug?_ws=${encodeURIComponent(token)}`);
      const html = await res.text();
      expect(html, token).not.toContain(PIXEL_ORIGIN);
      expect(res.headers.get('cache-control'), token).toBe('public, max-age=300');
    }
  });

  it('renders no pixel when the site has no secret configured, even for a token that would verify', async () => {
    const html = await (await get(`/a/slug?${await scopeParam()}`, { API_BASE: 'https://api.test' })).text();
    expect(html).not.toContain(PIXEL_ORIGIN);
  });

  it('leaves non-HTML responses alone', async () => {
    const res = await get(`/robots.txt?${await scopeParam()}`);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toBe('User-agent: *\nAllow: /\n');
  });
});
