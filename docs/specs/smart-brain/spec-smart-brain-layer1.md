# Smart Brain — Layer 1: Cross-Domain Portable Shared Pool (L4b)
**Branch:** `feat/tests/brain/portable-pool`
**Spec ref:** `kaizen-spec-v3.md` §8 (Element Resolution & Caching), Phase 4 Global Brain

---

## Goal

Make the shared pool (L4) truly cross-domain. Today L4 is filtered by `domain`, which means
two users on different websites get no benefit from each other's learnings — defeating the
purpose of a global brain.

The fix: ARIA-strategy selectors (`role=button[name="Login"]`) are universally valid CSS/ARIA
selectors — they work on *any* website that has a button with that accessible name, regardless
of domain, CSS framework, or component library. These selectors should be shared globally,
not scoped to a single domain.

This spec adds:
1. An `is_portable` flag on `selector_cache` to mark domain-agnostic entries.
2. A new **L4b** lookup in `CachedElementResolver` that searches portable shared entries
   across all domains with a tighter similarity threshold.
3. Write-path changes to detect and flag ARIA selectors as portable at persist time.

---

## Milestone Definition

The milestone is met when:

1. User A resolves "click the Login button" on `site-a.com` via LLM → selector
   `role=button[name="Log in"]` is written to `selector_cache` with `is_portable = true`.
2. User B (different tenant) runs "click the login button" on `site-b.com` — a site Kaizen
   has never seen. The step resolves from L4b with `resolutionSource: 'pgvector_universal'`
   and `tokensUsed: 0`. No LLM call is made.
3. If the ARIA selector doesn't exist in User B's DOM, L4b's DOM validation rejects it and
   the run falls through cleanly to L5 (LLM). No false positives surface.
4. `npm run db:migrate` applies `016_portable_selectors.sql` without error.

---

## What Already Exists (Do Not Rebuild)

| Existing | Location |
|---|---|
| Shared pool L4 lookup (same-domain) | `CachedElementResolver:69-80` |
| `is_shared` column on `selector_cache` | Migration 001 |
| `SharedPoolService.contribute()` — writes shared entries | `src/modules/shared-pool/shared-pool.service.ts` |
| `SelectorEntry.strategy` type (`'css' \| 'xpath' \| 'aria' \| 'text' \| 'data-testid'`) | `src/types/index.ts` |
| `step_embedding` HNSW index | Migration 001 |
| `ResolutionSource` union type | `src/types/index.ts` |

**Gaps to close:**

1. `selector_cache` has no `is_portable` column.
2. L4 `vectorSearch` always includes `AND domain = $2` — cross-domain lookup impossible.
3. `SharedPoolService.contribute()` does not detect or set `is_portable`.
4. `LLMElementResolver.persistToCache()` does not detect or write `is_portable`.
5. `ResolutionSource` does not include `'pgvector_universal'`.

---

## 1. Database Migration: 016

File: `db/migrations/016_portable_selectors.sql`

```sql
-- Migration 016: Cross-domain portable selector flag
--
-- is_portable = true marks a selector_cache entry whose primary selector is
-- strategy='aria' or strategy='text' — selectors that are valid on any website
-- with an element of that accessible name and role.
--
-- These entries are eligible for cross-domain lookup (L4b) regardless of domain.
-- Entries with is_portable = false (CSS id/class, xpath, data-testid) remain
-- domain-scoped because they are not portable to other sites.

ALTER TABLE selector_cache
  ADD COLUMN IF NOT EXISTS is_portable BOOLEAN NOT NULL DEFAULT false;

-- Partial index for fast L4b lookup: only portable shared entries
CREATE INDEX IF NOT EXISTS idx_selector_cache_portable
  ON selector_cache (step_embedding)
  WHERE is_shared = true AND is_portable = true;

-- Backfill: mark existing shared entries as portable if their primary selector
-- starts with 'role=' (ARIA selector format used by Playwright).
-- This is a best-effort backfill — new entries will be correctly flagged by code.
UPDATE selector_cache
SET is_portable = true
WHERE is_shared = true
  AND selectors IS NOT NULL
  AND (selectors::jsonb -> 0 ->> 'selector') LIKE 'role=%';
```

---

## 2. What Makes a Selector "Portable"

A selector is portable if and only if its primary selector (index 0 in the `selectors` array)
uses a strategy that is **not tied to a specific site's DOM structure**:

| Strategy | Portable? | Reason |
|---|---|---|
| `aria` | ✅ Yes | `role=button[name="Login"]` works on any site with that accessible name |
| `text` | ✅ Yes | Text-content selectors survive DOM restructuring across sites |
| `css` | ❌ No | `.login-btn`, `#submit`, `.auth-form button:nth-child(2)` are site-specific |
| `xpath` | ❌ No | XPath structural selectors are site-specific |
| `data-testid` | ❌ No | `data-testid` values are per-codebase conventions |

