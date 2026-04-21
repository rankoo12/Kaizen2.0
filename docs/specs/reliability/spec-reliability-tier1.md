# Reliability — Tier 1: Bulletproof Feedback Loop
**Branch:** `feat/reliability/tier1-feedback-loop`
**Spec ref:** Post-analysis of production flakiness patterns

---

## Goal

Make the system's self-improvement loop **reliable**. Today, critical state updates
(cache writes, outcome recording, archetype learning) are fire-and-forget `void` calls
that silently fail. When they fail:

- Confidence scores never update, so broken selectors appear healthy
- LLM results never reach the cache, causing repeat expensive calls
- Archetypes never learn new patterns, keeping the L0 library small
- Redis serves stale entries for up to 1 hour after Postgres is updated

This tier fixes the feedback loop so that every successful resolution reliably
propagates into the cache, and every failure reliably degrades the cached entry.
No new features are added — only existing write paths are hardened.

**Expected impact:** ~60% reliability to ~75% (eliminates the largest class of
non-deterministic failures — the ones where the system "forgets" what it learned).

---

## Milestone Definition

The milestone is met when:

1. `persistToCache` failures are surfaced via observability counters and retried once
   before being dropped. The counter `resolver.cache_write_failed` increments only after
   the retry also fails.
2. `recordFailure` and `recordSuccess` in the worker are `await`-ed, not fire-and-forget.
   A transient Postgres error on `recordFailure` does not cause the next run to reuse a
   broken selector as if it were healthy.
3. `archetypeResolver.learn()` in the worker is `await`-ed. A transient DB error is logged
   but does not block the step. The archetype's in-memory cache is busted on success.
4. Redis keys for a `targetHash:domain` pair are invalidated whenever the corresponding
   `selector_cache` row in Postgres is updated (outcome window, confidence score, pinned_at,
   or verdict).
5. All existing tests continue to pass. New tests cover the retry and invalidation paths.

---

## What Already Exists (Do Not Rebuild)

| Existing | Location |
|---|---|
| `void resolver.recordFailure(...)` call | `worker.ts:327` |
| `void resolver.recordSuccess(...)` call (through `resolver.recordSuccess`) | `worker.ts:309` |
| `void archetypeResolver.learn(...)` call | `worker.ts:318` |
| `void this.persistToCache(...)` call | `llm.element-resolver.ts:220` |
| `void this.sharedPool.contribute(...)` call | `llm.element-resolver.ts:374` |
| Redis key format `sel:{tenantId}:{targetHash}:{domain}` | `cached.element-resolver.ts:114` |
| `recordFailure` Redis SCAN + DEL invalidation | `cached.element-resolver.ts:89-109` |
| `updateOutcomeWindow` in LLMElementResolver | `llm.element-resolver.ts:390-425` |
| Redis `setex` on cache hits | `cached.element-resolver.ts:51,65,74` |

**Gaps to close:**

1. `recordFailure` and `recordSuccess` are called with `void` in worker — outcomes silently lost.
2. `archetypeResolver.learn()` is called with `void` — patterns silently lost.
3. `persistToCache` has no retry — a single transient DB error loses the LLM result.
4. No Redis invalidation when `selector_cache` is updated via `updateOutcomeWindow`.
5. `sharedPool.contribute()` is fire-and-forget with no retry.
6. `updateStepResult` to 'healed' status (worker.ts:365) is fire-and-forget.

---

## 1. Await Critical Write Paths in Worker

File: `src/workers/worker.ts`

### 1a. Await `recordFailure` on failure path

**Before (worker.ts:327):**
```typescript
void resolver.recordFailure(step.targetHash, domain, selectorSet.selectors[0]?.selector ?? '');
```

**After:**
```typescript
await resolver.recordFailure(step.targetHash, domain, selectorSet.selectors[0]?.selector ?? '').catch((e: any) =>
  obs.log('warn', 'worker.record_failure_failed', { error: e.message }),
);
```

### 1b. Await `recordSuccess` on success path

