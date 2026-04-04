-- =============================================================================
-- Kaizen v3 — Phase 3: Relax step_results.step_id constraint
-- Migration: 005_nullable_step_results_step_id
--
-- step_results.step_id is NOT NULL by design (spec §5) because step_results
-- are supposed to reference versioned test_steps rows. However, the current
-- API accepts raw NL steps without creating test hierarchy rows (test_cases,
-- test_steps), so there is no step_id to reference.
--
-- Making step_id nullable allows the worker to record step outcomes now,
-- before the full test management UI (Phase 6) is built. Once test_cases
-- and test_steps are properly created via the UI, step_id will always be set.
-- =============================================================================

ALTER TABLE step_results
  ALTER COLUMN step_id DROP NOT NULL;
