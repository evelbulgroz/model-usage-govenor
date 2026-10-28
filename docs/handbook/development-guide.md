# Development, Testing & Design Guidelines

## 1. Separation of Pure Logic from I/O

To ensure maximum testability, reliability, and speed:
- **Core modules (`policy`, `routing`, `ledger`):** Purely synchronous, deterministic TypeScript. Zero network calls, zero file I/O where possible, zero `await`.
- **Adapters (`adapters/`):** Encapsulate provider-specific HTTP schemas, header structures, and error status code mappings.

---

## 2. Testing Philosophy & The 4 Shadow Paths

All features and bug fixes must test both happy paths and the 4 Shadow Paths:
1. **Unhappy Path:** Provider errors (401 invalid key, 429 quota exhaustion, 500 server error, malformed JSON).
2. **Timeout & Delay Bounds:** Enforce circuit breakers and abort signals without hanging indefinitely.
3. **Empty & Null States:** Empty prompts, null responses, zero token returns, or missing usage records.
4. **Boundary Conditions:** Max output token limits, integer overflow bounds, floating-point roundoff in pricing calculations.

---

## 3. Offline & Deterministic Unit Testing

All unit tests in this package run 100% offline with zero token burn:
- Use `FakeModelAdapter` (`./adapters/fake.ts`) or `test-support.mjs` fixtures.
- Mock network interactions to verify route failover and circuit breaker state machines.

---

## 4. Native Node Type-Stripping & Erasable Syntax

- Source code uses erasable TypeScript syntax supported natively by Node.js `>= 22.18.0` (`erasableSyntaxOnly: true`).
- In-source relative imports specify explicit `.ts` extensions.
- Production emission to `dist/` is handled by `tsconfig.build.json` with `rewriteRelativeImportExtensions: true`.
- Navigability ceilings: every file must remain $\le 500$ lines and $\le 20,480$ bytes.
