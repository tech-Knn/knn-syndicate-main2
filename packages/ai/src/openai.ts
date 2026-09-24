import { env } from '@knn/config';
import { classifyTerm, cleanTerms, filterTerms } from '@knn/shared';
import { AiNotConfiguredError, AiRequestError } from './errors.js';

/**
 * OpenAI chat client for article generation + compliance (Phase 9.5). The platform
 * uses OpenAI (cost-optimized `gpt-4.1-mini` by default) for the monetized search-arb
 * articles — short, formulaic, high-volume, so a mini model matches the competitor
 * output at ≈⅓¢/article. fetch-based (no SDK), key optional (→ AiNotConfiguredError),
 * model from `env.OPENAI_ARTICLE_MODEL` (same invariants as the Claude client).
 */

const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';

interface ChatResponse {
  choices?: { message?: { content?: string } }[];
}

/** Low-level Chat Completions call → the assistant message text. `json` forces a JSON object reply. */
async function callOpenAiChat(
  system: string,
  user: string,
  opts: { json?: boolean; maxTokens?: number } = {},
): Promise<string> {
  if (!env.OPENAI_API_KEY) throw new AiNotConfiguredError('OPENAI_API_KEY is not set');

  const res = await fetch(OPENAI_CHAT_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: env.OPENAI_ARTICLE_MODEL,
      max_tokens: opts.maxTokens ?? 3000,
      temperature: 0.7,
      ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!res.ok) {
    throw new AiRequestError(`OpenAI request failed: ${res.status}`, res.status);
  }
  const json = (await res.json()) as ChatResponse;
  const text = json.choices?.[0]?.message?.content?.trim();
  if (!text) throw new AiRequestError('OpenAI returned no content');
  return text;
}

export interface GeneratedArticleAI {
  title: string;
  /** The 60–90 word opening paragraph (the content-page teaser). */
  teaser: string;
  /** Full article body in markdown (## headings, lists). */
  content: string;
  /** High-commercial-intent related-search queries → the CSA `terms` (where the CPC lives). */
  relatedSearchTerms: string[];
}

// -----------------------------------------------------------------------------
// PROMPT HISTORY — DO NOT DELETE (preserved for reference / rollback).
//
// v3 (2026-09-23, current): pivoted from "SEO writer, factual guide" tone to a
// "premium consultation guide" tone per operator direction. Structural changes:
// - 7-section body (calm opener → problem/solution → comparison → consultation
//   & eligibility → what to expect → FAQ → soft-CTA closer), replacing the older
//   5-section (Understanding / Benefits / How to Get Started / FAQ).
// - Explicit tone directive: professional, calm, premium, trustworthy, not sales-y.
// - Soft CTA phrasing throughout ("compare providers", "check eligibility",
//   "get a personalized recommendation") — the v2 prompt banned CTAs entirely.
// - Psychological framing checklist (problem awareness, expert-assisted discovery,
//   premium comparison, consultation intent).
// - Related-search terms now also encouraged to align with consultation /
//   comparison / eligibility patterns, on top of the v2 commercial-modifier rule.
// - `STRICTLY AVOID` list adds aggressive sales language.
//
// PRESERVED FROM v2:
// - STRICT JSON response with keys title/teaser/body_markdown/related_search_terms
// - 6 related_search_terms, 3-5 words each, EVERY query needs a commercial modifier
//   (price / purchase-intent / location) — the rule that lifted fill rate on India
//   traffic Sept 19-22.
// - No US hardcoding (still geo-neutral — market awareness is a separate future
//   change that requires passing a `market` param through generateArticleOpenAI).
// - Same avoid list foundation (2-word generic phrases, questions, brand names,
//   navigational, explicit, clickbait).
//
// v2 (2026-09-19): removed hardcoded "US audience" / "US buyers" and swapped
// US-only examples (medicare, car insurance, solar) for geo-neutral commercial
// patterns. Required commercial modifier on every keyword. Result: RSOC fill rate
// lifted from ~27% on India traffic (Mobile Phones campaign hit 60% CTR after).
//
// v1 (pre-2026-09-19): US-hardcoded SEO writer prompt. Full text recoverable via
// `git log -p packages/ai/src/openai.ts`.
// -----------------------------------------------------------------------------

