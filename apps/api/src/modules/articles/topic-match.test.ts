// apps/api/src/modules/articles/topic-match.test.ts
// Pure unit tests (no DB), so these run locally too.
import { describe, expect, it } from 'vitest';
import { articleMatchesQuery, contentTokens, coverage, queryFitsKeywords } from './topic-match';

describe('contentTokens', () => {
  it('drops stopwords, punctuation and plurals', () => {
    expect([...contentTokens('Carpenter Jobs Near Me')]).toEqual(['carpenter', 'job']);
    expect([...contentTokens('Beginner’s Guide')]).toEqual(['beginner']);
  });
});

describe('articleMatchesQuery (reuse guard)', () => {
  // Incidents from the 22/09 audit: these must NOT be reused.
  it('rejects fatty liver -> JCB article', () => {
    expect(
      articleMatchesQuery('fatty liver symptoms and treatment', {
        query: 'Second Hand JCB',
        title: 'Affordable Second Hand JCBs for Construction',
      }),
    ).toBe(false);
  });

  it('rejects second hand truck -> used car article', () => {
    expect(
      articleMatchesQuery('second hand truck', { query: 'Used car', title: 'Smart Guide to Buying a Used Car' }),
    ).toBe(false);
  });

  it('rejects second hand truck -> second hand JCB (shared generic words only)', () => {
    expect(
      articleMatchesQuery('second hand truck', { query: 'Second Hand JCB', title: 'Affordable Second Hand JCB Prices Guide' }),
    ).toBe(false);
  });

  // Legitimate reuses seen in the DB: these should still be reused.
  it('allows private driver -> private personal driver job article', () => {
    expect(
      articleMatchesQuery('private driver', {
        query: 'read more about private personal driver job',
        title: 'Private Personal Driver Jobs Explained',
      }),
    ).toBe(true);
  });

  it('allows carpenter job -> carpenter jobs article', () => {
    expect(
      articleMatchesQuery('Carpenter Job', { query: 'Carpenter Job', title: 'Carpenter Jobs: Skills, Pay, and Opportunities' }),
    ).toBe(true);
  });
});

describe('queryFitsKeywords (generation guard)', () => {
  it('rejects a JCB query with fatty-liver keywords', () => {
    expect(queryFitsKeywords('Second Hand JCB', ['fatty liver treatment USA', 'liver specialist near me'])).toBe(false);
  });

  it('accepts real campaigns from the DB', () => {
    expect(
      queryFitsKeywords('Ultimate Beginner’s Guide to Massage Therapy: Choosing the Right Treatment for Your Body', [
        'medical massage therapist',
      ]),
    ).toBe(true);
    expect(queryFitsKeywords('Private security services online', ['Private Security Guard Services'])).toBe(true);
    expect(queryFitsKeywords('Unisex Pg', ['Unisex PG Accommodation'])).toBe(true);
  });

  it('never blocks a stopword-only query', () => {
    expect(coverage('best guide', 'anything')).toBe(1);
  });
});