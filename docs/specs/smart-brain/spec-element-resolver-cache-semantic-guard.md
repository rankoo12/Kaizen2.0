# Spec: Element Resolver — Cache Semantic Guard

**Status:** Draft
**Created:** 2026-04-24
**Updated:** 2026-04-24
**Branch:** `fix/element-resolver/cache-semantic-guard`
**Spec ref:** [spec-element-resolver-archetype-disambiguation.md](./spec-element-resolver-archetype-disambiguation.md) (sibling fix on L0)
**Depends on:**
- [src/modules/element-resolver/cached.element-resolver.ts](../../../src/modules/element-resolver/cached.element-resolver.ts)
- [src/modules/element-resolver/composite.element-resolver.ts](../../../src/modules/element-resolver/composite.element-resolver.ts)
- [src/modules/element-resolver/llm.element-resolver.ts](../../../src/modules/element-resolver/llm.element-resolver.ts)
- [src/types/index.ts](../../../src/types/index.ts)

---

## Problem

A cache hit at L1–L4 can return a selector that resolves to the **wrong element**, the click still succeeds (because the wrong selector points at a real DOM node), and every subsequent step runs against an irrelevant page. The run reports mostly-passed while the test never did what the user asked.

Real repro, 2026-04-24:

> **Step 7:** _"choose day 12"_
> **Resolution source:** `DB_EXACT` (L2)
> **Resolved selector:** `role=link[name=" Test Cases"]`
> **Outcome:** Playwright clicked a **Test Cases** link in the nav, which navigated the browser to an unrelated page. Steps 8..N then ran against that page — Playwright continued to "succeed" on whatever happened to match, burning LLM tokens on cache misses and still reporting `passed`. The test was broken from step 7 onward but the run looked mostly healthy.

### Why the existing safeguards didn't catch this

- **L0 archetype guard** only protects archetype hits; this was an L2 `db_exact` row.
- **Live-DOM validation** already exists at L0 (`handle !== null`) and could exist at L1–L4. But the `Test Cases` link **does** exist in the DOM. The selector validates. The check only asserts "something matches" — not "something relevant matches."
- **targetHash uniqueness** — the `selector_cache` row is keyed on SHA-256(action + ':' + targetDescription). A stale/poisoned row for `click:choose day 12` pointing at the wrong selector sits in cache indefinitely because nothing proves it's wrong until the user notices mid-test.
- **User "fail" verdict** fixes the problem _after_ the run completes (we already evict selector_cache, Redis, compiled_ast_cache, archetype_failures). It cannot help the run that's currently burning tokens.

### Why this is different from the archetype disambiguation fix

Archetype disambiguation (S1–S5 on the sibling branch) guarded against picking the wrong _candidate_ at L0. This bug is a layer deeper: the cache returns a complete selector string that the execution engine trusts unconditionally. There is no candidate list to rerank.

---

## Goal

Before accepting a cache hit, verify the selector's semantic fingerprint has **minimal vector agreement** with the step's intent vector. If it doesn't, reject the hit, invalidate the cache row, and let the chain fall through to the next layer (eventually L5 / LLM) so the run stays correct.

Not a goal: proving the cached selector is _perfect_. The LLM is the ground truth for semantic correctness; this guard is a cheap gate to reject obviously-wrong rows.

---

## Solution — Embedding-based guard using the vectors we already store

### Why use the existing vectors (Option C) rather than word-overlap or a new embedding call

The `selector_cache` table already stores two vectors per row, written by `LLMElementResolver.writeCacheRow`:
- `step_embedding` — embedding of `"${action} ${targetDescription}"` (the intent that produced this row)
- `element_embedding` — embedding of the resolved element's semantic identity (role + accessible name + URL path)

Today we use these only as **search keys** (L3/L4 cosine-similarity lookup; L2.5 element-embedding lookup inside `LLMElementResolver`). We never use them to **verify** a row we already found by some other key. The `Test Cases` / `day 12` bug is exactly that gap: L2 matched on `content_hash` equality and returned the row without ever looking at its vectors.

