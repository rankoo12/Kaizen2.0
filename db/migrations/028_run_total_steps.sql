-- =============================================================================
-- Kaizen — run length for live progress in the Runs feed
-- Migration: 028_run_total_steps
-- Spec ref: docs/specs/roadmap/spec-phase-0-plumbing.md §3
--
-- The Runs feed wants "step 6 of 10" on a running row. step_results only gains
-- a row once a step FINISHES, so a live run supplies the numerator but not the
-- denominator.
--
-- The denominator cannot be derived from the case: test_steps rows are
-- immutable and versioned via parent_step_id, and since test editing shipped a
-- case's active step set can change WHILE a run is in flight. Deriving "of 10"
-- from the case would make a running run's meter jump — or exceed 100% — the
-- moment someone edits the test.
--
-- Both enqueue sites compile the steps before inserting the run, so the run
-- knows its own length at creation. Stamp it there and read it back verbatim.
--
-- Nullable on purpose: a run whose length is genuinely unknown must read as
-- unknown, not as zero-length. The UI omits the meter when it is NULL.
--
-- Additive only — safe to apply while a live worker is on the shared database.
-- =============================================================================

ALTER TABLE runs ADD COLUMN IF NOT EXISTS total_steps INT;

-- Historical runs are all terminal, so their executed length is exactly their
-- step_results count. Backfilling makes the feed consistent for rows that
-- predate this migration instead of showing progress only for new runs.
UPDATE runs r
   SET total_steps = (SELECT COUNT(*)::int FROM step_results sr WHERE sr.run_id = r.id)
 WHERE r.total_steps IS NULL;
