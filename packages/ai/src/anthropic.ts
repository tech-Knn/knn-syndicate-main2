import { env } from '@knn/config';
import { AiNotConfiguredError, AiRequestError } from './errors.js';

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

interface MessagesResponse {
  content: { type: string; text?: string }[];
}

/** Low-level Claude Messages call → concatenated text of the reply. */
async function callClaude(system: string, user: string, maxTokens = 2048): Promise<string> {
  if (!env.ANTHROPIC_API_KEY) throw new AiNotConfiguredError('ANTHROPIC_API_KEY is not set');

  const res = await fetch(ANTHROPIC_MESSAGES_URL, {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: env.ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) {
    throw new AiRequestError(`Anthropic request failed: ${res.status}`, res.status);
  }
  const json = (await res.json()) as MessagesResponse;
  const text = json.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('')
    .trim();
  if (!text) throw new AiRequestError('Anthropic returned no text content');
  return text;
}

export interface GeneratedArticle {
  title: string;
  content: string;
}

/** Pull a leading `TITLE: ...` line out of the model output; fall back to topic. */
function splitTitle(raw: string, fallback: string): GeneratedArticle {
  const match = raw.match(/^\s*TITLE:\s*(.+?)\s*\n+([\s\S]+)$/i);
  if (match?.[1] && match[2]) return { title: match[1].trim(), content: match[2].trim() };
  return { title: fallback, content: raw };
}

/** Generate a fresh monetizable article for the given keywords / angle (D16). */
export async function generateArticle(input: {
  keywords: string[];
  query?: string;
}): Promise<GeneratedArticle> {
  const topic = input.query?.trim() || input.keywords.join(', ');
  const system =
    'You are an expert content writer producing clear, informative, SEO-friendly articles for a ' +
    'monetized landing page. Write engaging, factual prose in several short paragraphs. ' +
    'Respond with a single line "TITLE: <article title>", then a blank line, then the article body.';
  const user =
    `Write an informative article about: ${topic}\n` +
    `Naturally incorporate these themes: ${input.keywords.join(', ')}.\n` +
    'Target 400-700 words. Do not include markdown headings or lists — just paragraphs.';
  const raw = await callClaude(system, user, 2048);
  return splitTitle(raw, topic);
}

/** Rewrite an article to satisfy the admin-configured compliance rules (D16). */
export async function complianceRewrite(input: {
  content: string;
  compliancePrompt: string;
}): Promise<string> {
  const system =
    'You are a compliance editor. Rewrite the article to satisfy these rules, preserving the ' +
    'meaning, length, and paragraph structure but removing anything non-compliant. ' +
    `Return ONLY the rewritten article body.\n\nRULES:\n${input.compliancePrompt}`;
  return callClaude(system, input.content, 2048);
}
