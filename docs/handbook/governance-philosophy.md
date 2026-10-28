# Model Governance Philosophy & Architecture

## 1. First Principles & Core Thesis

> **Architectural Rule of Thumb:**  
> *"Code for invariants and mechanisms; Prompts for policy and synthesis; Agents to build and maintain the code."*

We do not use natural language prompts as a replacement for disciplined software engineering. Instead, we use agentic engineering to build traditional, deterministic, type-safe software, reserving LLMs strictly for semantic reasoning, synthesis, and domain-grounded generation where logic cannot easily or economically be expressed in static code.

Operationally, `@evelbulgroz/model-usage-govenor` enforces strict preemptive cost governance, model vendor independence, and full local workflow ownership rather than tight coupling to any single vendor platform.

### Key Trade-Off Dimensions

1. **Token Economics vs. Latency:** Procedural tasks (branch validation, diff auditing, quality scanning, type checking) run in milliseconds at zero token cost via deterministic tools. Invoke an LLM only when synthesis or semantic judgment is required.
2. **Failure Polarity & Blast Radius ($p^n$):** Multi-step sequential LLM pipelines degrade exponentially ($0.95^{10} \approx 0.60$), and negative prompt constraints suffer attention drift. Compilers, type systems, and lint gates fail closed with certainty.
3. **Cognitive Ergonomics across Teams:** Type signatures, JSON Schemas, and static checks serve as unambiguous contracts between engineers and agents that cannot be subtly reinterpreted across model updates.

---

## 2. Two-Phase Governed Execution (Reserve-Dispatch-Reconcile)

Every repository-owned model call must route through the governor. The governor:
1. Validates the committed and local policy.
2. Atomically reserves worst-case prompt and completion budgets before network dispatch.
3. Dispatches execution only to enabled adapter routes.
4. Reconciles actual or conservative fallback usage upon completion.

Consumers never own provider credentials, SDK transports, physical retries, failover, or quota accounting.

### Synchronous Lock Invariants (`zero await`)

To prevent concurrent race conditions and reentrancy bugs in Node.js event loops, ledger updates, reservations, and quota tracking execute synchronously without `await`. Network calls occur strictly between reservation and reconciliation.

---

## 3. Dynamic Credit-Aware Routing & Runway Pressure

- **Quality Tiers:** Policy routes declare an integer `qualityTier` (`1` economy workhorse; `2` advanced reasoning/synthesis/review).
- **4-Step Route Selection:** Hard filter on invariants (`enabled`, `excludedVendors`, `requiredCapabilities`, token ceilings) $\to$ affordability gate $\to$ runway pressure check $\to$ strategy ordering.
- **Runway Pressure Gating:** When remaining run budget or runway drops to $\le 30\%$, the governor automatically overrides route ordering strategy to `min-cost`, preserving critical runway without failing mid-run.

---

## 4. Three-Tier Policy Hierarchy (Lower-Only)

Policy bounds may only be tightened, never loosened:
1. **Machine Environment Override:** Optional local config (`~/.config/model-usage/local-policy.json`).
2. **Host Repository Local Override:** Optional project config (`.agent-sdlc/local-policy.json` or `tools/.model-usage/local-policy.json`).
3. **Committed / Bundled Defaults:** Bundled package default policy (`default-policy.json`).
