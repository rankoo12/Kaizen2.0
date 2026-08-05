-- =============================================================================
-- Kaizen — who wrote this test
-- Migration: 030_test_case_created_by
-- Spec ref: docs/specs/roadmap/spec-keys-quota-authorship.md §6
--
-- Numbered 030 rather than 029: the dev databases carry 028_test_writer and
-- 029_site_model from an unmerged branch, so those numbers are already taken
-- even though the files are not in this repo yet. See the spec's §2.
--
-- Nullable, and deliberately NOT backfilled. Nothing recorded who created a
-- historical case — there is no audit trail to reconstruct from, and assigning
-- them all to the workspace owner would be a guess rendered as fact. Existing
-- cases show no author; only cases created from here on have one.
--
-- Nullable also covers a real ongoing case: a test created through an API key
-- has a tenant but no user behind it.
--
-- ON DELETE stays NO ACTION. Users are soft-deleted (users.deleted_at) rather
-- than removed, so authorship should never be silently orphaned.
--
-- Additive only — safe to apply while a live worker is on the shared database.
-- =============================================================================

ALTER TABLE test_cases ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id);

CREATE INDEX IF NOT EXISTS test_cases_created_by_idx ON test_cases (created_by);