const ARTICLE_SYSTEM =
  'You are a content strategist creating a premium informational landing page for the TOPIC ' +
  'provided. The page should feel like a trustworthy consultation and recommendation guide — ' +
  'NEVER an aggressive sales page. ' +
  'Core objectives (write for these outcomes, not for keyword density): increase high-intent ' +
  'engagement; improve revenue per click and view-to-conversion rate; attract advertiser-friendly ' +
  'traffic; build trust and longer session duration; create search-intent alignment. ' +
  'Tone: professional, calm, premium, trustworthy, informational, solution-aware. ' +
  'Weave these psychological elements naturally into the copy: emotional problem awareness ' +
  '(surface the reader’s pain point calmly, no fear-mongering); real timing / relevance signals ' +
  '(never scare tactics); expert-assisted discovery framing; premium comparison framing (options ' +
  'presented like a consultant would); consultation-oriented CTA phrasing throughout (soft, not ' +
  'aggressive); native informational style; commercial intent optimization — align with what a ' +
  'ready-to-buy user is actually searching for. ' +
  'MUST NOT feel like: clickbait, affiliate spam, fake advertorial, overhyped sales copy, ' +
  'aggressive direct-response marketing. ' +
  'Use this structure in the body markdown (1,000-1,500 words, 8th-grade reading level, include ' +
  'real numbers / price ranges / timeframes): ' +
  '(1) a calm premium opening paragraph (60-100 words) aligned with search intent — sets emotional ' +
  'context + promises informational value; ' +
  '(2) "## " topic-specific H2 for a problem/solution education section (2-3 short paragraphs, one ' +
  'real number or fact per paragraph); ' +
  '(3) "## Comparing your options" — premium comparison or recommendation section with 3-4 bolded ' +
  'sub-points; ' +
  '(4) "## Consultation & eligibility" — soft consultation-oriented guidance with 3-4 items and ' +
  'real criteria; ' +
  '(5) "## What to expect" — trust-building detail with specifics (process steps, typical ' +
  'timeframes, cost ranges); ' +
  '(6) "## Frequently Asked Questions" — exactly 3 short Q&As; ' +
  '(7) a calm closing paragraph with soft CTA phrasing ("compare providers", "check eligibility", ' +
  '"get a personalized recommendation"). ' +
  'Respond with STRICT JSON only, no prose around it, with keys: ' +
  '"title" (calm premium headline aligned with search intent, at most 8 words / 60 characters, ' +
  'fits two lines on a phone; never boilerplate like "The Complete Guide to", never clickbait, ' +
  'never colon-subtitle format); ' +
  '"teaser" (40-60 word opening hook, plain text — a few lines that set the topic up so the ' +
  'related-search unit sits high on the page); ' +
  '"body_markdown" (the full article in markdown starting with the opening paragraph, following ' +
  'the 7-section structure above); ' +
  '"related_search_terms" (array of exactly 6 short related-search queries, 3-5 words each, plain ' +
  'lowercase). Align them with treatment / service comparisons, consultation searches, provider ' +
  'discovery, pricing research, eligibility checks, or expert recommendations. ' +
  'EVERY query MUST include AT LEAST ONE commercial modifier: ' +
  '(a) PRICE / QUANTITY signal (e.g. "under 5 lakh", "below 50000", "monthly payments", "cheap", ' +
  '"affordable", "cost", "quote", "price"); ' +
  '(b) PURCHASE-INTENT signal (e.g. "buy", "for sale", "hire", "quote", "near me", "compare"); or ' +
  '(c) LOCATION modifier (a city or region name relevant to the topic). ' +
  'Example patterns that fill well across geographies: "compare [service] providers near me", ' +
  '"affordable [service] consultation", "[topic] cost comparison", "top-rated [service] near me", ' +
  '"eligibility for [service]", "[service] expert recommendation", "[item] price under [amount]". ' +
  'Stay tightly on the article TOPIC and its vertical — do NOT drift. ' +
  'STRICTLY AVOID: 2-word phrases with no commercial modifier ("mechanic service"); questions ' +
  '("how / what / why..."); brand or platform names ("olx cars", "amazon jobs"); navigational ' +
  'queries; explicit / adult / sensitive content; clickbait phrasing ("free money", "one weird ' +
  'trick"); aggressive sales language ("act now", "limited time offer", "don’t miss out").';

interface ArticleJson {
  title?: string;
  teaser?: string;
  body_markdown?: string;
  related_search_terms?: unknown;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim());
}

/** Infer the article's high-CPC vertical from its topic/keywords (for term-coherence ranking). */
function deriveContextVertical(parts: (string | undefined)[]): string | null {
  for (const p of parts) {
    if (!p) continue;
    const v = classifyTerm(p).vertical;
    if (v) return v;
  }
  return null;
}

/** Localize currency + city examples in the prompt based on the article's target market.
 *  Extend this table as new markets are added. Falls back to a neutral "local currency" note
 *  so an unknown market still gets a "don't mix currencies" instruction. */
