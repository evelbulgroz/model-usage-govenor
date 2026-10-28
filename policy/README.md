# Policy, Request Contracts & Error Taxonomy (`packages/model-usage/policy/`)

Loads and validates the committed repository model policy (`.agents/model-usage-policy.json`), enforces lower-only local overrides, normalizes and hashes operation requests, and defines the typed `ModelUsageError` taxonomy.

## Key Files & Entrypoints

- `packages/model-usage/policy/policy.ts` — Public facade exporting `loadPolicy`, `resolvePolicy`, `validatePolicy`, `BUILTIN_SAFETY`, `DEFAULT_LOCAL_POLICY_PATH`, and request validation/hashing helpers.
- `packages/model-usage/policy/policy-validation.ts` — Committed policy schema validation and `BUILTIN_SAFETY` absolute upper bounds.
- `packages/model-usage/policy/policy-local-merge.ts` — Lower-only local policy merge (`resolvePolicy`), rejecting any ceiling escalation or route re-enablement with `ERR_LIMIT_ESCALATION_FORBIDDEN`.
- `packages/model-usage/policy/policy-route-catalog.ts` — Route definition, capability, pricing, and reasoning configuration validators.
- `packages/model-usage/policy/policy-field-validators.ts` — Closed-object, repository-relative path, and scalar validators.
- `packages/model-usage/policy/operation-request.ts` — `validateOperationRequest`, `normalizePrompt`, `canonicalJson`, `operationInputHash`, and `effectiveProfile`.
- `packages/model-usage/policy/errors.ts` — `ModelUsageError`, `MODEL_USAGE_ERROR_CODES`, and `asModelUsageError`.

## Core Invariants

1. **3-Tier Committed Ceiling & Lower-Only Override Rule (`committed -> machine-local -> repo-local`):**
   - **Tier 1 (Committed Engine Ceiling):** `.agents/model-usage-policy.json` is the committed repository ceiling, bounded above by `BUILTIN_SAFETY`.
   - **Tier 2 (Machine-Local Override):** By default, `loadPolicy()` checks `${XDG_CONFIG_HOME:-~/.config}/model-usage/local-policy.json` (or `MODEL_USAGE_MACHINE_LOCAL_POLICY_PATH` / `machineLocalPolicyPath`).
   - **Tier 3 (Repo-Local Override):** Next, `loadPolicy()` checks `<cwd>/tools/.model-usage/local-policy.json`, `<cwd>/.agent-sdlc/local-policy.json`, or `DEFAULT_LOCAL_POLICY_PATH` (`<engine-repo>/tools/.model-usage/local-policy.json`), overridable via `MODEL_USAGE_DEFAULT_LOCAL_POLICY_PATH`, `defaultLocalPolicyPath`, or `localPolicyPath` (forwarded automatically for `--root <dir>` by `RepositoryModelGovernor` in `packages/agent-sdlc/adapters/model-governor.ts`).
   - Passing `localPolicyPath: null` bypasses both Tier 2 and Tier 3 discovery for hermetic tests. Every tier and per-request `requestedLimits` merges through `resolvePolicy()`: overrides may only lower numerical limits, shorten timeouts, disable routes, or remove capabilities; any attempt to raise a parent tier's ceiling or re-enable a disabled route throws `ERR_LIMIT_ESCALATION_FORBIDDEN`.

2. **Deterministic Request Hashing:**
   - `operationInputHash` hashes canonicalized prompt text, structured-output schema, routing constraints, and profile parameters so `governor/` and `ledger/` can detect idempotent replays vs illegal `operationId` reuse (`ERR_OPERATION_ID_REUSED`).

## Error Taxonomy (`ModelUsageError`)

| Error Code | Trigger |
|---|---|
| `ERR_BUDGET_RESERVATION_DENIED` | Pre-dispatch reservation denied across attempt, operation, run, or instance dimensions |
| `ERR_TOKEN_BUDGET_EXCEEDED` | Estimated prompt tokens or requested completion tokens exceed route or profile ceiling |
| `ERR_CALL_BUDGET_EXCEEDED` | Physical attempt limit exceeded for the operation, run, or instance |
| `ERR_COST_BUDGET_EXCEEDED` | Estimated or reconciled cost exceeds monetary ceiling |
| `ERR_CONCURRENCY_LIMIT` | Concurrent reservation limit exceeded for the profile, run, or instance |
| `ERR_OPERATION_TIMEOUT` | Operation deadline elapsed before completion |
| `ERR_RUN_DEADLINE_EXPIRED` | Shared run clock is past `runDeadlineAt` (distinct from route exhaustion) |
| `ERR_ALL_ALLOWED_ROUTES_EXHAUSTED` | No eligible enabled route matches constraints or all candidate routes failed |
| `ERR_LIMIT_ESCALATION_FORBIDDEN` | Local policy or `requestedLimits` attempted to raise ceilings or re-enable routes |
| `ERR_OPERATION_IN_PROGRESS` | Concurrent attempt with the same `operationId` is currently active |
| `ERR_OPERATION_ID_REUSED` | Reused `operationId` with a different normalized input hash |
| `ERR_USAGE_RECONCILIATION_FAILED` | Reconciled usage exceeded durable reservation without non-execution proof |