**Detection code** (pure function, no I/O):
```typescript
function isPortableSelector(selectors: SelectorEntry[]): boolean {
  if (selectors.length === 0) return false;
  const primary = selectors[0];
  return primary.strategy === 'aria' || primary.strategy === 'text';
}
```

---

## 3. Update `ResolutionSource` Type

File: `src/types/index.ts`

```typescript
// Before:
export type ResolutionSource =
  'archetype' | 'redis' | 'db_exact' | 'pgvector_step' | 'pgvector_element' | 'llm';

// After:
export type ResolutionSource =
  'archetype' | 'redis' | 'db_exact' | 'pgvector_step' | 'pgvector_element'
  | 'pgvector_universal' | 'llm';
```

`'pgvector_universal'` indicates a hit from the cross-domain portable shared pool (L4b).

---

## 4. Update `LLMElementResolver.persistToCache()`

File: `src/modules/element-resolver/llm.element-resolver.ts`

Detect portability at write time and persist the flag. Modify the INSERT:

```typescript
const portable = isPortableSelector(selectorSet.selectors);

await getPool().query(
  `INSERT INTO selector_cache
     (tenant_id, content_hash, domain, selectors, step_embedding, element_embedding, is_portable)
   VALUES ($1, $2, $3, $4, $5::vector, $6::vector, $7)
   ON CONFLICT (tenant_id, content_hash, domain)
   DO UPDATE SET
     selectors         = EXCLUDED.selectors,
     step_embedding    = EXCLUDED.step_embedding,
     element_embedding = EXCLUDED.element_embedding,
     is_portable       = EXCLUDED.is_portable,
     updated_at        = now()
   WHERE selector_cache.pinned_at IS NULL`,
  [context.tenantId, step.targetHash, context.domain,
   JSON.stringify(selectorSet.selectors),
   toVectorSQL(stepEmbedding), toVectorSQL(elementEmbedding), portable],
);
```

Add `isPortableSelector` as a module-level pure function (no export needed — internal).

---

## 5. Update `SharedPoolService.contribute()`

File: `src/modules/shared-pool/shared-pool.service.ts`

### Interface change

Add `isPortable: boolean` to `ContributeParams`:

```typescript
// src/modules/shared-pool/interfaces.ts
export type ContributeParams = {
  tenantId: string;
  contentHash: string;
  domain: string;
  selectors: SelectorEntry[];
  stepEmbedding: number[];
  elementEmbedding: number[] | null;
  confidenceScore: number;
  isPortable: boolean;          // ← new
};
```

### Implementation change

Pass `is_portable` in the shared pool INSERT:

```typescript
// In contribute():
const { isPortable } = params;

await pool.query(
  `INSERT INTO selector_cache
     (tenant_id, content_hash, domain, selectors, step_embedding, element_embedding,
      confidence_score, is_shared, is_portable, attribution)
   VALUES (NULL, $1, $2, $3, $4::vector, $5::vector, $6, true, $7, $8)
   ON CONFLICT ON CONSTRAINT idx_selector_cache_shared_unique
   DO UPDATE SET
     attribution = selector_cache.attribution || $8,
     is_portable = EXCLUDED.is_portable`,
  [params.contentHash, params.domain, JSON.stringify(params.selectors),
   toVectorSQL(params.stepEmbedding),
   params.elementEmbedding ? toVectorSQL(params.elementEmbedding) : null,
   params.confidenceScore, isPortable, attributionJson],
);
```

### Call site update

In `LLMElementResolver.persistToCache()`, pass `isPortable` to `sharedPool.contribute()`:

```typescript
void this.sharedPool.contribute({
  tenantId: context.tenantId,
  contentHash: step.targetHash,
  domain: context.domain,
  selectors: selectorSet.selectors,
  stepEmbedding,
  elementEmbedding,
  confidenceScore: 1.0,
  isPortable: isPortableSelector(selectorSet.selectors),  // ← new
});
```

---

## 6. Add L4b to `CachedElementResolver`

File: `src/modules/element-resolver/cached.element-resolver.ts`

### New constant

```typescript
const PORTABLE_COSINE_THRESHOLD = 0.97; // tighter than L3/L4 (0.95) — cross-domain is higher risk
```

### New private method: `portableVectorSearch`

