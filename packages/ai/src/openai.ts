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

const ARTICLE_SYSTEM =
  'You are an SEO content writer for a search-arbitrage landing page. Given a TOPIC, write a plain, ' +
  'factual, 1,000-1,500 word guide for a general US audience at an 8th-grade reading level. Be concrete: ' +
  'include real-world numbers, price ranges, and specifics. No fluff, no author, no in-text calls to action. ' +
  'Use this structure in the body markdown: an opening paragraph (60-90 words: hook, then define, then ' +
  'promise value), then "## Understanding {topic}", "## The Benefits of {topic}" (3-4 bolded sub-points), ' +
  'a concrete details section with numbers, "## How to Get Started" (3-4 numbered steps), and ' +
  '"## Frequently Asked Questions" (exactly 3 Q&As). ' +
  'Respond with STRICT JSON only, no prose around it, with keys: ' +
  '"title" (string, a CONCISE specific headline — at most ~7 words / 55 characters, fits two ' +
  'lines on a phone; do NOT use boilerplate like "The Complete Guide to" or a colon subtitle), ' +
  '"teaser" (string, a short 35-55 word opening hook, plain text — a few lines that set up the ' +
  'topic so the related-search unit sits high on the page), ' +
  '"body_markdown" (string, the full article in markdown starting with the opening paragraph), ' +
  '"related_search_terms" (array of exactly 6 short related-search queries, 2-5 words each, plain ' +
  'lowercase). They MUST be high-commercial / transactional intent that real US buyers type and that ' +
  'have strong ad inventory — e.g. "best medicare advantage plans", "affordable car insurance quotes", ' +
  '"solar panel installation cost". Stay tightly on the article TOPIC and its vertical; do NOT drift to ' +
  'unrelated verticals. Do NOT include questions ("how/what/why..."), brand or navigational queries, ' +
  'anything explicit/adult/sensitive, or implausible/clickbait phrasing ("free money", "one weird trick"). ' +
  'Each query should plausibly trigger relevant high-CPC ads.';

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

/** Generate a monetizable article + high-CPC related-search terms for a topic (OpenAI). */
export async function generateArticleOpenAI(input: {
  keywords: string[];
  query?: string;
}): Promise<GeneratedArticleAI> {
  const topic = input.query?.trim() || input.keywords.join(', ');
  const user =
    `TOPIC: ${topic}\n` +
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
