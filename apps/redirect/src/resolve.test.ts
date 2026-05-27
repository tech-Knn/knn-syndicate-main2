import { describe, expect, it } from 'vitest';
import { type RedirectConfig, isPaidTraffic, pickSplit, resolveRedirect } from './resolve.js';

const base: RedirectConfig = {
  campaignId: 'c1',
  active: true,
  articleUrl: 'https://articles.example.com/a/medicare-2026',
  channel: 'ch-007',
  rac: 'health insurance',
  adCreative: 'Compare Medicare Plans 2026',
  styleId: '7465600436',
  fallbackUrl: 'https://articles.example.com/',
};

describe('isPaidTraffic', () => {
  it('detects fbclid', () => expect(isPaidTraffic({ fbclid: 'abc' })).toBe(true));
  it('detects facebook/meta utm_source (case-insensitive)', () => {
    expect(isPaidTraffic({ utm_source: 'Facebook' })).toBe(true);
    expect(isPaidTraffic({ utm_source: 'fb' })).toBe(true);
    expect(isPaidTraffic({ utm_source: 'instagram' })).toBe(true);
  });
  it('treats organic/search as not paid', () => {
    expect(isPaidTraffic({})).toBe(false);
    expect(isPaidTraffic({ utm_source: 'google' })).toBe(false);
  });
});

describe('pickSplit', () => {
  it('returns undefined when there are no splits', () => {
    expect(pickSplit(undefined, 0.5)).toBeUndefined();
    expect(pickSplit([], 0.5)).toBeUndefined();
  });
  it('selects by weight band', () => {
    const splits = [
      { url: 'A', weight: 70 },
      { url: 'B', weight: 30 },
    ];
    expect(pickSplit(splits, 0)).toBe('A'); // 0   → first band
    expect(pickSplit(splits, 0.69)).toBe('A'); // <0.70
    expect(pickSplit(splits, 0.70)).toBe('B'); // ≥0.70
    expect(pickSplit(splits, 0.999)).toBe('B');
  });
  it('roughly honors the distribution over many draws', () => {
    const splits = [
      { url: 'A', weight: 80 },
      { url: 'B', weight: 20 },
    ];
    let a = 0;
    const n = 10_000;
    for (let i = 0; i < n; i++) if (pickSplit(splits, i / n) === 'A') a += 1;
    expect(a / n).toBeGreaterThan(0.75);
    expect(a / n).toBeLessThan(0.85);
  });
});

describe('resolveRedirect', () => {
  it('routes paid traffic to the content page with AFS params + txid', () => {
    const d = resolveRedirect(base, { fbclid: 'x' }, { txid: 'tx-1' });
    expect(d.paid).toBe(true);
    const u = new URL(d.location);
    expect(u.origin + u.pathname).toBe('https://articles.example.com/a/medicare-2026');
    expect(u.searchParams.get('rc')).toBe('Compare Medicare Plans 2026');
    expect(u.searchParams.get('ch')).toBe('ch-007');
    expect(u.searchParams.get('rac')).toBe('health insurance');
    expect(u.searchParams.get('styleId')).toBe('7465600436');
    expect(u.searchParams.get('txid')).toBe('tx-1');
  });

  it('sends organic traffic to the fallback (no monetization params)', () => {
    const d = resolveRedirect(base, { utm_source: 'google' }, { txid: 'tx-2' });
    expect(d.paid).toBe(false);
    expect(d.location).toBe('https://articles.example.com/');
  });

  it('sends paused-campaign traffic to the fallback even if paid', () => {
    const d = resolveRedirect({ ...base, active: false }, { fbclid: 'x' }, { txid: 'tx-3' });
    expect(d.location).toBe('https://articles.example.com/');
  });

  it('falls back to the article URL when no explicit fallback is set', () => {
    const { fallbackUrl, ...noFallback } = base;
    void fallbackUrl;
    const d = resolveRedirect(noFallback, {}, { txid: 'tx-4' });
    expect(d.location).toBe('https://articles.example.com/a/medicare-2026');
  });

  it('applies the traffic split for paid traffic', () => {
    const cfg: RedirectConfig = {
      ...base,
      splits: [
        { url: 'https://articles.example.com/a/variant-a', weight: 100 },
        { url: 'https://articles.example.com/a/variant-b', weight: 0 },
      ],
    };
    const d = resolveRedirect(cfg, { fbclid: 'x' }, { txid: 'tx-5', rand: 0.5 });
    expect(new URL(d.location).pathname).toBe('/a/variant-a');
  });
});
