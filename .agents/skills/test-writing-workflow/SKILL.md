---
name: test-writing-workflow
description: Write handbook-aligned tests covering the 4 Shadow Paths, regression boundaries, and contract surfaces. Use when adding or updating tests.
---

Use this skill when authoring tests.

## Canonical References

- `docs/handbook/development-guide.md`
- `AGENTS.md`

## The 4 Shadow Paths Coverage

For every data flow, validation boundary, or endpoint, explicitly test:
1. **Happy path:** Valid payload, expected transformations and outcomes.
2. **`nil`/null input path:** Undefined/null fields, missing parameters or options.
3. **Empty payload path:** Empty arrays, zero-length strings, empty filter criteria.
4. **Upstream error / timeout path:** Network failures, unexpected status codes, abort signals, timeouts.

## Seam-first

Name the subject's public API before writing tests. Test public behavior first rather than asserting on private implementation details. Expected values come from a spec or literal, not the algorithm under test.

## Test Selection Workflow

1. Choose the smallest layer that answers the question:
   - **unit** for isolated logic, path matrices, and boundary primitives
   - **integration** for real collaborators inside the package (state store + fake adapter)
   - **boundary** for external protocol serialization/deserialization
2. Place tests close to the code they protect (colocated `*.spec.mjs`).
3. Offline execution: All unit tests execute offline without real network dependencies or live model credentials.

## Structure & Focus

- Name tests by behavior/outcome (`returns...`, `handles...`, `rejects...`).
- Focus on validation/sanitization boundaries, transport mapping, and contract behavior.
- Do not delete or weaken existing tests when refactoring.
