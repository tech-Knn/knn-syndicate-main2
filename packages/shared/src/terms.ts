/**
 * RSOC related-search term quality engine.
 *
 * Google's mid-2026 RSOC quality signal *penalizes* related-search links that lead to
 * irrelevant / low-quality ads, and **discards** partner-provided terms it judges weak —
 * and the penalty drags down coverage across the whole page/account, not just the bad term.
 * So term quality is now a multiplier on the entire funnel's RPC, not a per-term yield.
 *
 * This module is the *preventive* half: a pure, deterministic classifier + filter that
 * (a) recognizes high-commercial-intent terms in high-CPC verticals (where the money is),
 * (b) hard-drops only *clearly* bad terms (sensitive / implausible / gibberish), and
 * (c) ranks the rest so the strongest terms lead — without ever starving the unit.
 *
 * Design rule (load-bearing): **rank-first, drop-rarely.** Over-dropping would reduce the
 * number of terms → lower fill → lower RPC, the exact opposite of the goal. We therefore
 * hard-drop ONLY clearly-bad terms; everything else is scored for ordering, never removed.
 * `filterTerms` never returns an empty list when given any non-bad input, and never throws.
 *
 * Pure (no I/O); used by `@knn/ai` (post-generation filter) and `apps/article` (serve-time
 * hygiene on the terms-precedence chain). Fully unit-tested in `terms.test.ts`.
 */

export type TermIntent = 'transactional' | 'commercial' | 'informational' | 'navigational' | 'unknown';
export type CpcTier = 'high' | 'medium' | 'low' | 'none';

export interface TermClassification {
  /** The normalized term (trimmed, whitespace-collapsed, edge punctuation stripped). */
  term: string;
  intent: TermIntent;
  /** The matched high-CPC vertical id, or null. */
  vertical: string | null;
  /** CPC tier of the matched vertical (`none` when no vertical matched). */
  cpcTier: CpcTier;
  /** False only for *clearly* unusable terms (gibberish / extreme length / implausible claim). */
  plausible: boolean;
  /** True for explicit / sensitive / disallowed terms (Google AFS policy). */
  blocked: boolean;
  /** Composite 0..100 quality score used for ranking (higher = better RPC potential). */
  score: number;
  /** Human-readable signals (e.g. 'informational', 'too_long', 'no_vertical'). */
  flags: string[];
}

/** A high-CPC vertical: the verticals where advertisers bid most and ad inventory is deep. */
interface Vertical {
  id: string;
  tier: CpcTier;
  /** Lowercase substrings; a term matches the vertical if it contains any. */
  patterns: string[];
}

/**
 * High-CPC verticals for US search arbitrage, ordered roughly by depth of ad inventory.
 * Patterns are matched as lowercase substrings against the normalized term. Kept as data
 * (not scattered conditionals) so it's tunable in one place with the test suite as the spec.
 */
