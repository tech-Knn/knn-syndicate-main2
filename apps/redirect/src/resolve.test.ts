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
    expect(pickSplit(splits, 0)?.url).toBe('A'); // 0   → first band
    expect(pickSplit(splits, 0.69)?.url).toBe('A'); // <0.70
    expect(pickSplit(splits, 0.70)?.url).toBe('B'); // ≥0.70
    expect(pickSplit(splits, 0.999)?.url).toBe('B');
  });
  it('roughly honors the distribution over many draws', () => {
    const splits = [
      { url: 'A', weight: 80 },
      { url: 'B', weight: 20 },
    ];
    let a = 0;
    const n = 10_000;
    for (let i = 0; i < n; i++) if (pickSplit(splits, i / n)?.url === 'A') a += 1;
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

  it('routes paid traffic to a PAID offer: its host, its channel, and reports the offerId', () => {
    const cfg: RedirectConfig = {
      ...base,
      splits: [
        { url: 'https://site-a.com/a/slug', weight: 60, channel: 'ch-a', offerId: 'offer-a' },
        { url: 'https://site-b.com/a/slug', weight: 40, channel: 'ch-b', offerId: 'offer-b' },
      ],
    };
    const a = resolveRedirect(cfg, { fbclid: 'x' }, { txid: 'tx-6', rand: 0.1 });
    const ua = new URL(a.location);
    expect(ua.host).toBe('site-a.com');
    expect(ua.searchParams.get('ch')).toBe('ch-a'); // the offer's channel beats config.channel
    expect(a.offerId).toBe('offer-a');

    const b = resolveRedirect(cfg, { fbclid: 'x' }, { txid: 'tx-7', rand: 0.99 });
    expect(new URL(b.location).host).toBe('site-b.com');
    expect(new URL(b.location).searchParams.get('ch')).toBe('ch-b');
    expect(b.offerId).toBe('offer-b');
  });

  it('sends organic traffic to the ORGANIC offer destination (fallbackUrl)', () => {
    const cfg: RedirectConfig = { ...base, fallbackUrl: 'https://organic-site.com/a/slug' };
    const d = resolveRedirect(cfg, { utm_source: 'google' }, { txid: 'tx-8' });
    expect(d.location).toBe('https://organic-site.com/a/slug');
    expect(d.offerId).toBeUndefined();
  });
});

describe('resolveRedirect — cloak ad-id verification', () => {
  const verifyCfg: RedirectConfig = { ...base, expectedAdId: '120250294019500066' };
  const isMoney = (loc: string) => new URL(loc).pathname === '/a/medicare-2026';

  describe('OBSERVE mode (default) — routing must NEVER change (zero revenue risk)', () => {
    it('records "match" but still routes by the base signal', () => {
      const d = resolveRedirect(verifyCfg, { fbclid: 'x', kaid: '120250294019500066' }, { txid: 't' });
      expect(d.paid).toBe(true);
      expect(isMoney(d.location)).toBe(true);
      expect(d.verify).toEqual({ route: 'money', outcome: 'match' });
    });
    it('records "mismatch" but STILL routes to money (observe does not block)', () => {
      const d = resolveRedirect(verifyCfg, { fbclid: 'x', kaid: 'WRONG' }, { txid: 't' });
      expect(d.paid).toBe(true);
      expect(isMoney(d.location)).toBe(true); // <-- unchanged routing: no money lost
      expect(d.verify).toEqual({ route: 'money', outcome: 'mismatch' });
    });
    it('records "missing" (no macro) but STILL routes to money', () => {
      const d = resolveRedirect(verifyCfg, { fbclid: 'x' }, { txid: 't' });
      expect(isMoney(d.location)).toBe(true); // <-- unchanged: the macro-loss case is only measured
      expect(d.verify).toEqual({ route: 'money', outcome: 'missing' });
    });
    it('non-paid → white, outcome "na"', () => {
      const d = resolveRedirect(verifyCfg, { utm_source: 'google' }, { txid: 't' });
      expect(d.verify).toEqual({ route: 'white', outcome: 'na' });
    });
  });

  describe('ENFORCE mode — block unverified paid traffic', () => {
    const enforce: RedirectConfig = { ...verifyCfg, verifyMode: 'enforce' };
    it('matching kaid → money', () => {
      const d = resolveRedirect(enforce, { fbclid: 'x', kaid: '120250294019500066' }, { txid: 't' });
      expect(d.paid).toBe(true);
      expect(isMoney(d.location)).toBe(true);
      expect(d.verify).toEqual({ route: 'money', outcome: 'match' });
    });
    it('wrong kaid → white (blocked)', () => {
      const d = resolveRedirect(enforce, { fbclid: 'x', kaid: 'WRONG' }, { txid: 't' });
      expect(d.paid).toBe(false);
      expect(d.location).toBe('https://articles.example.com/');
      expect(d.verify).toEqual({ route: 'white', outcome: 'mismatch' });
    });
    it('missing macro → white (blocked)', () => {
      const d = resolveRedirect(enforce, { fbclid: 'x' }, { txid: 't' });
      expect(d.paid).toBe(false);
      expect(d.verify).toEqual({ route: 'white', outcome: 'missing' });
    });
    it('LEGACY-TOLERANT: no expectedAdId → routes by base signal (existing campaigns never break)', () => {
      const legacy: RedirectConfig = { ...base, verifyMode: 'enforce' }; // no expectedAdId
      const d = resolveRedirect(legacy, { fbclid: 'x' }, { txid: 't' });
      expect(d.paid).toBe(true);
      expect(isMoney(d.location)).toBe(true);
      expect(d.verify).toEqual({ route: 'money', outcome: 'na' });
    });

    // SINGLE-FACTOR cloaker (operator decision): the money page is gated on the kaid match ALONE —
    // fbclid is no longer required, and (proven above) fbclid without a matching kaid never reaches money.
    it('matching kaid with NO fbclid → money (fbclid is no longer part of the decision)', () => {
      const d = resolveRedirect(enforce, { kaid: '120250294019500066' }, { txid: 't' });
      expect(d.paid).toBe(true);
      expect(isMoney(d.location)).toBe(true);
      expect(d.verify.route).toBe('money'); // outcome label is 'na' (no fbclid context) — real ad clicks carry both
    });
    it('no kaid and no fbclid (pure organic) → white', () => {
      const d = resolveRedirect(enforce, {}, { txid: 't' });
      expect(d.paid).toBe(false);
      expect(d.location).toBe('https://articles.example.com/');
      expect(d.verify.route).toBe('white');
    });
    it('wrong kaid with NO fbclid → white (the ad id is the only key to the money page)', () => {
      const d = resolveRedirect(enforce, { kaid: 'WRONG' }, { txid: 't' });
      expect(d.paid).toBe(false);
      expect(d.verify.route).toBe('white');
    });
  });
});
