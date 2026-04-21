# Kaizen — Master Specification Document
### Version 1.0 | Spec-Driven Development | Lead: [Your Name] | PO: [PO Name]

---

## Table of Contents

1. [Product Overview](#1-product-overview)
2. [Core Concepts & Glossary](#2-core-concepts--glossary)
3. [System Architecture](#3-system-architecture)
4. [Multi-Tenancy Model](#4-multi-tenancy-model)
5. [Data Model](#5-data-model)
6. [Service Specifications (Interfaces First)](#6-service-specifications-interfaces-first)
   - 6.1 ITestCompiler
   - 6.2 IDOMPruner
   - 6.3 IElementResolver
   - 6.4 IExecutionEngine
   - 6.5 IHealingStrategy / IHealingEngine
   - 6.6 ILLMGateway
   - 6.7 IBillingMeter
   - 6.8 IObservability
7. [DOM Pruning — Architecture](#7-dom-pruning--architecture)
8. [Element Resolution & Caching — Architecture](#8-element-resolution--caching--architecture)
9. [Selector Confidence & Decay Model](#9-selector-confidence--decay-model)
10. [Self-Healing Engine — Architecture](#10-self-healing-engine--architecture)
11. [Failure Classification System](#11-failure-classification-system)
12. [LLM Gateway — Architecture](#12-llm-gateway--architecture)
13. [Feedback Loop & Prompt Improvement](#13-feedback-loop--prompt-improvement)
14. [Test Versioning Model](#14-test-versioning-model)
15. [Parallel Execution & Worker Isolation](#15-parallel-execution--worker-isolation)
16. [CI/CD Integration](#16-cicd-integration)
17. [Observability Architecture](#17-observability-architecture)
18. [Billing & Metering Architecture](#18-billing--metering-architecture)
19. [Security Model](#19-security-model)
20. [Infrastructure](#20-infrastructure)
21. [Development Phases](#21-development-phases)
22. [Open Questions & Deferred Decisions](#22-open-questions--deferred-decisions)

---

## 1. Product Overview

### Problem Statement
UI test automation breaks when websites change. An element's CSS selector, ID, or position shifts after a deployment, and previously-passing tests fail — not because the app is broken, but because the test is fragile. Engineering teams spend significant time maintaining test suites instead of building product.

### What Kaizen Is
Kaizen is a SaaS platform where teams write tests in plain English. Kaizen uses AI to locate UI elements, executes those tests in real browsers, and automatically heals broken tests when elements change — without human intervention.

### Core Value Propositions
1. **Write tests in plain English** — no selector knowledge required.
2. **LLM cost efficiency at scale** — resolved elements are cached; similar steps reuse prior results.
3. **Self-healing** — tests that break due to UI changes fix themselves automatically.
4. **CI/CD native** — a CLI and REST API make Kaizen a drop-in addition to any pipeline.

### What Kaizen Is Not (v1)
- Not a full end-to-end test framework (no assertions beyond element interaction success)
- Not a test recorder (v2 feature)
- Not a load testing tool
- Not a visual regression testing tool (screenshot diffs are used internally for failure classification only)

---

## 2. Core Concepts & Glossary

| Term | Definition |
|---|---|
| **Test Suite** | A named collection of Test Cases belonging to a tenant. |
| **Test Case** | A named sequence of Test Steps that represent one user flow. |
| **Test Step** | A single natural-language instruction (e.g., "type 'hello' in the search box"). |
| **Step AST** | The compiled representation of a Test Step: `{ action, targetDescription, value, url }`. |
| **Selector Set** | An ordered array of CSS/XPath/ARIA selectors for one element, ranked by confidence. |
| **Selector Cache** | The persistent store of `(step_embedding, domain) → SelectorSet` mappings. |
| **Confidence Score** | A 0–1 float representing how reliably a selector has located its element historically. |
| **Healing Event** | A recorded instance where the self-healing engine attempted to fix a failing step. |
| **Tenant** | One organisation using Kaizen. All data is scoped to a tenant. |
| **Run** | One execution of a Test Suite or Test Case, producing a set of Step Results. |
| **Worker** | An isolated container running a Playwright browser, executing one Run at a time. |
| **LLM Gateway** | The internal service that proxies all LLM calls, enforcing dedup, budgets, and logging. |
| **Content Hash** | SHA-256 of normalised step text. Used as the immutable identifier for a step version. |
| **AX Tree** | Accessibility tree — the browser's semantic summary of interactive elements on a page. |
| **FailureClass** | The classified reason a step failed. Drives which healing strategy is applied. |

---

## 3. System Architecture

### Architecture Style: Modular Monolith (v1) → Service Extraction (v2+)

All modules are deployed as a single unit in v1. Each module has hard internal boundaries: no cross-module imports except through the defined interfaces in Section 6. This makes future service extraction a refactoring task, not a rewrite.

### Modules

```
kaizen/
├── api/                  # HTTP layer — routes, middleware, auth
├── modules/
│   ├── test-compiler/    # NL → Step AST
│   ├── dom-pruner/       # Page → candidate AX node list
│   ├── element-resolver/ # Step + DOM → SelectorSet (cache-first)
│   ├── execution-engine/ # Step AST + SelectorSet → browser action
│   ├── healing-engine/   # TestFailure → HealingResult
│   ├── llm-gateway/      # All outbound LLM calls
│   ├── billing-meter/    # Emit + aggregate billing events
│   └── observability/    # Logging, tracing, metrics
├── workers/              # Job queue consumers (Playwright runners) — separate process
├── db/                   # Migrations, seed, RLS policies
└── jobs/                 # Scheduled batch jobs (decay recompute, feedback loop, billing rollup)
```

### Request Flow (test run triggered from CI)

```
CLI → POST /runs
  → API gateway (auth, rate limit, tenant resolution)
    → TestCompiler.compile(steps)
      → for each step:
          → ElementResolver.resolve(step, domSnapshot)
              → SelectorCache.lookup(step.contentHash, domain)
              → [cache miss] → DOMPruner.prune(page) → LLMGateway.resolve(step, axNodes)
              → SelectorCache.write(result)
          → ExecutionEngine.execute(step, selectorSet)
              → [failure] → HealingEngine.heal(failure)
    → RunResult persisted
    → BillingMeter.emit(events)
  ← SSE stream / polling response to CLI
```

### External Dependencies

| Service | Purpose | Fallback |
|---|---|---|
| OpenAI / Anthropic API | LLM for element resolution | Configurable; abstracted behind ILLMGateway |
| PostgreSQL | Primary data store | — |
| Redis | Selector cache (hot), job queues, rate limiting | — |
| Pinecone / Weaviate | Vector store for semantic step embeddings | Can fallback to pgvector in Postgres |
| S3 / Cloudflare R2 | Screenshots, HAR files | — |
| Stripe | Billing | — |
| OpenTelemetry Collector | Trace aggregation | — |

---

## 4. Multi-Tenancy Model

### Strategy: Shared Database, Isolated Schema (Row-Level Security)

Every table carries a `tenant_id UUID NOT NULL` column. PostgreSQL Row-Level Security policies are defined on all tables. The application connects as a role that has RLS enforced — not as a superuser.

```sql
-- Example RLS policy (applied to every tenant-scoped table)
ALTER TABLE test_cases ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON test_cases
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);
```

The application sets `app.current_tenant_id` at the start of every database session, resolved from the JWT. A bug in application code cannot leak cross-tenant data because Postgres will reject the query.

### Vector Store Isolation

Each tenant gets a dedicated **namespace** in the vector store. Namespaces are cheap (metadata-level isolation) and prevent semantic queries from crossing tenant boundaries.

### Shared Knowledge Pool (Opt-in)

A separate `shared` namespace in the vector store holds selector resolutions keyed only by `(domain, step_embedding)` — no tenant attribution. Tenants who opt in (enterprise tier) contribute to and consume from this pool. A step resolved for `youtube.com/search` by any contributing tenant is available to all others on the next run. Implementation: before writing a new LLM-resolved selector to the tenant namespace, also write it to the shared namespace (if tenant has opted in). On cache lookup, check tenant namespace first, then shared namespace.

### Tenant Config Table

```
tenants
  id              UUID PK
  name            TEXT
  slug            TEXT UNIQUE          -- used in API paths and CLI
  plan_tier       ENUM('starter','growth','enterprise')
  feature_flags   JSONB                -- { shared_pool: true, ... }
  api_key_hash    TEXT                 -- SHA-256(raw_key), never store raw
  llm_budget_tokens_monthly  BIGINT
  max_concurrent_workers     INT
  created_at      TIMESTAMPTZ
  updated_at      TIMESTAMPTZ
```

---

## 5. Data Model

### Full Schema

> **Note:** The migration file `db/migrations/001_initial_schema.sql` is the authoritative, runnable SQL. The schema below is the canonical reference; always keep them in sync.

```sql
-- === ENUM TYPES ===
-- PostgreSQL requires custom types to be created before use in table definitions.
-- The spec originally used inline ENUM(...) syntax (MySQL-style), which is invalid
-- in PostgreSQL. The correct form is CREATE TYPE ... AS ENUM (...).

CREATE TYPE plan_tier          AS ENUM ('starter', 'growth', 'enterprise');
CREATE TYPE run_trigger        AS ENUM ('web', 'api', 'cli', 'schedule');
CREATE TYPE run_status         AS ENUM ('queued', 'running', 'passed', 'failed', 'healed', 'cancelled');
CREATE TYPE step_result_status AS ENUM ('passed', 'failed', 'healed', 'skipped');
CREATE TYPE billing_event_type AS ENUM ('LLM_CALL', 'TEST_RUN_STARTED', 'SCREENSHOT_STORED', 'STORAGE_GB_DAY');
CREATE TYPE key_scope          AS ENUM ('read_only', 'execute', 'admin');

-- === TENANTS ===
-- (defined above; plan_tier column uses the plan_tier type defined above)

-- === TEST HIERARCHY ===

CREATE TABLE test_suites (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  name            TEXT NOT NULL,
  description     TEXT,
  tags            TEXT[],
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE test_cases (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  suite_id        UUID NOT NULL REFERENCES test_suites(id),
  name            TEXT NOT NULL,
  base_url        TEXT NOT NULL,        -- e.g. https://staging.myapp.com
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- Immutable versioned steps
CREATE TABLE test_steps (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  case_id         UUID NOT NULL REFERENCES test_cases(id),
  position        INT NOT NULL,
  raw_text        TEXT NOT NULL,
  content_hash    TEXT NOT NULL,        -- SHA-256(normalise(raw_text))
  compiled_ast    JSONB,                -- { action, targetDescription, value }
  parent_step_id  UUID REFERENCES test_steps(id),  -- set when a step is edited
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(case_id, position, content_hash)
);

-- Join table: tracks which step version is active for each (case_id, position) pair.
-- When a step is edited, a new test_steps row is created (new content_hash,
-- parent_step_id → old id), the old test_case_steps row is deactivated, and a new
-- row is inserted pointing to the new version. Old step rows are never deleted —
-- full edit history is queryable via the parent_step_id linked list.
CREATE TABLE test_case_steps (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  case_id     UUID NOT NULL REFERENCES test_cases(id),
  step_id     UUID NOT NULL REFERENCES test_steps(id),
  position    INT NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- Partial unique index: only one active step per (case_id, position) at a time.
CREATE UNIQUE INDEX idx_test_case_steps_active_position
  ON test_case_steps (case_id, position)
  WHERE is_active = true;

-- === SELECTOR CACHE ===

CREATE TABLE selector_cache (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id),
  content_hash        TEXT NOT NULL,        -- links to test_steps.content_hash
  domain              TEXT NOT NULL,        -- e.g. youtube.com
  selectors           JSONB NOT NULL,       -- [{ selector, strategy, confidence }]
  confidence_score    FLOAT NOT NULL DEFAULT 1.0,
  outcome_window      JSONB NOT NULL DEFAULT '[]',  -- last 50 outcomes [true/false]
  last_verified_at    TIMESTAMPTZ,
  last_failed_at      TIMESTAMPTZ,
  fail_count_window   INT NOT NULL DEFAULT 0,
  is_shared           BOOLEAN DEFAULT false,  -- came from shared pool
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tenant_id, content_hash, domain)
);

-- Aliases table: maps a new content_hash to an existing selector_cache entry when
-- a step edit is detected as semantically equivalent (cosine similarity > 0.92).
-- CachedElementResolver checks this on cache miss before escalating to the LLM.
-- The alias inherits the parent's confidence_score. On first successful execution
-- via alias, a full independent selector_cache entry is created.
CREATE TABLE selector_cache_aliases (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  new_hash        TEXT NOT NULL,        -- the edited step's content_hash
  canonical_hash  TEXT NOT NULL,        -- points to the existing selector_cache entry
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tenant_id, new_hash)
);

-- === RUNS & RESULTS ===

CREATE TABLE runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  suite_id        UUID REFERENCES test_suites(id),
  case_id         UUID REFERENCES test_cases(id),
  triggered_by    run_trigger NOT NULL,
  status          run_status NOT NULL DEFAULT 'queued',
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  environment_url TEXT,                 -- the URL under test for this run
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE step_results (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id),
  run_id              UUID NOT NULL REFERENCES runs(id),
  step_id             UUID NOT NULL REFERENCES test_steps(id),
  content_hash        TEXT NOT NULL,
  status              step_result_status NOT NULL,
  cache_hit           BOOLEAN,
  selector_used       TEXT,
  selector_strategy   TEXT,            -- 'css', 'xpath', 'aria', 'text'
  duration_ms         INT,
  error_type          TEXT,
  failure_class       TEXT,            -- ELEMENT_REMOVED | ELEMENT_MUTATED | TIMING | ...
  screenshot_key      TEXT,            -- S3/R2 object key
  dom_snapshot_key    TEXT,
  healing_event_id    UUID,
  created_at          TIMESTAMPTZ DEFAULT now()
);

-- === HEALING EVENTS ===

CREATE TABLE healing_events (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id),
  step_result_id      UUID NOT NULL REFERENCES step_results(id),
  failure_class       TEXT NOT NULL,
  strategy_used       TEXT NOT NULL,
  attempts            INT NOT NULL,
  succeeded           BOOLEAN NOT NULL,
  new_selector        TEXT,
  old_selector        TEXT,
  duration_ms         INT,
  created_at          TIMESTAMPTZ DEFAULT now()
);

-- === LLM CALL LOG ===

CREATE TABLE llm_call_log (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id),
  prompt_hash         TEXT NOT NULL,    -- SHA-256(prompt_text) for dedup
  model               TEXT NOT NULL,
  prompt_tokens       INT,
  completion_tokens   INT,
  latency_ms          INT,
  cache_hit           BOOLEAN DEFAULT false,  -- was this served from LLM cache?
  purpose             TEXT,             -- 'element_resolution' | 'step_compilation'
  template_version    TEXT,             -- which prompt template was used
  created_at          TIMESTAMPTZ DEFAULT now()
);

-- === BILLING EVENTS (append-only) ===

CREATE TABLE billing_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  event_type  billing_event_type NOT NULL,
  quantity    NUMERIC NOT NULL,
  unit        TEXT NOT NULL,            -- 'tokens', 'runs', 'bytes', 'gb_days'
  metadata    JSONB,
  created_at  TIMESTAMPTZ DEFAULT now()
);
-- No UPDATE, no DELETE on this table. Enforced via Postgres policy.

-- === PROMPT TEMPLATES ===

CREATE TABLE prompt_templates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  version         TEXT NOT NULL,        -- semver e.g. '1.2.0'
  purpose         TEXT NOT NULL,        -- 'element_resolution' | 'step_compilation'
  template_text   TEXT NOT NULL,
  is_active       BOOLEAN DEFAULT false,
  success_rate    FLOAT,               -- computed by feedback loop job
  sample_count    INT DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(name, version)
);

-- === INDEXES ===
CREATE INDEX idx_selector_cache_lookup ON selector_cache(tenant_id, content_hash, domain);
CREATE INDEX idx_selector_cache_aliases_lookup ON selector_cache_aliases(tenant_id, new_hash);
CREATE INDEX idx_test_case_steps_case ON test_case_steps(case_id, step_id);
CREATE INDEX idx_step_results_run ON step_results(run_id);
CREATE INDEX idx_billing_events_tenant_month ON billing_events(tenant_id, date_trunc('month', created_at));
CREATE INDEX idx_healing_events_tenant ON healing_events(tenant_id, created_at);
CREATE INDEX idx_runs_tenant_status ON runs(tenant_id, status, created_at DESC);
CREATE INDEX idx_test_steps_case ON test_steps(case_id, position);
```

---

## 6. Service Specifications (Interfaces First)

> **SDD rule**: these interfaces are written and agreed upon before any implementation begins.
> All cross-module communication uses these interfaces. No module imports another module's implementation directly.

### 6.1 ITestCompiler

```typescript
interface ITestCompiler {
  /**
   * Parse a natural language test step into a structured AST.
   * Uses rule-based parsing first (fast, free), falls back to LLM.
   */
  compile(rawText: string): Promise<StepAST>;
  
  /**
   * Batch compile. Implementations may batch LLM calls for efficiency.
   */
  compileMany(steps: string[]): Promise<StepAST[]>;
}

type StepAST = {
  action: 'navigate' | 'click' | 'type' | 'select' | 'assert_visible' | 'wait' | 'press_key' | 'scroll';
  targetDescription: string | null;  // natural description of the element
  value: string | null;              // e.g. the text to type
  url: string | null;                // for navigate actions
  rawText: string;
  contentHash: string;
};
```

**Implementations** (registered in DI container):
- `RuleBasedCompiler` — regex + keyword matching for common patterns. Handles ~70% of steps without LLM.
- `LLMCompiler` — sends step to LLM with a structured output prompt. Used for ambiguous steps.
- `CompositeCompiler` — tries `RuleBasedCompiler` first; falls back to `LLMCompiler` if confidence < threshold.

---

### 6.2 IDOMPruner

```typescript
interface IDOMPruner {
  /**
   * Given a live Playwright page and a step's target description,
   * return a pruned list of candidate interactive nodes.
   * Pass 1: AX tree. Pass 2: enriched DOM region (only if pass 1 is empty).
   */
  prune(page: Page, targetDescription: string): Promise<CandidateNode[]>;
}

type CandidateNode = {
  role: string;           // 'button', 'textbox', 'link', etc.
  name: string;           // accessible name
  cssSelector: string;    // computed CSS selector
  xpath: string;          // computed XPath
  attributes: Record<string, string>;  // id, class, placeholder, aria-label, data-testid
  textContent: string;
  isVisible: boolean;
  similarityScore: number;  // pre-computed string similarity to targetDescription
};
```

---

### 6.3 IElementResolver

```typescript
interface IElementResolver {
  /**
   * Resolve a compiled step to an ordered set of selectors.
   * Implementations: CachedResolver, LLMResolver, CompositeResolver.
   */
  resolve(step: StepAST, context: ResolutionContext): Promise<SelectorSet>;
  
  /**
   * After a selector is used successfully, report back to update confidence.
   */
  recordSuccess(contentHash: string, domain: string, selectorUsed: string): Promise<void>;
  
  /**
   * After a selector fails, report back to trigger score decay.
   */
  recordFailure(contentHash: string, domain: string, selectorAttempted: string): Promise<void>;
}

type ResolutionContext = {
  tenantId: string;
  domain: string;
  page: Page;  // live Playwright page
};

type SelectorSet = {
  selectors: Array<{
    selector: string;
    strategy: 'css' | 'xpath' | 'aria' | 'text' | 'data-testid';
    confidence: number;
  }>;
  fromCache: boolean;
  cacheSource: 'tenant' | 'shared' | null;
};
```

**Implementations**:
- `CachedElementResolver` — Redis hot cache → Postgres → vector similarity lookup.
- `LLMElementResolver` — AX tree prune → LLM call via ILLMGateway → validate selectors against DOM.
- `CompositeElementResolver` — tries `CachedElementResolver`; falls back to `LLMElementResolver` on miss.

---

### 6.4 IExecutionEngine

```typescript
interface IExecutionEngine {
  /**
   * Execute a single step against a live browser page.
   * Returns result including which selector worked.
   */
  executeStep(step: StepAST, selectorSet: SelectorSet, page: Page): Promise<StepExecutionResult>;
}

type StepExecutionResult = {
  status: 'passed' | 'failed';
  selectorUsed: string | null;
  errorType: string | null;
  errorMessage: string | null;
  durationMs: number;
  screenshotKey: string | null;
  domSnapshotKey: string | null;
};
```

---

### 6.5 IHealingStrategy / IHealingEngine

```typescript
interface IHealingStrategy {
  /** Returns true if this strategy can handle the given failure class. */
  canHandle(failure: ClassifiedFailure): boolean;
  
  /** Attempt to heal. Returns result including whether it succeeded. */
  heal(failure: ClassifiedFailure, context: HealingContext): Promise<HealingAttempt>;
}

interface IHealingEngine {
  /** Run all applicable strategies in priority order until one succeeds. */
  heal(failure: ClassifiedFailure, context: HealingContext): Promise<HealingResult>;
}

type ClassifiedFailure = {
  stepResult: StepExecutionResult;
  failureClass: FailureClass;
  step: StepAST;
  previousSelector: string;
};

type FailureClass = 
  | 'ELEMENT_REMOVED'
  | 'ELEMENT_MUTATED'
  | 'ELEMENT_OBSCURED'
  | 'PAGE_NOT_LOADED'
  | 'TIMING'
  | 'LOGIC_FAILURE';

type HealingResult = {
  succeeded: boolean;
  strategyUsed: string;
  newSelector: string | null;
  attempts: number;
  durationMs: number;
};
```

**Strategy implementations** (in priority order):
1. `FallbackSelectorStrategy` — tries next-ranked selector from the existing SelectorSet.
2. `AdaptiveWaitStrategy` — retries with exponential backoff + smart polling (for `TIMING`).
3. `ResolveAndRetryStrategy` — triggers a fresh LLM re-resolution, updates cache, retries.
4. `EscalationStrategy` — marks test as requiring human review; sends notification.

---

### 6.6 ILLMGateway

```typescript
interface ILLMGateway {
  /**
   * Resolve element: given a step and candidate nodes, return ranked selectors.
   * Handles prompt construction, dedup check, caching, token logging.
   */
  resolveElement(
    step: StepAST,
    candidates: CandidateNode[],
    tenantId: string
  ): Promise<LLMResolutionResult>;
  
  /**
   * Compile step: parse ambiguous natural language into StepAST.
   */
  compileStep(rawText: string, tenantId: string): Promise<StepAST>;
}

type LLMResolutionResult = {
  selectors: Array<{ selector: string; strategy: string; confidence: number }>;
  fromCache: boolean;         // was this served from LLM response cache?
  promptTokens: number;
  completionTokens: number;
  templateVersion: string;
};
```

---

### 6.7 IBillingMeter

```typescript
interface IBillingMeter {
  emit(event: BillingEventInput): Promise<void>;
  getCurrentUsage(tenantId: string): Promise<TenantUsage>;
  isOverBudget(tenantId: string, forEventType: BillingEventType): Promise<boolean>;
}

type BillingEventInput = {
  tenantId: string;
  eventType: 'LLM_CALL' | 'TEST_RUN_STARTED' | 'SCREENSHOT_STORED' | 'STORAGE_GB_DAY';
  quantity: number;
  unit: string;
  metadata?: Record<string, unknown>;
};
```

---

### 6.8 IObservability

```typescript
interface IObservability {
  startSpan(name: string, attributes?: Record<string, string>): Span;
  log(level: 'info' | 'warn' | 'error', event: string, data: Record<string, unknown>): void;
  increment(metric: string, labels?: Record<string, string>): void;
  histogram(metric: string, value: number, labels?: Record<string, string>): void;
}
```

> All module implementations receive `IObservability` via constructor injection. All interface adapters (e.g., `CompositeElementResolver`) automatically wrap calls in spans and emit cache_hit/miss counters — observability is a cross-cutting concern, not an afterthought.

---

## 7. DOM Pruning — Architecture

### The Problem
A full browser DOM can contain 50,000+ tokens — unusable and expensive for LLM calls. Naive HTML extraction is also noisy. We need a compact, semantically rich representation of only the interactive elements relevant to the current step.

### Two-Pass Pruning Algorithm

**Pass 1 — Accessibility Tree Extraction (always runs)**

Playwright exposes `page.accessibility.snapshot()` — the browser's own accessibility tree (AX tree). This is already a semantic, compressed representation of the page. It contains roles (`button`, `textbox`, `link`, `combobox`, etc.), accessible names, and states.

Steps:
1. Extract full AX tree.
2. Filter to actionable roles only: `button`, `link`, `textbox`, `combobox`, `listbox`, `radio`, `checkbox`, `menuitem`, `tab`, `searchbox`.
3. Enrich each surviving node with: its best CSS selector (computed via Playwright's `element.evaluate`), its XPath, `data-testid` if present, `placeholder`, `aria-label`, `id`, visible text.
4. Run fast string-similarity (`Levenshtein` or `Jaro-Winkler`) between `step.targetDescription` and each node's accessible name + text. Score and sort.
5. Return top 20 candidates.

Typical output: 300–800 tokens. This goes to the LLM.

**Pass 2 — Enriched DOM Region (only if Pass 1 produces zero confident candidates)**

Trigger condition: all Pass 1 candidates have similarity score < 0.3 AND the AX tree returned fewer than 5 actionable nodes (suggesting the page may use non-semantic HTML).

Steps:
1. Identify the viewport region most likely to contain the target: scan for visible elements whose text contains keywords from `step.targetDescription`.
2. Extract the inner HTML of that region's closest ancestor container.
3. Strip all non-essential attributes, script tags, style attributes. Keep: `id`, `class`, `data-*`, `aria-*`, `type`, `placeholder`, `name`, `href`.
4. Hard-cap at 3,000 tokens. Truncate if needed.

Pass 2 is expected in < 5% of calls. Log every Pass 2 trigger — a high rate signals a site using non-standard HTML patterns that need to be handled.

### Prompt Structure (element resolution)

```
System: You are a browser automation assistant. Given a test step and a list of 
        candidate interactive elements, return the best CSS selectors to locate 
        the target element. Respond ONLY in JSON.

User:
Step: {{ step.rawText }}
Action: {{ step.action }}
Target: {{ step.targetDescription }}

Candidate elements ({{ candidates.length }}):
{{ candidates | formatCandidateList }}

Return JSON:
{
  "selectors": [
    { "selector": "string", "strategy": "css|xpath|aria|text|data-testid", "confidence": 0.0-1.0, "reasoning": "string" }
  ]
}
Return up to 5 selectors, ordered by confidence descending.
Prefer data-testid > aria-label > id > stable CSS > xpath.
```

---

## 8. Element Resolution & Caching — Architecture

### Cache Hierarchy (checked in order)

```
Level 1: Redis hot cache
  Key: "sel:{tenantId}:{contentHash}:{domain}"
  TTL: 1 hour
  Value: serialised SelectorSet JSON

Level 2: Postgres selector_cache table
  Lookup: tenant_id + content_hash + domain (exact)
  Condition: confidence_score > 0.4 AND last_verified_at > (now - 14 days)

Level 3: Vector similarity (tenant namespace)
  Embed step.rawText → query vector store
  Threshold: cosine similarity > 0.92
  Returns: SelectorSet from the semantically nearest step

Level 4: Shared pool (if tenant opted in)
  Same vector query against shared namespace

Level 5: LLM call
  Prune DOM → construct prompt → call LLM gateway → validate → persist
```

### Cache Write Flow (after LLM resolution)

1. Validate each returned selector by actually querying the live DOM (`page.$(selector)`). Discard any that return null.
2. Sort surviving selectors by: `data-testid` first, then `aria-label`, then `id`, then structural CSS, then XPath.
3. Assign initial confidence: `1.0` for `data-testid` selectors (most stable), `0.9` for ARIA, `0.8` for id, `0.7` for CSS, `0.6` for XPath.
4. Persist to Postgres `selector_cache`. Write to Redis Level 1.
5. Embed `step.rawText` and upsert to vector store (tenant namespace, and shared namespace if opted in).

### Semantic Dedup on Step Edit

When a user edits a test step's text, before creating a new content hash:
1. Embed the new text.
2. Query vector store for the existing version's embedding.
3. Compute cosine similarity.
4. If similarity > 0.92: prompt the user — "This looks like the same action. Reuse existing selector cache? (Yes / No, treat as new)".
5. If user confirms: link new content_hash to existing selector_cache entry. No LLM call needed.

---

## 9. Selector Confidence & Decay Model

### Sliding Window with Exponential Recency Weighting

Each `selector_cache` row maintains an `outcome_window` JSONB array: the last 50 execution outcomes as booleans (`true` = success, `false` = failure), most recent last.

**Score computation** (run after every outcome is recorded):

```
score = 0
total_weight = 0

for i, outcome in enumerate(reversed(outcome_window)):  // i=0 is most recent
  weight = 0.95 ^ i
  score += weight * (1 if outcome else 0)
  total_weight += weight

confidence_score = score / total_weight
```

This means a selector that worked 48/50 times but just failed twice is scored lower than one that worked 50/50 but has an older failure — recency matters.

### State Thresholds

| State | Condition | Action |
|---|---|---|
| **Healthy** | score ≥ 0.7 | Normal operation |
| **Degraded** | 0.4 ≤ score < 0.7 | Trigger background re-verification job |
| **Stale** | score < 0.4 OR last_verified_at > 14 days | Invalidate entry; next resolution goes to LLM |
| **Force-expired** | Manual trigger (e.g. tenant reports page changed) | Invalidate immediately |

### Background Re-verification

A scheduled job (runs every 6 hours) queries for all `selector_cache` entries in `Degraded` state. For each:
1. Open a headless browser against the stored domain.
2. Attempt to locate the element using the stored selectors.
3. Record the outcome (updates `outcome_window` and recomputes score).
4. If the top selector now fails but a fallback succeeds: reorder the `selectors` array.
5. If all selectors fail: mark as `Stale`, trigger LLM re-resolution.

This is proactive healing — tests are fixed before the next run fails.

---

## 10. Self-Healing Engine — Architecture

### Design: Chain of Responsibility

The `HealingEngine` holds an ordered list of `IHealingStrategy` implementations. On failure, it calls `canHandle()` on each in order and executes the first match. If that strategy fails, it continues down the chain.

### Strategy Priority Order

| Priority | Strategy | Handles | Description |
|---|---|---|---|
| 1 | `FallbackSelectorStrategy` | ELEMENT_MUTATED, ELEMENT_REMOVED | Try next-ranked cached selector |
| 2 | `AdaptiveWaitStrategy` | TIMING, PAGE_NOT_LOADED | Retry with smart wait (up to 10s, polling every 500ms) |
| 3 | `ResolveAndRetryStrategy` | ELEMENT_REMOVED, ELEMENT_MUTATED | Fresh LLM re-resolution; update cache; retry |
| 4 | `EscalationStrategy` | LOGIC_FAILURE, all unhandled | Notify team; mark test as needs-review |

### Healing Budget

To prevent runaway LLM costs from flaky tests:
- Maximum 3 healing attempts per step per run.
- Maximum 2 `ResolveAndRetryStrategy` calls per tenant per hour (rate-limited in Redis).
- If a step has failed AND triggered `ResolveAndRetryStrategy` in its last 5 consecutive runs: auto-disable healing for that step and notify the tenant.

### Healing Outcome Recording

Regardless of success/failure, every healing attempt writes a `healing_events` row. This is the input to the feedback loop (Section 13).

---

## 11. Failure Classification System

### The Problem
A Playwright `TimeoutError` is a symptom, not a cause. Correct classification determines which healing strategy to apply.

### Three-Signal Classification Matrix

After any step failure, collect three signals before classifying:

**Signal A — Error subtype**
- `ElementNotFoundError` → candidate: ELEMENT_REMOVED
- `StaleElementError` → candidate: ELEMENT_MUTATED
- `TimeoutError` → ambiguous; needs B + C
- `NavigationError` → PAGE_NOT_LOADED
- `AssertionError` → LOGIC_FAILURE

**Signal B — DOM diff**
Compare the AX tree snapshot taken at the start of the step with a new snapshot taken immediately after failure.
- Target selector no longer present → ELEMENT_REMOVED
- Target selector present but attributes changed → ELEMENT_MUTATED
- Target selector present, unchanged → element is there but unreachable → ELEMENT_OBSCURED or TIMING
- Entire AX tree is sparse (< 5 nodes) → PAGE_NOT_LOADED

**Signal C — Screenshot diff**
Compare screenshot at failure vs. last-known-good screenshot for this step.
- Visual similarity > 95% → page looks the same; the element is there → TIMING or ELEMENT_OBSCURED
- Visual similarity 60–95% → partial page change → ELEMENT_MUTATED or ELEMENT_REMOVED
- Visual similarity < 60% → major page change → PAGE_NOT_LOADED or LOGIC_FAILURE

### Classification Decision Table

| Error subtype | DOM diff | Screenshot diff | FailureClass |
|---|---|---|---|
| Any | Selector gone | Partial change | ELEMENT_REMOVED |
| Any | Attrs changed | Partial change | ELEMENT_MUTATED |
| TimeoutError | Selector present | High similarity | TIMING |
| TimeoutError | Selector present | Low similarity | ELEMENT_OBSCURED |
| NavigationError | Sparse tree | Low similarity | PAGE_NOT_LOADED |
| AssertionError | Any | Any | LOGIC_FAILURE |

### Implementation Note

Classification is deterministic code — no LLM involved. It runs in < 500ms. The screenshot diff uses a simple pixel-difference algorithm (no ML needed at this stage). The DOM diff is a structural comparison of the AX tree JSON.

---

## 12. LLM Gateway — Architecture

### Responsibilities

1. **Prompt deduplication** — cache LLM responses by prompt hash.
2. **Budget enforcement** — check `IBillingMeter.isOverBudget` before every call.
3. **DOM context management** — receive pre-pruned candidate list; construct prompt from active template.
4. **Response validation** — validate JSON schema of every LLM response.
5. **Token logging** — emit `LLM_CALL` billing event after every call.
6. **Retry logic** — on malformed response, retry once with a stricter prompt suffix.
7. **Model abstraction** — the gateway is the only place that knows which LLM provider/model is being used. All callers use `ILLMGateway`.

### Prompt Deduplication

```
cache_key = SHA-256(
  template_version +
  step.contentHash +
  domain +
  sorted_candidate_fingerprints  // hash of each candidate's role + name + cssSelector
)
```

Check Redis before every LLM call. TTL: 24 hours. If hit: return cached response, mark `fromCache: true`, do NOT emit billing event (no tokens consumed). Log the cache hit for efficiency tracking.

### Template Versioning and A/B Testing

Active prompt templates are stored in `prompt_templates` table. The gateway loads the active template on startup (cached in memory, refreshed every 5 minutes). A/B testing is done by assigning tenants to template variants via a consistent hash on `tenant_id` — no per-request randomness. This ensures a tenant always gets the same template, making debugging reproducible.

### Rate Limiting

Per-tenant rate limits enforced in Redis:
- Starter: 100 LLM calls / hour
- Growth: 1,000 LLM calls / hour
- Enterprise: 10,000 LLM calls / hour

If limit is exceeded: return a structured error `{ error: 'LLM_RATE_LIMITED', retryAfter: timestamp }`. The resolver falls back to the best available cached selector, even if degraded.

---

## 13. Feedback Loop & Prompt Improvement

### Data Pipeline (weekly batch job)

The `jobs/feedback-loop.ts` job runs weekly and:

1. Queries `llm_call_log` for all non-cached calls from the past 30 days, joined with `selector_cache` (current confidence score) and `healing_events` (was this selector eventually replaced?).

2. Groups by `template_version`. For each template:
   - **Success rate**: % of calls where the top-returned selector is still in use (not replaced by healing) 30 days later.
   - **First-try accuracy**: % of calls where the first returned selector was used successfully on first execution.
   - **Heal trigger rate**: % of calls that led to a `ResolveAndRetryStrategy` healing event within 7 days.

3. Updates `prompt_templates.success_rate` and `prompt_templates.sample_count`.

4. Generates a report artifact (written to S3): ranked template performance, top failing DOM patterns, top step categories requiring re-resolution.

### Acting on Results

- If a new template version achieves > 5% better success_rate than the current active version in A/B testing with > 500 sample calls: promote it to active.
- Log top-10 DOM patterns causing re-resolution → these are candidates for Pass 1 pruning rule improvements.

### Long-term: Fine-Tuning Dataset

Every `healing_event` where `succeeded: true` and `new_selector` is populated is a training example: `(step_text, dom_snapshot, correct_selector)`. After 10,000+ such examples, this dataset can be used to fine-tune a smaller, cheaper model (e.g., GPT-3.5 or a local model) specifically for selector resolution, reducing cost by 60–80%.

---

## 14. Test Versioning Model

### Immutable Steps

`test_steps` rows are never mutated after creation. An edit creates a new row with:
- New `content_hash`
- New `id`
- `parent_step_id` pointing to the previous version
- New `created_at`

The `test_cases` table references steps via a join table that can be updated to point to the new version. The old version row remains, making the full edit history queryable.

### Version Lineage Query

```sql
-- Get full history of a step (all versions)
WITH RECURSIVE lineage AS (
  SELECT * FROM test_steps WHERE id = :stepId
  UNION ALL
  SELECT ts.* FROM test_steps ts
  JOIN lineage l ON ts.id = l.parent_step_id
)
SELECT * FROM lineage ORDER BY created_at DESC;
```

### Cache Linkage on Semantic Edit

When a user edits step text and the system detects cosine similarity > 0.92 to the previous version:

```
new_content_hash → INSERT selector_cache_aliases (new_hash, existing_hash)
```

The `CachedElementResolver` checks this alias table on cache miss — if an alias exists, it returns the aliased entry's SelectorSet. No LLM call. The alias inherits the parent's confidence score. On first successful execution via alias, a full independent entry is created.

---

## 15. Parallel Execution & Worker Isolation

### Worker Architecture

Workers are separate Node.js processes running in Docker containers. They consume jobs from a BullMQ queue (backed by Redis). Workers are **stateless** — no local disk persistence.

### Tenant Concurrency Control

```
Redis key: "worker:concurrency:{tenantId}"
Value: current count of running jobs for this tenant
TTL: auto-expires if a worker crashes (set TTL = job timeout + 30s, refreshed every 10s)

On job pickup:
  if INCR("worker:concurrency:{tenantId}") > tenant.max_concurrent_workers:
    DECR("worker:concurrency:{tenantId}")
    re-queue job with delay
  else:
    proceed

On job complete/fail:
  DECR("worker:concurrency:{tenantId}")
```

### Browser Context Isolation

```
One Chromium process per worker container
  └── One BrowserContext per test run  ← strict isolation boundary
        └── One Page per test case being executed

BrowserContext is:
  - Created fresh for every run (never reused)
  - Configured with clean cookies, no cached state
  - Destroyed and garbage-collected after run completion
```

**Why not one process per run?** Chromium startup is ~800ms. With shared process + isolated contexts, startup cost is paid once per worker, not once per run. Context creation is ~50ms. This is the standard Playwright pattern for high-concurrency test farms.

### Worker Container Security

- No persistent filesystem writes (ephemeral `/tmp` only).
- Screenshots streamed directly to S3 via pre-signed URL — never written to worker disk.
- Network egress restricted to: target URL (configurable per-tenant allowlist), internal API, S3 endpoint.
- Workers do not have access to the Postgres database — they communicate only through the internal API and the job queue.
- Each worker container runs as a non-root user.

---

## 16. CI/CD Integration

### Two Execution Paths

**Async path** (web UI, scheduled runs): Job is enqueued; result is polled or received via webhook. No blocking.

**Synchronous path** (CLI, CI pipelines): Job is enqueued; client polls `GET /runs/{id}` with exponential backoff (starting 2s, max 30s, up to configurable timeout). Alternatively, tenant can configure a webhook URL to receive run completion events pushed to their CI system. Both paths use the same API.

### CLI Design

```bash
# Install
npm install -g @kaizen/cli

# Auth (run once)
kaizen auth --token kzn_live_xxxxx

# Run a suite
kaizen run --suite "smoke tests" --env https://staging.myapp.com

# Run a single case
kaizen run --case "user login flow" --env https://staging.myapp.com

# Run with timeout
kaizen run --suite "smoke tests" --timeout 300

# Output formats
kaizen run --suite "smoke tests" --reporter json > results.json
kaizen run --suite "smoke tests" --reporter junit > results.xml
```

### CLI Exit Codes

| Code | Meaning |
|---|---|
| 0 | All steps passed |
| 1 | One or more steps failed (not healed) |
| 2 | One or more steps were auto-healed (CI passes; notification sent) |
| 3 | Run timed out |
| 4 | Auth or configuration error |

### GitHub Actions Integration

```yaml
# .github/workflows/e2e.yml
- name: Run Kaizen tests
  uses: kaizen-hq/action@v1
  with:
    token: ${{ secrets.KAIZEN_TOKEN }}
    suite: "smoke tests"
    env-url: https://staging.${{ github.event.repository.name }}.com
    fail-on-healed: false  # CI passes even if healing occurred
```

### REST API (synchronous trigger)

```
POST /api/v1/runs
Body: { suiteId, environmentUrl, timeout? }
Response: { runId, streamUrl }

GET /api/v1/runs/:runId
Response: { status, steps: [...], startedAt, completedAt, healedCount }

GET /api/v1/runs/:runId/stream   (Server-Sent Events)
Events: step_started, step_passed, step_failed, step_healed, run_complete
```

---

## 17. Observability Architecture

### Three Layers

**Layer 1: Structured Logs**

Every log event is a JSON object with a fixed base schema:

```json
{
  "timestamp": "ISO-8601",
  "level": "info|warn|error",
  "event": "element_resolved",
  "tenantId": "uuid",
  "runId": "uuid",
  "stepId": "uuid",
  "durationMs": 124,
  "cacheHit": true,
  "cacheLevel": "redis",
  "metadata": {}
}
```

No string-interpolated log messages. Every loggable fact is a key-value pair. This makes logs queryable and alertable.

**Layer 2: OpenTelemetry Distributed Traces**

Trace per run. Span per step. Child spans for:
- `cache.lookup` (with `cache.level` and `cache.hit` attributes)
- `dom.prune` (with `pass` number and `candidates_returned` attribute)
- `llm.resolve` (with `model`, `prompt_tokens`, `completion_tokens`, `from_cache`)
- `browser.execute` (with `selector_strategy`, `duration_ms`)
- `healing.attempt` (with `strategy`, `failure_class`, `succeeded`)

Instrumented at the interface adapter level — all implementations automatically get traced via a proxy decorator.

**Layer 3: Business Metrics**

Emitted as OpenTelemetry metrics (exported to Prometheus or Datadog):

```
kaizen_llm_tokens_total{tenant, model, purpose}        counter
kaizen_cache_hit_ratio{tenant, cache_level}            gauge
kaizen_heal_success_rate{tenant, strategy}             gauge
kaizen_step_duration_ms{tenant, action}                histogram (p50, p95, p99)
kaizen_run_duration_ms{tenant}                         histogram
kaizen_worker_queue_depth{}                            gauge
kaizen_selector_confidence_avg{tenant, domain}         gauge
```

### Alerting Rules (define before launch)

- `kaizen_llm_tokens_total` rate > 150% of 7-day average → alert (runaway LLM usage)
- `kaizen_cache_hit_ratio` < 0.5 for any tenant for 1 hour → alert (cache degradation)
- `kaizen_worker_queue_depth` > 100 → alert (worker capacity issue)
- `healing_events` with `succeeded: false` rate > 30% over 1 hour → alert (healing broken)

---

## 18. Billing & Metering Architecture

### Append-Only Event Log

The `billing_events` table is append-only. A Postgres trigger prevents UPDATE and DELETE:

```sql
CREATE RULE no_update_billing AS ON UPDATE TO billing_events DO INSTEAD NOTHING;
CREATE RULE no_delete_billing AS ON DELETE TO billing_events DO INSTEAD NOTHING;
```

### What Emits Events

| Service | Event | Trigger |
|---|---|---|
| LLM Gateway | `LLM_CALL` | After every non-cached LLM call; quantity = total tokens |
| Execution Worker | `TEST_RUN_STARTED` | When a run begins; quantity = 1 |
| Storage Handler | `SCREENSHOT_STORED` | After writing screenshot; quantity = bytes |
| Billing Job | `STORAGE_GB_DAY` | Daily batch; quantity = total GB stored by tenant |

### Usage Aggregation

A scheduled job (runs hourly) computes a `monthly_usage` materialized view:

```sql
SELECT
  tenant_id,
  date_trunc('month', created_at) AS month,
  event_type,
  SUM(quantity) AS total
FROM billing_events
GROUP BY 1, 2, 3;
```

### Enforcement

The `IBillingMeter.isOverBudget()` call in the LLM Gateway checks this view (Redis-cached, refreshed every 5 minutes). If over budget:
- LLM calls are blocked.
- Test execution continues using best available cached selectors.
- Tenant receives an email notification.
- Tenant dashboard shows usage vs. limit prominently.

### Plan Limits (starter values — adjust for market)

| Resource | Starter | Growth | Enterprise |
|---|---|---|---|
| LLM tokens / month | 500K | 5M | Custom |
| Test runs / month | 500 | 5,000 | Custom |
| Screenshot storage | 1 GB | 20 GB | Custom |
| Concurrent workers | 2 | 10 | Custom |
| Shared knowledge pool | No | No | Yes (opt-in) |

---

## 19. Security Model

### API Key Management

- Keys are issued in the format `kzn_live_<32-random-hex>`. The prefix makes them detectable by secret scanners (GitHub, truffleHog).
- Only `SHA-256(key)` is stored in the database. The raw key is shown exactly once, at creation.
- Keys can be scoped: `read_only`, `execute`, `admin`.
- Keys have an optional expiry date.
- Every API request logs the key hash used — leaked key detection is possible via anomaly detection on key hash + IP.

### Test Credentials (secrets in tests)

Test steps may include sensitive values (e.g., "log in with username admin, password {{env.STAGING_PASSWORD}}"). The `{{env.VAR}}` syntax is resolved at execution time from a tenant-scoped encrypted secrets store:
- Secrets stored encrypted at rest using envelope encryption (AES-256-GCM with a KMS-managed key).
- Secrets are decrypted in the execution worker's memory only, for the duration of the step.
- Secret values are never logged. The `step_results` table stores a redacted version of the step text.
- Secrets are never sent to the LLM. Steps referencing secrets use a placeholder in the LLM prompt: `{{SECRET:REDACTED}}`.

### Worker Network Isolation

- Workers run in a VPC with no public IP.
- Egress is limited to: an allowlist of target domains (configured per tenant), S3 endpoint, and the internal API endpoint.
- Workers cannot reach the Postgres database, Redis, or the Vector DB directly.

### Data Encryption

- All data encrypted at rest (managed by cloud provider for Postgres, Redis, S3).
- All inter-service traffic over TLS 1.3.
- Vector embeddings contain no raw PII — they are numerical vectors derived from step text. However, step text itself may contain PII (e.g., test data). Tenants should be advised to use synthetic test data.

### Compliance Posture (future)

- SOC 2 Type II readiness: audit logging of all admin actions from day 1.
- GDPR: tenant data deletion endpoint that purges all rows, vector embeddings, and S3 objects for a tenant within 30 days.

---

## 20. Infrastructure

### v1 (Two-Person Team, < 50 Tenants)

| Component | Service | Notes |
|---|---|---|
| API + Modules | Single Node.js container (Fly.io or Railway) | Auto-scaling; start with 2 replicas |
| Workers | Separate Docker containers (same platform) | Scale independently; start with 4 |
| PostgreSQL | Neon (serverless Postgres) | Branching useful for migrations |
| Redis | Upstash | Serverless; generous free tier |
| Vector DB | Pinecone (serverless) | Namespace-per-tenant |
| Object Storage | Cloudflare R2 | No egress fees |
| Observability | Axiom (logs) + Grafana Cloud (metrics/traces) | Both have good free tiers |
| Billing | Stripe | Metered billing via usage records |

Estimated monthly cost at 50 active tenants, 20K test runs: ~$300–500.

### v2 (Post-PMF, 500+ Tenants)

- Extract workers to a dedicated auto-scaling service (Kubernetes or ECS).
- Extract LLM Gateway to its own service (highest blast radius if it has issues).
- Move from Neon to RDS Aurora Postgres with read replicas.
- Add CDN layer (Cloudflare) in front of the API for rate limiting and DDoS protection.

### Deployment Pipeline

```
git push → GitHub Actions:
  1. Run unit tests (jest --coverage, must be > 80%)
  2. Run integration tests (against test DB + mock LLM)
  3. Build Docker image, push to registry
  4. Deploy to staging (automatic)
  5. Run smoke test suite against staging via kaizen CLI
  6. Manual approval gate → deploy to production
  7. Run smoke tests against production
  8. Alert on failure, auto-rollback
```

---

## 21. Development Phases

### Phase 1 — Core Loop (Weeks 1–6)
> Goal: NL in, browser action out. One tenant, no auth.

- [ ] Database schema + migrations (all tables from Section 5)
- [ ] RLS policies on all tenant-scoped tables
- [ ] `ITestCompiler` — `RuleBasedCompiler` implementation (navigate, click, type, press_key)
- [ ] `IDOMPruner` — Pass 1 (AX tree extraction) implementation
- [ ] `ILLMGateway` — basic implementation (no dedup yet, no budget enforcement)
- [ ] `IElementResolver` — `LLMElementResolver` implementation
- [ ] `IExecutionEngine` — Playwright-backed implementation
- [ ] Job queue setup (BullMQ + Redis)
- [ ] Worker process (executes one run end-to-end)
- [ ] Basic REST API: `POST /runs`, `GET /runs/:id`

**Milestone**: Run "open youtube, search for cats, press enter" from a curl command.

### Phase 2 — Caching + Multi-Tenancy (Weeks 7–10)
> Goal: LLM calls only when needed. Real auth.

- [ ] `CachedElementResolver` implementation (Redis + Postgres levels)
- [ ] Vector store integration (Pinecone) — embed step text, semantic lookup
- [ ] Confidence score computation + decay model
- [ ] Background re-verification job
- [ ] Tenant auth (JWT, API key issuance, RLS enforcement)
- [ ] `IBillingMeter` — event emission + `isOverBudget` check
- [ ] LLM Gateway deduplication (prompt hash → Redis cache)
- [ ] Test versioning (immutable steps, `parent_step_id`, semantic dedup check)

**Milestone**: Cache hit rate > 80% for repeated test runs on same tenant.

### Phase 3 — Self-Healing (Weeks 11–14)
> Goal: Broken tests fix themselves.

- [ ] Screenshot capture and S3 upload in worker
- [ ] DOM snapshot capture in worker
- [ ] `FailureClassifier` — three-signal classification system
- [ ] `IHealingEngine` with chain-of-responsibility
- [ ] `FallbackSelectorStrategy`
- [ ] `AdaptiveWaitStrategy`
- [ ] `ResolveAndRetryStrategy`
- [ ] `EscalationStrategy` (email notification)
- [ ] `healing_events` persistence
- [ ] Healing budget enforcement (Redis rate limiting)

**Milestone**: A test that breaks because a button's class changes auto-heals and passes on the same run.

### Phase 4 — CI/CD + Observability (Weeks 15–18)
> Goal: Teams can integrate into their pipeline.

- [ ] CLI (`@kaizen/cli`) — auth, run, stream, exit codes
- [ ] SSE stream for run status
- [ ] JUnit + JSON reporters
- [ ] GitHub Actions action
- [ ] Structured logging implementation
- [ ] OpenTelemetry traces on all interface boundaries
- [ ] Business metrics emission
- [ ] Basic alerting rules

**Milestone**: Kaizen runs as a step in a real GitHub Actions workflow.

### Phase 5 — Web UI + Polish (Weeks 19–24)
> Goal: Sellable product with self-serve onboarding.

- [ ] Web app: auth, test suite editor, run history, step results viewer
- [ ] Screenshot diff viewer in UI
- [ ] Tenant dashboard: usage, cache hit ratio, heal rate
- [ ] Stripe billing integration
- [ ] `CompositeCompiler` with `LLMCompiler` fallback
- [ ] Feedback loop batch job
- [ ] Shared knowledge pool (enterprise tier)
- [ ] Pass 2 DOM pruning (fallback for non-semantic HTML)

---

## 22. Open Questions & Deferred Decisions

These are known unknowns. They should be resolved before the relevant phase begins, not at the start of the project.

| Question | Relevant Phase | Owner |
|---|---|---|
| Which LLM provider/model for v1? (OpenAI GPT-4o vs Anthropic Claude vs other) — affects cost model and prompt format. | Phase 1 | Lead Dev |
| What is the exact pricing model? (per-run, per-seat, token-based, or hybrid) | Phase 2 | PO |
| Should the CLI be Node.js (easy for web devs) or a compiled binary (no runtime dependency)? | Phase 4 | Lead Dev |
| What is the maximum acceptable test run latency for the sync CI path? Affects worker pool sizing. | Phase 4 | PO |
| GDPR / data residency: should tenant data be region-pinned? Affects cloud architecture choices. | Phase 5 | PO |
| Browser extension (record → generate test): is this v2 or v1.5? Shapes step format design. | Phase 5+ | PO |
| Fine-tuning a custom model: at what tenant/call volume does this become worth it? | Post-PMF | Lead Dev |
| Shared knowledge pool: what is the opt-in flow and trust model? Can tenants see which domains others are testing? | Phase 5 | PO |

---

*This document is the source of truth for Kaizen v1. All implementation decisions should reference back to this spec. When a decision diverges from what's written here, update the spec first — not after.*

*Last updated: [Date] | Status: Draft for review*
