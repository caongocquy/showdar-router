# Showdar Router Embeddings Tests

Unit tests for the `/v1/embeddings` endpoint implementation.

## Setup

Install test dependencies from the `tests/` directory:

```bash
cd tests/ && npm install
```

## Running Tests

From the `tests/` directory:

```bash
npm test
```

Or run vitest directly with npx:

```bash
npx vitest run --reporter=verbose --config ./vitest.config.js
```

## Runner and optional-dependency policy

- **Vitest** owns `tests/**/*.test.{js,mjs}`. Root `npm test` runs Vitest, then
  `npm run test:node`.
- **Node's test runner** owns `tests/**/*.node-test.mjs`. These files use
  `node:test` and are excluded from Vitest so they are not collected twice.
- **Optional cloud tree:** `unit/embeddings.cloud.test.js` is skipped when
  `cloud/src/handlers/embeddings.js` is absent. `cloud/` is an optional
  deployment artifact, not required for the router release.
- **Benchmark-only dependency:** `unit/db-benchmark.test.js` is skipped when
  `lowdb` is not installed. Production persistence uses SQLite.
- **Live upstream checks:** `unit/mimo-free.live.test.js` is skipped unless
  `SHOWDAR_ROUTER_LIVE_MIMO=1` is set. Deterministic offline coverage stays in
  `unit/mimo-free.test.js`.

## Test Files

| File | What it tests |
|------|--------------|
| `unit/embeddingsCore.test.js` | `open-sse/handlers/embeddingsCore.js` — core logic: body builder, URL router, headers, handler flow |
| `unit/embeddings.cloud.test.js` | `cloud/src/handlers/embeddings.js` — cloud worker handler: auth, validation, rate limits, CORS |

## Coverage Summary (59 tests)

### `embeddingsCore.test.js` (36 tests)
- `buildEmbeddingsBody`: single string, array, encoding_format, default float
- `buildEmbeddingsUrl`: openai, openrouter, openai-compatible-*, unsupported providers
- `buildEmbeddingsHeaders`: per-provider header sets, fallback to accessToken
- `handleEmbeddingsCore` input validation: missing, wrong type, null, empty
- `handleEmbeddingsCore` success: response format, CORS, Content-Type, callbacks
- `handleEmbeddingsCore` errors: 400/429/500, network error, invalid JSON
- `handleEmbeddingsCore` token refresh: 401 retry, graceful fallback

### `embeddings.cloud.test.js` (23 tests)
- CORS OPTIONS: 200 response, empty body, correct headers
- Authentication: missing key, bad format, old-format key, wrong key value, valid key
- Body validation: invalid JSON, missing model, missing input, bad model
- Happy path: single string, array, correct delegation, CORS header, machineId override
- Rate limiting: all accounts rate-limited → 503 + Retry-After, no credentials → 400
- Error propagation: non-fallback errors passed through, 429 exhausts accounts
- machineId override: validates key, rejects wrong key
