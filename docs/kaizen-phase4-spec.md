# Phase 4 — Global Brain Seeding
**Branch:** `feat/core/phase-4-global-brain`  
**Spec ref:** `kaizen-spec-v3.md` §8 (Cache Hierarchy L4), §Phase 4

---

## Goal

Eliminate the cold-start problem for common UI patterns. A new tenant's first test run
against a well-known SaaS UI (e.g., GitHub login, Salesforce nav) should hit the shared
pool at L4 — **zero LLM calls on first run**.

## Milestone Definition

The milestone is met when:
1. Running `npm run brain:seed` populates `selector_cache` with at least 30 `is_shared=true` entries across 3+ domains.
2. A fresh tenant submitting `"click the Sign in button"` against `github.com` resolves from the shared pool (log shows `resolver.cache_hit { source: 'pgvector_shared' }`), not LLM.
3. Tenant opt-in is stored in DB and respected by the write path.

---

## What Already Exists (Do Not Rebuild)

| Existing | Location |
|---|---|
| L4 shared pool **lookup** | `CachedElementResolver:84-92` — queries `is_shared=true` rows, cosine > 0.92 |
| `is_shared` column on `selector_cache` | Migration 001 |
| `selector_cache_aliases` write on shared hit | `CachedElementResolver:89` |
| `step_embedding` + `element_embedding` + HNSW indexes | Migrations 001 + 004 |
| LLM embedding via `ILLMGateway.generateEmbedding` | `OpenAIGateway` |

**Gaps to close:**
1. No `global_brain_opt_in` flag on `tenants` — the write path has no way to check opt-in.
2. No write path — successful LLM resolutions are never contributed to the shared pool.
3. No `ISharedPoolService` interface or implementation.
4. Shared pool is empty (0 rows) — seeding script does not yet exist.
5. No attribution tracking (who contributed which shared entry).
6. No API endpoint to toggle opt-in.

---

## 1. Database Migration: 006

File: `db/migrations/006_global_brain.sql`

```sql
-- Tenant opt-in flag for contributing to and reading from the shared pool.
-- Enterprise tenants only (enforced at API layer, not DB level — Phase 5 adds plan checks).
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS global_brain_opt_in BOOLEAN NOT NULL DEFAULT false;

-- Attribution: tracks which tenant(s) contributed a given shared entry.
-- Stored as JSONB to allow multiple contributors per entry without a join table.
-- Shape: { "contributors": [{ "tenantId": "uuid", "contributedAt": "ISO" }], "source": "seed|tenant" }
ALTER TABLE selector_cache
  ADD COLUMN IF NOT EXISTS attribution JSONB;

-- Index: fast fetch of all shared entries per domain (used by seeding job verification)
CREATE INDEX IF NOT EXISTS idx_selector_cache_shared_domain
  ON selector_cache (domain)
  WHERE is_shared = true;
```

---

## 2. ISharedPoolService Interface (SDD — write interface before implementation)

File: `src/modules/shared-pool/interfaces.ts`

```typescript
/**
 * Spec ref: Phase 4 — Global Brain Seeding
 *
 * Governs writing to and reading metadata from the shared selector pool.
 * The read path (L4 lookup) lives in CachedElementResolver — do not duplicate it here.
 *
 * Quality gate: only entries with confidence_score >= QUALITY_THRESHOLD are eligible
 * for promotion. This prevents low-quality or flaky selectors from poisoning the pool.
 */

export interface ISharedPoolService {
  /**
   * Attempt to contribute a freshly-resolved tenant entry to the shared pool.
   * Silently skips if:
   *   - tenant's global_brain_opt_in = false
   *   - entry confidence_score < QUALITY_THRESHOLD (0.8)
   *   - a shared entry for the same (content_hash, domain) already exists
   *
   * On success: inserts a new is_shared=true row with tenant_id=NULL and attribution JSONB.
   * Fire-and-forget safe: caller should `void contribute(...)`.
   */
  contribute(params: ContributeParams): Promise<void>;

  /**
   * Returns true if the tenant is opted in and the shared pool should be written to.
   * Used by the write path to gate contribution without fetching the full tenant row.
   */
  isOptedIn(tenantId: string): Promise<boolean>;

  /**
   * Toggle opt-in for a tenant. Called by PATCH /tenants/me/brain-opt-in.
   */
  setOptIn(tenantId: string, value: boolean): Promise<void>;
}

export type ContributeParams = {
  tenantId: string;
  contentHash: string;
  domain: string;
  selectors: import('../../types').SelectorEntry[];
  stepEmbedding: number[];
  elementEmbedding: number[] | null;
  confidenceScore: number;
};
```