```typescript
/**
 * L4b: cross-domain portable shared pool search.
 * Queries is_shared=true AND is_portable=true entries across ALL domains.
 * Uses a tighter threshold (0.97) than the domain-scoped L4 (0.95) because
 * we are matching across sites — a false positive here means executing the
 * wrong element on a page the system has never seen, with no domain similarity
 * to act as a natural safety net.
 *
 * The DOM validation step in the caller is the final safety net: if the ARIA
 * selector doesn't resolve on the current page, the hit is discarded and the
 * run falls through to L5 (LLM).
 */
private async portableVectorSearch(
  embeddingSQL: string,
): Promise<{ selectors: SelectorEntry[]; similarity: number } | null> {
  try {
    const { rows } = await getPool().query<{
      selectors: SelectorEntry[];
      similarity: number;
    }>(
      `SELECT selectors,
              1 - (step_embedding <=> $1::vector) AS similarity
       FROM selector_cache
       WHERE step_embedding IS NOT NULL
         AND is_shared = true
         AND is_portable = true
         AND confidence_score > 0.4
         AND 1 - (step_embedding <=> $1::vector) > $2
       ORDER BY step_embedding <=> $1::vector
       LIMIT 1`,
      [embeddingSQL, PORTABLE_COSINE_THRESHOLD],
    );
    return rows.length > 0 ? { selectors: rows[0].selectors, similarity: rows[0].similarity } : null;
  } catch (e: any) {
    this.observability.log('warn', 'cache_resolver.portable_search_failed', { error: e.message });
    return null;
  }
}
```

### Add L4b call in `resolve()`

After the existing L4 (same-domain shared) block:

```typescript
// ── L4b: cross-domain portable shared pool ────────────────────────────────
// Only runs if L4 missed. Searches portable (ARIA/text strategy) entries
// across all domains. Higher threshold (0.97) compensates for lack of domain filter.
const portableHit = await this.portableVectorSearch(embeddingSQL);

if (portableHit) {
  this.observability.increment('resolver.cache_hit', { source: 'pgvector_portable' });
  await this.redis.setex(redisKey, REDIS_TTL_SECONDS, JSON.stringify(portableHit.selectors));
  return {
    selectors: portableHit.selectors,
    fromCache: true,
    cacheSource: 'shared',
    resolutionSource: 'pgvector_universal',
    similarityScore: portableHit.similarity,
  };
}
```

**Full resolution order after this change:**

```
L1  → Redis hot cache (exact tenantId:targetHash:domain)
L2  → Postgres exact targetHash (tenant scope)
L3  → pgvector step_embedding cosine > 0.95 (tenant scope)
L4  → pgvector step_embedding cosine > 0.95 (shared pool, same domain)
L4b → pgvector step_embedding cosine > 0.97 (shared pool, cross-domain, portable only)  ← NEW
──── cache miss boundary ────
L2.5 → pgvector element_embedding cosine > 0.95 (tenant scope, inside LLMElementResolver)
L5  → LLM resolveElement()
```

---

## 7. DOM Validation for L4b Hits

L4b hits arrive at the worker as a `SelectorSet` with `resolutionSource: 'pgvector_universal'`.
The existing execution engine already validates selectors before acting on them
(`engine.executeStep` → `page.$(selector)` internally). No additional validation code
is required — the existing failure path and `recordFailure` eviction already handle the case
where the portable selector does not resolve in the current DOM.

However, `recordFailure` in `CachedElementResolver` currently evicts Redis keys matching
`sel:*:{targetHash}:{domain}`. A cross-domain portable hit written to Redis under the local
`sel:{tenantId}:{targetHash}:{localDomain}` key will be evicted correctly by this pattern.
The shared pool row itself is **not** evicted on a single DOM miss — it may be valid on other
sites. Only a human `verdict=failed` clears the shared pool row (existing behaviour, no change).

---

## 8. Observability

New counters to add to `CachedElementResolver`:

```typescript
obs.increment('resolver.cache_hit',  { source: 'pgvector_portable' });  // L4b hit
obs.increment('resolver.cache_miss_portable');                           // L4b miss (fell through to LLM)
```

These allow the dashboard to show:
- Archetype hit rate (L0)
- Same-domain shared pool hit rate (L4)
- Cross-domain universal hit rate (L4b)
- LLM call rate (L5)

Together they tell the story: **how smart is the brain getting over time?**

---

## 9. Tests

### Unit: `src/modules/element-resolver/__tests__/cached.element-resolver.l4b.test.ts`

| # | Test |
|---|---|
| 1 | L4b hit: returns SelectorSet with `resolutionSource: 'pgvector_universal'` when portable shared entry exists with similarity > 0.97 |
| 2 | L4b miss: returns MISS when best portable similarity is 0.96 (below threshold) |
| 3 | L4b not queried when L4 (same-domain) already returned a hit |
| 4 | L4b does not return domain-specific (`is_portable = false`) entries even at similarity 1.0 |
| 5 | L4b miss is handled gracefully when DB raises an error (returns MISS, does not throw) |

