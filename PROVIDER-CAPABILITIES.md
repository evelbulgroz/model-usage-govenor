# Model Usage Provider Capability Reference

This reference records the evidence boundary for routes declared in
`packages/model-usage/policy/default-policy.json` (and optional host
`.agents/model-usage-policy.json`). A route is not production-enabled merely
because an adapter exists. Enabling it requires reviewed policy, current
pricing, and an opt-in credential-safe smoke operation.

## Route classifications

| Route | Classification | Enabled | Evidence and disposition |
|---|---|---:|---|
| `fake-governed` | `test-only` | No | Deterministic injected transport proves success, all normalized failures, usage-present and usage-absent accounting, abort handling, retry, and failover without network access. |
| `openai-compatible-conservative` | `governed-conservative` | Yes | Native chat-completions adapter pins `gpt-4o-mini` at `https://api.openai.com/v1`, strict JSON Schema `response_format`, `max_completion_tokens`, abort signal, `x-request-id`, and documented usage fields. Pricing is the OpenAI standard rate as of 2026-09-11 ($0.15 / $0.60 per 1M). |
| `openai-compatible-quality` | `governed` | Yes | The same chat-completions adapter pins `gpt-6.1-sol` with `reasoning_effort=low`, strict JSON Schema, and explicit prompt-cache breakpoints on stable blocks. The route allows 922,000 prompt tokens and 16,000 completion tokens. Standard pricing as of 2026-10-16 is $2.00 / $10.00 per 1M, with cache reads at $0.10 and cache writes at $2.50. |
| `google-gemini-conservative` | `governed-conservative` | Yes | Native `generateContent` adapter pins `gemini-3.6-flash`, JSON Schema response mode, `thinkingConfig.thinkingLevel=minimal`, output-token ceiling, abort signal, request ID, quota/HTTP classes, and documented usage fields. Usage omissions retain the full reservation. Pricing is the Gemini Developer API paid standard intro rate as of 2026-10-16 ($0.75 / $3.75 per 1M input / output, thinking included in output). Implicit cache reads are $0.075 per 1M. There is no cache-write premium. |
| `xai-grok-conservative` | `governed-conservative` | Yes | Dedicated xAI adapter uses Chat Completions at `https://api.x.ai/v1` with `grok-4.20-0309-non-reasoning` (no reasoning tokens), strict JSON Schema `response_format`, `max_completion_tokens`, `x-grok-conv-id` from the operation id, and `XAI_API_KEY`. Short-context pricing as of 2026-10-16 is $1.25 / $2.50 per 1M, with cache reads at $0.20. |
| `xai-grok-quality` | `governed` | Yes | The same adapter uses Responses at `https://api.x.ai/v1/responses` with pinned `grok-4.7`, `reasoning.effort` low, `store` false, strict `text.format` JSON Schema, and `prompt_cache_key` from the operation id. Ceilings are 484,000 prompt tokens, 16,000 completion tokens, and 500,000 tokens per attempt. `max_output_tokens` bounds visible output. Short-context pricing as of 2026-10-16 is $2.00 / $6.00 per 1M, with cache reads at $0.50. |
| `anthropic-claude-quality` | `governed` | Yes | Native Messages adapter pins `claude-sonnet-5-5` at `https://api.anthropic.com/v1`, GA JSON Schema `output_config.format`, `max_tokens`, abort signal, `request-id`, and documented usage fields. Pricing is the Anthropic standard rate as of 2026-10-16 ($2.00 / $10.00 per 1M). Prompt-cache reads are $0.10 per 1M and 5-minute cache writes are $2.50 per 1M. |
| `copilot-external` | `external-best-effort` | No | No supported non-interactive repository interface currently provides the request controls and trustworthy physical-attempt usage required by the governor. Copilot CLI and hosted-agent usage remain external telemetry. |

## Metered route rate card and pricing evidence

| Route | Input (µUSD/1M) | Output (µUSD/1M) | Effective date | Citation |
|---|---:|---:|---|---|
| `openai-compatible-conservative` | 150000 | 600000 | 2026-09-11 | https://platform.openai.com/docs/pricing |
| `xai-grok-conservative` | 1250000 | 2500000 | 2026-10-16 | https://docs.x.ai/developers/pricing |
| `google-gemini-conservative` | 750000 | 3750000 | 2026-10-16 | https://ai.google.dev/gemini-api/docs/pricing |
| `openai-compatible-quality` | 2000000 | 10000000 | 2026-10-16 | https://developers.openai.com/api/docs/pricing |
| `xai-grok-quality` | 2000000 | 6000000 | 2026-10-16 | https://docs.x.ai/developers/pricing |
| `anthropic-claude-quality` | 2000000 | 10000000 | 2026-10-16 | https://platform.claude.com/docs/en/models/sonnet-5-5/overview |
| `google-gemini-quality` | 2000000 | 12000000 | 2026-10-16 | https://ai.google.dev/gemini-api/docs/pricing |

