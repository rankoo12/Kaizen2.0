-- 038_api_key_lookup.sql — resolve an API key to its tenant under enforced RLS.
--
-- Runbook: docs/runbooks/unprivileged-runtime-role.md §3(b)
--
-- The api_keys policy says "show rows whose tenant_id is the current tenant".
-- The auth middleware reads an api_keys row in order to LEARN the current
-- tenant. Under a role that RLS applies to, that read returns nothing and every
-- API-key request 401s: the one lookup that must happen before a tenant is
-- known cannot be subject to a rule that needs the tenant known.
--
-- The two ways out are a policy exception on the table (which reopens the whole
-- table to any query that forgot its tenant — the exact thing we are closing)
-- or a SECURITY DEFINER function: a single, narrow, audited door that runs with
-- the definer's privileges and does exactly one thing.
--
-- This is the second. It takes a key hash and returns tenant, scope and expiry.
-- It cannot list keys, cannot search by tenant, cannot return the hash itself,
-- and is not callable to discover anything you did not already hold. Holding a
-- valid key hash IS the credential, so answering "which tenant does this
-- credential belong to" leaks nothing the caller did not already prove.
--
-- Defined by the migration role (the owner), which is what lets it read past
-- the policy. EXECUTE is granted to PUBLIC deliberately: any runtime role,
-- including one provisioned later, can authenticate — that is the function's
-- purpose — and the function itself is the boundary, not who may call it.

BEGIN;

CREATE OR REPLACE FUNCTION api_key_lookup(p_key_hash TEXT)
RETURNS TABLE (tenant_id UUID, scope TEXT, expires_at TIMESTAMPTZ)
LANGUAGE sql
SECURITY DEFINER
STABLE
-- Pin the search path: a SECURITY DEFINER function that resolves table names
-- through the caller's search_path can be pointed at a shadow table.
SET search_path = public, pg_temp
AS $$
  SELECT k.tenant_id, k.scope::text, k.expires_at
    FROM api_keys k
   WHERE k.key_hash = p_key_hash
   LIMIT 1;
$$;

-- last_used_at is a write on the same row, and the middleware fires it after
-- resolving the tenant. Kept as a second definer function rather than folded
-- into the lookup, so the lookup stays STABLE and side-effect free.
CREATE OR REPLACE FUNCTION api_key_touch(p_key_hash TEXT)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE api_keys SET last_used_at = now() WHERE key_hash = p_key_hash;
$$;

REVOKE ALL ON FUNCTION api_key_lookup(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION api_key_touch(TEXT)  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api_key_lookup(TEXT) TO PUBLIC;
GRANT EXECUTE ON FUNCTION api_key_touch(TEXT)  TO PUBLIC;

COMMENT ON FUNCTION api_key_lookup(TEXT) IS
  'The one read of api_keys permitted before a tenant is known. SECURITY DEFINER '
  'so it works under an RLS-bound runtime role; takes a hash, returns tenant/scope/expiry, '
  'nothing else. Migration 038.';

COMMIT;
