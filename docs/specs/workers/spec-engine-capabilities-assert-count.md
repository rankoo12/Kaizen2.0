# Spec — Engine Capability: `assert_count`

Created: 2026-07-27
Updated: 2026-07-27

## 1. Intent

Let a natural-language step assert **how many** repeated things are on the page:

- "verify there are 5 products"
- "there should be at least 3 search results"
- "confirm no more than 4 rows are shown"
- "the cart has 2 items"

The hard requirement, inherited from the QA-parity work: **never false-pass.** A count
assertion must fail loudly when the system cannot confidently identify what to count —
a wrong count that happens to equal N is the one outcome we refuse to produce. This is
why `assert_count` does **not** build on `random-target.ts` `selectorsForTarget`, whose
selectors are hardcoded to nopCommerce/demowebshop and would miscount silently on any
other site.

## 2. Compilation (`llm-gateway/openai.gateway.ts`)

`assert_count` is added to the action union. Rule:

- **targetDescription** = the plural thing being counted, keeping its distinguishing
  noun (`"products"`, `"search results"`, `"rows"`, `"cart items"`).
- **value** = the expected number, with an optional comparison prefix encoding inexact
  phrasing:

  | Phrasing | value |
  |---|---|
  | "exactly N", "N items", "there are N" | `N` |
  | "at least N", "N or more", "minimum N" | `>=N` |
  | "more than N", "over N" | `>N` |
  | "at most N", "no more than N", "up to N" | `<=N` |
  | "fewer than N", "less than N", "under N" | `<N` |

## 3. Counting primitive (`element-resolver/countable.ts`)

`resolveCountSelector(page, target)` returns `{ selector, count, method } | null`.

Decision logic is **pure and unit-tested** (`matchRole`, `countNounStems`,
`pickCountable`); only the raw DOM walk (`GATHER_FN`) runs in-browser.

Two strategies, tried in this order:

1. **Semantic role sweep** — for native countable kinds (`rows`, `cells`, `list items`,
   `links`, `buttons`, `images`, `headings`, `checkboxes`, `radios`, `options`, `tabs`,
   `paragraphs`). Counts visible matches of a role/tag CSS selector. Preferred when the
   target names a native kind so a **class coincidence can't win** — "rows" must count
   `<tr>`, not Bootstrap `.row` divs.
2. **Grounded repeated group** — sets of sibling elements sharing a `tag+class`
   signature, with **≥2 visible members**, whose class/id/container/**descendant class
   tokens**/first-item-text contains a noun stem from the target. Scoped to an actual list
   (e.g. `<li class="col-md-3">` wrapping `<article class="product_pod">` grounds
   "products" via the descendant class). Largest grounded group wins.

If neither is confident → return `null`.

Each candidate's visible members are tagged with their own `data-kzc-<token>` attribute
(distinct per candidate, so overlapping role/group membership never clobbers another
candidate's marker). The returned selector is `[data-kzc-<token>]`, which the engine
re-counts — visible-only and deterministic.

## 4. Worker routing (`workers/worker.ts`)

`assert_count` bypasses the single-element resolver chain (which returns one `#id` and
would count 1). It calls `resolveCountSelector` directly against the live page. On `null`
it hands the engine an **empty** selector set → the engine fails loudly. `assert_count`
stays in `ASSERTION_ACTIONS` (never cached; re-counted every run).

## 5. Execution (`execution-engine/playwright.execution-engine.ts`)

`executeAssertCount` runs before the generic no-selectors guard so the failure names the
target:

- Parse `value` → operator (`==` default, `>=`, `>`, `<=`, `<`) + expected integer.
  Non-numeric → **`AssertCountBadValue`**.
- Empty selector set → **`CountTargetUnresolved`** ("could not identify a countable
  group … Refusing to pass on a guess.").
- Otherwise `actual = page.locator(selector).count()`, compare, and on mismatch fail with
  **`AssertCountFailed`** ("expected `<op> N` \"target\", found `actual`.").

## 6. Known limitations

- **No sub-scope** — "5 links in the footer" counts all visible links on the page. This
  fails loudly (over-count), never false-passes. Sub-scoping is future work.
- **Ambiguous grounded groups** — when multiple grounded groups relate to the noun (e.g. a
  main grid + a "related" carousel), the largest wins. Logged via
  `engine.assert_count_check`. If dogfood surfaces a false pass here, tighten to
  fail-on-ambiguous.
- **No synonym resolution** — grounding is literal: the target stem must appear in the
  group's class/id/text. "books" on a site whose markup says `product_pod` refuses
  (fails loud), never counts the wrong thing. This is deliberate — a false-fail is
  acceptable; a false-pass is not.

## 8. Serialization note (do not regress)

`GATHER_FN` runs in the page via `page.$eval` and contains **no named inner functions**.
Under `tsx`/esbuild `keepNames`, `const f = () => …` becomes `__name(() => …, 'f')`, and
Playwright serializes only the function body — so `__name` must exist in the page. The
worker injects a `__name` identity shim (`worker.ts` `addInitScript`), which is what lets
`random-target.ts`'s named-helper closures run under tsx. This closure is deliberately
kept **shim-independent** (anonymous inline arrows only) so it also works when driven from
a context that doesn't inject the shim — e.g. a standalone Playwright harness, which is
exactly how it was live-verified via `npx tsx`.

## 7. Tests

- `element-resolver/__tests__/countable.test.ts` — `matchRole`, `countNounStems`,
  `pickCountable` (grounded > role, largest-grounded, role fallback, **refuse-when-
  ungrounded**), and the `resolveCountSelector` wrapper.
- `execution-engine/__tests__/playwright.execution-engine.test.ts` → `assert_count` —
  exact match, **off-by-one fails**, `>=`/`<=`, **unresolved → CountTargetUnresolved**,
  non-numeric → `AssertCountBadValue`.
- Live dogfood: prove the off-by-one FAILS on a real site, not just the happy path.
