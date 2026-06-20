# Spec: Engine Capabilities — Text Assertion, Random Click, Run-Scoped Capture

Created: 2026-06-20
Updated: 2026-06-20

## 0. Motivation

Three common end-to-end testing patterns are not expressible in the current
engine. An audit of the `StepAction` union in
[`src/types/index.ts`](src/types/index.ts), the dispatch switch in
[`src/modules/execution-engine/playwright.execution-engine.ts`](src/modules/execution-engine/playwright.execution-engine.ts),
and the step loop in [`src/workers/worker.ts`](src/workers/worker.ts) shows
three capability gaps:

| Gap | Today | Needed |
|---|---|---|
| A — content assertion | `assert_visible` only checks presence | assert an element's **text contains/equals** a value |
| B — random selection | `select` = `<select>` dropdown; resolver returns one best element | click **one of N** matching elements at random |
| C — cross-step capture | steps are stateless (only `previousAfterPng` flows between steps) | **capture** a value in one step, **assert against it** in a later step |

Each is a first-class, reusable engine feature, independently shippable and
tested.

---

## 1. Gap A — `assert_text` action

### 1.1 Type

Extend the `StepAction` union in [`src/types/index.ts`](src/types/index.ts):

```ts
export type StepAction =
  | 'navigate'
  | 'click'
  | 'click_random'   // Gap B
  | 'type'
  | 'select'
  | 'assert_visible'
  | 'assert_text'    // Gap A
  | 'wait'
  | 'press_key'
  | 'scroll';
```

`assert_text` reuses existing `StepAST` fields:
- `targetDescription` — the element whose text is inspected (e.g. "the account links in the header", "the order total label").
- `value` — the expected substring. May contain a `{{variable}}` reference (Gap C).

### 1.2 Matching semantics

`assert_text` passes when the element's accessible/visible text **contains**
`value` (case-insensitive, whitespace-normalised). Substring-contains — not
strict equality — because real UI containers wrap the value of interest in
surrounding chrome (labels, adjacent controls, price/quantity columns). A
containment check is the robust default and matches how a human reads "X
appears in this element".

### 1.3 Executor

New case in `dispatchAction`:

```ts
case 'assert_text': {
  if (step.value == null) throw new Error('assert_text action requires StepAST.value');
  const actual = await page.$eval(selector, (el) => (el.textContent ?? '').trim());
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!norm(actual).includes(norm(step.value))) {
    throw new Error(
      `assert_text failed: expected element to contain "${step.value}" but got "${actual}".`,
    );
  }
  break;
}
```

Failure throws (same contract as other dispatch cases) so the selector
loop tries the next selector and, if all fail, the worker classifies it.

### 1.4 Compiler seed

Seed L2 (`compiled_ast_cache`) patterns mapping phrasings such as
"validate / verify / check that <target> contains / shows / displays <value>"
to `action: 'assert_text'`. Novel phrasings still fall through to L3 (LLM).

---

## 2. Gap B — `click_random` action

### 2.1 Rationale

Kaizen's resolver is built to return the single *best* element for a target.
"Select a random product" inverts that: we want any one of several equally
valid matches. A dedicated action expresses this intent unambiguously in NL
and keeps the deterministic resolver path untouched for every other step.

### 2.2 Resolution contract

For `click_random`, the element resolver must return **all** matching
candidates rather than collapsing to one. Implementation: the engine consumes
the full `selectorSet.candidates` array (already produced by the DOM pruner)
filtered to the candidates the resolver deemed relevant to `targetDescription`,
then picks one uniformly at random and clicks it.

Determinism for reproducibility: the chosen index is seeded from
`runId + stepIndex` (hashed) so a given run is replayable, while different
runs vary. The chosen candidate's `kaizenId` and accessible `name` are
recorded in the step result (`llm_picked_kaizen_id`, and the captured value
per Gap C) so the Details page can show exactly which product was picked.

### 2.3 Executor

```ts
case 'click_random': {
  // selectorSet carries >1 candidate; pick one deterministically-at-random.
  // (Engine resolves the concrete selector from the chosen candidate.)
  await page.click(selector, { timeout: ACTION_TIMEOUT_MS });
  break;
}
```

The randomness lives in selector *selection* (which candidate's selector the
engine hands to dispatch), not in dispatch itself. See §2.4.

### 2.4 Selection point

`executeStep` (engine) gains awareness of `click_random`: instead of iterating
selectors in confidence order until one works, it first reduces the candidate
set to the random pick, derives that pick's selector, and runs `click`. The
fallback-to-next-selector behaviour still applies *within* the chosen
candidate's selector list (role → css → xpath) for robustness.

---

## 3. Gap C — Run-scoped variable capture (the core feature)