export const HIGH_CPC_VERTICALS: Vertical[] = [
  {
    id: 'insurance',
    tier: 'high',
    patterns: [
      'insurance',
      'medicare',
      'medigap',
      'medicaid',
      'annuity',
      'annuities',
      'final expense',
      'life cover',
      'burial cover',
      'umbrella policy',
    ],
  },
  {
    id: 'finance',
    tier: 'high',
    patterns: [
      'loan',
      'loans',
      'mortgage',
      'refinance',
      'refi ',
      'credit card',
      'credit score',
      'debt relief',
      'debt consolidation',
      'home equity',
      'heloc',
      'line of credit',
      'cash advance',
      'structured settlement',
      'invoice factoring',
      'high yield savings',
      'cd rates',
      'ira',
      '401k',
      'tax relief',
      'tax debt',
    ],
  },
  {
    id: 'legal',
    tier: 'high',
    patterns: [
      'attorney',
      'lawyer',
      'law firm',
      'lawsuit',
      'personal injury',
      'injury claim',
      'mesothelioma',
      'car accident',
      'truck accident',
      'workers comp',
      "workers' comp",
      'wrongful death',
      'class action',
      'compensation claim',
      'disability claim',
      'bankruptcy',
    ],
  },
  {
    id: 'health',
    tier: 'high',
    patterns: [
      'rehab',
      'addiction treatment',
      'drug treatment',
      'dental implant',
      'hearing aid',
      'senior care',
      'assisted living',
      'memory care',
      'home care',
      'medical alert',
      'weight loss',
      'clinical trial',
      'hair transplant',
      'lasik',
      'varicose',
      'knee replacement',
      'cataract surgery',
      'cancer treatment',
      'mental health treatment',
      'physical therapy',
      'urgent care',
      'mobility scooter',
      'stair lift',
    ],
  },
  {
    id: 'home_services',
    tier: 'high',
    patterns: [
      'solar',
      'roofing',
      'roof replacement',
      'window replacement',
      'replacement windows',
      'hvac',
      'air conditioning',
      'furnace',
      'gutter',
      'siding',
      'bathroom remodel',
      'kitchen remodel',
      'walk-in tub',
      'walk in tub',
      'foundation repair',
      'pest control',
      'driveway',
      'water heater',
      'home warranty',
      'security system',
      'home security',
      'fence install',
      'concrete',
      'epoxy floor',
    ],
  },
  {
    id: 'auto',
    tier: 'high',
    patterns: [
      'suv',
      'pickup truck',
      'electric car',
      'electric suv',
      'hybrid suv',
      'lease deal',
      'car deal',
      'used cars',
      'new cars',
      'cars for sale',
      'auto loan',
      'car loan',
      'car warranty',
      'extended warranty',
      'rv for sale',
    ],
  },
  {
    id: 'education',
    tier: 'high',
    patterns: [
      'degree',
      'mba',
      'online courses',
      'nursing program',
      'certification',
      'bootcamp',
      'trade school',
      'masters program',
      'phd ',
      'cybersecurity program',
      'medical billing course',
    ],
  },
  {
    id: 'b2b_saas',
    tier: 'high',
    patterns: [
      'crm',
      'payroll',
      'erp',
      'business phone',
      'voip',
      'accounting software',
      'project management software',
      'hr software',
      'pos system',
      'merchant services',
      'business loan',
      'fleet management',
      'background check service',
    ],
  },
  {
    id: 'real_estate',
    tier: 'medium',
    patterns: [
      'homes for sale',
      'houses for sale',
      'apartments for rent',
      'senior apartments',
      'real estate',
      '55+ community',
      'foreclosure',
      'new construction homes',
    ],
  },
  {
    id: 'jobs',
    tier: 'medium',
    patterns: [
      'jobs',
      'hiring near',
      'remote jobs',
      'warehouse jobs',
      'work from home jobs',
      'job openings',
      'now hiring',
      'driving jobs',
    ],
  },
  {
    id: 'telecom',
    tier: 'medium',
    patterns: [
      'internet provider',
      'internet providers',
      'broadband',
      'fiber internet',
      'mobile plan',
      'phone plan',
      'cell phone plan',
      'satellite internet',
      'tv package',
    ],
  },
  {
    id: 'travel',
    tier: 'medium',
    patterns: [
      'cruise',
      'cruises',
      'vacation package',
      'all inclusive resort',
      'hotel deals',
      'flight deals',
      'tour package',
    ],
  },
];

/** Transactional / commercial-intent signals — the buyer-ready phrasing advertisers pay for. */
const TRANSACTIONAL_MODIFIERS = [
  'buy',
  'for sale',
  'price',
  'prices',
  'pricing',
  'cost',
  'costs',
  'quote',
  'quotes',
  'near me',
  'deal',
  'deals',
  'discount',
  'discounts',
  'cheap',
  'affordable',
  'low cost',
  'rates',
  'compare',
  'best',
  'top',
  'top rated',
  'offer',
  'offers',
  'online',
  'apply',
  'hire',
  'rent',
  'lease',
  'per month',
  'monthly',
  'plans',
  'options',
  'companies',
  'providers',
  'services',
  'reviews',
  ' vs ',
  'no exam',
  'no down payment',
  'free quote',
  'get a quote',
];

