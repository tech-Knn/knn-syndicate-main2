import { describe, expect, it } from 'vitest';
import { articleBlocks, articleParagraphs, articleTeaser } from './article.js';

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

describe('articleBlocks', () => {
  it('parses headings, paragraphs, and bullet/numbered lists', () => {
    const md = [
      'Opening paragraph here.',
      '',
      '## Understanding ADUs',
      '',
      'An ADU is a unit.',
      '',
      '### Benefits',
      '',
      '- Extra space',
      '- Rental income',
      '',
      '## How to Get Started',
      '',
      '1. Check zoning',
      '2. Set a budget',
    ].join('\n');
    expect(articleBlocks(md)).toEqual([
      { type: 'p', text: 'Opening paragraph here.' },
      { type: 'h2', text: 'Understanding ADUs' },
      { type: 'p', text: 'An ADU is a unit.' },
      { type: 'h3', text: 'Benefits' },
      { type: 'ul', items: ['Extra space', 'Rental income'] },
      { type: 'h2', text: 'How to Get Started' },
      { type: 'ol', items: ['Check zoning', 'Set a budget'] },
    ]);
  });

  it('strips inline emphasis markers and joins wrapped paragraph lines', () => {
    const md = '**Increased Value:** an ADU can\nraise your home value.';
    expect(articleBlocks(md)).toEqual([
      { type: 'p', text: 'Increased Value: an ADU can raise your home value.' },
    ]);
  });

  it('treats a single # as h2 (the page renders the title as h1)', () => {
    expect(articleBlocks('# Top Heading')).toEqual([{ type: 'h2', text: 'Top Heading' }]);
  });
});
