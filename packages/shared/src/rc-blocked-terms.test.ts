import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type RcLearningCampaign,
  findBlockedRcTerms,
  learnRcBlockedTerms,
  measureRcTerms,
  normalizeRcTerm,
  rcBlockedMessage,
  rcTokens,
} from './rc-blocked-terms.js';

const SEEDS = ['job', 'career', 'hiring', 'vacancy', 'free', 'work from home'];

describe('rcTokens / normalizeRcTerm', () => {
  it('lowercases, splits on punctuation and folds English plurals', () => {
    expect(rcTokens('Hospital JOBS — Apply-Now!')).toEqual(['hospital', 'job', 'apply', 'now']);
    expect(rcTokens('Vacancies, Careers & classes')).toEqual(['vacancy', 'career', 'class']);
    expect(rcTokens('courses matches boxes')).toEqual(['course', 'match', 'box']);
    expect(normalizeRcTerm('  Work  From Homes ')).toEqual('work from home');
  });

  it('keeps Devanagari words whole (vowel signs are combining marks, not separators)', () => {
    expect(rcTokens('हॉस्पिटल में नौकरी')).toEqual(['हॉस्पिटल', 'में', 'नौकरी']);
  });
});

describe('findBlockedRcTerms', () => {
  it('matches whole words, plural- and case-insensitively', () => {
    expect(findBlockedRcTerms('Hospital Jobs near you', SEEDS)).toEqual(['job']);
    expect(findBlockedRcTerms('FREE flat on rent', SEEDS)).toEqual(['free']);
    expect(findBlockedRcTerms('Hospitals are Hiring', SEEDS)).toEqual(['hiring']);
  });

  it('never matches inside another word', () => {
    expect(findBlockedRcTerms('Freedom plans for jobless-proof savings', ['free', 'job'])).toEqual([]);
    expect(findBlockedRcTerms('Nursing course fees in India', SEEDS)).toEqual([]);
  });

  it('matches a phrase only as consecutive words', () => {
    expect(findBlockedRcTerms('Packing work from home', SEEDS)).toEqual(['work from home']);
    expect(findBlockedRcTerms('Work at home from anywhere', SEEDS)).toEqual([]);
  });

  it('reports every hit once, in list order', () => {
    expect(findBlockedRcTerms('Free job, free careers', SEEDS)).toEqual(['job', 'career', 'free']);
    expect(findBlockedRcTerms('', SEEDS)).toEqual([]);
    expect(findBlockedRcTerms(null, SEEDS)).toEqual([]);
  });

  it('the buyer message names the words and points at the ad wording', () => {
    expect(rcBlockedMessage(['job'])).toContain('“job”');
    expect(rcBlockedMessage(['job'])).toContain("change the ad's wording");
  });
});

const camp = (rc: string, visits: number, keywordClicks: number): RcLearningCampaign => ({ rcTexts: [rc], visits, keywordClicks });
/** Healthy campaigns (≈50 keyword clicks per 100 visits) set the baseline. */
const HEALTHY = [
  camp('Flat on rent', 400, 200),
  camp('Used cars under 5 lakh', 500, 260),
  camp('Automatic gas stove price', 300, 150),
  camp('Laptop deals for students', 300, 140),
  camp('Personal loan interest rates', 600, 310),
];

