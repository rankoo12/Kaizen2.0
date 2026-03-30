-- =============================================================================
-- Kaizen v1 — Initial Schema
-- Migration: 001_initial_schema
-- Spec ref: docs/kaizen-spec-v1.md §5 (Data Model)
--
-- Changes from the spec draft (applied here as canonical fixes):
--   1. ENUM types defined as PostgreSQL CREATE TYPE (required syntax).
--   2. test_case_steps join table added — allows test_cases to point to new
--      step versions on edit while preserving full step history.
--   3. selector_cache_aliases table added — maps a new content_hash to an
--      existing selector_cache entry when a step edit is detected as
--      semantically equivalent (cosine similarity > 0.92), avoiding an LLM call.
-- =============================================================================

-- ─── ENUM TYPES ──────────────────────────────────────────────────────────────
-- PostgreSQL requires custom types to be created before they are used in
-- table column definitions.

CREATE TYPE plan_tier AS ENUM ('starter', 'growth', 'enterprise');
CREATE TYPE run_trigger AS ENUM ('web', 'api', 'cli', 'schedule');
CREATE TYPE run_status AS ENUM ('queued', 'running', 'passed', 'failed', 'healed', 'cancelled');
CREATE TYPE step_result_status AS ENUM ('passed', 'failed', 'healed', 'skipped');
CREATE TYPE billing_event_type AS ENUM (
  'LLM_CALL',
  'TEST_RUN_STARTED',
  'SCREENSHOT_STORED',
  'STORAGE_GB_DAY'
);
CREATE TYPE key_scope AS ENUM ('read_only', 'execute', 'admin');

-- ─── TENANTS ─────────────────────────────────────────────────────────────────

CREATE TABLE tenants (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                        TEXT NOT NULL,
  slug                        TEXT UNIQUE NOT NULL,          -- used in API paths and CLI
  plan_tier                   plan_tier NOT NULL DEFAULT 'starter',
  feature_flags               JSONB NOT NULL DEFAULT '{}',  -- { shared_pool: true, ... }
  api_key_hash                TEXT,                         -- SHA-256(raw_key); raw key never stored
  llm_budget_tokens_monthly   BIGINT NOT NULL DEFAULT 500000,
  max_concurrent_workers      INT NOT NULL DEFAULT 2,
  created_at                  TIMESTAMPTZ DEFAULT now(),
  updated_at                  TIMESTAMPTZ DEFAULT now()
);

-- ─── TEST HIERARCHY ──────────────────────────────────────────────────────────

