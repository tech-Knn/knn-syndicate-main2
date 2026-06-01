import { describe, expect, it } from 'vitest';
import { classifyTerm, cleanTerms, filterTerms, normalizeTerm } from './terms.js';

describe('normalizeTerm', () => {
  it('trims, collapses whitespace, strips edge punctuation/quotes', () => {
    expect(normalizeTerm('  best  car   insurance  ')).toBe('best car insurance');
    expect(normalizeTerm('"medicare plans"')).toBe('medicare plans');
    expect(normalizeTerm('cheap flights!!!')).toBe('cheap flights');
    expect(normalizeTerm('“solar panels”')).toBe('solar panels');
  });
  it('handles nullish/garbage without throwing', () => {
    expect(normalizeTerm(undefined as unknown as string)).toBe('');
    expect(normalizeTerm('')).toBe('');
  });
});

describe('classifyTerm — intent', () => {
  it('flags transactional modifiers as transactional', () => {
    expect(classifyTerm('best car insurance quotes').intent).toBe('transactional');
    expect(classifyTerm('affordable life insurance near me').intent).toBe('transactional');
    expect(classifyTerm('compare medicare plans').intent).toBe('transactional');
  });
  it('treats question openers without commercial modifiers as informational', () => {
    expect(classifyTerm('how does car insurance work').intent).toBe('informational');
    expect(classifyTerm('what is medicare').intent).toBe('informational');
  });
  it('lets a transactional modifier override an informational opener', () => {
    // "how to compare ..." has commercial intent despite the "how to" opener
    expect(classifyTerm('how to compare car insurance rates').intent).toBe('transactional');
  });
  it('marks a bare vertical noun phrase as commercial', () => {
    expect(classifyTerm('dental implants').intent).toBe('commercial');
  });
  it('detects navigational intent', () => {
    expect(classifyTerm('geico.com login').intent).toBe('navigational');
  });
});

describe('classifyTerm — vertical + cpc tier', () => {
  it('maps terms to high-CPC verticals', () => {
    expect(classifyTerm('car insurance quotes').vertical).toBe('insurance');
    expect(classifyTerm('mortgage refinance rates').vertical).toBe('finance');
    expect(classifyTerm('personal injury attorney').vertical).toBe('legal');
    expect(classifyTerm('solar panel installation').vertical).toBe('home_services');
    expect(classifyTerm('hearing aids for seniors').vertical).toBe('health');
  });
  it('assigns the vertical cpc tier', () => {
    expect(classifyTerm('car insurance').cpcTier).toBe('high');
    expect(classifyTerm('cruise deals').cpcTier).toBe('medium');
  });
  it('returns null vertical + none tier for off-vertical terms', () => {
    const c = classifyTerm('cute cat pictures');
    expect(c.vertical).toBeNull();
    expect(c.cpcTier).toBe('none');
    expect(c.flags).toContain('no_vertical');
  });
});

describe('classifyTerm — blocked + plausibility', () => {
  it('blocks sensitive/explicit terms', () => {
    expect(classifyTerm('free porn videos').blocked).toBe(true);
    expect(classifyTerm('buy cocaine online').blocked).toBe(true);
    expect(classifyTerm('how to make a bomb').blocked).toBe(true);
  });
  it('does NOT false-positive on legitimate look-alikes', () => {
    expect(classifyTerm('weed killer for lawns').blocked).toBe(false);
    expect(classifyTerm('gun safe for sale').blocked).toBe(false);
    expect(classifyTerm('sussex county homes for sale').blocked).toBe(false);
  });
  it('marks implausible clickbait as not plausible', () => {
    expect(classifyTerm('free money guaranteed').plausible).toBe(false);
    expect(classifyTerm('one weird trick to get rich quick').plausible).toBe(false);
  });
  it('marks gibberish + extreme length as not plausible', () => {
    expect(classifyTerm('asdfghjkl qwertyuiop').plausible).toBe(false);
    expect(classifyTerm('$$$ ###').plausible).toBe(false);
    expect(
      classifyTerm('the absolute best most affordable comprehensive full coverage car insurance policy for young drivers in california today').plausible,
    ).toBe(false);
  });
  it('keeps a normal commercial phrase plausible', () => {
    expect(classifyTerm('best medicare advantage plans 2026').plausible).toBe(true);
  });
});