describe('learnRcBlockedTerms', () => {
  it('learns the shared trigger word, not the topic words riding along', () => {
    const r = learnRcBlockedTerms({
      campaigns: [...HEALTHY, camp('Hospital Job', 300, 2), camp('Carpenter Job', 250, 0), camp('Packing Jobs', 200, 3)],
      known: [],
    });
    expect(r.learned.map((l) => l.term)).toEqual(['job']);
    expect(r.learned[0]).toMatchObject({ suppressedCampaigns: 3, campaignsUsing: 3 });
    expect(r.suppressedCampaigns).toBe(3);
  });

  it('learns nothing new when a known blocked term already explains the suppression', () => {
    const r = learnRcBlockedTerms({
      campaigns: [...HEALTHY, camp('Hospital Job', 300, 2), camp('Carpenter Job', 250, 0), camp('Packing Jobs', 200, 3)],
      known: [{ term: 'job', status: 'BLOCKED' }],
    });
    expect(r.learned).toEqual([]);
  });

  it('never learns a super-admin ALLOWED term', () => {
    const r = learnRcBlockedTerms({
      campaigns: [...HEALTHY, camp('Hospital Job', 300, 2), camp('Carpenter Job', 250, 0), camp('Packing Jobs', 200, 3)],
      known: [{ term: 'job', status: 'ALLOWED' }],
    });
    expect(r.learned).toEqual([]);
  });

  it('needs most campaigns using the word to be suppressed (healthy counter-examples veto it)', () => {
    const r = learnRcBlockedTerms({
      campaigns: [
        ...HEALTHY,
        camp('Hospital Job', 300, 2),
        camp('Carpenter Job', 250, 0),
        camp('Packing Jobs', 200, 3),
        camp('Driver job openings guide', 300, 180),
        camp('Job interview tips', 300, 170),
      ],
      known: [],
    });
    expect(r.learned).toEqual([]); // 3 of 5 = 60% < 75%
  });

  it('needs several different wordings and enough traffic per campaign', () => {
    const sameWording = learnRcBlockedTerms({
      campaigns: [...HEALTHY, camp('Hospital Job', 300, 2), camp('Hospital Job', 250, 0), camp('Hospital Job', 200, 3)],
      known: [],
    });
    expect(sameWording.learned).toEqual([]); // one wording, three copies — not independent evidence

    const lowTraffic = learnRcBlockedTerms({
      campaigns: [...HEALTHY, camp('Hospital Job', 90, 0), camp('Carpenter Job', 50, 0), camp('Packing Jobs', 80, 0)],
      known: [],
    });
    expect(lowTraffic.learned).toEqual([]);
    expect(lowTraffic.eligibleCampaigns).toBe(HEALTHY.length);
  });

  it('uses every rc of a campaign (campaign default + per-ad overrides)', () => {
    const r = learnRcBlockedTerms({
      campaigns: [
        ...HEALTHY,
        { rcTexts: ['Hospital staff guide', 'Hospital Job'], visits: 300, keywordClicks: 1 },
        { rcTexts: ['Carpenter tools', 'Carpenter Job'], visits: 300, keywordClicks: 0 },
        { rcTexts: ['Packing machines', 'Packing Job'], visits: 300, keywordClicks: 2 },
      ],
      known: [],
    });
    expect(r.learned.map((l) => l.term)).toEqual(['job']);
  });

  it('handles no data', () => {
    expect(learnRcBlockedTerms({ campaigns: [], known: [] })).toEqual({
      baselinePer100: null,
      eligibleCampaigns: 0,
      suppressedCampaigns: 0,
      learned: [],
    });
  });

  it('on the real Aug–Sep 2026 traffic it learns exactly "job" and "career" — and nothing beyond the seeds', () => {
    const campaigns = JSON.parse(
      readFileSync(new URL('./__fixtures__/rc-learning-2026-aug-sep.json', import.meta.url), 'utf8'),
    ) as RcLearningCampaign[];
    const fresh = learnRcBlockedTerms({ campaigns, known: [] });
    expect(fresh.eligibleCampaigns).toBe(48);
    expect(fresh.learned.map((l) => l.term)).toEqual(['job', 'career']);
    expect(fresh.learned[0]).toMatchObject({ term: 'job', suppressedCampaigns: 12, campaignsUsing: 14 });

    const withSeeds = learnRcBlockedTerms({ campaigns, known: SEEDS.map((term) => ({ term, status: 'BLOCKED' as const })) });
    expect(withSeeds.learned).toEqual([]);
  });
});

describe('measureRcTerms', () => {
  it('reports per-term usage, suppression and pooled keyword-click rate', () => {
    const r = measureRcTerms({
      campaigns: [...HEALTHY, camp('Hospital Job', 300, 3), camp('Carpenter Jobs', 200, 0), camp('Free flat listing', 150, 0)],
      terms: ['job', 'free', 'hiring'],
    });
    expect(r.baselinePer100).toBeGreaterThan(40);
    expect(r.stats.job).toEqual({ campaignsUsing: 2, suppressedCampaigns: 2, keywordClicksPer100: 0.6 });
    expect(r.stats.free).toEqual({ campaignsUsing: 1, suppressedCampaigns: 1, keywordClicksPer100: 0 });
    expect(r.stats.hiring).toEqual({ campaignsUsing: 0, suppressedCampaigns: 0, keywordClicksPer100: null });
  });
});
