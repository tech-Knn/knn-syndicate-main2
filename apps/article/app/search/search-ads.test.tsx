import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SiteConfig } from '../_afs/csa';
import { SearchAds } from './search-ads';
import { fetchWebResults } from './web-results';

const site: SiteConfig = { pubId: 'partner-pub-1', styleId: '8472563621', adsafe: 'low', adtest: false };
const html = (over: Partial<Parameters<typeof SearchAds>[0]> = {}): string =>
  renderToStaticMarkup(<SearchAds query="used camry" site={site} maxAds={5} {...over} />);

describe('SearchAds — one top ad', () => {
  it('requests a single top ad even when five organic results exist', () => {
    const out = html({ maxAds: 5 });
    expect(out).toContain("maxTop:1");
    expect(out).not.toMatch(/\bnumber:/);
  });

  it('still sends the RAC, the channel and the style on the results page', () => {
    const out = html({ referrerAdCreative: 'Learn more about Personal Loan', channel: '07985' });
    expect(out).toContain('"referrerAdCreative":"Learn more about Personal Loan"');
    expect(out).toContain('"channel":"07985"');
    expect(out).toContain('"styleId":"8472563621"');
  });

  it('renders no ads without an organic result (ads ≤ results) or without a query', () => {
    expect(html({ maxAds: 0 })).toBe('');
    expect(html({ query: '' })).toBe('');
  });
});

describe('fetchWebResults — one organic result', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('asks the API for exactly one article', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ articles: [{ slug: 'a', title: 'A', snippet: '' }] }) }));
    vi.stubGlobal('fetch', fetchMock);
    const out = await fetchWebResults('example.com');
    expect(out).toHaveLength(1);
    const url = String((fetchMock.mock.calls[0] as unknown[])[0]);
    expect(url).toContain('host=example.com');
    expect(url).toContain('limit=1');
  });
});