---

## 3. SharedPoolService Implementation

File: `src/modules/shared-pool/shared-pool.service.ts`

**Logic:**

```
contribute(params):
  1. isOptedIn(params.tenantId) → if false, return
  2. if params.confidenceScore < QUALITY_THRESHOLD (0.8), return
  3. Check if a shared entry already exists:
       SELECT id FROM selector_cache
       WHERE content_hash = $1 AND domain = $2 AND is_shared = true
       LIMIT 1
     If exists → UPDATE attribution to append this tenant as additional contributor (JSONB)
     If not exists → INSERT new row:
         tenant_id = NULL,
         is_shared = true,
         content_hash, domain, selectors, step_embedding, element_embedding,
         confidence_score = params.confidenceScore,
         attribution = { "contributors": [{ "tenantId": ..., "contributedAt": "..." }], "source": "tenant" }
  4. Log: obs.increment('shared_pool.contributed', { domain })

isOptedIn(tenantId):
  SELECT global_brain_opt_in FROM tenants WHERE id = $1
  Cache in Redis: "brain_opt_in:{tenantId}" TTL 5min (invalidate on setOptIn)

setOptIn(tenantId, value):
  UPDATE tenants SET global_brain_opt_in = $1 WHERE id = $2
  DEL Redis key "brain_opt_in:{tenantId}"
  Log: obs.log('info', 'shared_pool.opt_in_changed', { tenantId, value })
```

**Constructor:** `(redis: Redis, observability: IObservability)`

**Constants:**
```typescript
const QUALITY_THRESHOLD = 0.8;       // minimum confidence_score to contribute
const OPT_IN_CACHE_TTL = 300;        // Redis TTL seconds for isOptedIn cache
```

---

## 4. Wire SharedPoolService into the Write Path

File to modify: `src/modules/element-resolver/llm.element-resolver.ts`

**Where:** In `persistToCache()` — after the `INSERT INTO selector_cache` succeeds.

**What to add:**
```typescript
// After successful INSERT, contribute to shared pool (fire-and-forget)
void this.sharedPool.contribute({
  tenantId: context.tenantId,
  contentHash: step.contentHash,
  domain: context.domain,
  selectors: validatedSelectors,
  stepEmbedding,
  elementEmbedding,
  confidenceScore: 1.0,   // freshly resolved = max confidence
});
```

**Constructor change:** Add `private readonly sharedPool: ISharedPoolService` parameter.

**Wire-up:** Update `src/api/routes/runs.ts` and `src/workers/worker.ts` to construct
`SharedPoolService` and pass it to `LLMElementResolver`.

---

## 5. API Endpoint: Toggle Opt-In

File: `src/api/routes/auth.ts` (add alongside existing auth routes)

```
PATCH /auth/brain-opt-in
Headers: Authorization: Bearer kzn_live_xxx (admin scope required)
Body: { "optIn": boolean }
Response 200: { "tenantId": "...", "globalBrainOptIn": true/false }
```

Calls `SharedPoolService.setOptIn(req.tenantId, body.optIn)`.

No new file — add to existing `authRoutes`.

---

## 6. Seeding Script

File: `scripts/seed-global-brain.ts`

**Purpose:** Pre-populate the shared pool with verified selectors for common SaaS UIs
so new tenants get instant L4 hits with zero LLM calls.