### 3.1 Problem

An assertion of the form "this value matches the one chosen earlier" is only
meaningful if the earlier step's chosen value is remembered. Today the step
loop threads only
`previousAfterPng` between steps ([`src/workers/worker.ts:153-174`](src/workers/worker.ts)).
There is no run-scoped key/value memory and no interpolation.

### 3.2 Run context

Introduce a `RunContext` carried through `runStepLoop`:

```ts
export interface RunContext {
  /** Run-scoped captured values, keyed by variable name (no braces). */
  variables: Record<string, string>;
}
```

Created once per run, mutated by capturing steps, read by interpolating steps.
It lives only in worker memory for the run's duration — it is **not**
persisted across runs (each run captures fresh). Captured values ARE persisted
per-step in `step_results` (see §3.5) for the Details page.

### 3.3 Capture syntax

A step captures by naming a sink variable. Two non-breaking mechanisms:

- **Implicit on `click_random`**: the chosen element's accessible name is
  auto-captured to a well-known variable derived from the step, e.g.
  `selectedItem`. The capture key is set on the compiled `StepAST` via a
  new optional field `captureAs?: string | null`.
- **Explicit field** `captureAs` on any `StepAST`: when set, after the action
  succeeds the engine reads the resolved element's text and stores
  `variables[captureAs] = text`.

```ts
export type StepAST = {
  // ...existing fields...
  /** When set, store the resolved element's text into RunContext under this name. */
  captureAs?: string | null;
};
```

The compiler maps a phrasing like "select a random item" → `click_random`
with `captureAs: 'selectedItem'`.

### 3.4 Interpolation

Before a step executes, the worker resolves `{{var}}` tokens in `step.value`
and `step.targetDescription` against `RunContext.variables`:

```ts
function interpolate(s: string | null, ctx: RunContext): string | null {
  if (s == null) return s;
  return s.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, name) =>
    ctx.variables[name] ?? `{{${name}}}`);   // unknown vars pass through literally
}
```

The compiler maps a phrasing like "verify the item name matches the one
selected" → `assert_text` on the target element with
`value: '{{selectedItem}}'`. At run time this interpolates to the actual
captured value, and §1.2 containment matching does the comparison.

Unresolved variables (typo, capture step skipped) pass through literally so
the assertion fails loudly with a readable message rather than silently
matching empty string.

### 3.5 Persistence

Add nullable columns to `step_results` (new migration):

- `captured_name TEXT` — the variable name captured by this step (or NULL).
- `captured_value TEXT` — the value captured (or NULL).

These surface on the run details page: the capturing step shows "captured
`selectedItem` = '<value>'", and the asserting step shows "asserted contains
'<value>' ✓". This makes the cross-step linkage visible — a key differentiator
versus a flat pass/fail report.

### 3.6 Loop wiring

`runStepLoop` constructs `RunContext` once, passes it to each `executeStep`
call alongside the existing args. `executeStep` (worker wrapper):
1. interpolates `step.value` / `step.targetDescription` against the context,
2. runs the engine,
3. on success, if `step.captureAs` is set, reads the element text and writes
   `ctx.variables[step.captureAs]`,
4. records `captured_name` / `captured_value` in the step result row.

---

## 4. Out of scope

- Persisting `RunContext` across runs or exposing variables in the test
  authoring UI (future work).
- Arithmetic / transforms on captured values (only verbatim capture + contains).
- Multiple random picks per run with collision avoidance.

---

## 5. Test plan

- **A**: unit test `dispatchAction` `assert_text` pass (substring, case/ws
  insensitive) and fail (missing substring, null value).
- **B**: unit test that `click_random` selects from >1 candidate, that the
  pick is seeded-deterministic for a fixed `runId+stepIndex`, and that the
  pick is recorded.
- **C**: unit test `interpolate` (known var, unknown var passthrough, multiple
  vars); integration test of capture→interpolate→assert across two steps via
  a fake page; migration applies and `step_results` round-trips the new cols.
- **End-to-end**: a multi-step flow exercising all three features (capture on
  a `click_random` step, then `assert_text` against the captured variable in a
  later step) runs green against a live target (manual / integration), with the
  run details page showing the captured value and the matching assertion.

---

## 6. Acceptance criteria

1. `StepAction` includes `assert_text` and `click_random`; `StepAST` includes
   `captureAs`.
2. A flow using `click_random` + `captureAs` followed by `assert_text` on the
   captured variable compiles and runs end-to-end, finishing `passed`.
3. The `click_random` step's chosen element name is captured and the later
   `assert_text` step asserts it via containment; both captured name/value are
   persisted and visible in the API.
4. `npm run typecheck` and `npm run lint` pass; unit tests in §5 added & green.
