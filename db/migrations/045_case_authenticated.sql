-- =============================================================================
-- Kaizen — authenticated scope travels WITH the case
-- Migration: 045_case_authenticated
-- Spec ref: docs/specs/bench/spec-changing-sites.md §12 finding #14;
--           docs/specs/test-writer/spec-authenticated-scope.md §4.1, §12 threat 3
--
-- The behindAuth protection (no shared-pool contribution, no global archetype
-- learning from signed-in pages) was carried only by the Test Writer's proving
-- runs: the run payload flag was set for scope='authenticated' generation jobs
-- and absent everywhere else. An ordinary /suites/:id/run of those same cases
-- ran with behindAuth falsy, so a cache-miss LLM resolution of an admin-page
-- INTERACTION would pass the !behindAuth gate and teach the global, tenant-free
-- archetype library a customer's private UI vocabulary. Audited not to have
-- happened in the 2026-11 campaign — but the gate was one cache eviction away
-- from leaking. The scope is a property of the CASE, not of who enqueued it.
-- =============================================================================

ALTER TABLE test_cases
  ADD COLUMN IF NOT EXISTS authenticated BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN test_cases.authenticated IS
  'This case exercises pages behind a login wall (born from a scope=authenticated generation job, or flagged by hand). Every run of it must set behindAuth: nothing it learns may reach shared/global state. Finding #14.';

-- Backfill: every case born from an authenticated-scope generation job.
-- Conservative on purpose: a job's whole output is flagged, including any case
-- that happens to cover a public page — over-protecting a case only withholds
-- its learnings from the shared brain; under-protecting leaks a customer's
-- private UI vocabulary. generation_jobs is FORCE-RLS (036): this runs as the
-- migration role (DATABASE_ADMIN_URL — the superuser per
-- docs/runbooks/unprivileged-runtime-role.md §4), which RLS never applies to.
-- A non-exempt role would error loudly on current_setting, not skip rows.
UPDATE test_cases tc
SET authenticated = true
FROM generation_jobs gj
WHERE tc.generation_job_id = gj.id
  AND gj.scope = 'authenticated'
  AND NOT tc.authenticated;
