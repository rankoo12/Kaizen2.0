-- =============================================================================
-- Kaizen — step_results capture columns
-- Migration: 024_step_results_capture
-- Spec ref: docs/specs/workers/spec-engine-capabilities-assert-random-capture.md §3.5
--
-- Records run-scoped variable capture per step:
--   captured_name  — the variable name a step captured into (StepAST.captureAs)
--   captured_value — the value captured (the resolved element's text)
--
-- Both are nullable; the vast majority of steps capture nothing. They surface on
-- the run details page to make cross-step linkage (capture → later assertion)
-- visible to the viewer.
-- =============================================================================

ALTER TABLE step_results
  ADD COLUMN IF NOT EXISTS captured_name  TEXT,
  ADD COLUMN IF NOT EXISTS captured_value TEXT;
