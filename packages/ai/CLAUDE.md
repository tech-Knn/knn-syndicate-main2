# @knn/ai — Claude (articles + compliance) and OpenAI (embeddings) clients

Pure library for the AI calls behind the Phase 5 article engine (D16). No DB, no HTTP server —
callers (the API article service) own persistence + the reuse logic.

## Invariants / footguns

- **fetch, not the vendor SDKs** (same call as `@knn/fb`): keeps deps light and every call trivially
  mockable via `vi.stubGlobal('fetch', …)`. Don't add `@anthropic-ai/sdk` / `openai`.
- **Keys are optional** (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` in `@knn/config`). When unset, the
  calls throw `AiNotConfiguredError` so callers can degrade (skip reuse / queue for later) — they do
  **not** crash the app. Live generation needs the keys wired (an external dependency, like FB connect).
- **Embeddings are 1536-dim** (`text-embedding-3-small`, `EMBEDDING_DIMENSIONS`); `embedText` validates
  the length. The vector is for pgvector cosine reuse — the DB column is `vector(1536)`.
- **`generateArticle` returns `{title, content}`** by parsing a leading `TITLE:` line (falls back to the
  topic). **`complianceRewrite`** returns only the rewritten body. The API service stores BOTH the raw
  and the compliant text (audit, D16) and serves the compliant one.
- Models come from env (`ANTHROPIC_MODEL`, `OPENAI_EMBEDDING_MODEL`) — don't hardcode.

## Tests

`vitest` with `vi.mock('@knn/config')` (so we can flip keys on/off via a hoisted fake env) +
`vi.stubGlobal('fetch', …)`. Cover: request shaping, response parsing, error on non-OK, embedding
length validation, and the not-configured guard. No network.
