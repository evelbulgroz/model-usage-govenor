---
name: bugfix-workflow
description: Reproduce, localize, fix, and verify defects using systematic diagnostic heuristics (Iron Law, pattern matrix, 3-strike rule). Use when fixing bugs, failing tests, or regressions.
---

Use this skill for defect-oriented work.

## Diagnostic Heuristics

1. **The Iron Law:** No fixes without root-cause verification first. Never write patch code before proving the causal mechanism with a reproducer test or trace evidence.
2. **Diagnostic Pattern Matrix:** Classify against:
   - *Race condition:* Timing-dependent; check shared state, file locks, un-awaited promises.
   - *Null propagation:* `TypeError`/`undefined`; verify input validation and boundary handling.
   - *State corruption:* Inconsistent ledger/event records; check atomic transactions or async handlers.
   - *Integration/Timeout:* HTTP client retries, missing backoff, circuit breaker traps.
   - *Configuration drift:* Env vars, local vs CI differences, missing credentials.
3. **3-Strike Hypothesis Rule:** If 3 consecutive root-cause theories fail to localize or reproduce the defect, **STOP** and escalate to the human; do not guess a 4th hypothesis. Gate re-runs stay under the 2-repair budget.
4. **Fix the Shared Root:** Patch the shared helper/function at the source rather than sprinkling null checks in multiple caller sites.
5. **Blast Radius Gate:** If a fix crosses module boundaries or modifies unrelated files, pause and challenge whether the fix is too wide.

## Workflow

1. Reproduce the bug with the smallest reliable signal available (a minimal failing test or script).
2. Identify the owning module and failing layer (pure logic, orchestration, adapter transport, or configuration).
3. Fix the root cause instead of masking the symptom.
4. Add or update regression coverage at the boundary that failed.
5. Run the narrowest verification that proves the fix.

## Canonical References

- `docs/handbook/development-guide.md`
- `AGENTS.md` (Repair Budget & Critical Rules)

## Guardrails

- Do not bypass an architectural rule or delete tests to make checks green.
- Never weaken assertions or raise timeout limits to paper over flaky behavior.
