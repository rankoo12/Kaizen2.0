-- 039_vacuous_oracle_state.sql — a green run is the user's call, never silently discarded.
--
-- Spec: docs/specs/test-writer/spec-validation-trust.md §3, §6 (amended 2026-08-18)
--
-- Two validation-stage checks — the executed vacuity probe ("the final check
-- also passes without the scenario's actions") and the oracle-faithfulness
-- audit — used to write status='rejected' on a case whose proving run was
-- GREEN. The founder's rule is the opposite: if it ran green, the human
-- decides. Those cases now stay drafts, labelled honestly, and this adds the
-- label the vacuity probe needs. 'weak_oracle' already covers the audit.

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
    'validated',        -- ran green, oracle survived the audit
    'healed',           -- passed only after self-healing — the selector was wrong
    'weak_oracle',      -- ran green; the final check may not be reading what it names
    'vacuous_oracle',   -- ran green; the final check ALSO passed with the actions removed
    'flaky',            -- failed then passed on retry
    'unproven_signin',  -- the run never demonstrably reached the signed-in app
    'consent_held',     -- would create real data; suite consent is off
    'unvalidated'       -- proposed without a proving run
  ));

COMMIT;
