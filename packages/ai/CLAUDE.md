# @knn/ai — OpenAI (articles + compliance + embeddings) and Claude clients

Pure library for the AI calls behind the article engine (Phase 5 + the OpenAI rework). No DB, no
HTTP server — callers (the API article service) own persistence + the reuse logic.

## Invariants / footguns

- **fetch, not the vendor SDKs** (same call as `@knn/fb`): keeps deps light and every call trivially
  mockable via `vi.stubGlobal('fetch', …)`. Don't add `@anthropic-ai/sdk` / `openai`.
- **Keys are optional** (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` in `@knn/config`). When unset, the
  calls throw `AiNotConfiguredError` so callers can degrade (skip reuse / queue for later) — they do
  **not** crash the app. Live generation needs the keys wired (an external dependency, like FB connect).
- **Embeddings are 1536-dim** (`text-embedding-3-small`, `EMBEDDING_DIMENSIONS`); `embedText` validates
  the length. The vector is for pgvector cosine reuse — the DB column is `vector(1536)`.
- **Articles use OpenAI now (the default).** `generateArticleOpenAI` returns
  `{title, teaser, content, relatedSearchTerms}` — JSON-mode (`response_format: json_object`) so the
  reply is structured: a markdown body (## sections + lists, the reverse-engineered competitor
  skeleton) **plus** `related_search_terms` (the high-CPC AFS `terms` — where the RPM lives).
  `complianceRewriteOpenAI` returns the rewritten markdown body. The API service stores raw + compliant
  (audit) and the terms, serves the compliant one, and **skips the rewrite when no `compliance_prompt`
  is set** (saves a call). The Claude variants (`generateArticle`/`complianceRewrite`) remain available
  but are no longer the default (overrides D16's "articles via Claude").
- **Embeddings stay OpenAI 1536-dim** (`text-embedding-3-small`, `EMBEDDING_DIMENSIONS`); `embedText`
  validates the length. The vector is for pgvector cosine reuse — the DB column is `vector(1536)`.
- Models come from env (`OPENAI_ARTICLE_MODEL` default `gpt-4.1-mini` ≈ ⅓¢/article, `OPENAI_EMBEDDING_MODEL`,
  `ANTHROPIC_MODEL`) — don't hardcode.

## Tests

`vitest` with `vi.mock('@knn/config')` (so we can flip keys on/off via a hoisted fake env) +
`vi.stubGlobal('fetch', …)`. Cover: request shaping, response parsing, error on non-OK, embedding
length validation, and the not-configured guard. No network.
