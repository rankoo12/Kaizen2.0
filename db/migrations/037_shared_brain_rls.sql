-- 037_shared_brain_rls.sql — teach the isolation policies about the shared brain.
--
-- Spec: docs/specs/test-writer/spec-app-entity.md §5
-- Runbook: docs/runbooks/unprivileged-runtime-role.md §3(c)
--
-- The global brain is deliberate: selectors learned on one tenant's run are
-- promoted to a cross-tenant pool (`is_shared = true`, `tenant_id IS NULL`),
-- gated per tenant by `tenants.global_brain_opt_in`. It is what makes a repeat
-- run resolve from memory instead of paying the model again.
--
-- The tenant policies do not know that. They say
--   tenant_id = current_setting('app.current_tenant_id')::uuid
-- and a shared row's tenant_id is NULL. In SQL, NULL = anything is never true —
-- not false, but never true — so every shared row fails the check.
--
-- Today that costs nothing, because the runtime connects as a superuser and no
-- policy applies to it. The moment the app moves to an unprivileged role (the
-- entire point of 036 and the runbook), the shared pool would silently become
-- invisible: no error, no failed run, just a collapse in cache hit rate and a
-- rise in token spend that nothing announces. A quiet regression in the number
-- the product's core claim rests on.
--
-- So the policy is corrected BEFORE the role switch, not after it.
--
-- What this deliberately does NOT change: which rows are shared, who may
-- contribute, or what a shared row may contain. Promotion stays gated by
-- `global_brain_opt_in` in shared-pool.service.ts, and a shared row carries
-- selectors and attribution — never tenant data. This migration only makes the
-- database agree with a sharing decision that was already made.

BEGIN;

-- Only selector_cache. `selector_cache_aliases.tenant_id` is NOT NULL and the
-- table has no is_shared column — an alias always belongs to one tenant, so its
-- policy is already correct and referencing is_shared there would not even
-- compile. Checked rather than assumed, because "the cache tables" sounds like
-- one thing and is two.
DROP POLICY IF EXISTS tenant_isolation ON selector_cache;

-- Read: your own rows, plus the shared pool.
-- Write: your own rows, plus a contribution to the shared pool. That second
-- clause is what SharedPoolService.contribute needs; the service's opt-in check
-- remains the gate on WHO contributes, because "may this tenant share" is a
-- product decision and does not belong in a row predicate.
CREATE POLICY tenant_isolation ON selector_cache
  USING (
    tenant_id = current_setting('app.current_tenant_id')::uuid
    OR (is_shared AND tenant_id IS NULL)
  )
  WITH CHECK (
    tenant_id = current_setting('app.current_tenant_id')::uuid
    OR (is_shared AND tenant_id IS NULL)
  );

COMMENT ON COLUMN selector_cache.is_shared IS
  'Global-brain row: tenant_id IS NULL and this is true. Readable by every '
  'tenant by policy (037); contribution is gated by tenants.global_brain_opt_in.';

COMMIT;
