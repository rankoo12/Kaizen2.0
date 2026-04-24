-- Migration: step_results.archetype_name
-- Spec: docs/specs/smart-brain/spec-element-resolver-archetype-disambiguation.md § S4
--
-- Records which archetype resolved each step (when resolution_source = 'archetype').
-- Enables the UI verdict route in src/api/routes/runs.ts to write an
-- archetype_failures cooldown row on fail — the resolver instance lives in the
-- worker process and is unreachable from the API, so the archetype name must be
-- persisted on the step_results row instead.

ALTER TABLE step_results
  ADD COLUMN IF NOT EXISTS archetype_name TEXT;
