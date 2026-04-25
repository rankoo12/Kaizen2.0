# Element Resolver — Don't Cache Ambiguous Selectors

Created: 2026-04-25
Updated: 2026-04-25

## Problem

`LLMElementResolver` caches the wrong selector when the LLM-picked element shares
its stable selector (`role=…[name=…]`) with another element on the page.

Reproduction (live):

1. Page contains two `role=textbox[name="Email Address"]` — login and signup.
2. Step: `under signup type … in signup-email`.
3. **Run 1 (L0):** archetype matches `email_input`, returns the ambiguous
   `role=textbox[name="Email Address"]`. Playwright picks DOM-first (the login
   email). Step types into the wrong field. User marks fail.
4. **Run 2 (L5):** archetype on cooldown, cache empty. LLM correctly picks
   `kz-14` (the signup email). The current ambiguity-handling code at
   `llm.element-resolver.ts:244–259` swaps execution to `[data-kaizen-id='kz-14']`
   (correct), but **persists the ambiguous stable selector** to `selector_cache`
   "so future runs skip the LLM."
5. **Run 3 (L2):** `selector_cache` returns the ambiguous selector. Playwright
   picks DOM-first → wrong field again. The LLM is never called.

The LLM did its job. Execution on run 2 was correct. The cache write is what
poisons run 3.

The relevant code already documents the trap in a comment:

> Playwright picks DOM-first which may be the wrong element even though the
> LLM picked the correct candidate.

— and then caches that selector anyway, at reduced confidence (`0.50`). Reduced
confidence does not help: L1 Redis returns the row regardless, and L2
`db_exact` only filters on `confidence_score > 0.4`, so `0.50` passes.

## Goal

When the LLM-picked element is correctly identified but its stable selector is
ambiguous on the page, **never** cache the ambiguous selector. Instead:

1. **Try to find a unique stable selector** for the same element by walking the
   DOM pruner's `selectorCandidates` (already ordered most-stable to
   least-stable) and picking the first one whose Playwright count is exactly 1.
   Cache *that* selector — same element, future runs skip the LLM correctly.

2. **If no unique stable selector exists**, do not cache anything for this
   step. The next run pays for one more LLM call; correctness is preserved.

Execution behavior is unchanged: the run that detects ambiguity continues to
use `[data-kaizen-id='…']` for *this* execution. Only the cache write changes.

## Non-goals

- Composite selectors (`form[aria-label="Signup"] >> role=textbox[…]`). Cheap
  and correct in some cases but requires the resolver to reason about parent
  context the pruner doesn't always supply. Out of scope.
- `nth=` indices. Brittle under DOM reorder; not a "stable selector" by any
  honest definition.
- Element-embedding (L2.5) cache writes. Element embedding is keyed by the
  candidate's *semantic identity*, not the stable selector, so the same fix
  flows through naturally — when no unique selector is cacheable, no row is
  written, and the element-embedding column on that row also doesn't exist.

## Design

In [src/modules/element-resolver/llm.element-resolver.ts](../../../src/modules/element-resolver/llm.element-resolver.ts),
inside the ambiguity branch at lines 244–259:

```ts
if (validSelectors.length > 0 && llmResult.llmPickedKaizenId) {
  const isUnique = await this.isSelectorUnique(validSelectors[0].selector, page);
  if (!isUnique) {
    const kzSelector = `[data-kaizen-id='${llmResult.llmPickedKaizenId}']`;
    const handle = await page.$(kzSelector);
    if (handle !== null) {
      this.observability.increment('resolver.ambiguous_selector_kz_fallback');

      // NEW — try to find a unique stable selector for this element among
      // the candidate's pre-generated selectorCandidates.
      const pickedCandidate = candidates.find((c) => c.kaizenId === llmResult.llmPickedKaizenId);
      const uniqueStable = pickedCandidate
        ? await this.firstUniqueStableSelector(pickedCandidate, page)
        : null;

      if (uniqueStable) {
        cacheSelectors = [uniqueStable];                          // cache the disambiguated one
        this.observability.increment('resolver.ambiguous_selector_disambiguated');
      } else {
        cacheSelectors = null;                                    // skip cache write entirely
        this.observability.increment('resolver.ambiguous_selector_uncacheable');
      }

      validSelectors = [{ selector: kzSelector, strategy: 'css', confidence: 1.0 }];
    }
  }
}
```

Add private helper:

```ts
private async firstUniqueStableSelector(
  candidate: CandidateNode,
  page: PlaywrightPageLike,
): Promise<SelectorEntry | null> {
  for (const sel of candidate.selectorCandidates ?? []) {
    // Skip data-kaizen-id — session-scoped and never cacheable.
    if (sel.selector.includes('data-kaizen-id')) continue;
    try {
      const handles = await page.$$(sel.selector);
      if (handles.length === 1) return sel;
    } catch {
      // selector malformed; try the next one
    }
  }
  return null;
}
```

Update the cache-write branch (lines 319–326) so `cacheSelectors === null`
short-circuits the write:

```ts
if (!sessionOnly) {
  const setToCache = cacheSelectors === null
    ? null
    : (cacheSelectors
        ? { ...selectorSet, selectors: cacheSelectors }
        : selectorSet);
  if (setToCache && setToCache.selectors.length > 0) {
    void this.persistToCache(step, context, setToCache, candidates);
  }
}
```

## Why this is the right fix (and not the simpler "don't cache" one)

Rejected: **always skip the cache when the top selector is ambiguous.** Correct
but pessimistic — every page where the AX name is duplicated burns one LLM
call per run forever, even when the candidate has a perfectly unique
`#signup-email` id sitting in `selectorCandidates`. The DOM pruner already
generated those alternatives; using them is free.

Accepted: **walk `selectorCandidates`, prefer a unique one, fall back to no
write.** Best of both: cacheable when there's a clean alternative,
honest-failure when there isn't.

## Test plan

Unit tests in `__tests__/llm.element-resolver.test.ts`:

1. **Ambiguous top selector, candidate has a unique stable alternative** —
   asserts the cached selector is the unique alternative, not the ambiguous
   one; execution still uses the kz-id selector.
2. **Ambiguous top selector, no unique alternative** — asserts no cache write
   occurs; `resolver.ambiguous_selector_uncacheable` increments; execution
   still uses the kz-id selector.
3. **Unambiguous top selector** — asserts existing behavior (cache the stable
   selector) is unchanged.

Manual repro after fix:
- Truncate `selector_cache`, `archetype_failures`, `compiled_ast_cache`,
  `step_results`. Flush Redis.
- Run "under signup type … in signup-email" three times.
- Run 1: L0 archetype, mark fail.
- Run 2: LLM, correct selector. Inspect `selector_cache` row — its
  `selectors[0].selector` must NOT be `role=textbox[name="Email Address"]`.
  Either it's a unique stable selector (e.g. `#signup-email`) or no row was
  written.
- Run 3: either L2 hit on a unique selector (correct), or another LLM call
  (correct). Never the ambiguous one.

## Observability

New counters:
- `resolver.ambiguous_selector_disambiguated` — found a unique stable
  alternative; cached it.
- `resolver.ambiguous_selector_uncacheable` — no unique alternative; skipped
  cache write.

The existing `resolver.ambiguous_selector_kz_fallback` continues to fire on
every ambiguity event (it tracks the execution-time swap, independent of the
cache decision).

## Migration / rollback

No DB migration. No config flag. Pure-code change in one file plus tests.
Rollback = revert the commit.
