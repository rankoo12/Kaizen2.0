-- =============================================================================
-- Kaizen — async persistence prerequisites (worker service decomposition)
-- Migration: 027_async_persistence
-- Spec ref: docs/specs/workers/spec-service-decomposition.md §4.3, §6
--
-- With step_results / run_events written asynchronously by the persistence
-- consumer, wall-clock insert order no longer matches execution order. The
-- read side must order on logical position, not created_at:
--
--   * step_results.step_index — the compiled-step index this row belongs to.
--     Nullable: rows written before this migration (and by pre-decomposition
--     workers) have NULL; the runs API falls back to created_at for those.
--
--   * run_events (run_id, seq) UNIQUE — seq is already monotonic per run
--     (single producer). The unique index makes the persist consumer's batch
--     insert idempotent under BullMQ double-delivery (ON CONFLICT DO NOTHING).
--
-- Additive only — safe to apply while a pre-decomposition worker is live on
-- the shared database.
-- =============================================================================

ALTER TABLE step_results ADD COLUMN IF NOT EXISTS step_index INT;

CREATE INDEX IF NOT EXISTS step_results_run_step_idx
  ON step_results (run_id, step_index);

CREATE UNIQUE INDEX IF NOT EXISTS run_events_run_seq_uq
  ON run_events (run_id, seq);
