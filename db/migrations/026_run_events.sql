-- =============================================================================
-- Kaizen — run_events: persisted chronological run log
-- Migration: 026_run_events
-- Spec ref: docs/specs/tests-ux/spec-run-report-view.md §1.1
--
-- Append-only event stream the worker writes as it executes a run, at sub-step
-- granularity (resolve → execute → assert → llm → heal, plus run-level + errors).
-- Powers the full-run report's chronological "pytest -v"-style log. Ordered by
-- (run_id, seq).
-- =============================================================================

CREATE TABLE IF NOT EXISTS run_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  run_id      UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_index  INT,                       -- compiled-step index; NULL for run-level events
  seq         INT NOT NULL,              -- monotonic order within the run
  level       TEXT NOT NULL DEFAULT 'info'
                CHECK (level IN ('debug', 'info', 'warn', 'error')),
  phase       TEXT NOT NULL              -- run | resolve | execute | assert | llm | heal | capture
                CHECK (phase IN ('run', 'resolve', 'execute', 'assert', 'llm', 'heal', 'capture')),
  message     TEXT NOT NULL,
  data        JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS run_events_run_seq_idx ON run_events (run_id, seq);
CREATE INDEX IF NOT EXISTS run_events_tenant_idx  ON run_events (tenant_id, created_at);

-- Row-level security: tenant isolation, consistent with the rest of the schema.
ALTER TABLE run_events ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'run_events' AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON run_events
      USING (tenant_id = current_setting('app.current_tenant_id')::uuid);
  END IF;
END$$;