describe('classifyTerm — score ordering', () => {
  it('scores transactional+high-CPC above informational+no-vertical', () => {
    const good = classifyTerm('best car insurance quotes').score;
    const meh = classifyTerm('how does weather work').score;
    expect(good).toBeGreaterThan(meh);
  });
  it('gives blocked terms a zero score', () => {
    expect(classifyTerm('free porn videos').score).toBe(0);
  });
  it('keeps scores within 0..100', () => {
    for (const t of ['best car insurance quotes near me', 'x', 'free money', 'mortgage rates']) {
      const s = classifyTerm(t).score;
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(100);
    }
  });
});

describe('filterTerms — rank-first, drop-rarely', () => {
  it('drops blocked, implausible, gibberish, and duplicate terms with reasons', () => {
    const res = filterTerms([
      'best car insurance quotes',
      'free porn videos', // sensitive
      'free money guaranteed', // implausible
      'asdfghjkl', // gibberish
      'Best Car Insurance Quotes', // duplicate (case-insensitive)
      'mortgage refinance rates',
    ]);
    expect(res.kept).toContain('best car insurance quotes');
    expect(res.kept).toContain('mortgage refinance rates');
    expect(res.kept).not.toContain('free porn videos');
    const reasons = Object.fromEntries(res.dropped.map((d) => [d.term, d.reason]));
    expect(reasons['free porn videos']).toBe('sensitive');
    expect(reasons['free money guaranteed']).toBe('implausible');
    expect(reasons['asdfghjkl']).toBe('gibberish');
    expect(reasons['Best Car Insurance Quotes']).toBe('duplicate');
  });

  it('ranks the strongest commercial terms first', () => {
    const res = filterTerms([
      'what is car insurance', // informational
      'cheap car insurance quotes', // transactional + high CPC
      'car insurance', // commercial + high CPC
    ]);
    expect(res.kept[0]).toBe('cheap car insurance quotes');
  });

  it('caps to max and records the overflow as over_cap (no silent truncation)', () => {
    const input = ['a car insurance', 'b mortgage rates', 'c personal injury lawyer', 'd solar panels', 'e hearing aids', 'f dental implants', 'g cruise deals'];
    const res = filterTerms(input, { max: 6 });
    expect(res.kept).toHaveLength(6);
    expect(res.dropped.filter((d) => d.reason === 'over_cap')).toHaveLength(1);
  });

  it('never returns empty when given any non-bad term', () => {
    expect(filterTerms(['car insurance']).kept).toEqual(['car insurance']);
  });

  it('returns empty kept (not a throw) when EVERY term is bad', () => {
    const res = filterTerms(['free porn', 'asdfghjkl', '$$$']);
    expect(res.kept).toEqual([]);
    expect(res.dropped.length).toBe(3);
  });

  it('does not throw on empty/garbage input', () => {
    expect(filterTerms([]).kept).toEqual([]);
    expect(filterTerms(['', '   ', '!!!']).kept).toEqual([]);
  });

  it('applies the coherence nudge to rank in-vertical terms higher', () => {
    // Two equally-transactional terms; the in-context one should lead.
    const res = filterTerms(['top rated roofing companies', 'top rated cruise deals'], { contextVertical: 'home_services' });
    expect(res.kept[0]).toBe('top rated roofing companies');
  });
});

describe('cleanTerms', () => {
  it('returns just the ranked kept list', () => {
    expect(cleanTerms(['free porn', 'car insurance quotes'])).toEqual(['car insurance quotes']);
  });
});