`openai-compatible-quality` pins `gpt-6.1-sol` with `reasoning_effort` low. Its ceilings are 922,000 prompt tokens, 16,000 completion tokens, and 938,000 tokens per attempt, which stays inside the model's 922,000 input-token maximum. Standard rates as of 2026-10-16 are $2.00 input, $0.10 cached input, $2.50 cache writes, and $10.00 output per 1M for prompts up to 272,000 tokens. Prompts above 272,000 tokens are $4.00 input, $0.20 cached input, $5.00 cache writes, and $15.00 output for the whole request. This card stores the up-to-272,000-token rates only. The 30-minute cache TTL is the only retention value. The adapter sends `prompt_cache_options.mode=explicit` when the prompt has blocks, marks every block through the caller's breakpoint, and leaves a trailing block unmarked. `prompt_tokens` includes cached and written tokens, and the adapter subtracts both before pricing the uncached tail. `gpt-4o-mini` does not send these cache fields.

`google-gemini-quality` pins `gemini-3.1-pro-preview` and uses the implementer ceilings: 968,000 prompt tokens, 16,000 completion tokens, and 984,000 tokens per attempt. Standard paid rates as of 2026-10-16 are $2.00 / $12.00 per 1M for prompts up to 200,000 tokens, with an implicit cache read of $0.20 per 1M. Prompts above 200,000 tokens are $4.00 / $18.00 with a $0.40 cache read. This card stores the up-to-200,000-token rates only. There is no cache-write premium and no storage rate. `gemini-3.6-flash` prices a reported `cachedContentTokenCount` at $0.075 per 1M. The adapter subtracts that count from `promptTokenCount` after completion accounting, because the prompt count already includes cached tokens. The response `modelVersion` is stored on the ledger attempt. As of 2026-10-29, default route order for the `agent-sdlc-default` and `trace-attribution` profiles is OpenAI, Anthropic, Gemini, then xAI, with xAI held in reserve. The `critic-review` profile leads with xAI so the critic differs in vendor from an OpenAI author, followed by OpenAI, Anthropic, and Gemini.

`xai-grok-quality` pins `grok-4.7` with `reasoning.effort` low. Ceilings are 484,000 prompt tokens, 16,000 completion tokens, and 500,000 tokens per attempt, inside the model's 500,000-token context. `max_output_tokens` bounds visible output. Reported `output_tokens` already includes reasoning tokens and is the completion charge. Standard rates as of 2026-10-16 are $2.00 input, $0.50 cached input, and $6.00 output per 1M below 200,000 tokens. Prompts of ≥ 200,000 tokens are $4.00 input, $1.00 cached input, and $12.00 output for the whole request. This card stores the below-200,000-token rates only. The route has no cache-write rate. The adapter posts to `/v1/responses` with `store` false, `prompt_cache_key` set to the operation id, and strict `text.format` JSON Schema. `input_tokens` includes cached tokens. The adapter subtracts that count and prices it at the cache-read rate. `xai-grok-conservative` stays on Chat Completions with `grok-4.20-0309-non-reasoning`. Its short-context rates are $1.25 input, $0.20 cached input, and $2.50 output. Prompts of ≥ 200,000 tokens are $2.50 input, $0.40 cached input, and $5.00 output for the whole request. The conservative card stores the below-200,000-token rates only. Stickiness on that chat route is the `x-grok-conv-id` header. The `critic-review` profile allows 16,000 completion tokens. A plan review on this route billed 6,678 completion tokens, reasoning included, against a 6,000-token reservation. The `agent-sdlc-default` profile and this route allow $50 per run. The instance and that profile allow 80,000,000 tokens per run. The generation reviewer reserves 16,000 completion tokens.

## Capability evidence required before enablement

The adapter contract tests under `packages/model-usage/adapters/live-adapters-google.spec.mjs`,
`live-adapters-openai-xai.spec.mjs`, `live-adapters-anthropic.spec.mjs`, and
`live-adapters-classification.spec.mjs`
verify translation without credentials or billable requests. Before changing
`enabled` to `true`, human review must additionally confirm against the
provider's current official API reference:

1. JSON Schema structured-output semantics for the exact endpoint and model.
2. Request cancellation through `AbortSignal` and the provider's timeout
   behavior.
3. Success and failure response usage fields, including when usage may be
   omitted.
4. Request-ID headers and quota/rate-limit status codes.
5. Prompt and completion token-limit semantics.
6. Current input, output, fixed-request, and premium-unit pricing.

The Google adapter targets the official Gemini API `generateContent` endpoint:
<https://ai.google.dev/api/generate-content>. The OpenAI-compatible adapter
requires the OpenAI structured-output and usage contract:
<https://platform.openai.com/docs/guides/structured-outputs> and
<https://platform.openai.com/docs/api-reference/chat>. The xAI adapter targets
Responses for `grok-4.5`, `grok-4.6`, and `grok-4.7`, and Chat Completions for
other xAI models, at `https://api.x.ai/v1`. Pricing evidence is
<https://docs.x.ai/developers/pricing>. The Anthropic adapter targets the Messages API and GA
structured outputs documented at
<https://platform.claude.com/docs/en/build-with-claude/structured-outputs>.

## Operational status

Phases 0–9 of the governor implementation are complete and enforcement-ready.
The initial production consumer `packages/agent-sdlc` is registered in
`providerBoundary.registeredConsumerRoots`.
The Google, OpenAI, xAI, and Anthropic routes are production-enabled. External interactive
tools must not be described as governed.
