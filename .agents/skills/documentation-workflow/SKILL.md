---
name: documentation-workflow
description: Author or update technical guides, tutorials, and reference docs adhering to the Diataxis framework and doc-code drift verification. Use when writing or revising documentation.
---

Use this skill when authoring or revising guides, tutorials, and reference documentation under `docs/` or package READMEs.

## Scope & Exclusions

- **Applies to:** New or revised standalone guides, tutorials, reference manuals, and READMEs.
- **Exclusions:**
  - In-source comments and JSDoc follow standard code commenting guidelines, not Diataxis standalone document structures.
  - Do NOT retroactively restructure existing documentation when making targeted updates.

## Diataxis 4-Quadrant Framework

Structure new documentation strictly by its intended quadrant:
1. **Tutorial:** Learning-oriented walkthrough for newcomers (step-by-step onboarding).
2. **How-To Guide:** Problem-oriented guide for solving specific operational or development tasks.
3. **Reference:** Information-oriented technical description (APIs, schemas, config flags, CLI options).
4. **Explanation:** Understanding-oriented discussion of architecture, concepts, and trade-offs.

Do not mix reference tables into tutorials or theoretical essays into how-to guides.

## Doc-Code Drift Prevention

1. When code interfaces, exports, or CLI flags change, update corresponding READMEs and reference docs in the same turn.
2. Ensure every file path linked in markdown files exists on disk.
3. Keep all documentation files within navigability limits (<= 500 lines, <= 20,480 bytes).
