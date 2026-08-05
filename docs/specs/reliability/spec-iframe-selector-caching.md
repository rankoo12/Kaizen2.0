# Spec: iframe-resolved elements never reach the cache

Created: 2026-08-05

Backlog item **B9** in [spec-feature-backlog.md](../roadmap/spec-feature-backlog.md).
Sibling of [spec-assertion-selector-caching.md](./spec-assertion-selector-caching.md) (B19) —
the same defect shape in a different resolution path.

---

## 1. The defect

An element the LLM picks inside a child frame — overwhelmingly a cookie-consent CMP — is
resolved by `LLMElementResolver.resolveInFrame` and **returned early**:

```ts
// llm.element-resolver.ts:199
if (pickedFrameCand?.frameUrl) {
  const frameSet = await this.resolveInFrame(...);
  if (frameSet) return frameSet;          // ← returns 235 lines above persistToCache
}
```

`persistToCache` is called at line 434. Nothing between line 201 and line 434 runs for a
frame-resolved element, so **no `selector_cache` row is ever written**. Every run pays the
model again to dismiss the same consent banner.

This is the last known permanent floor under the cost curve. B19 removed the assertion
floor; this is the other one.

### Why it was written that way

The code says so, at [types/index.ts:132](../../../src/types/index.ts):

> such elements are session-only and never cached (frame URLs carry per-session tokens)

That reasoning is **correct about the URL and wrong about the element**. A CMP iframe's
`src` genuinely does carry per-session state:

```
https://cdn.privacy-mgmt.com/index.html?message_id=104&consentUUID=8f3c…&_sp=…
```

Caching *that* string would produce an entry that never matches again. But the element
inside it — `button[title="Yes, I'm happy"]` — is as stable as any other selector on the
page. The URL was the problem; the conclusion "therefore cache nothing" threw out the
element with it.

---

## 2. What identifies a frame durably

Strip the query and hash. What remains is the CMP's actual identity:

| | |
|---|---|
| live URL | `https://cdn.privacy-mgmt.com/index.html?consentUUID=8f3c…&_sp=…` |
| **stored** | `https://cdn.privacy-mgmt.com/index.html` |

`origin + pathname` survives across sessions, and it is also the better thing to *show* a
user — "inside `cdn.privacy-mgmt.com/index.html`" reads as provenance, where the raw URL
reads as noise. One representation serves the cache and the UI.

Frames with no stable identity — `about:blank`, `about:srcdoc`, a `data:` URL — are **not
cacheable**. They keep today's session-only behaviour rather than get a fingerprint that
cannot be relied on.

---

## 3. The hazard this must not create

A frame-scoped selector that runs against the **top document** is worse than a cache miss.

`button[title="Yes, I'm happy"]` does not exist in the main document, so it would resolve
to nothing and the step would fail — on a site where nothing is broken. Today the
execution engine falls back to the page when it cannot find the frame:

```ts
// playwright.execution-engine.ts:157
if (frame) execCtx = frame;   // ...and silently stays on the page when it doesn't
```

That fallback is safe for a set resolved *this run* (the frame was there a moment ago).
It is not safe for a set read back from cache days later.

**Rule: a cached entry carrying a `frameUrl` is only a hit if the frame is present now
and the selector resolves inside it. Otherwise it is a miss** and resolution escalates
normally. A miss costs one LLM call; a false hit costs a red run on a healthy site.

---

## 4. Design

### 4.1 Storage — migration 032

```sql
ALTER TABLE selector_cache ADD COLUMN IF NOT EXISTS frame_url TEXT;
ALTER TABLE step_results   ADD COLUMN IF NOT EXISTS frame_url TEXT;
```

Both nullable, both additive, safe to apply under a live stack. NULL means "main
document", which is what every existing row is.

`selector_cache.frame_url` stores the canonical `origin + pathname`.
`step_results.frame_url` records where the element was found for this run — the provenance
half of B9, which the design promised as "Inside frame `iframe#consent`".

### 4.2 Write — `resolveInFrame` persists

The frame path gains the same cache discipline the page path already has:

1. Prefer a **stable** in-frame selector (the LLM's own, then the pruner's candidates).
2. If the only thing that resolves is the session-scoped `data-kaizen-id`, **synthesize a
   structural selector inside the frame** — the exact move that fixed B19, applied to a
   frame. `synthesizeUniqueSelector` operates through `locator()`/`$$`, both of which a
   Playwright `Frame` implements, and its browser closure walks `el.ownerDocument`, which
   inside a frame is the frame's document. It works unchanged.
3. Persist only when the winner is stable and the frame is canonicalizable.
4. Never persist a `data-kaizen-id`, in a frame or out of one.

Execution still uses whatever selector actually worked this run; the cache stores the
replayable one.

### 4.3 Read — every tier carries the frame through

`selectors` and `frame_url` are read together from Postgres (L2/L3/L4) and travel together
in the Redis payload, which goes to **v3**. v1 and v2 payloads keep parsing (a v2 entry
simply has no frame, which is true of every entry written before this change).

### 4.4 The guard

Before returning any cached hit with a `frameUrl`, `CachedElementResolver` confirms:

- a frame whose canonical URL equals the stored one exists on the page **now**, and
- the first cached selector matches ≥1 element **inside that frame**.

Either check failing returns `MISS`. The check is one `locator().count()` against a live
frame — microseconds against the ~1s LLM call it replaces, and it only runs for the small
minority of entries that have a frame at all.

### 4.5 Execution

`playwright.execution-engine.ts` matches a frame by exact URL first, then by canonical
URL. Exact keeps same-run behaviour byte-identical; canonical is what a cached entry
carries. Shared with the resolver as one helper so the two cannot drift — a resolver that
validated one frame while the engine acted on another would be a silent wrong-element bug.

---

## 5. What this does not change

- **Non-frame resolution is untouched.** Every code path where `frameUrl` is undefined
  behaves exactly as before, including the Redis payload it reads.
- **Shared-pool contribution stays off for frame entries.** A consent banner is
  tenant-specific enough (locale, A/B bucket, CMP version) that promoting it to the global
  brain would export a guess. Revisit with evidence, not by default.
- **Nothing is backfilled.** No historical row records which frame it came from.

---

## 6. Acceptance

1. A test whose first step dismisses a consent banner in a CMP iframe: **run 1 resolves
   `llm` and pays tokens; run 2 resolves from cache and pays zero**, on a real site.
2. `selector_cache` holds exactly one row for that step, with a canonical `frame_url` and
   a selector that is not a `data-kaizen-id`.
3. Deleting the frame from the page (or pointing the entry at a frame that no longer
   exists) produces a **miss and a fresh resolution**, never a page-scoped execution of a
   frame-scoped selector.
4. The run screen names the frame the element was found in.
5. `npm run typecheck`, `npm run typecheck:web`, `npm run lint`, full unit suite green.
