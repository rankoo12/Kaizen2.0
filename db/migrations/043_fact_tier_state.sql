-- 043_fact_tier_state.sql — the fact tier's honest label.
--
-- Spec: docs/specs/test-writer/spec-agentic-testwriter.md §4
--
-- Batch-verified facts are proven by a live browser replay (recorded selectors,
-- no model, no engine run), which is real evidence but NOT the engine proof
-- 'validated' promises. They get their own state so the two can never be
-- confused: 'validated' still means an engine run passed and the oracle
-- survived the audit; 'verified_batch' means the fact held in the batch
-- session, with an engine-run audit sample standing behind the batch.

BEGIN;

DO $$
DECLARE
  cname text;
BEGIN
  SELECT conname INTO cname
    FROM pg_constraint
   WHERE conrelid = 'test_cases'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%validation_state%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE test_cases DROP CONSTRAINT %I', cname);
  END IF;
END $$;

ALTER TABLE test_cases
  ADD CONSTRAINT test_cases_validation_state_check
  CHECK (validation_state IN (
    'validated',        -- ran green through the engine, oracle survived the audit
    'verified_batch',   -- held in the fact tier's live batch session
    'healed',           -- passed only after self-healing — the selector was wrong
    'weak_oracle',      -- ran green; the final check may not be reading what it names
    'vacuous_oracle',   -- ran green; the final check ALSO passed with the actions removed
    'flaky',            -- failed then passed on retry
    'unproven_signin',  -- the run never demonstrably reached the signed-in app
    'consent_held',     -- would create real data; suite consent is off
    'unvalidated'       -- proposed without a proving run
  ));

COMMIT;
