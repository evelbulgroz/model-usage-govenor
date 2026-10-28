# Model Usage Governor (`packages/model-usage/`)

**Living home** for the Model Usage Governor (`@evelbulgroz/model-usage-govenor`), a standalone library consumed by host applications, agent frameworks, and review CLIs (where host identity is bound via `repositoryId` in `.agents/sdlc-host.json` and live state defaults to `tools/.model-usage` or `MODEL_USAGE_STATE_DIR`).

The governor is the exclusive gateway for all repository-owned LLM calls—enforcing lower-only policy ceilings (`.agents/model-usage-policy.json` + optional `tools/.model-usage/local-policy.json`), deterministic 4-step route selection, synchronous two-phase budget reservations (`tools/.model-usage/runs/<run-id>.json`), bounded multi-vendor failover, and attribution-tagged token/cost telemetry.

**Canonical references:**
- **Architecture, rationale & core guarantees:** [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- **Governance philosophy & principles:** [`docs/handbook/governance-philosophy.md`](./docs/handbook/governance-philosophy.md)
- **Development & testing guidelines:** [`docs/handbook/development-guide.md`](./docs/handbook/development-guide.md)
- **Package agent operating contract:** [`AGENTS.md`](./AGENTS.md)
- **Provider route capabilities & pricing evidence:** [`PROVIDER-CAPABILITIES.md`](./PROVIDER-CAPABILITIES.md)
- **Bundled default policy:** [`policy/default-policy.json`](./policy/default-policy.json)

---

## 1. Package Layout & Module Documentation

Detailed subsystem documentation and invariants live in co-located module READMEs:

| Module | Responsibility | Documentation |
|---|---|---|
| `governor/` | Execution orchestration (`executeOperation`, `assessReservation`), attempt dispatch, failover classification, provider circuit breaker, malformed-output diagnostics, and portable JSON Schema validation | [`governor/README.md`](./governor/README.md) |
| `ledger/` | Atomic two-phase budget reservation, synchronous lock critical sections (`ledger*.ts` contains zero `await`), envelope schema (`1.0.0`–`1.2.0`), hierarchical budget admission, and stale-PID recovery | [`ledger/README.md`](./ledger/README.md) |
| `policy/` | Committed policy validation, `BUILTIN_SAFETY` ceiling, lower-only local policy merge, route catalog rules, request normalization/hashing, and `ModelUsageError` taxonomy | [`policy/README.md`](./policy/README.md) |
| `routing/` | Deterministic 4-step route selection (`selectRoutes`), quality tiers, runway-pressure cost ordering, counterfactual Tier-2 pricing, and conservative prompt token estimation | [`routing/README.md`](./routing/README.md) |
| `adapters/` | Normalized `ModelAdapter` contract, live provider adapters (`google.ts`, `openai-compatible.ts`, `xai.ts`, `anthropic.ts`, `copilot.ts`), `FakeModelAdapter`, and reasoning/cache accounting | [`adapters/README.md`](./adapters/README.md) |
| `scripts/` | Offline pricing parity audit (`--check`) and atomic policy/handbook price bump CLI (`--bump`) | [`scripts/README.md`](./scripts/README.md) |
| `testing/` | Shared test fixtures (`*-test-support.mjs`) and package layout, navigability, and living-documentation gates | [`testing/README.md`](./testing/README.md) |

```text
packages/model-usage/
├── governor.ts                   # Root package entrypoint barrel re-exporting governor/governor.ts
├── atomic-file-state.ts          # Shared withLockSync and durableReplaceSync primitives
├── sanitize-failure-text.ts      # Shared failure-text sanitization and snippet extraction
├── governor/                     # Governor facade, reservation, attempt dispatch, circuit breaker, schema
│   └── governor.ts
├── ledger/                       # Synchronous JSON envelope ledger, budget admission, and PID recovery
│   └── ledger.ts
├── policy/                       # Policy schema, lower-only local merge, request hashing, and errors
│   └── policy.ts
├── routing/                      # 4-step capability/cost/runway routing, pricing, and prompt tokenizer
│   └── routing.ts
├── adapters/                     # Live provider adapters, FakeModelAdapter, and adapter contract specs
│   └── adapter-contract.ts
├── scripts/                      # Offline pricing parity audit and atomic bump CLI
│   └── audit-pricing.ts
├── testing/                      # Shared test fixtures and package layout/navigability/doc gates
│   └── navigability.spec.mjs
├── AGENTS.md
├── ARCHITECTURE.md
└── README.md
```

`governor-*.ts` and `ledger-*.ts` are internal parts of the governor that only `governor.ts` and `ledger.ts` import. Retry, failover, and accounting stay in the governor. `ledger-envelope-validation.ts` may import `ledger-attempt-validation.ts`. Production code outside this package imports only the subpath exports declared in `packages/model-usage/package.json`.

**State & Policy Files:**
- `.agents/model-usage-policy.json` — Committed maximum engine policy and route catalog (bounded above by `BUILTIN_SAFETY`).
- `${XDG_CONFIG_HOME:-~/.config}/model-usage/local-policy.json` — Optional machine-wide lower-only policy override (`MODEL_USAGE_MACHINE_LOCAL_POLICY_PATH`).
- `.agent-sdlc/local-policy.json` or `tools/.model-usage/local-policy.json` — Optional host-project lower-only policy override (`DEFAULT_LOCAL_POLICY_PATH` / `MODEL_USAGE_DEFAULT_LOCAL_POLICY_PATH`).
- `tools/.model-usage/` — Gitignored per-machine runtime state directory containing `.instance.lock`, `.circuit.lock`, `provider-circuit.json`, redacted `diagnostics/<run-id>/`, and per-run ledger envelopes under `runs/<run-id>.json`.

---

## 2. Installation, Configuration & Public API

### Hybrid Deployment Strategy: Per-Machine Governor + 3-Tier Policy Overrides

`@evelbulgroz/model-usage-govenor` is a standalone library package (`"type": "module"`) executed directly on Node.js 22 (`>= 22.18.0` with native TypeScript type stripping). In consuming packages, declare `"@evelbulgroz/model-usage-govenor": "^1.0.0"` in `package.json`.

When paired with host agent runners or review CLIs, the governor operates in a **hybrid deployment model**:

1. **Single Per-Machine Governor & Shared Ledger State:** All host repositories driven by the machine's agent and review CLIs execute against the single machine installation of `@evelbulgroz/model-usage-govenor` and share its `tools/.model-usage/` state directory (`.instance.lock`, `provider-circuit.json`, and `runs/<run-id>.json`). This enforces unified cross-repository concurrency limits, provider cooldown circuits, and instance lifetime spend caps without adding governor dependencies to target repositories.
2. **3-Tier Monotonic (Lower-Only) Policy Resolution (`loadPolicy` in `packages/model-usage/policy/policy.ts`):**
   - **Tier 1 — Committed Engine Ceiling:** `.agents/model-usage-policy.json` in the engine checkout (bounded above by `BUILTIN_SAFETY`).
   - **Tier 2 — Per-Machine Override (optional):** `${XDG_CONFIG_HOME:-~/.config}/model-usage/local-policy.json` (or `MODEL_USAGE_MACHINE_LOCAL_POLICY_PATH`), applying workstation-wide spend caps or route exclusions across all repositories.
   - **Tier 3 — Per-Project / Host-Repo Override (optional):** `<host-root>/.agent-sdlc/local-policy.json` or `<host-root>/tools/.model-usage/local-policy.json` (or `MODEL_USAGE_DEFAULT_LOCAL_POLICY_PATH` / `localPolicyPath`), tightening limits for a specific host project.

### Credentials & Local Budget Overrides (`local-policy.json`)

1. **Provider API Keys:** Export credentials in your shell environment for the routes enabled in `.agents/model-usage-policy.json` (`GEMINI_API_KEY` or `GOOGLE_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY`, `ANTHROPIC_API_KEY`; see [`adapters/README.md`](./adapters/README.md)).
2. **Optional Lower-Only Local Policy (Machine-Wide or Per-Project):** Create `~/.config/model-usage/local-policy.json` (machine-wide Tier 2) and/or `.agent-sdlc/local-policy.json` or `tools/.model-usage/local-policy.json` in a host repository (project-local Tier 3; see [`policy/README.md`](./policy/README.md)):
   ```json
   {
     "instance": {
       "maxCostMicrousd": 2000000
     },
     "profiles": {
       "agent-sdlc-default": {
         "limits": {
           "runMaxCostMicrousd": 500000
         }
       }
     }
   }
   ```
   *(Each tier merges monotonically via `resolvePolicy`: overrides may only lower numerical limits, shorten timeouts, or disable routes; any attempt to raise a parent tier's ceiling or re-enable a disabled route throws `ERR_LIMIT_ESCALATION_FORBIDDEN`.)*

### Package Subpath Exports (`packages/model-usage/package.json`)

| Specifier | Target | Primary Exports |
|---|---|---|
| `@evelbulgroz/model-usage-govenor` | `./governor.ts` | `executeOperation`, `assessReservation`, `validateSchemaDefinition`, `assertStrictModeSchemaCompleteness` |
| `@evelbulgroz/model-usage-govenor/ledger` | `./ledger/ledger.ts` | `ModelUsageLedger`, `loadRunLedger` |
| `@evelbulgroz/model-usage-govenor/policy` | `./policy/policy.ts` | `loadPolicy`, `resolvePolicy`, `validatePolicy`, `validateOperationRequest`, `DEFAULT_LOCAL_POLICY_PATH` |
| `@evelbulgroz/model-usage-govenor/routing` | `./routing/routing.ts` | `selectRoutes` |
| `@evelbulgroz/model-usage-govenor/tokenizer` | `./routing/tokenizer.ts` | `estimatePromptTokens` |
| `@evelbulgroz/model-usage-govenor/errors` | `./policy/errors.ts` | `ModelUsageError`, `MODEL_USAGE_ERROR_CODES`, `asModelUsageError` |
| `@evelbulgroz/model-usage-govenor/atomic-file-state` | `./atomic-file-state.ts` | `withLockSync`, `durableReplaceSync` |
| `@evelbulgroz/model-usage-govenor/sanitize-failure-text` | `./sanitize-failure-text.ts` | `sanitize`, `truncateBody`, `extractSnippets` |
| `@evelbulgroz/model-usage-govenor/adapters/fake` | `./adapters/fake.ts` | `FakeModelAdapter` |
| `@evelbulgroz/model-usage-govenor/test-support` | `./testing/test-support.mjs` | Test fixtures and temporary state helpers |

### Governed Invocation (`executeOperation` & `assessReservation`)

```ts
import { assessReservation, executeOperation } from '@evelbulgroz/model-usage-govenor';

// Optional dry-run preflight (verifies route eligibility and budget headroom without network I/O)
await assessReservation(request);

// Full governed execution with two-phase reservation, failover, and schema validation
const result = await executeOperation({
  schemaVersion: '1.1.0',
  operationId: 'my-feature:task-1:generation-0',
  runId: '2026-09-09-my-feature',
  consumer: 'agent-sdlc',
  profile: 'agent-sdlc-default',
  prompt: 'Generate unit tests for auth service...',
  structuredOutputSchema: {
    type: 'object',
    required: ['status', 'files'],
    properties: {
      status: { type: 'string' },
      files: { type: 'array', items: { type: 'string' } },
    },
    additionalProperties: false,
  },
  routingConstraints: {
    excludedVendors: ['google'],
    requiredCapabilities: ['structured-output'],
    preferredRouteIds: ['openai-compatible-conservative'],
    strategy: 'balanced', // 'min-cost' | 'balanced' | 'quality-first'
    minQualityTier: 1,
  },
  requestedLimits: {
    maxPromptTokens: 8000,
    timeoutMs: 60000,
  },
  attribution: {
    taskId: 'task-1',
    nodeId: 'implement',
    roleId: 'implementer',
    generation: 0,
    nodeAttempt: 1,
    phase: 'code',
    scope: 'packages/example',
  },
});
```

See [`governor/README.md`](./governor/README.md) for `GovernorResult` fields and [`policy/README.md`](./policy/README.md) for the complete `ModelUsageError` (`MODEL_USAGE_ERROR_CODES`) taxonomy.

---

## 3. Development, Testing & Maintenance Commands

### Develop

- **TypeScript & build:** Sources run directly on Node.js `>= 22.18.0` (`node -p process.features.typescript` printing `strip`) and emit precompiled `.js` + `.d.ts` to `dist/` via `tsconfig.build.json` (`rewriteRelativeImportExtensions: true`) for `node_modules` execution. Use erasable TypeScript syntax only (`erasableSyntaxOnly`, `verbatimModuleSyntax` in [`tsconfig.json`](./tsconfig.json)) and explicit `.ts` extensions on relative imports.
- **Package boundaries & navigability ceilings:** Keep all in-scope `.ts` and `.mjs` files within `<= 500` lines and `<= 20,480` bytes (`packages/model-usage/testing/navigability.spec.mjs`).

```bash
# Build dist/ (.js + .d.ts + dist/policy/default-policy.json)
pnpm run build

# Strictly typecheck governor TypeScript sources (no emit, erasable syntax only)
pnpm run typecheck

# Run offline pricing parity audit against PROVIDER-CAPABILITIES.md
pnpm run audit:pricing
```

### Test

```bash
# Run a single module spec directly during inner-loop development
node --test governor/governor.spec.mjs

# Run all governor, ledger, policy, routing, adapter, and documentation specs
pnpm run test:unit
```

---

## 4. License & Disclaimer

Released under the **ISC License** (permissive):

Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NONINFRINGEMENT. THE AUTHORS AND COPYRIGHT HOLDERS REFUSE ALL RESPONSIBILITY AND SHALL IN NO EVENT BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY OTHER LIABILITY—WHETHER IN AN ACTION OF CONTRACT, TORT, OR OTHERWISE—ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE, INCLUDING ANY MODEL API COSTS, DATA LOSS, OR WORKSPACE MODIFICATIONS.
