# Offline Pricing Maintenance Scripts (`packages/model-usage/scripts/`)

Deterministic offline CLI tooling for auditing and atomically updating route pricing across `packages/model-usage/policy/default-policy.json` (plus optional host `.agents/model-usage-policy.json`) and `packages/model-usage/PROVIDER-CAPABILITIES.md`.

## Key Files & Entrypoints

- `packages/model-usage/scripts/audit-pricing.ts` — CLI and programmatic API (`auditPricing`, `bumpPricing`, `parseMarkdownPricingTable`) for offline pricing parity checks and atomic bumps.
- `packages/model-usage/scripts/audit-pricing.spec.mjs` — Unit tests covering parity checks, mismatch detection, monotonic `pricingVersion` bumps, and rollback safety.

## Usage & Invariants

```bash
# Audit parity between policy and PROVIDER-CAPABILITIES.md pricing table
pnpm run audit:pricing

# Atomically update route rates, PROVIDER-CAPABILITIES.md row, and monotonic pricingVersion
node packages/model-usage/scripts/audit-pricing.ts --bump \
  --route openai-compatible-conservative \
  --input-rate 150000 \
  --output-rate 600000 \
  --effective-date 2026-09-11 \
  --citation https://platform.openai.com/docs/pricing
```

1. **100% Offline & Deterministic:** Never performs network requests; validates committed policy rates against the authoritative markdown table in `packages/model-usage/PROVIDER-CAPABILITIES.md`.
2. **Atomic Monotonic Bumps:** `--bump` updates the policy JSON, updates the matching markdown row in `packages/model-usage/PROVIDER-CAPABILITIES.md`, advances `pricingVersion` monotonically, and runs `packages/model-usage/routing/tokenizer-pricing.spec.mjs` to verify pricing invariants.
