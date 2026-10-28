# Test Fixtures & Package Gates (`packages/model-usage/testing/`)

Shared offline test fixtures and mechanical package gates enforcing directory layout, agent-navigability ceilings, and living-documentation anti-drift across `packages/model-usage`.

## Key Files & Entrypoints

- `packages/model-usage/testing/test-support.mjs` — Shared policy fixtures, temporary state directory helpers (`makeTestRoot`, `cleanupTestRoot`), and base operation requests (exported via `@evelbulgroz/model-usage-govenor/test-support`).
- `packages/model-usage/testing/governor-test-support.mjs` — Governor execution and failover test harness helpers.
- `packages/model-usage/testing/ledger-test-support.mjs` — Ledger reservation, envelope setup, and child-process lock spawn helpers.
- `packages/model-usage/testing/live-adapters-test-support.mjs` — Offline mock `fetch` harnesses for provider adapter contract tests.
- `packages/model-usage/testing/layout.spec.mjs` — Enforces the allowlisted package root layout, subpath export existence, and recursive `test:model-usage` spec discovery.
- `packages/model-usage/testing/navigability.spec.mjs` — Enforces the `<= 500` lines and `<= 20,480` bytes ceiling across all in-scope `.ts` and `.mjs` files in `packages/model-usage`.
- `packages/model-usage/testing/living-docs.spec.mjs` — Verifies that root and module READMEs stay within navigability limits, are indexed in `packages/model-usage/AGENTS.md`, contain no broken `packages/model-usage/...` file references, and contain no retired pre-package path prefixes.
