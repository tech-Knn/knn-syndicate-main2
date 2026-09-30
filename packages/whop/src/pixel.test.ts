import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WHOP_PIXEL_LOADER, WHOP_PIXEL_ORIGIN, normalizeWhopScopes, whopPixelJs, whopPixelTag } from './pixel.js';

describe('Whop pixel snippet', () => {
  it('ships Whop\'s loader byte for byte (Whop finds the pixel by matching it in page source)', () => {
    // sha256 of the loader as published at docs.whop.com/developer/ads/pixel. If this fails, someone edited
    // the loader: restore it, or re-copy it from the docs and update this hash on purpose.
    expect(createHash('sha256').update(WHOP_PIXEL_LOADER).digest('hex')).toBe('99553e128c279888d621c3d2d8fe329542031d87fb85b2276c317da62121d7da');
    expect(WHOP_PIXEL_LOADER).toContain(`"${WHOP_PIXEL_ORIGIN}"`);
  });

  it('scopes the pixel to the business and reports the page view', () => {
    const js = whopPixelJs(['biz_AAAAAA1111']);
    expect(js.startsWith(WHOP_PIXEL_LOADER)).toBe(true);
    expect(js).toContain('whop.setScope("biz_AAAAAA1111");');
    expect(js.trim().endsWith('whop.track("page");')).toBe(true);
    // The page view is the ONLY event the snippet fires: conversions are sent server-side.
    expect(js.match(/whop\.track\(/g)).toHaveLength(1);
  });

  it('lists every business when a page serves several', () => {
    expect(whopPixelJs(['biz_AAAAAA1111', 'biz_BBBBBB2222'])).toContain('whop.setScope("biz_AAAAAA1111","biz_BBBBBB2222");');
  });

  it('trims and de-duplicates ids', () => {
    expect(normalizeWhopScopes([' biz_AAAAAA1111 ', 'biz_AAAAAA1111', 'biz_BBBBBB2222'])).toEqual(['biz_AAAAAA1111', 'biz_BBBBBB2222']);
  });

  it('refuses anything that is not a business id, because the id ends up inside a page', () => {
    for (const bad of ['', 'acct_123456', 'biz_', 'biz_ab', '"); alert(1); ("', 'biz_AAAAAA1111"); alert(1); //', '<script>', 'biz_AAAAAA 1111']) {
      expect(() => whopPixelJs([bad]), bad).toThrow(/business id/);
    }
    expect(() => whopPixelJs([])).toThrow(/at least one/);
    expect(() => normalizeWhopScopes(Array.from({ length: 11 }, (_, i) => `biz_AAAAAA${String(i).padStart(4, '0')}`))).toThrow(/at most/);
  });

  // The white Worker and the article server cannot import this package, so each holds a copy of the loader.
  // Whop finds the pixel by matching the loader in page source: a copy that drifts is a pixel Whop cannot see.
  it('is what the white Worker and the article server render, byte for byte', async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const copies = [resolve(here, '../../../apps/white/src/whop-pixel.ts'), resolve(here, '../../../apps/article/app/_afs/whop-pixel.ts')];
    expect(readFileSync(copies[0]!, 'utf8')).toBe(readFileSync(copies[1]!, 'utf8'));
    for (const file of copies) {
      const mod = (await import(file)) as { WHOP_PIXEL_LOADER: string; whopPixelJs: (biz: string) => string; whopPixelTag: (biz: string) => string };
      expect(mod.WHOP_PIXEL_LOADER, file).toBe(WHOP_PIXEL_LOADER);
      expect(mod.whopPixelJs('biz_AAAAAA1111'), file).toBe(whopPixelJs(['biz_AAAAAA1111']));
      expect(mod.whopPixelTag('biz_AAAAAA1111'), file).toBe(whopPixelTag(['biz_AAAAAA1111']));
      expect(() => mod.whopPixelTag('"); alert(1); ("'), file).toThrow(/business id/);
    }
  });

  it('wraps the snippet in a script tag, with a validated CSP nonce when given', () => {
    const tag = whopPixelTag(['biz_AAAAAA1111']);
    expect(tag.startsWith('<script>\n')).toBe(true);
    expect(tag.endsWith('\n</script>')).toBe(true);
    expect(whopPixelTag(['biz_AAAAAA1111'], { nonce: 'abc123DEF456ghi=' })).toContain('<script nonce="abc123DEF456ghi=">');
    expect(() => whopPixelTag(['biz_AAAAAA1111'], { nonce: '"><img src=x onerror=alert(1)>' })).toThrow(/nonce/);
  });
});
