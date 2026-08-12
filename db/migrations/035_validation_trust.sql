-- =============================================================================
-- Kaizen — Test Writer: validation trust (oracle integrity)
-- Migration: 035_validation_trust
-- Spec ref: docs/specs/test-writer/spec-validation-trust.md §6, §7
--
-- NOTE on numbering: 035 is claimed by this migration (COORDINATION.md
-- 2026-08-12). The app-entity re-keying renumbered to 036/037 because
-- validation trust ships first; the assessment docs under docs/assessments/
-- still say "035" for app-entity and are superseded by that cross-note.
-- =============================================================================

-- 1. validation_state — stop collapsing four different meanings into 'draft'.
--
-- `status` is the lifecycle (active/draft/validating/rejected/archived) and it
-- stays exactly as it is. What it cannot express is the EVIDENCE behind a
-- draft: today ValidationRunner writes status='draft' from three separate
-- places meaning "never run", "sign-in failed so we can't say", and "ran
-- green" — and the review UI, unable to tell them apart, captions a
-- self-healed draft as "ran green against your site" and a sign-in casualty as
-- "needs consent". Both are false. Evidence gets its own column.
--
-- 'weak_oracle' is deliberately promotable-but-labelled: an assertion whose
-- anchor was chosen by the least-constrained resolver (L5) is suspicious, not
-- provably wrong, and rejecting it outright would throw away real tests.

ALTER TABLE test_cases
  ADD COLUMN IF NOT EXISTS validation_state TEXT
    CHECK (validation_state IN (
      'validated',        -- ran green, oracle survived the audit
      'healed',           -- passed only after self-healing — the selector was wrong
      'weak_oracle',      -- promoted, but its terminal anchor was L5-resolved
      'flaky',            -- failed then passed on retry
      'unproven_signin',  -- the run never demonstrably reached the signed-in app
      'consent_held',     -- would create real data; suite consent is off
      'unvalidated'       -- proposed without a proving run
    ));

COMMENT ON COLUMN test_cases.validation_state IS
  'Evidence level behind this case, orthogonal to status. NULL for user-authored cases. Spec: spec-validation-trust.md §6.';

-- 2. expected_outcome — Tier-2 negatives must judge correctly on RE-runs too.
--
-- Expected-fail semantics currently live only in the in-memory WrittenScenario
-- during validation, so the moment that job ends nothing knows this case is
-- supposed to fail. Every later run reads it as broken.

ALTER TABLE test_cases
  ADD COLUMN IF NOT EXISTS expected_outcome TEXT
    CHECK (expected_outcome IN ('pass', 'fail'));

COMMENT ON COLUMN test_cases.expected_outcome IS
  'Tier-2 expected-fail marker. NULL/pass = ordinary test. Spec: spec-validation-trust.md §7.';

-- 3. validation_seed — what the green run actually typed.
--
-- Seed variables are re-rolled per run (generateFormData), so "proven" today
-- means "proven with one random draw nobody recorded". Storing the draw makes
-- the proof reproducible, and is the substrate for the known-entity binding
-- rule that stops a search test claiming to find an entity it invented.

ALTER TABLE test_cases
  ADD COLUMN IF NOT EXISTS validation_seed JSONB;

COMMENT ON COLUMN test_cases.validation_seed IS
  'Seed variable values used by the run that validated this case. Spec: spec-validation-trust.md §7.';

-- 4. Backfill — honest about what we can and cannot know retroactively.
--
-- Only generated cases get a state; user-authored ones keep NULL. A draft that
-- carries a validation_run_id is graded from that run's own terminal status,
-- which is the one thing the old code did record faithfully. Everything else
-- is 'unvalidated' — including consent-held drafts, which are indistinguishable
-- from never-run ones without reading the job report. scripts/audit-existing-drafts.ts
-- refines these, and applies the §2 oracle audit that no existing row has faced.

UPDATE test_cases tc
SET validation_state = CASE
      WHEN r.status = 'healed' THEN 'healed'
      WHEN r.status = 'passed' THEN 'validated'
      ELSE 'unvalidated'
    END
FROM runs r
WHERE r.id = tc.validation_run_id
  AND tc.origin = 'generated'
  AND tc.status = 'draft'
  AND tc.validation_state IS NULL;

UPDATE test_cases
SET validation_state = 'unvalidated'
WHERE origin = 'generated'
  AND status = 'draft'
  AND validation_run_id IS NULL
  AND validation_state IS NULL;

-- Index supports the review UI's "show me what is actually proven" filter and
-- the retroactive audit's sweep over generated drafts.
CREATE INDEX IF NOT EXISTS test_cases_validation_state_idx
  ON test_cases (tenant_id, suite_id, validation_state)
  WHERE origin = 'generated';
