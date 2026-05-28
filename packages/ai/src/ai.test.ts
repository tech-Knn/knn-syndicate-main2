import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock the validated env so we can exercise both configured and not-configured
// paths (the real test env has empty AI keys). The fns read `env.*` at call time.
const { fakeEnv } = vi.hoisted(() => ({
  fakeEnv: {
    OPENAI_API_KEY: 'sk-openai-test',
    OPENAI_EMBEDDING_MODEL: 'text-embedding-3-small',
    OPENAI_ARTICLE_MODEL: 'gpt-4.1-mini-test',
    ANTHROPIC_API_KEY: 'sk-ant-test',
    ANTHROPIC_MODEL: 'claude-test',
  },
}));
vi.mock('@knn/config', () => ({ env: fakeEnv }));

const { embedText } = await import('./embeddings.js');
const { generateArticle, complianceRewrite } = await import('./anthropic.js');
const { generateArticleOpenAI, complianceRewriteOpenAI } = await import('./openai.js');
const { AiNotConfiguredError, AiRequestError } = await import('./errors.js');

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
  fakeEnv.OPENAI_API_KEY = 'sk-openai-test';
  fakeEnv.ANTHROPIC_API_KEY = 'sk-ant-test';
});

describe('embedText', () => {
  it('returns the 1536-dim vector and posts the configured model', async () => {
    const vec = Array.from({ length: 1536 }, () => 0.01);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [{ embedding: vec }] }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(embedText('health insurance')).resolves.toHaveLength(1536);
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string) as {
      model: string;
      input: string;
    };
    expect(body.model).toBe('text-embedding-3-small');
    expect(body.input).toBe('health insurance');
  });

  it('rejects a wrong-length embedding', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ data: [{ embedding: [0.1, 0.2] }] })));
    await expect(embedText('x')).rejects.toBeInstanceOf(AiRequestError);
  });

  it('throws AiRequestError on a non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'nope' }, 500)));
    await expect(embedText('x')).rejects.toBeInstanceOf(AiRequestError);
  });

  it('throws AiNotConfiguredError when the key is missing', async () => {
    fakeEnv.OPENAI_API_KEY = '';
    await expect(embedText('x')).rejects.toBeInstanceOf(AiNotConfiguredError);
  });
});

describe('generateArticle', () => {
  it('parses a TITLE: line into title + body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ content: [{ type: 'text', text: 'TITLE: Best Health Plans\n\nFirst para. Second para.' }] }),
      ),
    );
    await expect(generateArticle({ keywords: ['health', 'insurance'] })).resolves.toEqual({
      title: 'Best Health Plans',
      content: 'First para. Second para.',
    });
  });

  it('falls back to the topic when no TITLE line is present', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ content: [{ type: 'text', text: 'Just a body, no title.' }] })),
    );
    const out = await generateArticle({ keywords: ['medicare'], query: 'medicare 2026' });
    expect(out.title).toBe('medicare 2026');
    expect(out.content).toContain('Just a body');
  });

  it('throws AiNotConfiguredError when the key is missing', async () => {
    fakeEnv.ANTHROPIC_API_KEY = '';
    await expect(generateArticle({ keywords: ['x'] })).rejects.toBeInstanceOf(AiNotConfiguredError);
  });
});

describe('complianceRewrite', () => {
  it('returns the rewritten body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ content: [{ type: 'text', text: 'Rewritten, compliant body.' }] })),
    );
    await expect(
      complianceRewrite({ content: 'Original with claims.', compliancePrompt: 'Remove claims.' }),
    ).resolves.toBe('Rewritten, compliant body.');
  });
});

function chatResponse(content: string, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status });
}

describe('generateArticleOpenAI', () => {
  it('parses the JSON reply into title/teaser/body/terms and requests JSON mode', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      chatResponse(
        JSON.stringify({
          title: 'The Complete Guide to Backyard Apartments: A Smart Investment',
          teaser: 'A backyard apartment, or ADU, adds living space and value...',
          body_markdown: '## Understanding ADUs\n\nAn ADU is a self-contained unit.',
          related_search_terms: ['adu builders near me', 'backyard apartment cost', '  '],
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const out = await generateArticleOpenAI({ keywords: ['backyard apartment', 'ADU'] });
    expect(out.title).toContain('Backyard Apartments');
    expect(out.teaser).toContain('ADU');
    expect(out.content).toContain('## Understanding ADUs');
    // Empty/whitespace terms are dropped.
    expect(out.relatedSearchTerms).toEqual(['adu builders near me', 'backyard apartment cost']);

    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string) as {
      model: string;
      response_format?: { type: string };
    };
    expect(body.model).toBe('gpt-4.1-mini-test');
    expect(body.response_format?.type).toBe('json_object');
  });

  it('throws AiRequestError on non-JSON output', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(chatResponse('not json at all')));
    await expect(generateArticleOpenAI({ keywords: ['x'] })).rejects.toBeInstanceOf(AiRequestError);
  });

  it('throws AiNotConfiguredError when the OpenAI key is missing', async () => {
    fakeEnv.OPENAI_API_KEY = '';
    await expect(generateArticleOpenAI({ keywords: ['x'] })).rejects.toBeInstanceOf(AiNotConfiguredError);
  });
});

describe('complianceRewriteOpenAI', () => {
  it('returns the rewritten markdown body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(chatResponse('## Rewritten\n\nCompliant body.')));
    await expect(
      complianceRewriteOpenAI({ content: '## Original\n\nClaims.', compliancePrompt: 'Remove claims.' }),
    ).resolves.toContain('Compliant body.');
  });
});
