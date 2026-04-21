# Reliability — Tier 3: Resilience & Classification Hardening
**Branch:** `feat/reliability/tier3-resilience`
**Spec ref:** Post-analysis of production flakiness patterns
**Depends on:** `spec-reliability-tier1.md`, `spec-reliability-tier2.md`

---

## Goal

Push reliability from ~90% to 95%+ by hardening the system's **resilience** to external
failures (LLM provider outages, slow networks) and improving **failure classification
accuracy** so the healing engine picks the right strategy more often.

After Tier 1 (reliable feedback loop) and Tier 2 (higher cache hit rate), the remaining
failures fall into three categories:

1. **LLM provider outages** — when OpenAI/Anthropic is down, the system hangs until timeout
   instead of failing fast and falling back to cached/archetype paths.
2. **Wrong healing strategy** — the failure classifier misclassifies because the AX tree is
   sparse or unavailable, leading the healing engine to try the wrong recovery path.
3. **Cross-worker cache staleness** — worker process A learns a new archetype, but worker
   process B's in-memory cache doesn't see it for 5 minutes.

This tier adds a circuit breaker, improves the failure classifier, and synchronises
archetype knowledge across workers.

**Expected impact:** ~90% to ~95%+ (eliminates the long tail of failures caused by
infrastructure issues and classification errors).

---

## Milestone Definition

The milestone is met when:

1. When the LLM provider returns 5 consecutive errors within 60 seconds, the circuit
   breaker trips OPEN. Subsequent LLM calls fail immediately (< 5ms) for 30 seconds.
   Steps that need LLM fall through gracefully with `resolutionSource: null` and are
   reported as unresolved (not as crashed runs).
2. When the AX tree is null/sparse on BOTH before and after snapshots, the failure
   classifier falls back to error-type + screenshot signals only (does not default to
   TIMING). The `SparsePage` DOM signal is only emitted when the before-tree was populated
   but the after-tree is sparse (genuine page unload).
3. When `archetypeResolver.learn()` succeeds, a Redis pub/sub message is published on
   channel `kaizen:archetype:invalidate`. All worker processes subscribe and bust their
   in-memory archetype cache within 1 second.
4. The `selectorToName` function in the failure classifier correctly extracts names from
   ARIA role selectors (e.g. `role=button[name="Login"]` -> `"login"`), not just
   `aria-label` and `text=` patterns.
5. All existing tests pass. New tests cover circuit breaker states, classifier edge cases,
   and pub/sub invalidation.

---

## What Already Exists (Do Not Rebuild)

| Existing | Location |
|---|---|
| `classifyErrorSignal()` — Signal A | `failure-classifier.ts:27-39` |
| `classifyDOMSignal()` — Signal B | `failure-classifier.ts:55-83` |
| `classifyScreenshotSignal()` — Signal C | `failure-classifier.ts:124-150` |
| `classify()` — decision table | `failure-classifier.ts:157-197` |
| `selectorToName()` — name extraction from selector | `failure-classifier.ts:101-109` |
| `DBArchetypeResolver` in-memory cache (5min TTL) | `db.archetype-resolver.ts:37-60` |
| `OpenAIGateway` — LLM provider wrapper | `src/modules/llm-gateway/openai.gateway.ts` |
| Redis connection available in worker | `worker.ts:63` |

---

## 1. LLM Circuit Breaker

File: `src/modules/llm-gateway/circuit-breaker.ts` (CREATE)

### Design

A simple three-state circuit breaker (CLOSED → OPEN → HALF_OPEN → CLOSED/OPEN):

```
CLOSED (normal operation)
  └─ 5 consecutive failures in 60s → OPEN
      └─ after 30s cooldown → HALF_OPEN
          ├─ first call succeeds → CLOSED
          └─ first call fails → OPEN (restart cooldown)
```

### Interface

```typescript
export interface ICircuitBreaker {
  /** Returns true if the circuit is OPEN (should not call the provider). */
  isOpen(): boolean;
  /** Record a successful call. Transitions HALF_OPEN → CLOSED. */
  recordSuccess(): void;
  /** Record a failed call. May transition CLOSED → OPEN. */
  recordFailure(): void;
  /** Current state for observability. */
  state(): 'CLOSED' | 'OPEN' | 'HALF_OPEN';
}
```

