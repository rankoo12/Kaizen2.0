-- app_runtime_role.sql — the unprivileged role the application connects as.
--
-- Spec: docs/specs/test-writer/spec-app-entity.md §5 (Decision 5, corrected)
-- Runbook: docs/runbooks/unprivileged-runtime-role.md
--
-- WHY THIS EXISTS
--
-- Row-level security does not apply to superusers, to roles with BYPASSRLS, or
-- to a table's owner unless the table is FORCEd. Kaizen's tables have carried
-- tenant policies since migration 029 and FORCE since 036, and both were
-- decorative the entire time, because the application connects as a SUPERUSER.
-- Measured on dev: the same predicate-free SELECT returned every tenant's rows
-- as `kaizen`, and exactly one tenant's rows as an unprivileged role.
--
-- So this role is the actual mechanism. Everything else was scaffolding for it.
--
-- WHAT IT DELIBERATELY IS NOT
--
--   NOSUPERUSER   — a superuser ignores RLS entirely; this is the whole point
--   NOBYPASSRLS   — same hole under a different name
--   NOCREATEDB / NOCREATEROLE — the runtime never provisions anything
--   not an owner  — owners are exempt from un-FORCEd policies, and FORCE is a
--                   per-table flag someone will forget on a future table
--
-- It is granted DML on existing tables and, via ALTER DEFAULT PRIVILEGES, on
-- tables created LATER by the migration role. That last part is the one people
-- miss: without it the next migration ships a table this role cannot read, and
-- the failure appears at runtime rather than at deploy.
--
-- IDEMPOTENT. Safe to re-run after every migration, and the runbook says to.
--
-- Usage (as an admin/superuser connection):
--   psql "$DATABASE_ADMIN_URL" -v app_role=kaizen_app -v app_password="'...'" \
--        -v migration_role=kaizen -f db/roles/app_runtime_role.sql

\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
  app_role  TEXT := current_setting('kaizen.app_role', true);
  app_pass  TEXT := current_setting('kaizen.app_password', true);
BEGIN
  IF app_role IS NULL OR app_role = '' THEN
    RAISE EXCEPTION 'kaizen.app_role must be set';
  END IF;
  IF app_pass IS NULL OR app_pass = '' THEN
    RAISE EXCEPTION 'kaizen.app_password must be set (do not default it)';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L', app_role, app_pass);
  ELSE
    EXECUTE format('ALTER ROLE %I LOGIN PASSWORD %L', app_role, app_pass);
  END IF;

  -- Asserted every run, not just at creation: a role that is later granted
  -- SUPERUSER silently un-does this entire migration, and nothing else in the
  -- system would notice.
  EXECUTE format(
    'ALTER ROLE %I NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION',
    app_role);
END$$;

DO $$
DECLARE
  app_role       TEXT := current_setting('kaizen.app_role', true);
  migration_role TEXT := COALESCE(NULLIF(current_setting('kaizen.migration_role', true), ''), current_user);
BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', app_role);
  EXECUTE format(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', app_role);
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', app_role);

  -- Tables and sequences created by FUTURE migrations. Default privileges are
  -- attached to the role that creates the object, so this must name the
  -- migration role — not whoever happens to be running this script.
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public '
    'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', migration_role, app_role);
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public '
    'GRANT USAGE, SELECT ON SEQUENCES TO %I', migration_role, app_role);

  -- No DDL, no TRUNCATE, no REFERENCES: the runtime reads and writes rows and
  -- nothing else. Schema change is the migration role's job.
END$$;

-- Fail the script rather than report success on a role that can still bypass
-- the thing it was created to be subject to.
DO $$
DECLARE
  app_role TEXT := current_setting('kaizen.app_role', true);
  bad      RECORD;
BEGIN
  SELECT rolsuper, rolbypassrls INTO bad FROM pg_roles WHERE rolname = app_role;
  IF bad.rolsuper OR bad.rolbypassrls THEN
    RAISE EXCEPTION
      'role % still has SUPERUSER/BYPASSRLS — row-level security would not apply to it', app_role;
  END IF;
END$$;

COMMIT;
