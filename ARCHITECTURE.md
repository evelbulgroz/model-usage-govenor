# Architecture & Core Guarantees (`packages/model-usage/`)

Conceptual architecture, rationale, core budget/concurrency guarantees, and two-phase execution lifecycle for the Model Usage Governor (`@evelbulgroz/model-usage-govenor`, consumed by host applications and agent harnesses).

For installation, credential and local-policy setup, subpath exports, `executeOperation` usage, and development/testing commands, see [`README.md`](./README.md) and [`AGENTS.md`](./AGENTS.md).

---

## 1. Architectural Intent, Rationale & Core Guarantees

The Model Usage Governor is the **exclusive gateway** through which all repository-owned model calls must execute. No script, agent harness, evaluator, generator, or reviewer may make direct unmetered network calls to model providers.

### Why a Repository-Owned Governor?
Autonomous agent loops and multi-phase critic workflows can rapidly compound token spend, retry storms, and silent vendor drift if individual callers manage their own SDK transports or retry loops. Centralizing model execution behind a synchronous, file-locked two-phase reservation ledger ensures deterministic budget enforcement before a single packet leaves the machine, while providing both **in-flight observability** (live reservation envelopes, provider cooldown circuit state, and redacted malformed-output diagnostics) and **retrospective analytics** (reconciled per-attempt token, cost, latency, route/failover, and attribution telemetry plus offline pricing parity audits; see [`governor/README.md`](./governor/README.md), [`ledger/README.md`](./ledger/README.md), and [`scripts/README.md`](./scripts/README.md)).

### Core Guarantees
1. **Atomic two-phase budget reservation:** Worst-case prompt, schema, framing, and completion tokens and micro-USD cost are reserved against durable ceilings in `tools/.model-usage/runs/<run-id>.json` before physical network dispatch ([`governor/README.md`](./governor/README.md), [`ledger/README.md`](./ledger/README.md)).
2. **Synchronous lock critical sections:** Cross-run coordination uses `tools/.model-usage/.instance.lock` via `packages/model-usage/atomic-file-state.ts`; `ledger*.ts` contains zero `await`, and network I/O never executes while holding a ledger lock ([`ledger/README.md`](./ledger/README.md)).
3. **Hierarchical ceilings:** Bounds are enforced across physical attempt, logical operation, run ID, instance lifetime, route, and profile dimensions ([`ledger/README.md`](./ledger/README.md)).
4. **Bounded retries, failover & circuit breaking:** Controlled failover depth with fresh reservations per physical attempt, per-attempt deadline shares, and provider cooldown circuit breaking ([`governor/README.md`](./governor/README.md)).
5. **Conservative fallback charging:** When a provider omits trustworthy integer token usage, the full worst-case reservation remains charged ([`ledger/README.md`](./ledger/README.md), [`adapters/README.md`](./adapters/README.md)).
6. **Committed ceiling / lower-only policy:** `.agents/model-usage-policy.json` is the committed repository ceiling; local overrides (`tools/.model-usage/local-policy.json`) and per-request limits may only tighten bounds, never escalate ([`policy/README.md`](./policy/README.md)).
7. **Direct-call prevention:** `providerBoundary` in `policy/default-policy.json` (and optional host `.agents/model-usage-policy.json`) declares `registeredConsumerRoots`, `allowedAdapterRoots`, and `allowedSetupFiles` so host boundary scanners can block direct provider SDK imports, API host literals, credential reads, and consumer-owned retry loops outside allowlisted adapters.
8. **In-flight observability, attribution-tagged telemetry & offline pricing audits:** Active runs expose live `RESERVED` envelopes (`tools/.model-usage/runs/<run-id>.json`), cross-process provider cooldown state (`provider-circuit.json`), and redacted malformed-output diagnostics (`diagnostics/<run-id>/`), while completed attempts record reconciled token/cost charges, observational `tokenDetails` (`cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens`), route/failover provenance, caller `attribution` (`taskId`, `nodeId`, `roleId`, `generation`, `phase`, `scope`), run/route budget summaries ([`governor/README.md`](./governor/README.md), [`ledger/README.md`](./ledger/README.md)), and offline pricing parity audits ([`scripts/README.md`](./scripts/README.md)).

### Non-Goals & Exclusions
- Runtime domain behavior inside host application bounded contexts is not governed by this package.
- Interactive coding tools (GitHub Copilot CLI, Claude Code, hosted web UIs, interactive CLI sessions) that do not expose deterministic request controls and physical token evidence are classified as external best-effort telemetry, not governed execution.
- Provider-side billing caps and organization quotas remain the final account-level backstop.

---

## 2. Two-Phase Execution & Subsystem Boundaries

```text
  Caller (executeOperation / assessReservation)
         │
         ▼
  1. Policy & Request Normalization (policy/)
     • Merge committed .agents/model-usage-policy.json with lower-only local-policy.json
     • Validate OperationRequest, structuredOutputSchema, and compute operationInputHash
         │
         ▼
  2. Deterministic 4-Step Route Selection (routing/)
     • Filter enabled routes by profile, requiredCapabilities, excludedVendors, minQualityTier
     • Order candidates by strategy ('min-cost' | 'balanced' | 'quality-first') and runway pressure
         │
         ▼
  3. Phase 1 — Synchronous Lock & Worst-Case Reservation (ledger/ — zero await)
     • Acquire tools/.model-usage/.instance.lock synchronously
     • Recover stale dead-PID RESERVED attempts; verifyattempt/op/run/instance ceilings
     • Persist RESERVED attempt in tools/.model-usage/runs/<run-id>.json & release lock
         │
         ▼
  4. Lock-Free Provider Dispatch & Schema Validation (governor/ + adapters/)
     • Invoke allowlisted provider adapter (google, openai-compatible, xai, anthropic, fake)
     • Validate structured JSON output; on retryable failure, record cooldown & try next route
         │
         ▼
  5. Phase 2 — Synchronous Reconciliation (ledger/ — zero await)
     • Re-acquire .instance.lock synchronously
     • Reconcile actual integer token/cache/reasoning usage (or retain worst-case reservation)
```

### Encapsulation Invariants
- `governor-*.ts` and `ledger-*.ts` are internal parts of the governor that only `governor.ts` and `ledger.ts` import. Retry, failover, and accounting stay in the governor. `ledger-envelope-validation.ts` may import `ledger-attempt-validation.ts`.
- Production code outside `packages/model-usage/` imports only the subpath exports declared in [`packages/model-usage/package.json`](./package.json).
