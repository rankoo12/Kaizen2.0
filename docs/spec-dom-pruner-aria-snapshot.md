# Spec: DOM Pruner — ariaSnapshot-Based Accessible Name Resolution

**Status:** Draft  
**Branch:** feat/dom-pruner/aria-snapshot (to be created after L0 merges)  
**Playwright requirement:** ≥ 1.59  
**Spec ref:** Playwright 1.59 release notes — `locator.ariaSnapshot()` + `page.ariaSnapshot()`

---

## Problem

`PlaywrightDOMPruner` computes accessible names in two phases:

1. **evaluate()** — runs in-browser JS to derive names from `aria-label`, `<label for>`,
   wrapping `<label>`, `placeholder`, `title`, and `innerText`. Mostly correct but misses
   names derived from CSS pseudo-element content (Font Awesome icons, `::before`/`::after`
   text) because those are not in the DOM.

2. **per-element `page.accessibility.snapshot({ root: handle })`** — patches names using
   Playwright's AX tree, which computes the browser's full accessible name algorithm
   including pseudo-element content. **Removed in Playwright 1.49.1.** The call is silently
   skipped; the evaluate()-computed name is always used as-is.

This produces two known failure modes:
- `input[type=submit]` buttons lose their accessible name (void element, no `innerText`;
  worked around in the evaluate() block by reading the `value` attribute).
- Elements whose label comes from `::before`/`::after` content get an empty name and
  never match an archetype or generate a valid ARIA selector.

---

## Solution

Replace the deprecated `page.accessibility.snapshot` patch with `locator.ariaSnapshot()`
introduced in Playwright 1.59. This API is explicitly supported, stable, and returns the
browser's authoritative AX name for any locator.

### Design choices

Two implementation strategies are available:

#### Option A — Per-element ariaSnapshot (recommended for v1)

For each evaluate() candidate, call `locator.ariaSnapshot()` on its kaizen-id locator and
parse the accessible name from the YAML output.

```typescript
// After the evaluate() block, replace the page.accessibility.snapshot loop with:
for (const raw of rawCandidates) {
  try {
    const snapshot = await pwPage
      .locator(`[data-kaizen-id='${raw.kaizenId}']`)
      .ariaSnapshot();
    // snapshot = `- button "Sign in"\n` or `- textbox "Email"` etc.
    const match = snapshot.match(/- \w[\w\s]*\s+"([^"]+)"/);
    if (match?.[1]) raw.accessibleName = match[1];
  } catch { /* keep evaluate()-computed name as fallback */ }
}
```

**Pros:** Direct drop-in replacement for the deprecated API. Same per-element granularity.  
**Cons:** N round-trips to the browser (one per candidate). For a page with 40 candidates
this is ~40 sequential calls. Acceptable because the evaluate() batch already injected
kaizen-ids and we iterate once.

#### Option B — Single page-level ariaSnapshot (future optimisation)

Take one `page.locator('body').ariaSnapshot({ depth: 50, mode: 'raw' })` call and parse
the returned YAML to build a `(role, name)` lookup, then cross-reference with evaluate()
results by DOM order.

**Pros:** 1 browser call total regardless of candidate count.  
**Cons:** Matching the flat evaluate() array to snapshot positions is fragile when
elements share the same role (e.g. ten `button` nodes). Requires a stable ordering
guarantee. Defer to v2 once the per-element approach is validated.

---

## Implementation Plan

### 1. Version gate

Add a one-time check on startup (or lazy on first prune) that Playwright ≥ 1.59 is
available. If not, fall back to the evaluate()-only path and log a warning.

```typescript
// In PlaywrightDOMPruner.prune():
const supportsAriaSnapshot = typeof pwPage.locator === 'function' &&
  typeof pwPage.locator('body').ariaSnapshot === 'function';
```

### 2. Replace the AX patch block

Current code (lines ~211–224 in playwright.dom-pruner.ts):

```typescript
// ── Patch accessible names using Playwright's own AX tree ─────────────────────
const axPage = pwPage as any;
if (axPage.accessibility?.snapshot) {
  for (const raw of rawCandidates) {
    try {
      const handle = await pwPage.$(`[data-kaizen-id='${raw.kaizenId}']`);
      if (handle) {
        const snapshot = await axPage.accessibility.snapshot({ root: handle });
        if (snapshot?.name) {
          raw.accessibleName = snapshot.name;
        }
      }
    } catch { /* keep the evaluate()-computed name as fallback */ }
  }
}
```

Replace with:

```typescript
// ── Patch accessible names using locator.ariaSnapshot() (Playwright ≥ 1.59) ──
if (supportsAriaSnapshot) {
  for (const raw of rawCandidates) {
    try {
      const snapshot = await pwPage
        .locator(`[data-kaizen-id='${raw.kaizenId}']`)
        .ariaSnapshot();
      // YAML format: `- button "Sign in"\n` or `- textbox "Enter your email"\n`
      // The name is always in double-quotes after the role token.
      const nameMatch = snapshot.match(/- \w[\w\s-]*\s+"((?:[^"\\]|\\.)*)"/);
      if (nameMatch?.[1]) {
        raw.accessibleName = nameMatch[1].replace(/\\"/g, '"');
      }
    } catch { /* keep evaluate()-computed name */ }
  }
}
```

### 3. Update playwright package

```bash
npm install playwright@^1.59.0
```

Verify `package.json` lists `"playwright": "^1.59.0"`.

### 4. Remove the `input[type=submit]` workaround?

The workaround (reading `value` attribute for submit inputs) was added because the AX
patch was silently skipped. With ariaSnapshot working again, Playwright's own AX
computation will handle submit inputs correctly. **Keep the workaround anyway** — it is
a correct computation and a cheap fallback that also helps when ariaSnapshot fails.

### 5. Tests

Update `playwright.dom-pruner.test.ts` (or create it if absent):
- Mock `locator.ariaSnapshot()` returning valid YAML for a standard button and a
  submit input — assert the accessible name is taken from the snapshot.
- Mock `locator.ariaSnapshot()` throwing — assert evaluate()-computed name is preserved.
- Assert the `supportsAriaSnapshot` fallback path works when the method is absent on the
  locator (Playwright < 1.59).

---

## Affected Files

| File | Change |
|---|---|
| `src/modules/dom-pruner/playwright.dom-pruner.ts` | Replace AX patch block (~12 lines) |
| `src/modules/dom-pruner/__tests__/playwright.dom-pruner.test.ts` | Add/update tests |
| `package.json` | Bump `playwright` to `^1.59.0` |

---

## Observability

Emit an increment on each ariaSnapshot call:

```typescript
this.observability.increment('dom_pruner.aria_snapshot_patched');   // name updated
this.observability.increment('dom_pruner.aria_snapshot_fallback');  // exception, kept evaluate() name
```

---

## Known Risks

- **YAML format change:** Playwright could change the ariaSnapshot YAML schema in a
  future minor. The regex `- ROLE "NAME"` is documented behaviour; treat as stable but
  pin the regex in a unit test so breakage is caught immediately.
- **Performance:** 40 sequential locator calls add ~100–400 ms on a dense page. Acceptable
  for self-healing (not a hot path). If profiling shows it dominates, switch to Option B.