**Before (worker.ts:309):**
```typescript
void resolver.recordSuccess(step.targetHash, domain, result.selectorUsed);
```

**After:**
```typescript
await resolver.recordSuccess(step.targetHash, domain, result.selectorUsed).catch((e: any) =>
  obs.log('warn', 'worker.record_success_failed', { error: e.message }),
);
```

### 1c. Await `archetypeResolver.learn()`

**Before (worker.ts:318):**
```typescript
void archetypeResolver.learn(picked.role, picked.name, step.action);
```

**After:**
```typescript
await archetypeResolver.learn(picked.role, picked.name, step.action).catch((e: any) =>
  obs.log('warn', 'worker.archetype_learn_failed', { error: e.message }),
);
```

### 1d. Await healed step_result update

**Before (worker.ts:365-369):**
```typescript
if (stepResultId) {
  void getPool().query(
    `UPDATE step_results SET status = 'healed', selector_used = $1 WHERE id = $2`,
    [healingResult.newSelector, stepResultId],
  ).catch(() => { });
}
```

**After:**
```typescript
if (stepResultId) {
  await getPool().query(
    `UPDATE step_results SET status = 'healed', selector_used = $1 WHERE id = $2`,
    [healingResult.newSelector, stepResultId],
  ).catch((e: any) => obs.log('warn', 'worker.healed_update_failed', { error: e.message }));
}
```

### Design rationale

- `await` with `.catch()` ensures the write is attempted but a transient failure does
  not crash the step or the run.
- The step already completed (passed or failed) before these writes run, so adding
  `await` adds latency (~5-20ms per DB write) but not risk.
- Screenshot uploads remain fire-and-forget because they are observability-only and
  involve network I/O to an object store (higher latency, lower criticality).

---

## 2. Add Single-Retry to `persistToCache`

File: `src/modules/element-resolver/llm.element-resolver.ts`

The LLM call that produced this result cost tokens. Losing it to a transient connection
error means the same step will hit the LLM again on the next run. A single retry with
a short delay is cost-justified.

### Extract the DB write into a retryable inner function

```typescript
private async persistToCache(
  step: StepAST,
  context: ResolutionContext,
  selectorSet: SelectorSet,
  candidates: CandidateNode[],
): Promise<void> {
  try {
    // ... existing embedding generation code stays unchanged ...

    // DB write with single retry
    await this.writeCacheRow(context, step, selectorSet, stepEmbedding, elementEmbedding);

    this.observability.increment('resolver.cache_write', { domain: context.domain });

    // Shared pool contribution (keep fire-and-forget — separate system, lower criticality)
    if (this.sharedPool) {
      void this.sharedPool.contribute({ ... });
    }
  } catch (e: any) {
    this.observability.log('warn', 'resolver.cache_write_failed', { error: e.message });
  }
}

private async writeCacheRow(
  context: ResolutionContext,
  step: StepAST,
  selectorSet: SelectorSet,
  stepEmbedding: number[],
  elementEmbedding: number[],
): Promise<void> {
  const sql = `INSERT INTO selector_cache ...`;  // existing INSERT
  const params = [...];                           // existing params

  try {
    await getPool().query(sql, params);
  } catch (firstError: any) {
    // Single retry after 100ms for transient connection errors
    if (isTransient(firstError)) {
      this.observability.increment('resolver.cache_write_retry');
      await new Promise((r) => setTimeout(r, 100));
      await getPool().query(sql, params);  // let this throw if it fails again
    } else {
      throw firstError;
    }
  }
}
```

### Transient error detection (module-level utility)

```typescript
/**
 * Returns true for Postgres error codes that are typically transient:
 *  - 08xxx: connection exceptions
 *  - 40001: serialization failure
 *  - 40P01: deadlock detected
 *  - 57P01: admin shutdown
 */
function isTransient(error: any): boolean {
  const code = error.code as string | undefined;
  if (!code) return false;
  return code.startsWith('08') || code === '40001' || code === '40P01' || code === '57P01';
}
```