### Implementation

```typescript
export class CircuitBreaker implements ICircuitBreaker {
  private currentState: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';
  private failureCount = 0;
  private firstFailureAt = 0;
  private openedAt = 0;

  constructor(
    private readonly failureThreshold: number = 5,
    private readonly failureWindowMs: number = 60_000,
    private readonly cooldownMs: number = 30_000,
  ) {}

  isOpen(): boolean {
    if (this.currentState === 'CLOSED') return false;

    if (this.currentState === 'OPEN') {
      // Check if cooldown has elapsed
      if (Date.now() - this.openedAt >= this.cooldownMs) {
        this.currentState = 'HALF_OPEN';
        return false; // allow one probe call
      }
      return true;
    }

    // HALF_OPEN: allow calls (single probe)
    return false;
  }

  recordSuccess(): void {
    this.failureCount = 0;
    this.firstFailureAt = 0;
    if (this.currentState === 'HALF_OPEN') {
      this.currentState = 'CLOSED';
    }
  }

  recordFailure(): void {
    const now = Date.now();

    if (this.currentState === 'HALF_OPEN') {
      // Probe failed — reopen
      this.currentState = 'OPEN';
      this.openedAt = now;
      return;
    }

    // CLOSED state
    if (this.failureCount === 0 || now - this.firstFailureAt > this.failureWindowMs) {
      // Start a new failure window
      this.failureCount = 1;
      this.firstFailureAt = now;
    } else {
      this.failureCount++;
    }

    if (this.failureCount >= this.failureThreshold) {
      this.currentState = 'OPEN';
      this.openedAt = now;
      this.failureCount = 0;
    }
  }

  state(): 'CLOSED' | 'OPEN' | 'HALF_OPEN' {
    // Re-evaluate in case cooldown elapsed
    this.isOpen();
    return this.currentState;
  }
}
```

### Integration with OpenAIGateway

File: `src/modules/llm-gateway/openai.gateway.ts`

Add circuit breaker to the gateway. Before every LLM call:

```typescript
import { CircuitBreaker } from './circuit-breaker';

export class OpenAIGateway implements ILLMGateway {
  private readonly circuitBreaker = new CircuitBreaker();

  async resolveElement(step: StepAST, candidates: CandidateNode[], tenantId: string): Promise<LLMResult> {
    if (this.circuitBreaker.isOpen()) {
      this.observability.increment('llm.circuit_breaker_rejected');
      throw new Error('LLM circuit breaker is OPEN — provider appears down');
    }

    try {
      const result = await this.callProvider(...);
      this.circuitBreaker.recordSuccess();
      return result;
    } catch (e) {
      this.circuitBreaker.recordFailure();
      throw e;
    }
  }
}
```

**The caller (LLMElementResolver) already handles errors gracefully** — an empty
SelectorSet is returned, and the step falls through to execution with no selector
(which fails fast and enters the healing path).

### Observability

| Counter | When |
|---|---|
| `llm.circuit_breaker_rejected` | Call rejected because circuit is OPEN |
| `llm.circuit_breaker_opened` | State transitioned to OPEN |
| `llm.circuit_breaker_closed` | State transitioned to CLOSED from HALF_OPEN |

---

## 2. Harden Failure Classifier

### 2a. Fix `selectorToName` to handle ARIA role selectors

File: `src/modules/healing-engine/failure-classifier.ts`

The archetype system generates selectors like `role=button[name="Login"]`. The current
`selectorToName` only matches `aria-label="..."` and `text="..."`, missing ARIA role
selectors entirely. When the name can't be extracted, `classifyDOMSignal` can't detect
`SelectorGone` and defaults to `SelectorPresent` → `TIMING`, skipping useful healing.

**Before:**
```typescript
function selectorToName(selector: string): string | null {
  const ariaMatch = selector.match(/aria-label="([^"]+)"/i);
  if (ariaMatch) return ariaMatch[1].toLowerCase();
  const textMatch = selector.match(/text="([^"]+)"/i);
  if (textMatch) return textMatch[1].toLowerCase();
  return null;
}
```

