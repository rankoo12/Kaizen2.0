---
name: add-capability
description: Add a new test capability to Kaizen through every layer in order — spec, types, compiler prompt, worker routing, execution engine, unit tests, live dogfood, PR. Use when the user says /add-capability or asks to add a new StepAction / assertion / interaction (like drag_and_drop, multi-tab, assert_count). Enforces the layered pipeline so no layer is skipped.
---

# Add Capability

A capability is only real when it survives the whole pipeline. Skipping a layer is how a step compiles but silently no-ops (or false-passes). Follow the order — the SDD rule says spec first.

## The pipeline (in order)
1. **Spec (SDD)** — write or extend the spec under `docs/specs/...` first, with Created / Updated dates. The spec is the source of truth.
2. **Types** — add the action to the `StepAction` union in `src/types/index.ts` (plus any new field on `SelectorSet` / `StepAST`).
3. **Compiler** — teach `compileStep` in `src/modules/llm-gateway/openai.gateway.ts`: map the NL phrasing → action, define which field carries the target vs the value, and pin polarity / edge rules explicitly. The prompt is where false-compiles start.
4. **Worker routing** — wire the action in `src/workers/worker.ts`: how the target resolves (cached vs no-cache resolver — mind `targetHash` collisions), then dispatch to the executor.
5. **Execution engine** — implement the real browser action in `src/modules/execution-engine/playwright.execution-engine.ts`. **Fail LOUDLY** when the precondition isn't met (no element, no match, wrong count) — never return success on a no-op. This is the false-pass firewall.
6. **Unit tests** — update the module `__tests__` (mock page; positive + negative + the specific misuse that would false-pass).
7. **Live dogfood** — run it through the real worker on real sites (see `/dogfood`). Prove the negative case FAILS, not just the happy path.
8. **Gates + PR** — run `/ship` (typecheck, lint, test), then commit `feat(scope) : "..."` on a `feat/scope/...` branch and open the PR. No AI attribution.

## Watch for
- **Loud failure over silent pass** — the recurring risk. If the engine can't do the thing, the step must fail, not pass.
- **targetHash collisions** — a step whose destination reuses the source `targetHash` will poison the cache; resolve destinations no-cache (that's why `drag_and_drop` routes its destination through the assertion resolver).
- **Don't build general counting on `random-target.ts` `selectorsForTarget`** — it's hardcoded to e-commerce selectors and will miscount silently.