---

## 3. Redis Invalidation on Postgres Writes

File: `src/modules/element-resolver/llm.element-resolver.ts`

### Problem

When `updateOutcomeWindow` updates `confidence_score` in Postgres (e.g. from 0.9 down to
0.3 after repeated failures), the Redis hot cache still holds the old selectors for up to
1 hour. Subsequent runs hit Redis L1, skip Postgres, and reuse the degraded selector.

### Solution

After any `selector_cache` UPDATE, invalidate the matching Redis key. The LLMElementResolver
needs access to the Redis instance (already available via the `CachedElementResolver` —
but LLM resolver doesn't hold a Redis reference today).

#### Option A: Pass Redis to LLMElementResolver (chosen)

Add `redis: Redis` to LLMElementResolver constructor:

```typescript
export class LLMElementResolver implements IElementResolver {
  constructor(
    private readonly domPruner: IDOMPruner,
    private readonly llmGateway: ILLMGateway,
    private readonly observability: IObservability,
    private readonly sharedPool?: ISharedPoolService,
    private readonly redis?: Redis,          // <-- new optional param
  ) {}
```

Worker instantiation (worker.ts):

```typescript
const llmResolver = new LLMElementResolver(domPruner, llm, obs, sharedPool, cacheRedis);
```

#### Invalidation in `updateOutcomeWindow`

After the UPDATE query succeeds, delete the Redis key:

```typescript
private async updateOutcomeWindow(
  targetHash: string,
  domain: string,
  success: boolean,
  _selector: string,
): Promise<void> {
  try {
    // ... existing SELECT + UPDATE code ...

    // Invalidate Redis so the next resolve reads from Postgres
    if (this.redis) {
      const pattern = `sel:*:${targetHash}:${domain}`;
      let cursor = '0';
      do {
        const [next, batch] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', '100');
        cursor = next;
        if (batch.length > 0) await this.redis.del(...batch);
      } while (cursor !== '0');
    }
  } catch (e: any) {
    this.observability.log('warn', 'resolver.outcome_update_failed', { error: e.message });
  }
}
```

**Note:** This duplicates the SCAN+DEL logic from `CachedElementResolver.recordFailure()`.
Extract into a shared utility to avoid drift:

File: `src/modules/element-resolver/redis-cache.utils.ts`

```typescript
import type { Redis } from 'ioredis';

/**
 * Invalidates all Redis hot-cache entries for a given targetHash + domain.
 * Key format: sel:{tenantId}:{targetHash}:{domain}
 */
export async function invalidateRedisCache(
  redis: Redis,
  targetHash: string,
  domain: string,
): Promise<number> {
  const pattern = `sel:*:${targetHash}:${domain}`;
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', '100');
    cursor = next;
    keys.push(...batch);
  } while (cursor !== '0');

  if (keys.length > 0) {
    await redis.del(...keys);
  }
  return keys.length;
}
```

Both `CachedElementResolver.recordFailure()` and `LLMElementResolver.updateOutcomeWindow()`
should call this shared utility.

---

## 4. Observability Additions

New counters:

| Counter | When |
|---|---|
| `resolver.cache_write_retry` | `writeCacheRow` retries after transient error |
| `resolver.cache_write_failed` | `persistToCache` fails after retry (existing, unchanged) |
| `resolver.redis_invalidated` | Redis keys deleted by `invalidateRedisCache` |
| `worker.record_failure_failed` | `recordFailure` `.catch()` fires |
| `worker.record_success_failed` | `recordSuccess` `.catch()` fires |
| `worker.archetype_learn_failed` | `archetypeResolver.learn()` `.catch()` fires |
| `worker.healed_update_failed` | Healed step_result UPDATE fails |

---

## 5. Tests

### Unit: `src/modules/element-resolver/__tests__/redis-cache-utils.test.ts`

| # | Test |
|---|---|
| 1 | `invalidateRedisCache` deletes all matching keys for targetHash + domain |
| 2 | `invalidateRedisCache` returns 0 and does not throw when no keys match |
| 3 | `invalidateRedisCache` handles Redis errors gracefully (does not throw) |

### Unit: `src/modules/element-resolver/__tests__/llm.element-resolver.persist.test.ts`

| # | Test |
|---|---|
| 1 | `persistToCache` retries once on transient Postgres error (code '08006') |
| 2 | `persistToCache` does not retry on non-transient error (code '23505') |
| 3 | `persistToCache` increments `resolver.cache_write_retry` on retry |
| 4 | `persistToCache` increments `resolver.cache_write_failed` when retry also fails |
| 5 | `updateOutcomeWindow` invalidates Redis after Postgres UPDATE |
| 6 | `updateOutcomeWindow` still works when Redis is not provided (optional param) |

### Integration: `src/workers/__tests__/worker.feedback-loop.test.ts`

| # | Test |
|---|---|
| 1 | After a step fails, the selector_cache confidence_score decreases |
| 2 | After a step fails, the Redis hot-cache entry for that targetHash is deleted |
| 3 | After a step succeeds via LLM, the selector is found in selector_cache within 1 second |
| 4 | After a step succeeds via LLM with archetype-eligible candidate, the archetype's name_patterns grow |

---

## 6. Execution Order

Follow strictly:

- [ ] **Step 1:** Create `src/modules/element-resolver/redis-cache.utils.ts` with `invalidateRedisCache`
- [ ] **Step 2:** Create `isTransient()` utility in `llm.element-resolver.ts`
- [ ] **Step 3:** Add `redis?: Redis` parameter to `LLMElementResolver` constructor
- [ ] **Step 4:** Update `LLMElementResolver.persistToCache()` with retry logic (`writeCacheRow`)
- [ ] **Step 5:** Update `LLMElementResolver.updateOutcomeWindow()` to call `invalidateRedisCache`
- [ ] **Step 6:** Refactor `CachedElementResolver.recordFailure()` to use shared `invalidateRedisCache`
- [ ] **Step 7:** Update worker.ts: pass `cacheRedis` to `LLMElementResolver` constructor
- [ ] **Step 8:** Update worker.ts: `await` the four fire-and-forget calls (1a, 1b, 1c, 1d)
- [ ] **Step 9:** Write unit tests for `redis-cache.utils.ts`
- [ ] **Step 10:** Write unit tests for persist retry + Redis invalidation
- [ ] **Step 11:** Write integration test for end-to-end feedback loop
- [ ] **Step 12:** Run `npm run typecheck && npm run lint && npm run test`

---

## 7. Files to Create / Modify

| Action | File |
|---|---|
| CREATE | `src/modules/element-resolver/redis-cache.utils.ts` |
| MODIFY | `src/modules/element-resolver/llm.element-resolver.ts` — add Redis param, retry, invalidation |
| MODIFY | `src/modules/element-resolver/cached.element-resolver.ts` — use shared `invalidateRedisCache` |
| MODIFY | `src/workers/worker.ts` — await critical writes, pass Redis to LLM resolver |
| CREATE | `src/modules/element-resolver/__tests__/redis-cache-utils.test.ts` |
| CREATE | `src/modules/element-resolver/__tests__/llm.element-resolver.persist.test.ts` |
| CREATE | `src/workers/__tests__/worker.feedback-loop.test.ts` |

---

## 8. What Is NOT In This Spec

Deferred to Tier 2 and Tier 3:

- **Cosine threshold tuning** — lowering from 0.95 to 0.90 (Tier 2)
- **Archetype library expansion** — seeding 50+ new patterns (Tier 2)
- **Selector pre-validation removal** — trusting Playwright auto-wait (Tier 2)
- **Circuit breaker for LLM provider** — fast-fail on provider outages (Tier 3)
- **Cross-worker archetype sync** — Postgres NOTIFY or Redis pub/sub (Tier 3)
- **Failure classifier hardening** — structural DOM diffing fallback (Tier 3)
