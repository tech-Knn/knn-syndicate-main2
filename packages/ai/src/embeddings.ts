import { env } from '@knn/config';
import { EMBEDDING_DIMENSIONS } from '@knn/shared';
import { AiNotConfiguredError, AiRequestError } from './errors.js';

const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';

interface EmbeddingResponse {
  data: { embedding: number[] }[];
}

/**
 * Embed text with OpenAI `text-embedding-3-small` (1536-dim, D16). Returns the
 * raw vector for pgvector cosine reuse. Throws `AiNotConfiguredError` when no key
 * is set so callers can degrade gracefully (e.g. skip reuse, queue for later).
 */
export async function embedText(text: string): Promise<number[]> {
  if (!env.OPENAI_API_KEY) throw new AiNotConfiguredError('OPENAI_API_KEY is not set');

  const res = await fetch(OPENAI_EMBEDDINGS_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: env.OPENAI_EMBEDDING_MODEL, input: text }),
  });
  if (!res.ok) {
    throw new AiRequestError(`OpenAI embeddings request failed: ${res.status}`, res.status);
  }
  const json = (await res.json()) as EmbeddingResponse;
  const vector = json.data[0]?.embedding;
  if (!vector || vector.length !== EMBEDDING_DIMENSIONS) {
    throw new AiRequestError(`Unexpected embedding length: ${vector?.length ?? 'none'}`);
  }
  return vector;
}