CREATE TABLE test_suites (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  name        TEXT NOT NULL,
  description TEXT,
  tags        TEXT[],
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE test_cases (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  suite_id    UUID NOT NULL REFERENCES test_suites(id),
  name        TEXT NOT NULL,
  base_url    TEXT NOT NULL,                                -- e.g. https://staging.myapp.com
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- Immutable versioned steps.
-- Rows are NEVER updated after creation. An edit creates a new row with a new
-- content_hash and parent_step_id pointing to the previous version.
-- The test_case_steps join table (below) tracks which version is "active".
CREATE TABLE test_steps (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  case_id         UUID NOT NULL REFERENCES test_cases(id),
  position        INT NOT NULL,
  raw_text        TEXT NOT NULL,
  content_hash    TEXT NOT NULL,                            -- SHA-256(normalise(raw_text))
  compiled_ast    JSONB,                                    -- { action, targetDescription, value }
  parent_step_id  UUID REFERENCES test_steps(id),          -- set when a step is edited
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(case_id, position, content_hash)
);

-- Join table: tracks which step version is active for each (case, position) pair.
--
-- When a user edits a step:
--   1. A new test_steps row is inserted (new content_hash, parent_step_id = old id).
--   2. The old test_case_steps row is set is_active = false.
--   3. A new test_case_steps row is inserted pointing to the new step.
--
-- The old test_steps row is never deleted — full edit history is preserved and
-- queryable via the parent_step_id linked list.
CREATE TABLE test_case_steps (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  case_id     UUID NOT NULL REFERENCES test_cases(id),
  step_id     UUID NOT NULL REFERENCES test_steps(id),
  position    INT NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- Partial unique index: only one active step per (case, position) pair at a time.
CREATE UNIQUE INDEX idx_test_case_steps_active_position
  ON test_case_steps (case_id, position)
  WHERE is_active = true;

-- ─── SELECTOR CACHE ──────────────────────────────────────────────────────────

CREATE TABLE selector_cache (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id),
  content_hash      TEXT NOT NULL,                          -- links to test_steps.content_hash
  domain            TEXT NOT NULL,                          -- e.g. youtube.com
  selectors         JSONB NOT NULL,                         -- [{ selector, strategy, confidence }]
  confidence_score  FLOAT NOT NULL DEFAULT 1.0,
  outcome_window    JSONB NOT NULL DEFAULT '[]',            -- last 50 outcomes [true/false], recent-last
  last_verified_at  TIMESTAMPTZ,
  last_failed_at    TIMESTAMPTZ,
  fail_count_window INT NOT NULL DEFAULT 0,
  is_shared         BOOLEAN DEFAULT false,                  -- came from shared knowledge pool
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tenant_id, content_hash, domain)
);

-- Aliases table: maps an edited step's content_hash to an existing selector_cache entry
-- when the edit is detected as semantically equivalent (cosine similarity > 0.92).
--
-- CachedElementResolver checks this table on a cache miss before escalating to the LLM.
-- The alias inherits the parent's confidence_score. On first successful execution via
-- alias, a full independent selector_cache entry is created.
CREATE TABLE selector_cache_aliases (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  new_hash        TEXT NOT NULL,                            -- the edited step's content_hash
  canonical_hash  TEXT NOT NULL,                            -- points to the existing selector_cache entry
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tenant_id, new_hash)
);

-- ─── RUNS & RESULTS ──────────────────────────────────────────────────────────

CREATE TABLE runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  suite_id        UUID REFERENCES test_suites(id),
  case_id         UUID REFERENCES test_cases(id),
  triggered_by    run_trigger NOT NULL,
  status          run_status NOT NULL DEFAULT 'queued',
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  environment_url TEXT,                                     -- URL under test for this run
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE step_results (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id),
  run_id            UUID NOT NULL REFERENCES runs(id),
  step_id           UUID NOT NULL REFERENCES test_steps(id),
  content_hash      TEXT NOT NULL,
  status            step_result_status NOT NULL,
  cache_hit         BOOLEAN,
  selector_used     TEXT,
  selector_strategy TEXT,                                   -- 'css' | 'xpath' | 'aria' | 'text'
  duration_ms       INT,
  error_type        TEXT,
  failure_class     TEXT,                                   -- FailureClass value
  screenshot_key    TEXT,                                   -- S3/R2 object key
  dom_snapshot_key  TEXT,
  healing_event_id  UUID,
  created_at        TIMESTAMPTZ DEFAULT now()
);

-- ─── HEALING EVENTS ──────────────────────────────────────────────────────────

CREATE TABLE healing_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  step_result_id  UUID NOT NULL REFERENCES step_results(id),
  failure_class   TEXT NOT NULL,
  strategy_used   TEXT NOT NULL,
  attempts        INT NOT NULL,
  succeeded       BOOLEAN NOT NULL,
  new_selector    TEXT,
  old_selector    TEXT,
  duration_ms     INT,
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- ─── LLM CALL LOG ────────────────────────────────────────────────────────────

