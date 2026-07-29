-- =============================================================================
-- Kaizen — Test Writer: generation jobs + draft case lifecycle
-- Migration: 028_test_writer
-- Spec ref: docs/specs/test-writer/spec-test-writer-service.md §6,
--           docs/specs/tests-ux/spec-draft-review-ux.md §1
--
-- 1. New run_trigger value 'testwriter' — validation runs are attributed to
--    the Test Writer and excluded from customer run lists.
--    NOTE: PG16 allows ADD VALUE inside a transaction, but the new value must
--    NOT be used within this same migration file.
-- 2. generation_jobs — one row per analyze/suggest job (audit trail for scope
--    + auth consent, phase report, test plan).
-- 3. test_cases lifecycle columns — generated tests are drafts until a human
--    approves them; existing rows default to status='active', origin='user'.
-- =============================================================================

ALTER TYPE run_trigger ADD VALUE IF NOT EXISTS 'testwriter';

CREATE TABLE IF NOT EXISTS generation_jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  suite_id      UUID NOT NULL REFERENCES test_suites(id) ON DELETE CASCADE,
  target_url    TEXT NOT NULL,
  scope         TEXT NOT NULL DEFAULT 'public'
                  CHECK (scope IN ('public', 'authenticated')),
  auth_consent  BOOLEAN NOT NULL DEFAULT false,
  login_case_id UUID REFERENCES test_cases(id),
  status        TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'running', 'completed', 'failed', 'blocked')),
  options       JSONB NOT NULL DEFAULT '{}',
  test_plan     JSONB,                    -- PlannedScenario[] — written when PLAN completes
  report        JSONB,                    -- per-phase counts, rejections, tokenUsage
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  -- authenticated scope requires an explicit, recorded consent + login recipe
  CONSTRAINT generation_jobs_auth_consent CHECK (
    scope = 'public' OR (auth_consent AND login_case_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS generation_jobs_suite_idx
  ON generation_jobs (tenant_id, suite_id, created_at DESC);

ALTER TABLE generation_jobs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'generation_jobs' AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON generation_jobs
      USING (tenant_id = current_setting('app.current_tenant_id')::uuid);
  END IF;
END$$;

-- Draft lifecycle on test_cases. Existing rows keep working: they become
-- status='active', origin='user' via the column defaults.
ALTER TABLE test_cases
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'draft', 'validating', 'rejected', 'archived')),
  ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'user'
    CHECK (origin IN ('user', 'generated')),
  ADD COLUMN IF NOT EXISTS generation_job_id UUID REFERENCES generation_jobs(id),
  ADD COLUMN IF NOT EXISTS validation_run_id UUID REFERENCES runs(id);

CREATE INDEX IF NOT EXISTS test_cases_status_idx
  ON test_cases (tenant_id, suite_id, status);
