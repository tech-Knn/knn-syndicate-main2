/**
 * Referrer Ad Creative words that make Google hide the related-search keyword block (D28).
 *
 * Measured 2026-09-30 on live landing pages (rc passed as `?rc=`, exactly like a paid click): with
 * job-seeking wording ("Hospital Job", "Hospitals are hiring", "Hospital Vacancy 2026") or "free"
 * anywhere in the rc, Google returned NO related-search unit, while the same page with a neutral rc
 * ("Nursing course fees in India") showed it. Real traffic agreed: job-wording rc campaigns got 17
 * keyword clicks per 100 visits vs 60 for the rest.
 *
 * The list lives in `rc_blocked_terms` (seeded with the tested words, grown daily by
 * `learnRcBlockedTerms` from real traffic, overridable by super-admins). This module is the pure
 * part — shared by the API (enforcement + learning) and the dashboard (inline errors) so both
 * match words identically.
 */

/** Learner thresholds. A campaign needs `minVisits` paid visits in the window to count; it's
 *  "suppressed" when its keyword-click rate is below `suppressedBelow` × the platform median. A word
 *  is learned when ≥ `minSuppressedCampaigns` suppressed campaigns use it, in ≥ `minContexts`
 *  different rc wordings, and ≥ `minShare` of ALL campaigns using it are suppressed. */
export const RC_LEARNING = {
  windowDays: 30,
  minVisits: 100,
  suppressedBelow: 0.35,
  minSuppressedCampaigns: 3,
  minContexts: 3,
  minShare: 0.75,
} as const;

/** Words too generic to be learned on their own (they ride along with the real trigger). */
const LEARNING_STOPWORDS = new Set(
  (
    'a an and or the of in on for to with from at by near me my your you our is are be new best top ' +
    'more read about guide informational article india indian get how what now today this that'
  ).split(' '),
);

