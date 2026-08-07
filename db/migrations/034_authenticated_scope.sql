-- =============================================================================
-- Kaizen — Test Writer P3: authenticated scope (signed-in exploration)
-- Migration: 034_authenticated_scope
-- Spec ref: docs/specs/test-writer/spec-authenticated-scope.md §8.2
--
-- NOTE on numbering: 032 is the Test Writer's P2 migration; the B9 branch
-- renumbered its frame_url migration to 033 to clear that collision, so P3
-- continues at 034. B11 (CI integration) also plans to start at 034 — see the
-- 2026-08-07 cross-notes in COORDINATION.md.
-- =============================================================================

-- 1. Consent audit — who granted signed-in exploration, and when.
--
-- Migration 028's header promised an "audit trail for scope + auth consent"
-- but shipped only the boolean. Signing into a customer's system is the
-- largest grant in the product; a bare `auth_consent = true` records that
-- someone agreed without recording who, which is not an audit trail.

ALTER TABLE generation_jobs
  ADD COLUMN IF NOT EXISTS auth_consented_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS auth_consented_at TIMESTAMPTZ;

COMMENT ON COLUMN generation_jobs.auth_consented_by IS
  'User who consented to authenticated scope. NULL on public jobs. Never set from an impersonated session (spec §8.3).';
COMMENT ON COLUMN generation_jobs.auth_consented_at IS
  'When authenticated-scope consent was granted. NULL on public jobs.';

-- 2. Consent attributed to nobody is not consent.
--
-- Widens 028's constraint so the database itself refuses an authenticated job
-- that names no consenter. Adding the columns as plain nullables would leave
-- the audit trail a convention enforced only by the route that happens to
-- write it; this makes it a schema guarantee.

ALTER TABLE generation_jobs
  DROP CONSTRAINT IF EXISTS generation_jobs_auth_consent;

ALTER TABLE generation_jobs
  ADD CONSTRAINT generation_jobs_auth_consent CHECK (
    scope = 'public' OR (
      auth_consent
      AND login_case_id     IS NOT NULL
      AND auth_consented_by IS NOT NULL
      AND auth_consented_at IS NOT NULL
    )
  );

-- Nothing else is needed at the schema level. The other P3 behaviours ride
-- existing columns: `requires_auth` (029) gains mode-dependent upsert
-- semantics in the repository rather than a new column, and Tier A
-- capture-suppressed pages are stored as ordinary URL + title stubs — the
-- `blocked` distinction lives on PageCapture, not in the table.
