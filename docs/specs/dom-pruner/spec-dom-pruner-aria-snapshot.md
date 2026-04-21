# Spec: DOM Pruner — ariaSnapshot-Based Accessible Name Resolution

**Status:** Draft  
**Created:** 2026-04-17  
**Updated:** 2026-04-20 — Added whitespace-mismatch failure mode, evidence appendix, acceptance test; corrected Playwright version floor (1.49+ has `locator.ariaSnapshot`, not 1.59).  
**Branch:** fix/element-resolver/selector-cache-not-populated  
**Playwright requirement:** ≥ 1.49 (`locator.ariaSnapshot()` verified available on 1.58.2 in-tree)  
**Spec ref:** Playwright release notes — `locator.ariaSnapshot()` introduced for stable AX name/tree access

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

This produces three known failure modes:
- `input[type=submit]` buttons lose their accessible name (void element, no `innerText`;
  worked around in the evaluate() block by reading the `value` attribute).
- Elements whose label comes from `::before`/`::after` content get an empty name and
  never match an archetype or generate a valid ARIA selector.
- **Whitespace mismatch (added 2026-04-20):** the pruner calls `.trim()` on `innerText`,
  but Playwright's AX engine preserves leading/trailing whitespace introduced by inline
  siblings (e.g. a Font Awesome `<i>` icon followed by a space and the label). On a page
  with multiple candidates of the same role, Playwright's `role=X[name="Y"]` engine
  requires exact AX-name match and returns 0 hits when the stored name is trimmed.
  The LLM resolver then falls back to `data-kaizen-id` (session-only, never cached),
  silently paying LLM tokens every run.

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

---

## Acceptance Tests (added 2026-04-20)

### AT-1: Leading-whitespace parity
Given a page with `<a href="/login"><i class="fa"></i> Signup / Login</a>`:
- `candidate.name` stored by the pruner MUST equal `" Signup / Login"` (leading space
  preserved to match Playwright's AX output), OR the pruner MUST normalize AND drive
  the LLM prompt+cache through the same canonical form so that
  `page.locator(\`role=\${candidate.role}[name="\${candidate.name}"]\`).count() >= 1`
  for every emitted candidate with a non-empty name.
- This assertion MUST run on a fixture page that has ≥ 2 anchors sharing the role so
  Playwright's disambiguation path is exercised.

### AT-2: Trailing whitespace
Same as AT-1 with `<a>Edit Profile  </a>` (trailing double-space).

### AT-3: Pseudo-element name
`<button class="close"></button>` where `::before { content: "×"; }`. Pruner MUST NOT
emit an empty name when Playwright reports `× Close` via ariaSnapshot.

### AT-4: Submit input keeps existing workaround
Existing `value`-based fallback must still produce a valid name when ariaSnapshot fails
or is unavailable (regression guard on the current workaround).

---

## Evidence Appendix (2026-04-20)

Diagnostic log captured from the automationexercise.com repro that motivated the
amendment:

```
event: resolver.all_selectors_invalidated
pickedKaizenId: "kz-5"
attempted:    [{ selector: 'role=link[name="Signup / Login"]', locatorCount: 0 }]
prunerCandidate: { role: "link", name: "Signup / Login" }             ← trimmed
probes:
  exact:            0
  caseInsensitive:  0
  roleOnly:         60
  ariaSnapshot:     '- link " Signup / Login":\n  - /url: /login'     ← Playwright keeps leading space
  element:
    tag: "a"
    attrs: { href: "/login", data-kaizen-id: "kz-5" }
    innerText:   " Signup / Login"
    textContent: " Signup / Login"
    ariaHidden: false
    hiddenByCss: false
```

Key observations:
1. Pruner name differs from AX name by exactly one leading space.
2. `role=link[name="..."]` with the trimmed form returns 0 on a page with 60 links;
   Playwright's engine requires exact AX-name match when disambiguating.
3. Element is rendered, visible, not aria-hidden — rules out visibility/iframe theories.

This evidence supplies the fixture content for AT-1 and pins the regex used to parse
ariaSnapshot output in implementation step 2.