/** Plural-insensitive for Latin-script words (jobs → job, vacancies → vacancy); others untouched. */
function stem(word: string): string {
  if (!/^[a-z]+$/.test(word)) return word;
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && /(sses|ches|shes|xes)$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/**
 * The rc as comparable tokens: lowercase, split on anything that isn't a letter, combining mark
 * (Devanagari vowel signs) or digit, then stemmed. Order is kept so phrases can match.
 */
export function rcTokens(text: string | null | undefined): string[] {
  return (String(text ?? '').toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? []).map(stem);
}

/** Canonical stored form of a blocked word/phrase ("Work  From Homes" → "work from home"). */
export function normalizeRcTerm(term: string): string {
  return rcTokens(term).join(' ');
}

/**
 * Which blocked terms appear in `text` (whole words, plural-insensitive; a phrase must appear as
 * consecutive words). Returns the matching terms as given, deduplicated, in list order.
 */
export function findBlockedRcTerms(text: string | null | undefined, blockedTerms: readonly string[]): string[] {
  const tokens = rcTokens(text);
  if (tokens.length === 0) return [];
  const hits: string[] = [];
  for (const term of blockedTerms) {
    const phrase = rcTokens(term);
    if (phrase.length === 0 || hits.includes(term)) continue;
    for (let i = 0; i + phrase.length <= tokens.length; i += 1) {
      if (phrase.every((p, j) => tokens[i + j] === p)) {
        hits.push(term);
        break;
      }
    }
  }
  return hits;
}

/** The buyer-facing explanation for a blocked rc. rc must stay the ad's real text, so the fix is to
 *  change the ad's wording — not to write a different rc. */
export function rcBlockedMessage(hits: readonly string[]): string {
  const words = hits.map((h) => `“${h}”`).join(', ');
  return (
    `Google hides the keyword block when the Referrer Ad Creative contains ${words}. ` +
    `The rc must be your ad's real text, so change the ad's wording (e.g. course, training, company or ` +
    `information angle) and use that text here.`
  );
}

export interface RcLearningCampaign {
  /** All effective rc texts of the campaign (campaign default + per-ad overrides). */
  rcTexts: readonly string[];
  /** Paid visits (FB link clicks) in the window. */
  visits: number;
  /** Keyword-block clicks in the window (AFS ad requests on /search come only from a chip click). */
  keywordClicks: number;
}

export interface LearnedRcTerm {
  term: string;
  suppressedCampaigns: number;
  campaignsUsing: number;
  /** Keyword clicks per 100 visits across the campaigns using the term. */
  keywordClicksPer100: number;
}

export interface RcLearningResult {
  /** Median keyword clicks per 100 visits over eligible campaigns (null = too little data). */
  baselinePer100: number | null;
  eligibleCampaigns: number;
  suppressedCampaigns: number;
  learned: LearnedRcTerm[];
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

type Thresholds = typeof RC_LEARNING;

/** Eligible campaigns (enough visits) with their rate, words and suppression flag + the baseline. */
function prepare(campaigns: readonly RcLearningCampaign[], t: Thresholds) {
  const eligible = campaigns
    .filter((c) => c.visits >= t.minVisits)
    .map((c) => {
      const tokens = new Set(c.rcTexts.flatMap((x) => rcTokens(x)));
      const words = new Set([...tokens].filter((w) => w.length >= 3 && /\p{L}/u.test(w) && !LEARNING_STOPWORDS.has(w)));
      return { text: c.rcTexts.join(' | '), words, visits: c.visits, keywordClicks: c.keywordClicks, rate: (100 * c.keywordClicks) / c.visits };
    });
  const baseline = eligible.length ? median(eligible.map((c) => c.rate)) : null;
  return {
    baseline,
    campaigns: eligible.map((c) => ({ ...c, suppressed: baseline !== null && c.rate < t.suppressedBelow * baseline })),
  };
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Current evidence for known terms (shown to super-admins next to each word): how many eligible
 * campaigns use it, how many of those are suppressed, and their pooled keyword clicks per 100 visits.
 */
export function measureRcTerms(input: {
  campaigns: readonly RcLearningCampaign[];
  terms: readonly string[];
  thresholds?: Partial<Thresholds>;
}): { baselinePer100: number | null; stats: Record<string, { campaignsUsing: number; suppressedCampaigns: number; keywordClicksPer100: number | null }> } {
  const { baseline, campaigns } = prepare(input.campaigns, { ...RC_LEARNING, ...input.thresholds });
  const stats: Record<string, { campaignsUsing: number; suppressedCampaigns: number; keywordClicksPer100: number | null }> = {};
  for (const term of input.terms) {
    const using = campaigns.filter((c) => findBlockedRcTerms(c.text, [term]).length > 0);
    const visits = using.reduce((s, c) => s + c.visits, 0);
    const clicks = using.reduce((s, c) => s + c.keywordClicks, 0);
    stats[term] = {
      campaignsUsing: using.length,
      suppressedCampaigns: using.filter((c) => c.suppressed).length,
      keywordClicksPer100: visits ? round1((100 * clicks) / visits) : null,
    };
  }
  return { baselinePer100: baseline === null ? null : round1(baseline), stats };
}

/**
 * Learn new blocked words from real traffic. Greedy "explain the suppression" search:
 *   1. suppressed campaigns already explained by a known BLOCKED term are set aside first — so a
 *      topic word that only rides along ("hospital" in "Hospital Job") is never learned;
 *   2. repeatedly take the single word that explains the most remaining suppressed campaigns (ties:
 *      higher share of its campaigns suppressed), provided it clears every `RC_LEARNING` threshold;
 *   3. ALLOWED terms (super-admin overrides) are never candidates.
 * Pure: the caller loads the numbers and persists the result.
 */
export function learnRcBlockedTerms(input: {
  campaigns: readonly RcLearningCampaign[];
  known: readonly { term: string; status: 'BLOCKED' | 'ALLOWED' }[];
  thresholds?: Partial<Thresholds>;
}): RcLearningResult {
  const t = { ...RC_LEARNING, ...input.thresholds };
  const { baseline, campaigns } = prepare(input.campaigns, t);
  if (baseline === null) return { baselinePer100: null, eligibleCampaigns: 0, suppressedCampaigns: 0, learned: [] };
  const blocked = input.known.filter((k) => k.status === 'BLOCKED').map((k) => k.term);
  const excluded = new Set(input.known.map((k) => normalizeRcTerm(k.term)));

  // Step 1: suppression that known blocked terms already explain doesn't need a new word.
  let unexplained = campaigns.filter((c) => c.suppressed && findBlockedRcTerms(c.text, blocked).length === 0);
  const learned: LearnedRcTerm[] = [];

  for (;;) {
    const candidates = [...new Set(unexplained.flatMap((c) => [...c.words]))]
      .filter((w) => !excluded.has(w))
      .map((w) => {
        const using = campaigns.filter((c) => c.words.has(w));
        const explains = unexplained.filter((c) => c.words.has(w));
        const contexts = new Set(explains.map((c) => [...c.words].filter((x) => x !== w).sort().join(' ')));
        const share = using.filter((c) => c.suppressed).length / using.length;
        return { w, using, explains, contexts: contexts.size, share };
      })
      .filter(
        (c) => c.explains.length >= t.minSuppressedCampaigns && c.contexts >= t.minContexts && c.share >= t.minShare,
      )
      .sort((a, b) => b.explains.length - a.explains.length || b.share - a.share || a.w.localeCompare(b.w));
    const best = candidates[0];
    if (!best) break;
    const visits = best.using.reduce((s, c) => s + c.visits, 0);
    const clicks = best.using.reduce((s, c) => s + c.keywordClicks, 0);
    learned.push({
      term: best.w,
      suppressedCampaigns: best.using.filter((c) => c.suppressed).length,
      campaignsUsing: best.using.length,
      keywordClicksPer100: round1((100 * clicks) / visits),
    });
    excluded.add(best.w);
    unexplained = unexplained.filter((c) => !c.words.has(best.w));
  }

  return {
    baselinePer100: round1(baseline),
    eligibleCampaigns: campaigns.length,
    suppressedCampaigns: campaigns.filter((c) => c.suppressed).length,
    learned,
  };
}
