# Synchronous Budget Ledger (`packages/model-usage/ledger/`)

Manages per-run atomic JSON ledger envelopes (`tools/.model-usage/runs/<run-id>.json`), hierarchical budget admission, attempt reconciliation, and stale-process reservation recovery.

## Key Files & Entrypoints

- `packages/model-usage/ledger/ledger.ts` — Public facade exporting `ModelUsageLedger` and `loadRunLedger`; sole owner of `withLockSync` and `durableReplaceSync` lock critical sections.
- `packages/model-usage/ledger/ledger-budget.ts` — Pure budget aggregation, hierarchical ceiling admission (attempt, operation, run, instance), and charge reconciliation.
- `packages/model-usage/ledger/ledger-envelope-validation.ts` — Envelope schema validation and transparent migration across schema versions `1.0.0`, `1.1.0`, and `1.2.0`.
- `packages/model-usage/ledger/ledger-attempt-validation.ts` — Physical attempt record, charge, route reference, and `tokenDetails` validation.
- `packages/model-usage/ledger/ledger-recovery.ts` — Pure synchronous recovery of reservations abandoned by dead owner PIDs (`recoverEnvelope`).
- `packages/model-usage/ledger/ledger-summary.ts` — Operation and run budget summaries (`getRunBudgetSummary`, `getExhaustedRouteIds`).
- `packages/model-usage/ledger/ledger-child.mjs` & `ledger-success-child.mjs` — Subprocess fixtures used by cross-process lock and recovery specs.

## Core Invariants

1. **Strictly Synchronous Lock Critical Sections (`zero await`):**
   - Cross-run coordination uses `tools/.model-usage/.instance.lock` via `packages/model-usage/atomic-file-state.ts`.
   - Every production file in `ledger/` (`ledger*.ts`) contains zero `async`, `await`, or `.then(`, verified mechanically by `packages/model-usage/ledger/ledger-lock-invariant.spec.mjs`.
   - Network I/O is never performed while holding a ledger lock, and envelope writes use `durableReplaceSync` (fsyncing temporary files and parent directories).

2. **Envelope Schema `1.2.0` & Observational `tokenDetails`:**
   - Durable state lives exclusively in per-run JSON envelopes under `tools/.model-usage/runs/<run-id>.json` (never in a SQLite database).
   - New envelopes write schema `1.2.0`; envelopes at `1.0.0` and `1.1.0` validate cleanly and upgrade to `1.2.0` on next write while preserving historical attempts.
   - Provider attempts on `1.2.0` record observational `tokenDetails`: `cacheReadTokens`, `cacheWriteTokens`, and `reasoningTokens` (`null` when unreported by the provider; `0` when reported as zero). Pricing, `charge`, reservations, and budgets do not read `tokenDetails`.

3. **Hierarchical Ceilings & Shared Run Clock:**
   - `runMaxTotalTokens`, `runMaxPhysicalCalls`, `runMaxCostMicrousd`, and `runMaxPremiumRequestUnits` apply per profile on a `runId`, while instance ceilings cap aggregate usage across all envelopes on disk.
   - `runDeadlineAt` is anchored to `createdAt` plus the longest `runTimeoutMs` of any profile that has reserved on that run; a subsequent shorter profile never moves the deadline earlier.

4. **Attempt Attribution & Run Budget Analytics (`ledger-summary.ts`):**
   - Each attempt records reconciled `inputTokens`, `outputTokens`, `totalTokens`, `costMicrousd`, `premiumRequestUnits`, `latencyMs`, `routeId`/`vendor`/`modelId`, `executionProvenFalse` reconciliation, and caller `attribution` (`taskId`, `nodeId`, `roleId`, `generation`, `nodeAttempt`, `phase`, `scope`).
   - `packages/model-usage/ledger/ledger-summary.ts` exposes `getRunBudgetSummary` (per-profile token, call, cost, and premium-request rollups across a run) and `getExhaustedRouteIds` (routes that have reached their per-run ceilings).

## Operational Troubleshooting

- **Stale instance lock (`tools/.model-usage/.instance.lock`):** Foreign locks are never deleted automatically. Inspect `cat tools/.model-usage/.instance.lock` and remove the lock file manually only after confirming the recorded owner PID is no longer running.
- **Corrupt run envelope (`tools/.model-usage/runs/<run-id>.json`):** Invalid JSON or schema errors fail closed and preserve the file for forensics. Move or delete the corrupted file while no governor process is active.
