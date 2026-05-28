import { env } from '@knn/config';
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
  '"title" (string, like "The Complete Guide to {topic}: {short benefit}"), ' +
  '"teaser" (string, the 60-90 word opening paragraph, plain text), ' +
  '"body_markdown" (string, the full article in markdown starting with the opening paragraph), ' +
  '"related_search_terms" (array of 6 short, high-commercial-intent search queries a buyer in this ' +
  'vertical would type — the kind that carry high ad CPC).';

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
  return {
    title: parsed.title?.trim() || topic,
    teaser: parsed.teaser?.trim() || '',
    content,
    relatedSearchTerms: asStringArray(parsed.related_search_terms),
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
