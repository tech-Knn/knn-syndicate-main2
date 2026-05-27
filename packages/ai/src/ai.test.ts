import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock the validated env so we can exercise both configured and not-configured
// paths (the real test env has empty AI keys). The fns read `env.*` at call time.
const { fakeEnv } = vi.hoisted(() => ({
  fakeEnv: {
    OPENAI_API_KEY: 'sk-openai-test',
    OPENAI_EMBEDDING_MODEL: 'text-embedding-3-small',
    ANTHROPIC_API_KEY: 'sk-ant-test',
    ANTHROPIC_MODEL: 'claude-test',
  },
}));
vi.mock('@knn/config', () => ({ env: fakeEnv }));

const { embedText } = await import('./embeddings.js');
const { generateArticle, complianceRewrite } = await import('./anthropic.js');
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
