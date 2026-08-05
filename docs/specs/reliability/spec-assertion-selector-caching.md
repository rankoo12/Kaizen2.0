# Spec: assertions re-pay the model on every run

Created: 2026-08-05

Branch: `fix/element-resolver/assertions-never-cached`
Backlog: [spec-feature-backlog.md](../roadmap/spec-feature-backlog.md) — B19

---

## 1. The symptom

The same test, run twice, with nothing changed in between:

| step | run 1 | run 2 |
|---|---|---|
| `type "42" in the number field` | `redis` · selector `input` · **0 tok** | `redis` · `input` · **0 tok** |
| `verify the number field has value 42` | `llm` · `[data-kaizen-id='kz-1']` · **97 tok** | `llm` · `[data-kaizen-id='kz-1']` · **97 tok** |

Both steps target the **same element**. The interaction learned it once and is free
forever; the assertion pays the model every run, permanently.

Confirmed against `selector_cache`: the interaction's `target_hash` has a row, the
assertion's has none — ever.

That matters more than one step's cost. Assertions are how tests end, so the step that
never gets cheaper is the step **every test finishes on**. It puts a permanent floor under
the cost curve the product exists to drive to zero.

## 2. Root cause

A four-link chain, each link individually reasonable:

1. `verify the number field has value 42` compiles to **`assert_attribute`**.
2. `assert_attribute` is in `NO_CACHE_ASSERTIONS`
   ([worker.ts:637](../../../src/workers/worker.ts#L637)), so the step is routed to
   `assertionResolver` instead of the normal one.
3. That resolver's LLM tier is constructed with **`cacheWrites: false`**
   ([worker.ts:116-119](../../../src/workers/worker.ts#L116)).
4. `cacheWrites` gates **two** things in `LLMElementResolver`: the `persistToCache` call
   ([llm.element-resolver.ts:434](../../../src/modules/element-resolver/llm.element-resolver.ts#L434))
   *and* the last-resort selector synthesis
   ([:417](../../../src/modules/element-resolver/llm.element-resolver.ts#L417)).

Link 4 is the sharp edge. This element is an unlabelled `<input type="number">` with no
id, name, placeholder or aria-label, so the DOM pruner can only offer the session-scoped
`[data-kaizen-id='kz-1']`. Synthesis exists precisely to turn that into something
cacheable — and it works: run against the live page, it produces `input`, matching exactly
one element, which is the very selector the interaction step already caches.

It never runs, because it is behind the same flag as the write.

## 3. Why the no-cache policy exists, and why it is right

Not a mistake to be deleted. The stated reason
([worker.ts:106-115](../../../src/workers/worker.ts#L106)) is that a verify step's target
can embed run-specific data, and the hazard is real — worse than the comment suggests.

`targetHash` is computed **in the compiler**, at enqueue
([learned.compiler.ts:55](../../../src/modules/test-compiler/learned.compiler.ts#L55)),
from the raw `targetDescription`. The worker then interpolates `{{variables}}` at execution
time ([run-context.ts](../../../src/workers/run-context.ts)) — and `interpolateStep`
**does not recompute `targetHash`**.

So for a step like `verify the header shows {{email}}`:

- `targetHash` is **identical on every run** (hashed before substitution)
- `targetDescription` is **different on every run** (`alice+1111@…`, `alice+2222@…`)

Caching under that hash would have run 2 read back run 1's selector — `text=alice+1111@…`
— and assert against an email that no longer exists. A stable key pointing at volatile
content is the worst possible cache entry, and the blanket policy correctly prevents it.

## 4. The fix

Keep the policy; narrow it to the case it actually protects.

**Route a state assertion to the caching resolver only when interpolation did not change
its target.** `interpolateStep` already returns the *same object reference* when neither
`value` nor `targetDescription` contained a token, so the test is exact and free:

```ts
const targetIsRunVarying = step.targetDescription !== rawStep.targetDescription;
```

- `verify the number field has value 42` — no token, target unchanged → **cacheable**
- `verify the header shows {{email}}` — token substituted, target changed → **stays fresh**

`assert_not_visible` remains on the no-cache path regardless. Its pass condition is that
the element *is not there*, so resolving it from a remembered selector inverts what the
step is asking; the cost saving does not justify reasoning about that.

Note this also enables cache **reads** for those steps, which is the point — a write with
no read saves nothing. The read hazard is the same run-specific-data hazard, and the same
guard covers it.

### 4.1 What this does not change

- Interaction steps: untouched.
- `assert_not_visible`: untouched.
- Any assertion whose target interpolates: untouched, still resolves fresh every run.
- `recordSuccess` / archetype learning stay disabled for all assertions
  ([worker.ts:763](../../../src/workers/worker.ts#L763), [:775](../../../src/workers/worker.ts#L775)).
  Those write to the *shared* brain and the outcome window; this change is only about a
  tenant-scoped selector for a specific step.

## 5. Verification

Per `feedback_verify_before_prod` — this is engine behaviour, so a green unit test proves
nothing on its own.

| | Proof required |
|---|---|
| Cost | The same test run twice: the assertion goes `llm` → a cache tier, and its tokens go 97 → 0. A `selector_cache` row exists for its `target_hash`. |
| Correctness | The assertion still passes, and still fails when it should — a wrong expected value must not pass off a cached selector. |
| No poisoning | A test whose assertion target interpolates a per-run variable resolves fresh on both runs, writes no cache row, and asserts against the right value each time. |
| No regression | The full benchmark battery is unaffected; suite green. |

## 6. Out of scope

- Recomputing `targetHash` after interpolation. It would make run-varying targets safely
  cacheable-per-value, but it changes the key for every existing cache row and every
  `step_results.target_hash` already written — a migration-scale change for a case this
  guard already handles.
- The same shape in iframe-resolved elements (cookie/consent banners resolve without
  persisting, so they re-pay every run). Related, separate, noted in the backlog under B9.
