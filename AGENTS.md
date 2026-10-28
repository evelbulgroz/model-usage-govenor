# AGENTS.md — @evelbulgroz/model-usage-govenor

Standalone package providing the Model Usage Governor and provider adapters (`packages/model-usage`).

## Critical Rules

1. **Explicit Git Approval**: DO NOT commit, branch, or push unless the operator explicitly approves that action in chat. Local file changes only by default.
2. **Platform & Toolchain**: Linux/WSL only (`node >= 22.18.0`, `pnpm install`). Use `pnpm` exclusively.
3. **Model Provider Boundary**: Repository-owned model calls must route through `governor.ts`. Provider transports, credentials, retries, failover, token/cost accounting, and circuit breaking belong strictly inside the governor and allowlisted adapters.
4. **Lower-Only Local Policy**: Local policy overrides may only lower committed limits (machine environment -> host local policy -> committed/bundled default policy).
5. **Pre-Emit Verification**: Before flagging any bug or regression in review/triage, quote the exact code and reproduction evidence proving it exists. Add tests for uncertain boundary conditions.
6. **Repair Budget**: Max 2 autonomous repair iterations per failing check before stopping to escalate.
7. **No Masking**: Never delete test assertions, weaken invariants, raise budget limits, or bypass circuit breakers. Prefer fixing the root cause.
8. **Navigability Ceilings**: Every file must remain within <= 500 lines and <= 20,480 bytes.

## Development & Packaging Directives

1. **Native Node Type Stripping**: `tsconfig.json` maintains `noEmit: true`, `erasableSyntaxOnly: true`, and `verbatimModuleSyntax: true`. In-source relative imports use explicit `.ts` extensions.
2. **Build Emission**: `tsconfig.build.json` compiles to `dist/` with rewritten `.js` specifiers and bundled assets.
3. **Self-Sufficiency**: Zero path assumptions outside the package root. All repository and state discovery must use `loadPolicy.resolveHostRepoRoot()` or `loadPolicy.resolveDefaultStateRoot()`.
4. **Status Lead**: End implementation turns with what changed, what was skipped, and verification command results.

## Package Documentation

- [`./README.md`](./README.md) — Package layout, credential/local-policy configuration, public API, and development/testing commands
- [`./ARCHITECTURE.md`](./ARCHITECTURE.md) — Architectural intent, rationale, core guarantees, and two-phase execution lifecycle
- [`./PROVIDER-CAPABILITIES.md`](./PROVIDER-CAPABILITIES.md) — Provider route capabilities and metered pricing evidence

### Module Reference Guides (Progressive Disclosure)

- [`./governor/README.md`](./governor/README.md) — Two-phase execution, failover, circuit breaker, diagnostics, and JSON Schema checks
- [`./ledger/README.md`](./ledger/README.md) — Synchronous lock invariants (`zero await`), envelope schema (`1.0.0`–`1.2.0`), budget admission, and recovery
- [`./policy/README.md`](./policy/README.md) — Committed policy schema, lower-only local policy merge, request normalization, and `ModelUsageError` codes
- [`./routing/README.md`](./routing/README.md) — 4-step route selection, runway-pressure gating, counterfactual Tier-2 pricing, and prompt tokenization
- [`./adapters/README.md`](./adapters/README.md) — Normalized adapter contract, live provider adapters, reasoning/cache token accounting, and fake adapter
- [`./scripts/README.md`](./scripts/README.md) — Offline pricing parity audit (`--check`) and atomic policy/capabilities price bump CLI (`--bump`)
- [`./testing/README.md`](./testing/README.md) — Shared test fixtures and package layout, navigability, and living-documentation gates

## Commands

| Task | Command |
|------|---------|
| Build | `pnpm run build` |
| Pricing audit | `pnpm run audit:pricing` |
| Tests | `pnpm run test:unit` |
| Typecheck | `pnpm run typecheck` |

## Local Done Bar

Before claiming an implementation task is done in this package:

```bash
pnpm run build && pnpm run typecheck && pnpm run test:unit && pnpm run audit:pricing
```
