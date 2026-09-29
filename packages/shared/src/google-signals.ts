import { z } from 'zod';
import { classifyTerm, cleanTerms } from './terms.js';

/**
 * Buyer-editable Google signals (D27): the Referrer Ad Creative (`referrerAdCreative` / redirect
 * `rc`) and the RSOC related-search `terms` sent with every paid article view. Buyers see exactly
 * what is sent and edit it on LIVE campaigns without approval. Buyer text is passed through AS
 * ENTERED — the only limits here are technical (the values travel inside a signed URL token and
 * CSA's comma-delimited `terms` format), never content rules.
 */

/**
 * Technical caps — never content rules. rc + terms ride base64-encoded inside the signed `?t=` token,
 * so they size the money-page URL, and the browser then repeats that URL as the `Referer` of every
 * same-origin asset request. Next (Node) rejects requests over 16 KB of URL + headers with 431 —
 * a failed JS chunk would silently kill the page's conversion beacon. Measured worst case (all
 * Devanagari, 3 bytes/char) at these caps: a ~4.8 KB page URL (vs ~10.4 KB at 20 × 100), leaving
 * ample room for cookies. Google's own request is not the constraint (its front end accepts ≥ 64 KB).
 * The rc cap is also the draft wizard's (one constant).
 */
export const GOOGLE_SIGNAL_LIMITS = {
  /** Max characters of one Referrer Ad Creative (fits a full FB primary text). */
  racMaxChars: 500,
  /** Max number of custom terms (the unit shows 5 chips). */
  termsMaxCount: 10,
  /** Max characters of one custom term. */
  termMaxChars: 60,
} as const;

/**
 * Normalize buyer-entered terms WITHOUT judging them: trim, collapse whitespace, replace commas
 * (CSA `terms` is comma-delimited, so a comma inside a term would split it) with a space, drop
 * empties, and de-duplicate case-insensitively keeping the first occurrence. No ranking, no
 * filtering, no cap beyond the technical limits.
 */
export function normalizeCustomTerms(input: readonly string[] | string | null | undefined): string[] {
  const raw = typeof input === 'string' ? input.split(/\r?\n/) : [...(input ?? [])];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of raw) {
    const t = String(r).replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/** Where the terms sent to Google came from. */
export type TermsSource = 'custom' | 'article' | 'keywords' | 'none';

export interface PublisherTermsInput {
  /** The buyer's custom terms (signed, from the redirect). Non-empty → sent exactly as entered. */
  custom?: readonly string[] | null;
  /** The article's AI-generated related-search terms. */
  articleTerms?: readonly string[] | null;
  /** The article's (campaign) keywords — fallback when the article has no AI terms. */
  keywords?: readonly string[] | null;
  /** The article's query/angle — sets the vertical context for the AI-term cleaner. */
  query?: string | null;
}

/**
 * THE single source of truth for the RSOC `terms` a money page sends (used by the article page
 * AND the dashboard's "Sent to Google" panel, so they can never disagree):
 *   1. the buyer's custom terms — as entered (only `normalizeCustomTerms`);
 *   2. else the article's AI terms, then its keywords — through the RSOC term-quality cleaner
 *      (`cleanTerms`, max 6), exactly as before D27.
 */
export function resolvePublisherTerms(input: PublisherTermsInput): { source: TermsSource; terms: string[] } {
  const custom = normalizeCustomTerms(input.custom);
  if (custom.length) return { source: 'custom', terms: custom };

  const articleTerms = input.articleTerms ?? [];
  const keywords = input.keywords ?? [];
  const source: TermsSource = articleTerms.length ? 'article' : keywords.length ? 'keywords' : 'none';
  const pool = articleTerms.length ? articleTerms : keywords;
  if (!pool.length) return { source: 'none', terms: [] };
  const contextVertical =
    [input.query ?? null, ...keywords].map((p) => (p ? classifyTerm(p).vertical : null)).find(Boolean) ?? null;
  const terms = cleanTerms(pool, { contextVertical, max: 6 });
  return { source: terms.length ? source : 'none', terms };
}

/** Effective Referrer Ad Creative for one ad: its own override, else the campaign default. */
export function effectiveRac(adRac: string | null | undefined, campaignRac: string | null | undefined): string | null {
  const own = (adRac ?? '').trim();
  if (own) return own;
  const def = (campaignRac ?? '').trim();
  return def || null;
}

const racField = z
  .string()
  .max(GOOGLE_SIGNAL_LIMITS.racMaxChars, `Referrer Ad Creative is limited to ${GOOGLE_SIGNAL_LIMITS.racMaxChars} characters`)
  .nullable();

/**
 * Live-edit body. Every field is optional (send only what changed). `null`/empty clears:
 * an ad's `racValue` → falls back to the campaign default; `terms: []` → back to the AI terms.
 */
export const googleSignalsUpdateSchema = z.object({
  /** The campaign-default Referrer Ad Creative (used by ads without their own). */
  racValue: racField.optional(),
  /** Custom terms, sent exactly as entered. `[]` reverts to the article's AI terms. */
  terms: z
    .array(z.string().max(GOOGLE_SIGNAL_LIMITS.termMaxChars, `Each keyword is limited to ${GOOGLE_SIGNAL_LIMITS.termMaxChars} characters`))
    .max(GOOGLE_SIGNAL_LIMITS.termsMaxCount, `At most ${GOOGLE_SIGNAL_LIMITS.termsMaxCount} keywords`)
    .optional(),
  /** Per-ad overrides; `racValue: null` (or blank) → use the campaign default. */
  ads: z.array(z.object({ adId: z.string().uuid(), racValue: racField })).optional(),
});
export type GoogleSignalsUpdate = z.infer<typeof googleSignalsUpdateSchema>;

/** One ad's row in the "Sent to Google" view. */
export interface GoogleSignalsAd {
  id: string;
  name: string;
  adSetName: string;
  creativeType: string;
  /** The uploaded creative's file name (helps the buyer match the ad). */
  fileName: string | null;
  /** The ad's own override, or null when it uses the campaign default. */
  racValue: string | null;
  /** What Google receives for this ad right now. */
  effectiveRac: string | null;
}

/** The terms one landing article sends. */
export interface GoogleSignalsArticleTerms {
  articleId: string;
  slug: string;
  title: string;
  /** Where the SENT terms come from. */
  source: TermsSource;
  /** Exactly what Google receives as `terms` (post-D27). */
  sent: string[];
  /** The AI terms that would be sent without a custom list. */
  aiTerms: string[];
}

/** GET/PUT /api/campaigns/:id/google-signals response. */
export interface GoogleSignalsView {
  campaignId: string;
  status: string;
  /** Launched → edits re-sync the live redirect immediately. */
  live: boolean;
  racValue: string | null;
  ads: GoogleSignalsAd[];
  /** The buyer's custom terms ([] = AI terms are sent). */
  customTerms: string[];
  articles: GoogleSignalsArticleTerms[];
  /** True when the save re-synced the live redirect (PUT only). */
  synced?: boolean;
}