**After:**
```typescript
function selectorToName(selector: string): string | null {
  // role=button[name="Login"] → "login"
  const roleNameMatch = selector.match(/\[name="([^"]+)"\]/i);
  if (roleNameMatch) return roleNameMatch[1].toLowerCase();
  // aria-label="Submit" → "submit"
  const ariaMatch = selector.match(/aria-label="([^"]+)"/i);
  if (ariaMatch) return ariaMatch[1].toLowerCase();
  // text="Add to Cart" → "add to cart"
  const textMatch = selector.match(/text="([^"]+)"/i);
  if (textMatch) return textMatch[1].toLowerCase();
  return null;
}
```

### 2b. Improve `classifyDOMSignal` when both AX trees are null

**Problem:** When `axBefore === null` and `axAfter === null` (AX API unavailable on this
browser/page), the function falls through to comparing empty name sets and returns
`SelectorPresent`. This funnels every failure into `TIMING`, even when the element was
actually removed.

**After:**
```typescript
export function classifyDOMSignal(
  axBefore: AXNode | null,
  axAfter: AXNode | null,
  previousSelector: string,
): DOMSignal {
  // If BOTH trees are null, AX API is unavailable — return a dedicated signal
  // so the decision table can rely on error type + screenshot instead.
  if (axBefore === null && axAfter === null) return 'Unavailable';

  // Populated before-tree but sparse/null after-tree → page unloaded
  if (axBefore !== null && (!axAfter || countNodes(axAfter) < 5)) return 'SparsePage';

  // ... rest unchanged ...
}
```

Add `'Unavailable'` to the `DOMSignal` type:

```typescript
export type DOMSignal =
  | 'SelectorGone'
  | 'AttrsChanged'
  | 'SelectorPresent'
  | 'SparsePage'
  | 'Unavailable';
```

### 2c. Update decision table for `Unavailable` DOM signal

When DOM signal is `Unavailable`, fall back to error type + screenshot only:

```typescript
// In classify():

// DOM signal unavailable — rely on error type and screenshot only
if (sigB === 'Unavailable') {
  if (sigA === 'TimeoutError') return sigC === 'HighSimilarity' ? 'TIMING' : 'PAGE_NOT_LOADED';
  if (sigA === 'ElementNotFoundError') return 'ELEMENT_REMOVED';
  if (sigA === 'StaleElementError') return 'ELEMENT_MUTATED';
  if (sigC === 'LowSimilarity') return 'PAGE_NOT_LOADED';
  if (sigC === 'PartialChange') return 'ELEMENT_MUTATED';
  return 'TIMING';
}
```

This should be inserted after the `AssertionError` check and before the `SparsePage` check.

---

## 3. Cross-Worker Archetype Invalidation via Redis Pub/Sub

### Problem

Each worker process has an in-memory archetype cache (5-minute TTL). When worker A's
`archetypeResolver.learn()` adds a new pattern to Postgres, worker B doesn't see it for
up to 5 minutes. During that window, worker B makes unnecessary LLM calls for patterns
that are already known.

### Solution

Use Redis pub/sub to broadcast archetype cache invalidation:

#### Publisher (in `DBArchetypeResolver.learn`)

File: `src/modules/element-resolver/db.archetype-resolver.ts`

Add a Redis publisher to `DBArchetypeResolver`:

```typescript
export class DBArchetypeResolver implements IArchetypeResolver {
  private cache: ArchetypeRow[] | null = null;
  private cacheExpiresAt = 0;

  constructor(
    private readonly observability: IObservability,
    private readonly redis?: Redis,           // <-- new optional param
  ) {}

  async learn(role: string, name: string, action: string): Promise<void> {
    // ... existing learn logic ...

    try {
      await getPool().query(...);  // INSERT pattern

      // Bust local cache
      this.cache = null;
      this.cacheExpiresAt = 0;

      // Broadcast to other workers
      if (this.redis) {
        await this.redis.publish('kaizen:archetype:invalidate', 'bust');
      }

      this.observability.increment('archetype_learner.pattern_added', ...);
    } catch (e: any) {
      this.observability.log('warn', 'archetype_learner.learn_failed', ...);
    }
  }
```

#### Subscriber (in worker startup)