CREATE TABLE llm_call_log (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id),
  prompt_hash       TEXT NOT NULL,                          -- SHA-256(prompt_text) for dedup
  model             TEXT NOT NULL,
  prompt_tokens     INT,
  completion_tokens INT,
  latency_ms        INT,
  cache_hit         BOOLEAN DEFAULT false,                  -- served from LLM response cache?
  purpose           TEXT,                                   -- 'element_resolution' | 'step_compilation'
  template_version  TEXT,
  created_at        TIMESTAMPTZ DEFAULT now()
);

-- ─── BILLING EVENTS (append-only) ────────────────────────────────────────────

CREATE TABLE billing_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  event_type  billing_event_type NOT NULL,
  quantity    NUMERIC NOT NULL,
  unit        TEXT NOT NULL,                                -- 'tokens', 'runs', 'bytes', 'gb_days'
  metadata    JSONB,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- Enforce append-only semantics at the database level.
-- No application-layer bug can corrupt the audit trail.
CREATE RULE no_update_billing AS ON UPDATE TO billing_events DO INSTEAD NOTHING;
CREATE RULE no_delete_billing AS ON DELETE TO billing_events DO INSTEAD NOTHING;

-- ─── PROMPT TEMPLATES ────────────────────────────────────────────────────────

CREATE TABLE prompt_templates (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  version       TEXT NOT NULL,                              -- semver, e.g. '1.2.0'
  purpose       TEXT NOT NULL,                              -- 'element_resolution' | 'step_compilation'
  template_text TEXT NOT NULL,
  is_active     BOOLEAN DEFAULT false,
  success_rate  FLOAT,                                      -- computed by weekly feedback loop job
  sample_count  INT DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE(name, version)
);

-- ─── INDEXES ─────────────────────────────────────────────────────────────────

CREATE INDEX idx_selector_cache_lookup
  ON selector_cache (tenant_id, content_hash, domain);

CREATE INDEX idx_selector_cache_aliases_lookup
  ON selector_cache_aliases (tenant_id, new_hash);

CREATE INDEX idx_test_case_steps_case
  ON test_case_steps (case_id, step_id);

CREATE INDEX idx_step_results_run
  ON step_results (run_id);

CREATE INDEX idx_billing_events_tenant_month
  ON billing_events (tenant_id, created_at);

CREATE INDEX idx_healing_events_tenant
  ON healing_events (tenant_id, created_at);

CREATE INDEX idx_runs_tenant_status
  ON runs (tenant_id, status, created_at DESC);

CREATE INDEX idx_test_steps_case
  ON test_steps (case_id, position);

-- ─── ROW LEVEL SECURITY ──────────────────────────────────────────────────────
-- The application sets app.current_tenant_id from the resolved JWT at the start
-- of every database session. A bug in application code cannot leak cross-tenant
-- data because Postgres will reject the query at the RLS policy level.

ALTER TABLE test_suites             ENABLE ROW LEVEL SECURITY;
ALTER TABLE test_cases              ENABLE ROW LEVEL SECURITY;
ALTER TABLE test_steps              ENABLE ROW LEVEL SECURITY;
ALTER TABLE test_case_steps         ENABLE ROW LEVEL SECURITY;
ALTER TABLE selector_cache          ENABLE ROW LEVEL SECURITY;
ALTER TABLE selector_cache_aliases  ENABLE ROW LEVEL SECURITY;
ALTER TABLE runs                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE step_results            ENABLE ROW LEVEL SECURITY;
ALTER TABLE healing_events          ENABLE ROW LEVEL SECURITY;
ALTER TABLE llm_call_log            ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_events          ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON test_suites
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE POLICY tenant_isolation ON test_cases
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE POLICY tenant_isolation ON test_steps
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE POLICY tenant_isolation ON test_case_steps
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE POLICY tenant_isolation ON selector_cache
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE POLICY tenant_isolation ON selector_cache_aliases
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE POLICY tenant_isolation ON runs
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE POLICY tenant_isolation ON step_results
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE POLICY tenant_isolation ON healing_events
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE POLICY tenant_isolation ON llm_call_log
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE POLICY tenant_isolation ON billing_events
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);
