# Dynamic Route Selection, Pricing & Tokenization (`packages/model-usage/routing/`)

Implements deterministic capability- and credit-aware route selection (`selectRoutes`), micro-USD reservation and reconciliation pricing, counterfactual Tier-2 cost baselines, and conservative prompt token estimation.

## Key Files & Entrypoints

- `packages/model-usage/routing/routing.ts` — Deterministic 4-step route selector (`selectRoutes`) returning `{ routes, effectiveStrategy, pressureActive }`.
- `packages/model-usage/routing/pricing.ts` — Versioned route pricing (`calculateReservationPrice`, `calculatePrice`) handling input, output, cache-read, cache-write, fixed-request, and premium-request-unit rates.
- `packages/model-usage/routing/tokenizer.ts` — Conservative prompt and JSON Schema token estimator (`estimatePromptTokens`) with UTF-8 byte/character heuristics and request-envelope padding.

## Core Invariants

1. **Dynamic 4-Step Route Selection Precedence (`selectRoutes`):**
   - **Step 1 (Hard Invariants & Ceilings):** Filters routes by `enabled`, `canonicalVendor` exclusions, `requiredCapabilities`, token ceilings (`maxPromptTokens`, `maxCompletionTokens`, `maxTotalTokens`), and caller `minQualityTier` floors.
   - **Step 2 (Affordability Gating):** Computes worst-case reservation cost $C_{\text{est}}$ per candidate route. When affordable routes exist ($C_{\text{est}} \le \text{remainingRunCostMicrousd}$), unaffordable routes are pruned.
   - **Step 3 (Runway State Classification):** Activates *Runway Pressure* (`pressureActive: true`) when $\text{runwayRatio} \le 0.30$, remaining budget $< 3 \times C_{\text{min\_affordable}}$, or all candidates are unaffordable.
   - **Step 4 (Strategy & Cost Ordering):**
     - *Healthy Runway:* Honors `preferredRouteIds`, then orders remaining routes by `strategy` (`'min-cost'` by ascending $C_{\text{est}}$, `'balanced'` by `policyRank`, `'quality-first'` by descending `qualityTier` with cost tie-break).
     - *Runway Pressure:* Overrides strategy to `'min-cost'`, demotes caller preferences to cost tie-breakers, and orders candidates strictly by ascending $C_{\text{est}}$.

2. **Conservative Reservation vs Reconciled Cache Pricing:**
   - Reservations always price prompt tokens at the conservative worst-case rate (input rate, or cache-write rate when a route declares a cache-write premium) so reconciled usage never exceeds the reserved cost ceiling.
   - Counterfactual Tier-2 cost ($C_{\text{tier2}}$) records the cheapest eligible `qualityTier >= 2` route cost on each operation for downstream cost-benefit analysis.
