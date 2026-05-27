import { describe, expect, it } from 'vitest';
import { articleParagraphs, articleTeaser } from './article.js';

describe('articleTeaser', () => {
  it('returns a short first paragraph unchanged (no ellipsis)', () => {
    const out = articleTeaser('A concise intro paragraph.\n\nSecond paragraph here.');
    expect(out).toBe('A concise intro paragraph.');
  });

  it('uses only the first paragraph', () => {
    expect(articleTeaser('First.\n\nSecond paragraph that is long.')).toBe('First.');
  });

  it('caps at 100 words with an ellipsis', () => {
    // Single-char words so 100 words (~199 chars) stays under the 300-char cap,
    // making the word cap the binding constraint.
    const para = Array.from({ length: 150 }, () => 'a').join(' ');
    const out = articleTeaser(para);
    expect(out.endsWith('…')).toBe(true);
    expect(out.replace('…', '').trim().split(/\s+/)).toHaveLength(100);
  });

  it('caps at 300 chars on a word boundary with an ellipsis', () => {
    // 60 ten-char words = ~660 chars but only 60 words → the char cap bites first.
    const para = Array.from({ length: 60 }, () => 'abcdefghi').join(' ');
    const out = articleTeaser(para);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(301); // 300 + ellipsis char
    expect(out).not.toMatch(/\sabcdefgh$/); // didn't cut mid-word at the tail
  });

  it('handles empty content', () => {
    expect(articleTeaser('   ')).toBe('');
  });
});

describe('articleParagraphs', () => {
  it('splits on blank lines and drops empties', () => {
    expect(articleParagraphs('One.\n\nTwo.\n\n\n\nThree.')).toEqual(['One.', 'Two.', 'Three.']);
  });
});
