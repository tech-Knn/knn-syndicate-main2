import { describe, expect, it } from 'vitest';
import {
  GOOGLE_SIGNAL_LIMITS,
  effectiveRac,
  googleSignalsUpdateSchema,
  normalizeCustomTerms,
  resolvePublisherTerms,
} from './google-signals.js';
import { classifyTerm, cleanTerms } from './terms.js';

describe('normalizeCustomTerms', () => {
  it('passes buyer terms through as entered — no filtering, ranking or cap', () => {
    const terms = ['Hospital Job', 'hospital jobs near me', 'Carpenter Job', 'x', 'free money now', 'jobs'];
    expect(normalizeCustomTerms(terms)).toEqual(terms);
  });

  it('only trims, collapses whitespace, strips commas and de-duplicates case-insensitively', () => {
    expect(normalizeCustomTerms(['  used  cars ', 'Used Cars', 'cars, under 5 lakh', '', '   '])).toEqual([
      'used cars',
      'cars under 5 lakh',
    ]);
  });

  it('accepts newline-separated text (the dashboard textarea)', () => {
    expect(normalizeCustomTerms('one\r\ntwo\n\nthree')).toEqual(['one', 'two', 'three']);
  });

  it('handles empty input', () => {
    expect(normalizeCustomTerms(undefined)).toEqual([]);
    expect(normalizeCustomTerms(null)).toEqual([]);
    expect(normalizeCustomTerms([])).toEqual([]);
  });
});

describe('resolvePublisherTerms', () => {
  const article = {
    articleTerms: ['used smartphones under 10000 price', 'second hand mobile price', 'buy used iphone online'],
    keywords: ['second hand mobile phones'],
    query: 'second hand mobile',
  };

  it('custom terms win and are sent exactly as entered (not cleaned, not capped at 6)', () => {
    const custom = ['Hospital Job', 'a', 'b', 'c', 'd', 'e', 'f', 'g'];
    expect(resolvePublisherTerms({ ...article, custom })).toEqual({ source: 'custom', terms: custom });
  });

  it('without custom terms, sends EXACTLY what the article page sent before D27', () => {
    const contextVertical =
      [article.query, ...article.keywords].map((p) => (p ? classifyTerm(p).vertical : null)).find(Boolean) ?? null;
    const before = cleanTerms(article.articleTerms, { contextVertical, max: 6 });
    expect(resolvePublisherTerms(article)).toEqual({ source: 'article', terms: before });
  });

  it('falls back to keywords, then to none', () => {
    expect(resolvePublisherTerms({ keywords: ['used car price'], articleTerms: [] }).source).toBe('keywords');
    expect(resolvePublisherTerms({})).toEqual({ source: 'none', terms: [] });
  });

  it('an empty custom list falls through to the AI terms', () => {
    expect(resolvePublisherTerms({ ...article, custom: ['  ', ''] }).source).toBe('article');
  });
});

describe('effectiveRac', () => {
  it('ad override wins, else campaign default, else null', () => {
    expect(effectiveRac('Ad text', 'Campaign text')).toBe('Ad text');
    expect(effectiveRac(null, 'Campaign text')).toBe('Campaign text');
    expect(effectiveRac('   ', 'Campaign text')).toBe('Campaign text');
    expect(effectiveRac(null, null)).toBeNull();
  });
});

describe('googleSignalsUpdateSchema — technical limits only', () => {
  it('accepts any wording, including single words and "job" phrasing', () => {
    const r = googleSignalsUpdateSchema.safeParse({
      racValue: 'Job',
      terms: ['Hospital Job', 'x'],
      ads: [{ adId: '11111111-1111-1111-1111-111111111111', racValue: 'हॉस्पिटल में नौकरियां 2000+' }],
    });
    expect(r.success).toBe(true);
  });

  it('allows clearing (null / empty list)', () => {
    expect(googleSignalsUpdateSchema.safeParse({ racValue: null, terms: [], ads: [{ adId: '11111111-1111-1111-1111-111111111111', racValue: null }] }).success).toBe(true);
  });

  it('rejects only oversized values', () => {
    expect(googleSignalsUpdateSchema.safeParse({ racValue: 'x'.repeat(GOOGLE_SIGNAL_LIMITS.racMaxChars + 1) }).success).toBe(false);
    expect(googleSignalsUpdateSchema.safeParse({ terms: Array.from({ length: GOOGLE_SIGNAL_LIMITS.termsMaxCount + 1 }, (_, i) => `t${i}`) }).success).toBe(false);
    expect(googleSignalsUpdateSchema.safeParse({ terms: ['x'.repeat(GOOGLE_SIGNAL_LIMITS.termMaxChars + 1)] }).success).toBe(false);
  });
});
