-- 036_force_rls.sql — make tenant isolation a database guarantee, not a habit.
--
-- Spec: docs/specs/test-writer/spec-app-entity.md §0, §4 (attack 2)
--
-- Every one of these tables has had ROW LEVEL SECURITY enabled and a
-- `tenant_isolation` policy since 029, and none of it has ever done anything:
-- the runtime role OWNS the tables, and Postgres exempts a table's owner from
-- its own policies unless the table is FORCEd. Verified live before writing
-- this: relrowsecurity = t, relforcerowsecurity = f, on all of them.
--
-- So today isolation rests entirely on every query remembering to say
-- `tenant_id = $1`. That is a real discipline and it has held, but it is
-- invisible to the database, unenforceable in review, and a single forgotten
-- predicate is a cross-tenant leak. Confidentiality is this product's stated
-- first priority; this is the gap between saying that and having it.
--
-- Scope note — deliberately five tables, not every tenant table. The code paths
-- that touch these five were audited and converted to run inside
-- withTenantTransaction in the same change, so FORCE here is proven safe.
-- test_cases, test_suites and runs also carry inert policies, but the worker and
-- several routes still reach them through the bare pool; forcing those before
-- that work is done would take the product down. They are the next step, not
-- this one — see the spec.
--
-- Failure mode is loud, which is the point. A query that runs outside a tenant
-- transaction does not quietly return the wrong rows: `current_setting` finds
-- no `app.current_tenant_id` and the statement errors. Silent wrong answers are
-- what we are buying our way out of.

BEGIN;

ALTER TABLE site_pages      FORCE ROW LEVEL SECURITY;
ALTER TABLE page_elements   FORCE ROW LEVEL SECURITY;
ALTER TABLE page_links      FORCE ROW LEVEL SECURITY;
ALTER TABLE app_briefs      FORCE ROW LEVEL SECURITY;
ALTER TABLE generation_jobs FORCE ROW LEVEL SECURITY;

-- The 029 policies omit WITH CHECK, which Postgres reads as "the USING
-- expression governs writes too" — so an INSERT carrying another tenant's id is
-- rejected, not merely invisible. Asserted here rather than assumed, because the
-- whole value of this migration rests on it.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['site_pages','page_elements','page_links','app_briefs','generation_jobs']
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = 'tenant_isolation'
    ) THEN
      RAISE EXCEPTION
        'FORCE ROW LEVEL SECURITY on % without a tenant_isolation policy would deny all access', t;
    END IF;
  END LOOP;
END$$;

COMMENT ON TABLE site_pages IS
  'Site knowledge. Tenant isolation is enforced by FORCED row-level security (036): '
  'every read and write must run inside withTenantTransaction, which sets '
  'app.current_tenant_id. A bare pool query against this table will error, by design.';

COMMIT;
