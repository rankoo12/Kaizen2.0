-- Migration 009: store DOM pruner candidates per step result
--
-- dom_candidates: compact JSONB array of every element the DOM pruner extracted
--   and presented to the LLM for disambiguation. Null when the result came
--   entirely from cache (no DOM prune was performed).
--   Schema: [{ kaizenId, role, name, selector }]
--
-- Useful for debugging wrong LLM picks: you can see exactly what was on the
-- page at resolution time, whether the right element was extracted at all,
-- and which one the LLM chose.

ALTER TABLE step_results ADD COLUMN IF NOT EXISTS dom_candidates JSONB;
