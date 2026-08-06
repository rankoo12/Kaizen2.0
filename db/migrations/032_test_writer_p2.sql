-- =============================================================================
-- Kaizen — Test Writer P2: plan-approval checkpoint, synthetic-data consent,
--                          Init Brief storage, draft provenance
-- Migration: 032_test_writer_p2
-- Spec ref: docs/specs/test-writer/spec-generation-pipeline.md §2.1, §6.2
--           docs/specs/test-writer/spec-test-writer-service.md §8, §12
--
-- NOTE on numbering: main took 028_run_total_steps / 030 / 031 while the Test
-- Writer branch held 028_test_writer / 029_site_model, so P2 continues at 032.
-- =============================================================================

-- 1. Plan-approval checkpoint — the job pauses after PLAN so a human approves
--    the matrix BEFORE any WRITE/VALIDATE spend (tokens + browser minutes).
ALTER TABLE generation_jobs DROP CONSTRAINT IF EXISTS generation_jobs_status_check;
ALTER TABLE generation_jobs ADD CONSTRAINT generation_jobs_status_check
  CHECK (status IN ('queued', 'running', 'awaiting_plan_approval', 'completed', 'failed', 'blocked'));

ALTER TABLE generation_jobs
  ADD COLUMN IF NOT EXISTS plan_approved_at TIMESTAMPTZ,
  -- Free-text steering notes captured at approval time; ride into the WRITE
  -- prompt as UNTRUSTED data (service spec §13.3).
  ADD COLUMN IF NOT EXISTS plan_notes TEXT;

-- 2. Per-suite synthetic-data consent + distilled Init Brief.
--    allow_synthetic_data gates VALIDATE execution for scenarios that create
--    real records (accounts, cart state) — default OFF, opt-in per suite.
--    tenant_brief is the distilled "describe your app" text: tenant-scoped
--    proprietary data, never shared, secret-scrubbed on intake.
ALTER TABLE test_suites
  ADD COLUMN IF NOT EXISTS allow_synthetic_data BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS tenant_brief JSONB;

-- 3. Draft provenance — which catalog archetype produced a generated case
--    (NULL for LLM gap-fill scenarios and user-authored cases). Starts the
--    telemetry clock; the scenario_archetypes table itself is deferred.
ALTER TABLE test_cases
  ADD COLUMN IF NOT EXISTS archetype_key TEXT;
