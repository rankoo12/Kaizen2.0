-- Migration 007: User verdict on step results + pinned selectors
--
-- Allows the QA dashboard to mark individual steps as pass/fail.
-- A 'passed' verdict pins the resolved selector so healing and re-resolution
-- never overwrite a selector that a human has explicitly validated.

BEGIN;

-- Human-provided verdict on a step result from the QA dashboard.
ALTER TABLE step_results
  ADD COLUMN IF NOT EXISTS user_verdict TEXT
    CHECK (user_verdict IN ('passed', 'failed'));

-- When set, this selector was explicitly validated by a human.
-- Pinned rows are returned unconditionally (confidence threshold bypassed)
-- and are never overwritten by healing or fresh LLM resolution.
ALTER TABLE selector_cache
  ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ;

COMMIT;