**Run command:** Add to `package.json`:
```json
"brain:seed": "tsx scripts/seed-global-brain.ts"
```

**Script logic:**
```
1. For each SEED_TARGET in SEED_MANIFEST (see below):
   a. Launch Playwright, navigate to target.url
   b. For each step in target.steps:
      i.  Call LLMElementResolver to resolve the element (normal flow — LLM if needed)
      ii. Validate selector resolves on the live page
      iii. Generate step_embedding + element_embedding
      iv. Upsert into selector_cache with:
            is_shared = true,
            tenant_id = NULL,
            confidence_score = 1.0,
            attribution = { "contributors": [], "source": "seed", "seededAt": "ISO" }
   c. Log result per step: "seeded" | "skipped (already exists)" | "failed"
2. Print summary: X entries seeded, Y skipped, Z failed
```

**SEED_MANIFEST** (the list of sites + steps to seed):

```typescript
const SEED_MANIFEST: SeedTarget[] = [
  {
    domain: 'github.com',
    url: 'https://github.com/login',
    steps: [
      'type in the username or email field',
      'type in the password field',
      'click the Sign in button',
    ],
  },
  {
    domain: 'github.com',
    url: 'https://github.com',
    steps: [
      'click the Sign in link',
      'click the Sign up button',
    ],
  },
  {
    domain: 'login.salesforce.com',
    url: 'https://login.salesforce.com',
    steps: [
      'type in the email field',
      'type in the password field',
      'click the Log In button',
    ],
  },
  {
    domain: 'accounts.google.com',
    url: 'https://accounts.google.com',
    steps: [
      'type in the email field',
      'click the Next button',
      'type in the password field',
    ],
  },
  {
    domain: 'app.slack.com',
    url: 'https://slack.com/signin',
    steps: [
      'type in the email field',
      'click the Continue button',
    ],
  },
  {
    domain: 'linkedin.com',
    url: 'https://www.linkedin.com/login',
    steps: [
      'type in the email field',
      'type in the password field',
      'click the Sign in button',
    ],
  },
  {
    domain: 'twitter.com',
    url: 'https://twitter.com/login',
    steps: [
      'type in the phone, email, or username field',
      'click the Next button',
      'type in the password field',
      'click the Log in button',
    ],
  },
];
```

**Important notes for the script:**
- The script uses the real `LLMElementResolver` + `OpenAIGateway` — it will make real LLM calls.
- DNS must be available (run from Windows terminal, not this bash shell).
- The script should be idempotent: `ON CONFLICT (tenant_id, content_hash, domain) DO NOTHING`
  won't work for shared entries because `tenant_id = NULL`. Use a unique partial index instead
  (see migration 006 below — add `UNIQUE (content_hash, domain) WHERE is_shared = true`).
- Add `--dry-run` flag: prints what would be inserted without writing to DB.

**Migration 006 addition** (add to the SQL file):
```sql
-- Ensure uniqueness of shared entries per (content_hash, domain)
CREATE UNIQUE INDEX IF NOT EXISTS idx_selector_cache_shared_unique
  ON selector_cache (content_hash, domain)
  WHERE is_shared = true AND tenant_id IS NULL;
```

---

## 7. Tests

### Unit: `src/modules/shared-pool/__tests__/shared-pool.service.test.ts`

Test cases:
1. `contribute()` skips if `isOptedIn` returns false (no DB writes)
2. `contribute()` skips if `confidenceScore < 0.8` (quality gate)
3. `contribute()` inserts new row when no shared entry exists
4. `contribute()` updates attribution JSONB when shared entry already exists (second contributor)
5. `isOptedIn()` returns false when tenant has `global_brain_opt_in = false`
6. `isOptedIn()` caches in Redis; second call does not hit DB
7. `setOptIn()` updates DB and invalidates Redis cache

### Integration: verify L4 lookup hits seeded entries

File: `src/modules/element-resolver/__tests__/shared-pool.integration.test.ts`

