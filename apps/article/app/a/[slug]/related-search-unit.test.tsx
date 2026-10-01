import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SiteConfig } from '../../_afs/csa';
import { RelatedSearchBootstrap, RelatedSearchSlot } from './related-search-unit';

const site: SiteConfig = { pubId: 'partner-pub-1', styleId: '8472563621', adsafe: 'low', adtest: false };
const none: SiteConfig = { pubId: '', styleId: '', adsafe: 'low', adtest: false };

const bootstrap = (over: Partial<Parameters<typeof RelatedSearchBootstrap>[0]> = {}): string =>
  renderToStaticMarkup(<RelatedSearchBootstrap site={site} {...over} />);

describe('RelatedSearchBootstrap — two units of six chips', () => {
  it('fires ONE relatedsearch call with both blocks', () => {
    const html = bootstrap();
    expect(html).toContain("_googCsa('relatedsearch',po,b1,b2)");
    expect(html).toContain("container:'relatedsearches1'");
    expect(html).toContain("container:'relatedsearches2'");
  });

  it('asks for six chips per unit and sends no legacy `number`', () => {
    const html = bootstrap();
    expect(html.match(/relatedSearches:6/g)).toHaveLength(2);
    expect(html).not.toContain('number:5');
    expect(html).not.toMatch(/\bnumber:/);
  });

  it('counts a page view once: the fill beacon is on block 1 only', () => {
    const html = bootstrap();
    const b1 = html.slice(html.indexOf('var b1='), html.indexOf('var b2='));
    const b2 = html.slice(html.indexOf('var b2='), html.indexOf("_googCsa('relatedsearch',po,b1,b2)"));
    expect(b1).toContain('adLoadedCallback');
    expect(b2).not.toContain('adLoadedCallback');
  });

  it('re-fires both units after a bfcache restore', () => {
    const html = bootstrap();
    expect(html).toContain("['relatedsearches1','relatedsearches2']");
    expect(html.match(/_googCsa\('relatedsearch',po,b1,b2\)/g)).toHaveLength(2);
  });

  it("sends the domain's style, the RAC and the channel", () => {
    const html = bootstrap({ referrerAdCreative: 'Learn more about Personal Loan', channel: '07985', txid: 'tx-1' });
    expect(html).toContain('"styleId":"8472563621"');
    expect(html).toContain('"referrerAdCreative":"Learn more about Personal Loan"');
    expect(html).toContain('"channel":"07985"');
    expect(html).toContain('"relatedSearchTargeting":"content"');
  });

  it('carries the click id, channel and RAC in the results-page fragment', () => {
    const html = bootstrap({ referrerAdCreative: 'a b', channel: '07985', txid: 'tx-1' });
    // `&` is written as \u0026 inside the inline script (the XSS escape), and means the same thing to the JS reader.
    expect(html).toContain('#c=07985\\u0026r=a%20b\\u0026x=tx-1');
  });

  it('escapes anything that could break out of the inline script', () => {
    const html = bootstrap({ referrerAdCreative: '</script><script>alert(1)</script>' });
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).toContain('\\u003c/script\\u003e');
  });

  it('renders nothing for a host without an AFS account', () => {
    expect(renderToStaticMarkup(<RelatedSearchBootstrap site={none} />)).toBe('');
  });
});

describe('RelatedSearchSlot', () => {
  it('renders an empty, externally managed container with the given id', () => {
    const html = renderToStaticMarkup(<RelatedSearchSlot id="relatedsearches2" site={site} />);
    expect(html).toContain('id="relatedsearches2"');
    expect(html).toContain('aria-label="Related searches"');
    expect(html).toContain('></div>');
  });

  it('renders nothing for a host without an AFS account', () => {
    expect(renderToStaticMarkup(<RelatedSearchSlot id="relatedsearches1" site={none} />)).toBe('');
  });
});