File: `src/workers/worker.ts`

Create a dedicated Redis connection for subscribing (Redis clients in subscribe mode
cannot be used for other commands):

```typescript
// After archetypeResolver construction:
const subRedis = createRedisConnection();
subRedis.subscribe('kaizen:archetype:invalidate').catch((e) =>
  logger.warn({ event: 'archetype_sub_failed', error: e.message }),
);
subRedis.on('message', (channel) => {
  if (channel === 'kaizen:archetype:invalidate') {
    archetypeResolver.bustCache();
    obs.increment('archetype.cache_invalidated_by_pubsub');
  }
});
```

#### Add `bustCache()` method

File: `src/modules/element-resolver/db.archetype-resolver.ts`

```typescript
/** Externally triggered cache bust (e.g. from pub/sub). */
bustCache(): void {
  this.cache = null;
  this.cacheExpiresAt = 0;
}
```

#### Worker shutdown cleanup

In the `shutdown` function, unsubscribe and disconnect:

```typescript
const shutdown = async (signal: string): Promise<void> => {
  logger.info({ event: 'shutdown', signal });
  await subRedis.unsubscribe('kaizen:archetype:invalidate').catch(() => {});
  await subRedis.quit().catch(() => {});
  await worker.close();
  await closePool();
  process.exit(0);
};
```

---

## 4. Observability Additions

| Counter | When |
|---|---|
| `llm.circuit_breaker_rejected` | LLM call rejected (circuit OPEN) |
| `llm.circuit_breaker_opened` | Circuit breaker transitioned to OPEN |
| `llm.circuit_breaker_closed` | Circuit breaker transitioned back to CLOSED |
| `classifier.dom_signal_unavailable` | Both AX trees null, using error+screenshot fallback |
| `classifier.selector_name_extracted` | `selectorToName` successfully extracted a name |
| `archetype.cache_invalidated_by_pubsub` | Worker received pub/sub bust signal |

---

## 5. Tests

### Unit: `src/modules/llm-gateway/__tests__/circuit-breaker.test.ts`

| # | Test |
|---|---|
| 1 | Starts in CLOSED state, `isOpen()` returns false |
| 2 | After 4 failures within 60s, stays CLOSED |
| 3 | After 5 failures within 60s, transitions to OPEN |
| 4 | In OPEN state, `isOpen()` returns true |
| 5 | After cooldown (30s), transitions to HALF_OPEN, `isOpen()` returns false |
| 6 | In HALF_OPEN, `recordSuccess()` transitions to CLOSED |
| 7 | In HALF_OPEN, `recordFailure()` transitions back to OPEN |
| 8 | Failures outside the 60s window reset the counter (does not trip) |
| 9 | `recordSuccess()` in CLOSED state resets failure count |

### Unit: `src/modules/healing-engine/__tests__/failure-classifier.selectorToName.test.ts`

| # | Test |
|---|---|
| 1 | Extracts name from `role=button[name="Login"]` → `"login"` |
| 2 | Extracts name from `role=textbox[name="Email Address"]` → `"email address"` |
| 3 | Extracts name from `aria-label="Submit"` → `"submit"` |
| 4 | Extracts name from `text="Add to Cart"` → `"add to cart"` |
| 5 | Returns null for CSS selector `#login-btn` |
| 6 | Returns null for XPath selector `//button[1]` |

### Unit: `src/modules/healing-engine/__tests__/failure-classifier.dom-unavailable.test.ts`

| # | Test |
|---|---|
| 1 | `classifyDOMSignal(null, null, ...)` returns `'Unavailable'` |
| 2 | `classifyDOMSignal(populatedTree, null, ...)` returns `'SparsePage'` (unchanged) |
| 3 | `classify()` with `Unavailable` DOM + `ElementNotFoundError` → `ELEMENT_REMOVED` |
| 4 | `classify()` with `Unavailable` DOM + `TimeoutError` + `HighSimilarity` → `TIMING` |
| 5 | `classify()` with `Unavailable` DOM + `TimeoutError` + `LowSimilarity` → `PAGE_NOT_LOADED` |
| 6 | `classify()` with `Unavailable` DOM + `StaleElementError` → `ELEMENT_MUTATED` |

