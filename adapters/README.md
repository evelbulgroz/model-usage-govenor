# Model Provider Adapters (`packages/model-usage/adapters/`)

Allowlisted outbound HTTP adapters translating normalized governor requests into provider-specific wire protocols and reconciling provider token, reasoning, and prompt-cache usage.

## Key Files & Entrypoints

- `packages/model-usage/adapters/adapter-contract.ts` — Normalized `ModelAdapter` interface, request/response types, request-ID sanitization (`validateProviderRequestId`), and malformed-output excerpt bounds.
- `packages/model-usage/adapters/google.ts` — Google Gemini API live adapter (`GoogleModelAdapter`).
- `packages/model-usage/adapters/openai-compatible.ts` — OpenAI Chat Completions live adapter (`OpenAICompatibleModelAdapter`).
- `packages/model-usage/adapters/xai.ts` — xAI `/v1/responses` and Chat Completions live adapter (`XaiModelAdapter`).
- `packages/model-usage/adapters/anthropic.ts` — Anthropic Messages API live adapter (`AnthropicModelAdapter`).
- `packages/model-usage/adapters/copilot.ts` — Disabled placeholder (`CopilotModelAdapter`, throws on construction until capability evidence exists).
- `packages/model-usage/adapters/fake.ts` — Deterministic in-memory `FakeModelAdapter` for offline unit and integration tests.

## Core Invariants

1. **Allowlisted Provider Boundary:**
   - `packages/model-usage/adapters` is the sole `allowedAdapterRoots` entry in `.agents/model-usage-policy.json`. Direct provider host URLs and credential environment variables (`OPENAI_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`, `ANTHROPIC_API_KEY`) are forbidden outside this directory.

2. **Provider-Specific Reasoning & Prompt-Cache Accounting:**
   - **Google Gemini (`google.ts`):** Accounts for thinking tokens within completion tokens as `Math.max(totalTokenCount - promptTokenCount, candidatesTokenCount + thoughtsTokenCount)`. Valid `cachedContentTokenCount` within `promptTokenCount` is subtracted afterward and priced at the route's cache-read rate when configured. `thinkingConfig.thinkingLevel` follows declared route `reasoning.effort` (`minimal` on conservative, `low` on quality).
   - **OpenAI (`openai-compatible.ts`):** `gpt-6.1-sol` sends explicit cache breakpoints and `reasoning_effort: 'low'`, pricing `cached_tokens` ($0.10/1M) and `cache_write_tokens` ($2.50/1M) slices inside `prompt_tokens`. `gpt-4o-mini` has no cache rates and bills all prompt tokens at the input rate.
   - **xAI (`xai.ts`):** `grok-4.7` posts to `/v1/responses` with `store: false`, `reasoning.effort: 'low'`, and `prompt_cache_key` set to `operationId`; `output_tokens` already includes reasoning tokens and cached input tokens are priced at the cache-read rate ($0.50/1M). `grok-4.20` uses Chat Completions with `x-grok-conv-id` set to `operationId` ($0.20/1M cache-read rate).
   - **Conservative Fallback:** If any adapter receives missing, negative, or non-integer token metrics, usage reconciles to `undefined` so the ledger retains the full worst-case reservation charge.