### Unit: `src/modules/shared-pool/__tests__/shared-pool.portable.test.ts`

| # | Test |
|---|---|
| 1 | `contribute()` sets `is_portable = true` when primary selector strategy is `'aria'` |
| 2 | `contribute()` sets `is_portable = false` when primary selector strategy is `'css'` |
| 3 | `contribute()` sets `is_portable = false` when primary selector strategy is `'xpath'` |
| 4 | `contribute()` sets `is_portable = true` when primary selector strategy is `'text'` |

### Unit: `isPortableSelector` pure function

| # | Test |
|---|---|
| 1 | Returns true for `[{ strategy: 'aria', ... }]` |
| 2 | Returns true for `[{ strategy: 'text', ... }]` |
| 3 | Returns false for `[{ strategy: 'css', ... }]` |
| 4 | Returns false for `[{ strategy: 'xpath', ... }]` |
| 5 | Returns false for `[{ strategy: 'data-testid', ... }]` |
| 6 | Returns false for empty array |

---

## 10. Execution Order

Follow strictly — each step depends on the previous:

- [ ] **Step 1:** Write `db/migrations/016_portable_selectors.sql` → run `npm run db:migrate`
- [ ] **Step 2:** Add `'pgvector_universal'` to `ResolutionSource` in `src/types/index.ts`
- [ ] **Step 3:** Add `isPortable: boolean` to `ContributeParams` in shared-pool interfaces
- [ ] **Step 4:** Update `SharedPoolService.contribute()` to write `is_portable`
- [ ] **Step 5:** Add `isPortableSelector()` pure function to `llm.element-resolver.ts`
- [ ] **Step 6:** Update `LLMElementResolver.persistToCache()` to compute and write `is_portable`
- [ ] **Step 7:** Update `LLMElementResolver.persistToCache()` call to `sharedPool.contribute()` to pass `isPortable`
- [ ] **Step 8:** Add `portableVectorSearch()` private method to `CachedElementResolver`
- [ ] **Step 9:** Add L4b call in `CachedElementResolver.resolve()` after the L4 block
- [ ] **Step 10:** Write unit tests for `isPortableSelector`
- [ ] **Step 11:** Write unit tests for L4b in `cached.element-resolver.l4b.test.ts`
- [ ] **Step 12:** Write unit tests for `SharedPoolService` portable flag
- [ ] **Step 13:** Verify milestone: run two tenants on different domains, confirm L4b hit on second tenant

---

## 11. Files to Create / Modify

| Action | File |
|---|---|
| CREATE | `db/migrations/016_portable_selectors.sql` |
| MODIFY | `src/types/index.ts` — add `'pgvector_universal'` to `ResolutionSource` |
| MODIFY | `src/modules/shared-pool/interfaces.ts` — add `isPortable` to `ContributeParams` |
| MODIFY | `src/modules/shared-pool/shared-pool.service.ts` — write `is_portable` in INSERT |
| MODIFY | `src/modules/element-resolver/llm.element-resolver.ts` — add `isPortableSelector`, write flag, pass to contribute |
| MODIFY | `src/modules/element-resolver/cached.element-resolver.ts` — add `portableVectorSearch`, L4b call |
| CREATE | `src/modules/element-resolver/__tests__/cached.element-resolver.l4b.test.ts` |
| CREATE | `src/modules/shared-pool/__tests__/shared-pool.portable.test.ts` |

---

## 12. What Is NOT In This Spec

Deferred to future iterations:

- **Portable entry quality decay:** Shared portable entries currently have a static
  `confidence_score`. If a portable selector begins failing DOM validation frequently
  across multiple tenants (tracked via `recordFailure`), its score should decay. This
  requires cross-tenant failure aggregation — deferred.
- **Portable entry expiration:** ARIA accessible names can change between major site
  redesigns. A TTL-based expiration for portable entries is desirable long-term.
  Deferred — the human `verdict=failed` path already handles egregious cases.
- **Locale-aware portability:** `role=button[name="Connexion"]` is a portable French login
  button, but distinct from `role=button[name="Login"]`. The current model handles this
  naturally (separate embeddings + name strings), but a locale tag on archetypes/portables
  would make this explicit. Deferred.
- **UI for portable pool inspection:** A dashboard view showing which cross-domain entries
  exist, their hit counts, and their confidence scores. Deferred to product UI phase.
- **Automatic promotion of domain-scoped entries to portable:** A batch job that inspects
  high-confidence domain-scoped shared entries, checks if their primary selector is ARIA,
  and promotes them to `is_portable = true`. Deferred — handle at contribute time is sufficient
  for now.