/** Informational openers — low commercial value (Google: these often have no good ad inventory). */
const INFORMATIONAL_OPENERS = [
  'how ',
  'how to',
  'what ',
  'what is',
  'what are',
  'why ',
  'when ',
  'who ',
  'where ',
  'which ',
  'is ',
  'are ',
  'does ',
  'do ',
  'can ',
  'should ',
  'meaning of',
  'definition of',
  'history of',
  'examples of',
];

/** Navigational signals — looking for a specific site, not a commercial intent. */
const NAVIGATIONAL_SIGNALS = ['login', 'log in', 'sign in', 'sign up', '.com', '.net', '.org', 'official site', 'website'];

/**
 * Conservative sensitive / disallowed blocklist (Google AFS "explicit, adult, or sensitive").
 * Deliberately small + specific to avoid false positives that would starve legitimate verticals
 * (e.g. "weed killer" must NOT trip a drug filter; "gun safe" must NOT trip a weapons filter).
 */
const SENSITIVE_PATTERNS = [
  'porn',
  ' sex ',
  'sex video',
  'escort',
  'xxx',
  ' nude',
  'onlyfans',
  'buy weed',
  'buy cocaine',
  'buy heroin',
  'buy meth',
  'buy guns',
  'buy a gun',
  'ammo for sale',
  'silencer for sale',
  'how to make a bomb',
  'fake id',
  'counterfeit money',
  'hire a hitman',
  'child ',
];

/** Implausible / clickbait claim patterns — "highly unrealistic" intent Google says to avoid. */
const IMPLAUSIBLE_PATTERNS = [
  'free money',
  'win the lottery',
  'guaranteed millionaire',
  'get rich quick',
  'make money fast',
  'one weird trick',
  'doctors hate',
  'banks hate',
  '$1 ',
  '99% off',
  'click here',
  'you wont believe',
  "you won't believe",
  'shocking secret',
];

const HARD_MAX_WORDS = 9; // beyond this it isn't a real search query → drop
const HARD_MAX_CHARS = 80;
const SOFT_MAX_WORDS = 6; // beyond this, penalize but keep
const DEFAULT_MIN_TERMS = 3;
const DEFAULT_MAX_TERMS = 6;