### Unit: `src/modules/element-resolver/__tests__/db.archetype-resolver.pubsub.test.ts`

| # | Test |
|---|---|
| 1 | `learn()` publishes to `kaizen:archetype:invalidate` after successful DB write |
| 2 | `learn()` does not publish when DB write fails |
| 3 | `bustCache()` clears the in-memory cache (next `match()` queries DB) |
| 4 | `bustCache()` followed by `match()` returns updated archetype data |

---

## 6. Execution Order

- [ ] **Step 1:** Create `src/modules/llm-gateway/circuit-breaker.ts` with `CircuitBreaker` class
- [ ] **Step 2:** Integrate circuit breaker into `OpenAIGateway`
- [ ] **Step 3:** Add `'Unavailable'` to `DOMSignal` type in `failure-classifier.ts`
- [ ] **Step 4:** Fix `selectorToName` to handle ARIA role selectors
- [ ] **Step 5:** Update `classifyDOMSignal` to return `'Unavailable'` when both trees null
- [ ] **Step 6:** Update `classify()` decision table to handle `'Unavailable'` DOM signal
- [ ] **Step 7:** Add `redis?: Redis` param to `DBArchetypeResolver` constructor
- [ ] **Step 8:** Add `bustCache()` method to `DBArchetypeResolver`
- [ ] **Step 9:** Add Redis pub/sub publish to `DBArchetypeResolver.learn()`
- [ ] **Step 10:** Add Redis pub/sub subscriber in `worker.ts`
- [ ] **Step 11:** Update worker.ts: pass `cacheRedis` to `DBArchetypeResolver`
- [ ] **Step 12:** Update worker.ts: add `subRedis` subscriber + cleanup in shutdown
- [ ] **Step 13:** Write circuit breaker tests
- [ ] **Step 14:** Write failure classifier tests (selectorToName + DOM unavailable)
- [ ] **Step 15:** Write archetype pub/sub tests
- [ ] **Step 16:** Run `npm run typecheck && npm run lint && npm run test`

---

## 7. Files to Create / Modify

| Action | File |
|---|---|
| CREATE | `src/modules/llm-gateway/circuit-breaker.ts` |
| MODIFY | `src/modules/llm-gateway/openai.gateway.ts` — integrate circuit breaker |
| MODIFY | `src/modules/healing-engine/failure-classifier.ts` — fix selectorToName, add Unavailable |
| MODIFY | `src/modules/element-resolver/db.archetype-resolver.ts` — add Redis pub/sub, bustCache |
| MODIFY | `src/workers/worker.ts` — pub/sub subscriber, pass Redis to archetype resolver |
| CREATE | `src/modules/llm-gateway/__tests__/circuit-breaker.test.ts` |
| CREATE | `src/modules/healing-engine/__tests__/failure-classifier.selectorToName.test.ts` |
| CREATE | `src/modules/healing-engine/__tests__/failure-classifier.dom-unavailable.test.ts` |
| CREATE | `src/modules/element-resolver/__tests__/db.archetype-resolver.pubsub.test.ts` |

---

## 8. What Is NOT In This Spec

Deferred to future iterations:

- **Multi-provider LLM fallback:** When OpenAI is down, route to Anthropic (and vice versa).
  Currently the circuit breaker only fast-fails; a provider switchover adds significant
  complexity (different prompt formats, different pricing). Deferred to LLM gateway v2.
- **Adaptive healing budget:** Today MAX_ATTEMPTS_PER_STEP = 3 regardless of failure class.
  TIMING failures could benefit from more retries while LOGIC_FAILURE should retry 0 times.
  Deferred — requires strategy-specific budget tables.
- **Screenshot animation filtering:** Animated elements, loading spinners, and cursor blinks
  cause false PartialChange signals. A frame-diff approach (capture 2 screenshots 500ms
  apart, diff them to find animated regions, mask those regions) would improve Signal C
  accuracy. Deferred — requires Playwright multi-capture.
- **Locale-aware failure classification:** Error messages from Playwright may be localised
  in non-English environments. The regex-based `classifyErrorSignal` would fail. Deferred
  — Playwright's programmatic error types (not messages) are the correct long-term fix.
