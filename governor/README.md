# Governor Execution & Failover (`packages/model-usage/governor/`)

Orchestrates governed model operations from pre-dispatch budget reservation through physical provider dispatch, failure-aware failover, structured-output validation, and durable attempt reconciliation.

## Key Files & Entrypoints

- `packages/model-usage/governor/governor.ts` — Public facade exporting `executeOperation`, `assessReservation`, `validateSchemaDefinition`, and `assertStrictModeSchemaCompleteness` (re-exported by the package root barrel `packages/model-usage/governor.ts`).
- `packages/model-usage/governor/governor-reservation.ts` — Route candidate resolution, worst-case reservation sizing (`reservationChargeForRoute`), durable replay lookup, and dry-run `assessReservation`.
- `packages/model-usage/governor/governor-attempt.ts` — Physical attempt dispatch (`dispatchAttempt`), linked abort/timeout signals, failure outcome classification (`classifyAttemptOutcome`), and failover deadline budgeting (`reservedFailoverTimeMs`).
- `packages/model-usage/governor/governor-result.ts` — `GovernorResult` assembly and counterfactual Tier-2 cost calculation (`calculateCounterfactualTier2Cost`).
- `packages/model-usage/governor/circuit-breaker.ts` — Cross-process `ProviderCircuitBreaker` (`tools/.model-usage/provider-circuit.json`) enforcing cooldowns and retry schedules after provider failures.
- `packages/model-usage/governor/diagnostics.ts` — Redacted malformed-output diagnostic capture (`tools/.model-usage/diagnostics/<run-id>/`, 32 KiB cap, mode `0600`, 7-day retention).
- `packages/model-usage/governor/structured-output-schema.ts` — Portable JSON Schema validation, strict-mode completeness checks, and structural `enum`/`const` matching.

## Core Invariants

1. **Exclusive Live Adapter Import Boundary:**
   - `packages/model-usage/governor/governor.ts` is the only production module outside `packages/model-usage/adapters/` permitted to import live provider adapters (`anthropic.ts`, `google.ts`, `openai-compatible.ts`, `xai.ts`).
   - Internal `governor-*.ts` modules, `circuit-breaker.ts`, `diagnostics.ts`, and `structured-output-schema.ts` never import `./governor.ts`.

2. **Two-Phase Reservation, Preflight & Idempotent Replay:**
   - Before every physical network attempt, the governor reserves worst-case tokens and cost in the run ledger.
   - `assessReservation` executes identical route selection, reservation sizing, and budget admission checks without calling a provider or persisting a new reservation.
   - Re-invoking `executeOperation` with the same `operationId` and identical normalized input hash returns the persisted `GovernorResult` (`replayed: true`) with zero network I/O; mismatched input throws `ERR_OPERATION_ID_REUSED`.

3. **Failure-Aware Failover & Malformed Structured Output:**
   - Timeouts, HTTP 5xx, quota/429 (including credit-balance 4xx), and malformed structured output prefer a healthy alternate vendor while reserving a bounded share of the operation deadline for remaining failover attempts.
   - When no alternate vendor is available, `implementer` and `repairer` roles permit one bounded same-route retry within a four-attempt operation ceiling and write a secret-redacted excerpt via `diagnostics.ts`.

4. **In-Flight Observability: Circuit State & Redacted Diagnostics (`circuit-breaker.ts`, `diagnostics.ts`):**
   - Active runs expose live `RESERVED` attempt records in `tools/.model-usage/runs/<run-id>.json` (including owner PID and reservation bounds; see [`../ledger/README.md`](../ledger/README.md)), cross-process provider cooldown windows and failure counters in `tools/.model-usage/provider-circuit.json`, and mode-`0600` secret-redacted malformed-output diagnostic excerpts in `tools/.model-usage/diagnostics/<run-id>/`.