/** Normalize a term for matching/dedup: trim, collapse internal whitespace, strip edge punctuation/quotes. */
export function normalizeTerm(raw: string): string {
  return String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“”‘’\s.,;:!?-]+/, '')
    .replace(/["'“”‘’\s.,;:!?-]+$/, '')
    .trim();
}

/** Lowercase, single-spaced, alnum-only key for case/punctuation-insensitive dedup. */
function dedupKey(term: string): string {
  return normalizeTerm(term)
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function wordCount(term: string): number {
  const t = term.trim();
  return t ? t.split(/\s+/).length : 0;
}

/** Keyboard rows — a 5+ char contiguous substring of one of these is almost always a mash. */
const KEYBOARD_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

/** Heuristic: does the term read like gibberish (no real word structure)? */
function looksLikeGibberish(term: string): boolean {
  const t = term.toLowerCase();
  const letters = t.replace(/[^a-z]/g, '').length;
  const nonSpace = t.replace(/\s/g, '').length;
  if (nonSpace === 0) return true;
  // Mostly non-letters (e.g. "$$$ ###", "12345 !!!") → not a search phrase.
  if (letters / nonSpace < 0.5) return true;
  // A long run of one repeated character ("aaaaaa", "!!!!!!").
  if (/(.)\1{5,}/.test(t)) return true;
  for (const w of t.split(/\s+/)) {
    const letterWord = w.replace(/[^a-z]/g, '');
    if (letterWord.length >= 22) return true;
    // No vowel in a longish word → consonant mash ("brrmpf", "sdfghjk").
    if (letterWord.length >= 6 && !/[aeiouy]/.test(letterWord)) return true;
    // A run of 5+ consonants ("asdfghjkl" → "sdfghjkl").
    if (/[bcdfghjklmnpqrstvwxz]{5,}/.test(letterWord)) return true;
    // A 5+ char contiguous slice of a keyboard row ("qwertyuiop", "asdfghjkl").
    if (letterWord.length >= 5 && KEYBOARD_ROWS.some((row) => row.includes(letterWord))) return true;
    // Very low vowel ratio in a longish word.
    if (letterWord.length >= 5) {
      const vowels = (letterWord.match(/[aeiouy]/g) ?? []).length;
      if (vowels / letterWord.length < 0.2) return true;
    }
  }
  return false;
}

function matchesAny(haystackLower: string, patterns: string[]): string | null {
  for (const p of patterns) {
    if (haystackLower.includes(p)) return p;
    // Allow word-boundary matches for short bare tokens padded with spaces in the pattern list.
  }
  return null;
}

/** Classify a single related-search term (pure; never throws). */
export function classifyTerm(raw: string): TermClassification {
  const term = normalizeTerm(raw);
  const lower = ` ${term.toLowerCase()} `; // pad so " vs " / "is " boundary patterns work
  const flags: string[] = [];

  if (!term) {
    return { term, intent: 'unknown', vertical: null, cpcTier: 'none', plausible: false, blocked: false, score: 0, flags: ['empty'] };
  }

  // --- Blocked (sensitive / disallowed) ---------------------------------------------------
  const blocked = matchesAny(lower, SENSITIVE_PATTERNS) !== null;
  if (blocked) flags.push('sensitive');

  // --- Plausibility -----------------------------------------------------------------------
  let plausible = true;
  const words = wordCount(term);
  if (words > HARD_MAX_WORDS || term.length > HARD_MAX_CHARS) {
    plausible = false;
    flags.push('too_long');
  }
  if (looksLikeGibberish(term)) {
    plausible = false;
    flags.push('gibberish');
  }
  if (matchesAny(lower, IMPLAUSIBLE_PATTERNS) !== null) {
    plausible = false;
    flags.push('implausible');
  }

  // --- Vertical ---------------------------------------------------------------------------
  let vertical: string | null = null;
  let cpcTier: CpcTier = 'none';
  for (const v of HIGH_CPC_VERTICALS) {
    if (matchesAny(lower, v.patterns) !== null) {
      vertical = v.id;
      cpcTier = v.tier;
      break;
    }
  }
  if (!vertical) flags.push('no_vertical');

  // --- Intent -----------------------------------------------------------------------------
  let intent: TermIntent;
  const startsInformational = INFORMATIONAL_OPENERS.some((o) => `${term.toLowerCase()} `.startsWith(o));
  const hasTransactional = matchesAny(lower, TRANSACTIONAL_MODIFIERS) !== null;
  const isNavigational = matchesAny(lower, NAVIGATIONAL_SIGNALS) !== null;
  if (isNavigational) {
    intent = 'navigational';
    flags.push('navigational');
  } else if (startsInformational && !hasTransactional) {
    intent = 'informational';
    flags.push('informational');
  } else if (hasTransactional) {
    intent = 'transactional';
  } else if (vertical) {
    intent = 'commercial';
  } else {
    intent = 'unknown';
  }

  // --- Score (0..100) ---------------------------------------------------------------------
  let score: number;
  if (blocked) {
    score = 0;
  } else {
    const intentBase: Record<TermIntent, number> = {
      transactional: 60,
      commercial: 45,
      informational: 15,
      navigational: 10,
      unknown: 30,
    };
    const tierBonus: Record<CpcTier, number> = { high: 32, medium: 18, low: 6, none: 0 };
    score = intentBase[intent] + tierBonus[cpcTier];
    // A tight 2–6 word phrase is the sweet spot for a related-search chip.
    if (words >= 2 && words <= SOFT_MAX_WORDS) score += 6;
    if (words > SOFT_MAX_WORDS && words <= HARD_MAX_WORDS) {
      score -= 8;
      flags.push('long');
    }
    if (!plausible) score = Math.max(0, score - 45);
    score = Math.max(0, Math.min(100, score));
  }

  return { term, intent, vertical, cpcTier, plausible, blocked, score, flags };
}

export interface FilterTermsOptions {
  /** Always keep at least this many terms when that many non-bad terms exist (default 3). */
  min?: number;
  /** Cap the kept list to the top-scored this many (default 6). */
  max?: number;
  /**
   * Optional coherence context: the article/campaign's vertical. Terms in the SAME vertical get
   * a small ranking bonus; terms in a DIFFERENT high-CPC vertical a small penalty (incoherent
   * funnels are what the quality signal punishes). Ranking-only — never a hard drop.
   */
  contextVertical?: string | null;
}

export interface FilterTermsResult {
  /** Clean, ranked terms (best first), capped to `max`. */
  kept: string[];
  /** Terms removed, with the reason — surfaced for transparency (no silent truncation). */
  dropped: { term: string; reason: string }[];
}

/**
 * Filter + rank related-search terms for the RSOC unit. Rank-first, drop-rarely:
 * hard-drops ONLY blocked / implausible / empty / duplicate terms; ranks the rest by quality
 * score (with optional vertical-coherence nudge) and caps to `max`. Never throws; never returns
 * an empty `kept` if any non-bad term was supplied.
 */
export function filterTerms(terms: readonly string[], opts: FilterTermsOptions = {}): FilterTermsResult {
  const max = opts.max ?? DEFAULT_MAX_TERMS;
  const min = Math.min(opts.min ?? DEFAULT_MIN_TERMS, max);
  const dropped: { term: string; reason: string }[] = [];
  const seen = new Set<string>();
  const candidates: { term: string; score: number }[] = [];

  for (const raw of terms ?? []) {
    const cls = classifyTerm(raw);
    if (!cls.term) {
      dropped.push({ term: String(raw ?? ''), reason: 'empty' });
      continue;
    }
    const key = dedupKey(cls.term);
    if (!key || seen.has(key)) {
      dropped.push({ term: cls.term, reason: 'duplicate' });
      continue;
    }
    if (cls.blocked) {
      dropped.push({ term: cls.term, reason: 'sensitive' });
      continue;
    }
    if (!cls.plausible) {
      dropped.push({ term: cls.term, reason: cls.flags.find((f) => ['gibberish', 'too_long', 'implausible'].includes(f)) ?? 'implausible' });
      continue;
    }
    seen.add(key);
    // Coherence nudge (ranking only).
    let score = cls.score;
    if (opts.contextVertical) {
      if (cls.vertical === opts.contextVertical) score += 8;
      else if (cls.vertical && cls.vertical !== opts.contextVertical) score -= 5;
    }
    candidates.push({ term: cls.term, score });
  }

  // Stable sort by score desc (preserve original order for equal scores).
  const ranked = candidates
    .map((c, i) => ({ ...c, i }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((c) => c.term);

  const kept = ranked.slice(0, max);
  for (const t of ranked.slice(max)) dropped.push({ term: t, reason: 'over_cap' });

  // `min` is a guarantee that we don't drop GOOD terms below the floor — since we only ever
  // hard-drop clearly-bad terms, it's already satisfied; exposed here for intent/clarity.
  void min;

  return { kept, dropped };
}

/** Convenience: just the cleaned, ranked term list (drops discarded). */
export function cleanTerms(terms: readonly string[], opts?: FilterTermsOptions): string[] {
  return filterTerms(terms, opts).kept;
}
