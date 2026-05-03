# Spec: Empty Accessible Name Disambiguation

Created: 2026-04-30
Updated: 2026-04-30

## 1. Reproduction

Step: `under signup type 12345 in zipcode`.
Page: `https://automationexercise.com/signup` (after the initial email/name
step lands on the address-details form).

Resolver picks the **wrong** element via `pgvector_element` cache:

```
role=textbox[name="City * Zipcode *"]
via pgvector_element
```

The 17 LLM candidates included these two adjacent rows:

```
[kz-27] textbox: "City * Zipcode *"   ← wrong; matched by the LLM
   role=textbox[name="City * Zipcode *"]
[kz-28] textbox: ""                   ← right; ignored by the LLM
   #zipcode
```

The actual zipcode input on the page is:

```html
<input type="text" data-qa="zipcode" class="form-control" required=""
       name="zipcode" id="zipcode" value="">
```

## 2. Diagnosis

Two independent problems combine to produce the wrong pick.

### 2.1 The page has a shared / mis-associated label

The form's "City" + "Zipcode" inputs share the same form group. The
`<label>` element associated with one of the inputs (city) has the visible
text `"City * Zipcode *"` because the page designer used a single label
across two columns, OR the label's `for=` only covers one of the two
inputs. The result is one input with a misleadingly-merged accessible
name and the other with an empty accessible name (no associated label).

This part of the bug is **outside Kaizen's control** — we receive whatever
the page authored.

### 2.2 The LLM prompt drops every distinguishing attribute when the name is empty

[`src/modules/llm-gateway/openai.gateway.ts`](src/modules/llm-gateway/openai.gateway.ts)
lines 179-186 construct one prompt line per candidate:

```ts
const displayName = c.name || c.textContent || c.attributes['placeholder'] || '';
return `[${c.kaizenId}] ${c.role}: "${displayName}"${contextSuffix}`;
```

For the zipcode input:

- `c.name` = `""`
- `c.textContent` = `""` (`<input>` has no inner text)
- `c.attributes['placeholder']` = (none on this page)

So `displayName` is `""` and the line becomes `[kz-28] textbox: ""`.

The candidate's `attributes` object DOES contain
`{ id: "zipcode", name: "zipcode", "data-qa": "zipcode", type: "text" }`,
but **none of that information makes it into the prompt**. The LLM has no
basis to pick kz-28 over kz-27 — kz-27 at least has the substring "Zipcode"
in its visible name.

This is the actual fixable bug. With the right attribute hints in the
prompt the LLM consistently picks `kz-28`.

## 3. Fix

### 3.1 LLM gateway — fall through to identifier attributes when display name is empty

When `displayName` would be empty, append a compact `attrs:` clause built
from the most-stable identifier attributes in priority order:

1. `data-qa`
2. `data-testid`
3. `data-test`
4. `id`
5. `name`

Only the **first present** attribute is rendered, prefixed with its key,
to keep the prompt compact and unambiguous. Empty-named candidates with
no attributes either still render as `""` (truly opaque elements that the
LLM cannot disambiguate without DOM inspection — those will need a
separate fix later, e.g. visible-text from siblings).

Example output for the bug repro:

```
[kz-27] textbox: "City * Zipcode *"
[kz-28] textbox  (data-qa: "zipcode")
[kz-29] textbox: "Mobile Number *"
```

The LLM now sees `data-qa: "zipcode"` and reliably picks `kz-28`.

### 3.2 DOM pruner — guard the wrapping-label clone (defensive)

A wrapping-label fallback at
[`playwright.dom-pruner.ts`](src/modules/dom-pruner/playwright.dom-pruner.ts)
lines 119-128 currently does:

```ts
const wrappingLabel = el.closest('label');
if (wrappingLabel) {
  const clone = wrappingLabel.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('input, textarea, select').forEach((n) => n.remove());
  accessibleName = (clone.textContent || '').trim().replace(/\s+/g, ' ');
}
```

If a single `<label>` wraps multiple inputs (defensive case — not the
current automationexercise bug, but a closely-related one I want to
prevent), every wrapped input gets the *combined* visible text as its
name. The fix:

- If the wrapping label contains **more than one** form control
  (`input`, `textarea`, `select`), **skip** the wrapping-label assignment.
  The input's own `id` / `name` / placeholder fallback path handles it
  without merging.

- Mark the element via a `data-kaizen-wrapping-label-skipped="N"` attribute
  (where N is the input count) so debugging via DevTools / trace can spot
  the case. A proper observability counter is deferred — `PlaywrightDOMPruner`
  doesn't currently take an observability dep and threading one through is a
  separate concern.

### 3.3 Observability

One new metric on the LLM gateway side:

- `llm.candidate_empty_name` — increment when a candidate would be rendered
  with an empty `""` after the new attribute-fallback runs. Tracks how
  often the LLM is asked to disambiguate a truly opaque element.

DOM-pruner side: marker attribute (`data-kaizen-wrapping-label-skipped`)
only — no metric, see §3.2.

## 4. Non-goals

- **No semantic enrichment of empty-name candidates.** Walking siblings to
  synthesize a name from nearby text is brittle and out of scope. The
  attribute fallback covers the common case (every input with a `data-qa`
  or `id`).
- **No backfill of mis-cached entries.** The user already has a
  `selector_cache` row pointing at `role=textbox[name="City * Zipcode *"]`
  for the zipcode step. That's a verdict-purge concern — the existing
  archetype-verdict-cooldown spec covers it. Out of scope here.
- **No backend API change** to `/runs/:id`. The fix is gateway-internal.

## 5. Affected files

| File | Change |
|---|---|
| `src/modules/llm-gateway/openai.gateway.ts` | New prompt-line builder; fallback attrs clause |
| `src/modules/llm-gateway/__tests__/openai.gateway.test.ts` | New test cases for empty-name + attrs |
| `src/modules/dom-pruner/playwright.dom-pruner.ts` | Wrapping-label multi-input guard |
| `src/modules/dom-pruner/__tests__/playwright.dom-pruner.test.ts` | New test for the guard |

## 6. Test plan

### 6.1 Unit tests

LLM gateway:

1. Empty-name candidate with `data-qa` → prompt line contains
   `(data-qa: "zipcode")`.
2. Empty-name candidate with no identifier attributes → renders as `""`
   (current behaviour preserved as last-resort).
3. Non-empty name candidate → no `attrs:` clause is appended (preserves
   the compact prompt for the common case).
4. Fallback priority: `data-qa` > `data-testid` > `data-test` > `id` >
   `name` — only the first present attribute appears.

DOM pruner:

5. Wrapping label with one input → existing behaviour preserved
   (regression guard).
6. Wrapping label with two inputs → both inputs get empty
   `accessibleName` and `wrapping_label_skipped` metric fires.

### 6.2 Manual verification

- Truncate caches (`scripts/truncate-caches.ts`).
- Run the test from §1 against `automationexercise.com/signup`.
- Step "type 12345 in zipcode" should resolve via LLM → `#zipcode`
  selector → cache write of `#zipcode`.
- Re-run the test. Step should hit cache and resolve `#zipcode` directly.
- The wrong cached entry from §1 will still exist for older steps; this
  spec doesn't try to repair that.

## 7. Risks

- **Prompt drift on cache key.** The LLM prompt is part of an LLM-dedup
  cache key (`llm:dedup:{targetHash}:{sha256}`). Changing the prompt
  format invalidates the cache once on the next run and burns one extra
  LLM call per step. Acceptable — one-time cost and forces fresh-pick
  resolution on pages where the old prompt was insufficient.
- **Attribute leakage into prompt.** `data-qa`, `data-testid`, `id`,
  `name` are routinely PR-reviewable HTML; they shouldn't carry secrets.
  No new privacy surface.
- **Empty-name floor.** Some elements are still impossible to
  disambiguate (e.g. icon-only buttons with no aria-label, no data-* and
  no text). Those will show as `""` and the LLM may guess. Tracked via
  `llm.candidate_empty_name` so we can decide when to invest in a richer
  fallback (sibling text, ancestor heading, etc.).
