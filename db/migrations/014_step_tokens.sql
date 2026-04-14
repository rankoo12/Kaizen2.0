-- Migration 014: per-step token attribution
--
-- tokens_used: LLM tokens consumed by the element resolver for this specific step.
-- Populated only when the LLM was called (resolveElement or compileStep).
-- Zero on pure cache hits — no LLM was invoked.
-- Replaces the fragile time-window billing_events heuristic in GET /runs/:id.

ALTER TABLE step_results ADD COLUMN IF NOT EXISTS tokens_used INT NOT NULL DEFAULT 0;