function marketGuidance(market: string): string {
  const m = market.trim().toLowerCase();
  if (m === 'india' || m === 'in') {
    return 'TARGET MARKET: India. Use INR (₹) throughout — never dollars. Reference Indian cities (Delhi, Mumbai, Bangalore, Chennai, Hyderabad, Pune, Kolkata, Noida, Gurgaon, Ahmedabad). Use Indian salary/price scales (thousands and lakhs, not tens/hundreds of thousands of USD). Prefer Indian institutions/context (ITI, government hospital, NEET, UPSC, Aadhaar) where relevant. Never mix currencies or geographies inside the article.';
  }
  if (m === 'usa' || m === 'us' || m === 'united states') {
    return 'TARGET MARKET: United States. Use USD ($) throughout. Reference US cities (New York, Los Angeles, Chicago, Houston, Phoenix, Dallas, Atlanta, Miami, Seattle, Boston). Use US salary/price scales. Prefer US institutions/context (community college, DMV, IRS, Social Security). Never mix currencies or geographies inside the article.';
  }
  if (m === 'uk' || m === 'united kingdom' || m === 'gb') {
    return 'TARGET MARKET: United Kingdom. Use GBP (£) throughout. Reference UK cities (London, Manchester, Birmingham, Glasgow, Leeds, Liverpool). Use UK salary/price scales. Prefer UK institutions/context (NHS, HMRC, sixth form). Never mix currencies or geographies inside the article.';
  }
  if (m === 'uae' || m === 'united arab emirates' || m === 'ae') {
    return 'TARGET MARKET: United Arab Emirates. Use AED (د.إ) throughout. Reference UAE cities (Dubai, Abu Dhabi, Sharjah, Ajman). Never mix currencies or geographies inside the article.';
  }
  if (m === 'saudi arabia' || m === 'saudi' || m === 'ksa' || m === 'sa') {
    return 'TARGET MARKET: Saudi Arabia. Use SAR (ر.س) throughout — never INR, never USD, never rupees. Reference Saudi cities (Riyadh, Jeddah, Mecca, Medina, Dammam, Khobar). The audience is residents of Saudi Arabia (Saudi nationals and long-term expats); do NOT frame the article around "Indian professionals relocating" or any other single-nationality expat group. Prefer Saudi institutions/context (iqama, MOL, Absher, GOSI, Nitaqat) where relevant. Never mix currencies or geographies inside the article.';
  }
  if (m === 'australia' || m === 'au') {
    return 'TARGET MARKET: Australia. Use AUD (A$) throughout. Reference Australian cities (Sydney, Melbourne, Brisbane, Perth, Adelaide). Never mix currencies or geographies inside the article.';
  }
  if (m === 'canada' || m === 'ca') {
    return 'TARGET MARKET: Canada. Use CAD (C$) throughout. Reference Canadian cities (Toronto, Vancouver, Montreal, Calgary, Ottawa). Never mix currencies or geographies inside the article.';
  }
  // Unknown market — at least prevent currency mixing
  return `TARGET MARKET: ${market}. Use the LOCAL currency and reference LOCAL cities / price scales for ${market} throughout. Never mix currencies or geographies inside the article.`;
}

/** Generate a monetizable article + high-CPC related-search terms for a topic (OpenAI). */
export async function generateArticleOpenAI(input: {
  keywords: string[];
  query?: string;
  /** Target country / market (e.g. "India", "USA", "UK"). Localizes currency + city examples in the
   *  prompt so the article never mixes $ into an India-served page. Defaults to "India" upstream —
   *  100% of live FB traffic today is India-served (verified 2026-09-23). */
  market?: string;
}): Promise<GeneratedArticleAI> {
  const topic = input.query?.trim() || input.keywords.join(', ');
  const marketLine = input.market ? marketGuidance(input.market) + '\n' : '';
  const user =
    `TOPIC: ${topic}\n` +
    marketLine +
    (input.keywords.length ? `Related themes to weave in: ${input.keywords.join(', ')}.` : '');
  const raw = await callOpenAiChat(ARTICLE_SYSTEM, user, { json: true, maxTokens: 3000 });

  let parsed: ArticleJson;
  try {
    parsed = JSON.parse(raw) as ArticleJson;
  } catch {
    throw new AiRequestError('OpenAI returned non-JSON article output');
  }
  const content = parsed.body_markdown?.trim();
  if (!content) throw new AiRequestError('OpenAI article output missing body');

  // Quality gate (Google RSOC quality signal): run the model's terms through the deterministic
  // filter so junk/implausible/sensitive/off-vertical terms never reach the AFS unit (where Google
  // now penalizes them). Rank-first/drop-rarely. If the model returned nothing usable, derive clean
  // terms from the campaign keywords so the unit is never left empty.
  const contextVertical = deriveContextVertical([input.query, ...input.keywords]);
  const filtered = filterTerms(asStringArray(parsed.related_search_terms), { contextVertical, min: 3, max: 6 });
  const relatedSearchTerms = filtered.kept.length > 0 ? filtered.kept : cleanTerms(input.keywords, { contextVertical, max: 6 });

  return {
    title: parsed.title?.trim() || topic,
    teaser: parsed.teaser?.trim() || '',
    content,
    relatedSearchTerms,
  };
}

/** Rewrite an article to satisfy the admin-configured compliance rules (OpenAI). */
export async function complianceRewriteOpenAI(input: {
  content: string;
  compliancePrompt: string;
}): Promise<string> {
  const system =
    'You are a compliance editor. Rewrite the article to satisfy these rules, preserving the meaning, ' +
    'length, and markdown structure (headings, lists) but removing anything non-compliant. ' +
    `Return ONLY the rewritten article body in markdown.\n\nRULES:\n${input.compliancePrompt}`;
  return callOpenAiChat(system, input.content, { maxTokens: 3000 });
}