**What we compute and what's already free:**
- `T₁` (current step's intent vector) — **must be computed once per step**. `CachedElementResolver` already computes this for L3/L4 today (line 58 of `cached.element-resolver.ts`). We lift that computation up to `CompositeElementResolver` so L1/L2 can use it too without paying for a second embedding call.
- `T₂` (each candidate row's `step_embedding`) — **free**. Already stored on the row; just widen the SELECT to return it.

Total new cost: zero extra OpenAI embedding calls per step. We were already paying for T₁ whenever the chain reached L3; now we pay for it once per step regardless of which layer hits, and get a correctness guard in return.

**Why not word-overlap:** brittle on short descriptions (`click next` has one non-stopword token), duplicates logic that `extractTargetWords` already owns in the archetype resolver, and throws away the semantic signal we already embedded.

**Why not a fresh embedding per hit:** that was Option A — doubles our OpenAI spend on the happy path (every L1/L2 hit already means zero LLM cost today).

### S1 — Compute the step embedding once, in CompositeElementResolver

Add an optional field to `ResolutionContext`:

```ts
// src/types/index.ts
export type ResolutionContext = {
  tenantId: string;
  domain: string;
  page: unknown;
  pageUrl?: string;
  /**
   * Embedding of `"${step.action} ${step.targetDescription}"`, computed once
   * per step by CompositeElementResolver and reused by every cache layer
   * for semantic-guard verification and existing pgvector lookups.
   * Undefined when targetDescription is null (navigate/wait) — guard skipped.
   */
  stepEmbedding?: number[];
};
```

In `CompositeElementResolver.resolve`, compute it before entering the chain:

```ts
// Skip when there's nothing to embed — navigate/wait steps have no target.
const enrichedContext: ResolutionContext = step.targetDescription
  ? { ...context, stepEmbedding: await this.llmGateway.generateEmbedding(`${step.action} ${step.targetDescription}`) }
  : context;

for (const resolver of this.resolvers) {
  const result = await resolver.resolve(step, enrichedContext);
  if (result.selectors.length > 0) return result;
}
```

This requires `CompositeElementResolver` to hold a reference to `ILLMGateway` — a new constructor parameter. The DI wiring in `src/workers/worker.ts` / `src/api/app.ts` already has the gateway available at the point it constructs the composite.

Downstream effect: `CachedElementResolver.resolve` drops its own `generateEmbedding` call at line 58 and reads `context.stepEmbedding` instead. L1 and L2 gain access to the vector without paying for it.

### S2 — The guard function

```ts
// src/modules/element-resolver/cache-semantic-guard.ts (new)
export const SEMANTIC_GUARD_THRESHOLD = 0.80;

/**
 * Returns true when either stored vector on the cached row is close enough
 * (cosine similarity ≥ SEMANTIC_GUARD_THRESHOLD) to the current step's intent.
 *
 * We accept the hit if EITHER vector agrees, because:
 *  - step_embedding agreement means "past intent matched current intent"
 *  - element_embedding agreement means "element identity matches description"
 * These are complementary signals; requiring both would over-reject rows
 * written by slightly different phrasings of the same intent.
 */
export function semanticGuardPasses(
  stepEmbedding: number[] | undefined,
  rowStepEmbedding: number[] | null,
  rowElementEmbedding: number[] | null,
): { passed: boolean; bestSimilarity: number | null } {
  if (!stepEmbedding) return { passed: true, bestSimilarity: null }; // can't evaluate
  if (!rowStepEmbedding && !rowElementEmbedding) return { passed: true, bestSimilarity: null }; // legacy row

  const a = rowStepEmbedding ? cosine(stepEmbedding, rowStepEmbedding) : -1;
  const b = rowElementEmbedding ? cosine(stepEmbedding, rowElementEmbedding) : -1;
  const best = Math.max(a, b);
  return { passed: best >= SEMANTIC_GUARD_THRESHOLD, bestSimilarity: best };
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
```

**Threshold choice:** `0.80`. Chosen empirically below L3/L4's search threshold (`0.95`) because:
- L3/L4 `0.95` is a **retrieval** threshold (pick the single best row from thousands). A guard asking "is this row not utterly wrong?" can safely be much looser.
- The bug case `"choose day 12"` vs `role=link[name=" Test Cases"]` has near-zero cosine — well under `0.80`, so easily caught.
- Legitimate paraphrases (`"click submit"` vs stored `"click the submit button"`) sit comfortably above `0.80`.
- Start at `0.80`, log `bestSimilarity` on every reject, tune once we have data.

### S3 — Widen the cache SELECTs and apply the guard

**L2 (`fetchByHash`):** SELECT must now return `step_embedding` and `element_embedding`. Call guard before returning. On reject: delete the row, invalidate Redis, return MISS.

```ts
private async fetchByHash(
  targetHash: string, domain: string, tenantId: string, stepEmbedding: number[] | undefined,
): Promise<SelectorSet | null> {
  const { rows } = await getPool().query<{ selectors: SelectorEntry[]; step_embedding: number[] | null; element_embedding: number[] | null }>(
    `SELECT selectors, step_embedding, element_embedding
     FROM selector_cache
     WHERE content_hash = $1 AND domain = $2 AND tenant_id = $3
       AND (pinned_at IS NOT NULL OR confidence_score > 0.4)
     ORDER BY pinned_at DESC NULLS LAST
     LIMIT 1`,
    [targetHash, domain, tenantId],
  );
  if (rows.length === 0) return null;

  const { passed, bestSimilarity } = semanticGuardPasses(stepEmbedding, rows[0].step_embedding, rows[0].element_embedding);
  if (!passed) {
    this.observability.increment('resolver.cache_semantic_reject', { source: 'db_exact' });
    this.observability.log('info', 'cache_resolver.semantic_reject', { source: 'db_exact', similarity: bestSimilarity, targetHash });
    await this.invalidateRow(targetHash, domain, tenantId);
    return null;
  }
  return { selectors: rows[0].selectors, fromCache: true, cacheSource: 'tenant', resolutionSource: 'db_exact', similarityScore: null };
}
```

**L3 / L4 (`vectorSearch`):** same treatment — widen SELECT, apply guard, reject on failure.

**L1 (Redis hit):** Redis stores only `selectors` (not vectors), so on a Redis hit we must fetch the row's vectors from Postgres before we can evaluate the guard. Two options:

1. **Store vectors alongside selectors in Redis** — changes the Redis payload shape; safe because Redis keys already namespace by tenant/target/domain.
2. **Fetch vectors from Postgres on Redis hit** — adds a DB roundtrip; negates the latency benefit of Redis.

Chosen: **option 1**. On cache write, persist `{ selectors, stepEmbedding, elementEmbedding }` to Redis. On read, parse and feed into the guard. Keeps L1 fast.

**L2.5 (`elementEmbeddingLookup` in `llm.element-resolver.ts`):** already embedding-based retrieval at `ELEMENT_EMBEDDING_THRESHOLD = 0.95`. No separate guard needed — the retrieval threshold already serves the same purpose. Skip.

### S4 — Reject scope

| Source | Guard applies? | Why |
|---|---|---|
| `redis` (L1) | **Yes** | Fast path; most-hit surface. Fetches vectors from Redis payload. |
| `db_exact` (L2) | **Yes** | The repro case. Primary target of this spec. |
| `pgvector_step` tenant (L3) | **Yes** | Retrieval threshold is 0.95 on step_embedding only; the element_embedding may still disagree strongly — guard catches that. |
| `pgvector_step` shared (L4) | **Yes** | Same reasoning. |
| `pgvector_element` (L2.5) | No | Retrieval is already embedding-based with threshold 0.95. |
| `archetype` (L0) | No | L0 has its own top-score-lock + ambiguity check + archetype_failures cooldown. |
| `llm` (L5) | No | Authoritative. |

### S5 — Invalidate-on-reject

When the guard rejects a hit, treat it the same as a user-marked failure for that (tenant, domain, targetHash):

1. Delete the `selector_cache` row for this targetHash in the tenant scope.
2. Invalidate Redis via the existing `invalidateRedisCache` helper.
3. Return MISS so the composite resolver falls through to the next layer.

Writing an `archetype_failures` cooldown signal is **not** applicable — this path is for non-archetype cache rows. Archetype rows bypass the guard entirely.

### S6 — Observability

New counters:
- `resolver.cache_semantic_reject` with labels `{ source: 'redis' | 'db_exact' | 'pgvector_step' }`
- `resolver.cache_semantic_invalidate` — a cache row was deleted because of a guard rejection.

New log line on every reject: `cache_resolver.semantic_reject` with `{ source, similarity, targetHash }` so we can see the actual cosine values and retune the threshold with real data.

Existing `resolver.cache_hit` still fires **before** the guard check. After the guard rejects, the corresponding `resolver.cache_semantic_reject` counter fires, so `reject / hit` reveals cache corruption rate.

---

## Acceptance Tests

### AT-1: Guard rejects a semantically-unrelated cached L2 hit (reproduces the bug)

Fixture: `selector_cache` row with `content_hash = hash("click:choose day 12")` and `step_embedding` = embedding of `"click Test Cases"`. Step: `{ action: "click", targetDescription: "choose day 12" }`. Expected:
- Resolver returns MISS for L2.
- `resolver.cache_semantic_reject` fires with `source: 'db_exact'`.
- The `selector_cache` row is deleted.
- Redis is invalidated.
- The composite chain escalates to L5.

### AT-2: Guard accepts a semantically-close paraphrase hit

Fixture: `selector_cache` row with `step_embedding` = embedding of `"click the sign in button"`. Step: `"click Sign in"`. Cosine similarity well above 0.80. Expected:
- Resolver returns the hit.
- No semantic reject counter fires.

### AT-3: Guard is silent on legacy rows with null embeddings

Fixture: row with both `step_embedding` and `element_embedding` = NULL (legacy data written before embeddings). Expected: guard passes (can't evaluate), hit returned, migration-path counter fires.

### AT-4: Guard is silent when stepEmbedding is undefined

`step.targetDescription === null` (navigate/wait). CompositeElementResolver skips embedding; `context.stepEmbedding === undefined`. Expected: guard passes, hit returned.

### AT-5: Guard does not apply to archetype / LLM sources

A `resolutionSource: 'llm'` or `'archetype'` SelectorSet is never re-checked.

### AT-6: Redis hit uses stored vectors from payload

L1 hit. Redis value is `{ selectors, stepEmbedding, elementEmbedding }`. Guard evaluates against those and passes/rejects without a Postgres roundtrip.

### AT-7: Threshold is tunable from a single constant

`SEMANTIC_GUARD_THRESHOLD` is exported and referenced everywhere. Changing it flips test AT-1/AT-2 outcomes as expected.

---

## Affected Files

| File | Change |
|---|---|
| `src/types/index.ts` | Add `stepEmbedding?: number[]` to `ResolutionContext`. |
| `src/modules/element-resolver/composite.element-resolver.ts` | Add `llmGateway` constructor param; compute step embedding up front; pass enriched context down the chain. |
| `src/modules/element-resolver/cached.element-resolver.ts` | Drop the internal `generateEmbedding` call (read from context). Widen L2/L3/L4 SELECTs to return `step_embedding` / `element_embedding`. Apply guard before returning each hit. Widen Redis payload to include both vectors. Implement `invalidateRow` helper. |
| `src/modules/element-resolver/cache-semantic-guard.ts` (new) | Pure function `semanticGuardPasses(stepEmbedding, rowStep, rowElement)` + `cosine` helper + `SEMANTIC_GUARD_THRESHOLD` constant. Unit-tested in isolation. |
| `src/modules/element-resolver/__tests__/cache-semantic-guard.test.ts` (new) | Covers cosine math, null handling, threshold boundary, both-null legacy rows. |
| `src/modules/element-resolver/__tests__/cached.element-resolver.test.ts` | AT-1 through AT-7 integration on the cached resolver. |
| `src/modules/element-resolver/__tests__/composite.element-resolver.test.ts` | Verifies `stepEmbedding` is computed once and propagated; skipped when `targetDescription` is null. |
| `src/workers/worker.ts` | Pass `llmGateway` into `CompositeElementResolver` constructor. |
| `src/api/app.ts` (or wherever the composite is wired for API-side use) | Same constructor wiring. |

---

## Out of Scope

- Run-level navigation sanity check ("did the URL unexpectedly change?"). Brittle; many legitimate tests click navigation elements. Separate spec if we ever need it.
- Stop-on-fail behavior (separate spec: [spec-worker-stop-on-step-failure.md](../workers/spec-worker-stop-on-step-failure.md)).
- Adaptive per-targetHash thresholds. Starting with a single global constant; if logs show false rejects on specific elements we can add targeted overrides later.
- Back-filling embeddings for legacy rows. AT-3 covers the migration path: legacy rows with null vectors pass through untouched and get re-written with embeddings on the next LLM resolution.

---

## Known Risks

- **False rejects on paraphrased steps whose intent genuinely shifted.** A step edited from `"click Submit"` to `"click Cancel"` produces a new targetHash (so no collision), but if the user rewords `"click Submit"` to `"click Confirm"`, cosine stays close to 1.0 and the guard accepts — which is correct, because the cached selector does still match. The risk is the reverse: `"type email"` vs `"type username"` are semantically close but the cached selector is now for the wrong field. Mitigation: the LLM-resolution fallback catches this the next run after the user marks it failed; guard is a *cheap first line*, not a correctness guarantee.
- **Cosine threshold too loose.** Start at `0.80`, log every reject with similarity. If we see rejects clustering at 0.75–0.85 for legitimate hits, raise the floor. If we see `Test Cases / day 12` style corruption slipping through at 0.82, lower it.
- **Redis payload shape change.** Existing Redis entries written before this change contain only `{ selectors: [...] }`. On read we must tolerate both shapes — if the payload lacks `stepEmbedding`, fall back to the Postgres row lookup (one-time cost; rows get rewritten with full payload on next write).
- **Embedding computation added to composite.** Every step now pays for one `generateEmbedding` call, even when L0 archetype would have hit instantly. Mitigation: L0 runs **before** the composite embeds — add a bailout: compute embedding lazily on first resolver that needs it, or skip when the first resolver (archetype) returns non-empty. Covered by the composite test AT.
