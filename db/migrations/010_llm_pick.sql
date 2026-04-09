-- Migration 010: store which kaizenId the LLM picked and which candidates it was shown
--
-- llm_picked_kaizen_id: the kaizenId string returned by the LLM (e.g. "kz-135")
--   Lets the UI highlight exactly which row the LLM chose from the candidates table.
--   Null when resolution came from cache (LLM was never invoked).
--
-- dom_candidates: ALREADY added in 009, but from migration 009 it stored all pruner
--   candidates. Going forward the worker populates it with only the ranked list
--   the LLM actually saw (post role-filter + score-rank, top 7).
--   No schema change needed for dom_candidates itself.

ALTER TABLE step_results ADD COLUMN IF NOT EXISTS llm_picked_kaizen_id TEXT;
