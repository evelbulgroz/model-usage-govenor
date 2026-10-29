# Backlog

## Demote Gemini in the default route order

- **Status:** open
- **Current:** `policy/default-policy.json` (1.1.0) orders `agent-sdlc-default` and `trace-attribution` as fake-governed, openai, anthropic, gemini, xai. `critic-review` is fake-governed, xai, openai, anthropic, gemini.
- **Wanted:** place `google-gemini-quality` last in `agent-sdlc-default` and `trace-attribution` (openai, anthropic, xai, gemini), keeping xAI mostly in reserve for critic review.
- **Interim:** a machine-local `~/.config/model-usage/local-policy.json` carries this order. It must stay a minimal lower-only override that only reorders `routeIds`; copying the full default breaks the boundary check.
- **Work:**
  - Reorder `policy/default-policy.json` and update the route-order assertion in `policy/policy-validation.spec.mjs`.
  - Update the order described in `PROVIDER-CAPABILITIES.md`.
  - Bump the version, update the version pin in `testing/layout.spec.mjs`, publish, and re-import in agent-sdlc (version pins in `testing/package-shape.spec.mjs` and `testing/model-usage-gate.spec.mjs`, plus `pnpm-workspace.yaml` and the lockfile).
  - Re-qualify the agent-sdlc canary afterwards, because `modelPolicyHash` changes.
- **Then:** remove the machine-local override once the default carries the order.