Test flow (uses real pool, mock Redis):
1. Insert a shared `selector_cache` row with known `step_embedding` and `is_shared=true`
2. Call `CachedElementResolver.resolve()` with a step whose embedding is cosine-close (> 0.92) to that row
3. Assert result has `cacheSource: 'shared'`
4. Assert `selector_cache_aliases` row was written for the tenant

---

## 8. Execution Order

Follow strictly in this order — each step depends on the previous:

- [ ] **Step 1:** Write migration `006_global_brain.sql` and run `npm run db:migrate`
- [ ] **Step 2:** Write `src/modules/shared-pool/interfaces.ts`
- [ ] **Step 3:** Write `src/modules/shared-pool/shared-pool.service.ts`
- [ ] **Step 4:** Modify `src/modules/element-resolver/llm.element-resolver.ts` — add `sharedPool` param + call `contribute()` in `persistToCache()`
- [ ] **Step 5:** Update `src/api/routes/runs.ts` + `src/workers/worker.ts` — construct and inject `SharedPoolService`
- [ ] **Step 6:** Add `PATCH /auth/brain-opt-in` to `src/api/routes/auth.ts`
- [ ] **Step 7:** Write `scripts/seed-global-brain.ts`
- [ ] **Step 8:** Add `"brain:seed": "tsx scripts/seed-global-brain.ts"` to `package.json`
- [ ] **Step 9:** Enable opt-in for the dev tenant: `UPDATE tenants SET global_brain_opt_in = true WHERE slug = 'test-tenant'`
- [ ] **Step 10:** Write unit tests (`shared-pool.service.test.ts`)
- [ ] **Step 11:** Write integration test (`shared-pool.integration.test.ts`)
- [ ] **Step 12:** Run `npm run brain:seed` from a terminal with internet access (Windows terminal, not bash shell)
- [ ] **Step 13:** Verify milestone: submit a run with a step matching a seeded entry and confirm `pgvector_shared` cache hit in logs

---

## 9. Files to Create / Modify

| Action | File |
|---|---|
| CREATE | `db/migrations/006_global_brain.sql` |
| CREATE | `src/modules/shared-pool/interfaces.ts` |
| CREATE | `src/modules/shared-pool/shared-pool.service.ts` |
| CREATE | `src/modules/shared-pool/__tests__/shared-pool.service.test.ts` |
| CREATE | `src/modules/shared-pool/__tests__/shared-pool.integration.test.ts` |
| CREATE | `scripts/seed-global-brain.ts` |
| MODIFY | `src/modules/element-resolver/llm.element-resolver.ts` — inject + call SharedPoolService |
| MODIFY | `src/api/routes/runs.ts` — construct SharedPoolService, pass to resolver |
| MODIFY | `src/workers/worker.ts` — construct SharedPoolService, pass to resolver |
| MODIFY | `src/api/routes/auth.ts` — add PATCH /auth/brain-opt-in |
| MODIFY | `package.json` — add brain:seed script |

---

## 10. What Is NOT In Phase 4

Deferred to future phases:

- **Plan gating**: Only `enterprise` plan tenants may opt in. Enforcement deferred to Phase 5 (billing/plan checks).
- **UI toggle**: The opt-in toggle is API-only in Phase 4. A settings page belongs to the product UI (post-Phase 5).
- **Quality decay for shared entries**: Shared entries have a static confidence score. Decay (outcome_window tracking for shared rows) is deferred — shared entries do not participate in per-run outcome tracking.
- **Cross-domain patterns**: Shared pool is domain-scoped. A generic "click the Submit button" that works across all domains is intentionally excluded — the domain filter prevents false positives.
- **Crawler / scheduled re-seeding**: The seeding script is manual/one-shot. An automated re-crawl scheduler is future work.
- **Semantic dedup on step edit**: `selector_cache_aliases` dedup on edit is specified in §8 of the main spec but deferred — it needs a UI prompt. Deferred to the product UI phase.
