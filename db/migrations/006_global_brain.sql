-- Phase 4: Global Brain Seeding
-- Spec ref: kaizen-phase4-spec.md §1

-- Allow tenant_id to be NULL for shared pool entries (is_shared=true rows have no tenant).
-- The original schema created this column as NOT NULL for tenant-scoped rows.
ALTER TABLE selector_cache ALTER COLUMN tenant_id DROP NOT NULL;

-- Gap 1: Tenant opt-in flag for contributing to and reading from the shared pool.
-- Enterprise tenants only (enforced at API layer — Phase 5 adds plan checks).
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS global_brain_opt_in BOOLEAN NOT NULL DEFAULT false;

-- Gap 5: Attribution — tracks which tenant(s) or source seeded a given shared entry.
-- Shape: { "contributors": [{ "tenantId": "uuid", "contributedAt": "ISO" }], "source": "seed|tenant" }
ALTER TABLE selector_cache
  ADD COLUMN IF NOT EXISTS attribution JSONB;

-- Index: fast fetch of all shared entries per domain (used by seeding job verification)
CREATE INDEX IF NOT EXISTS idx_selector_cache_shared_domain
  ON selector_cache (domain)
  WHERE is_shared = true;

-- Uniqueness: prevent duplicate shared entries per (content_hash, domain).
-- Allows the seeding script to use ON CONFLICT DO NOTHING cleanly.
CREATE UNIQUE INDEX IF NOT EXISTS idx_selector_cache_shared_unique
  ON selector_cache (content_hash, domain)
  WHERE is_shared = true AND tenant_id IS NULL;
