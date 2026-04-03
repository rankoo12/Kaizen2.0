-- =============================================================================
-- Kaizen — Phase 2: pgvector + API Key Auth
-- Migration: 003_add_pgvector_and_auth
-- Spec ref: docs/kaizen-spec-v3.md §5 (Data Model), §8 (Element Resolution), §19 (Security)
--
-- Changes:
--   1. Enable pgvector extension
--   2. Add step_embedding vector(1536) to selector_cache + HNSW index
--   3. Create api_keys table (scoped, multi-key per tenant, hashed)
--   4. Seed a default development tenant for local testing
-- =============================================================================

-- ─── 1. PGVECTOR EXTENSION ───────────────────────────────────────────────────
-- Must be created before any vector column is added.
-- Requires pgvector to be installed on the Postgres instance.

CREATE EXTENSION IF NOT EXISTS vector;

-- ─── 2. STEP EMBEDDING COLUMN ────────────────────────────────────────────────
-- Stores the semantic intent vector of the step's natural-language text.
-- Used by CachedElementResolver for cosine similarity lookup (L2/L3 cache hit).
-- Phase 3 will add element_embedding (the resolved DOM node vector).

ALTER TABLE selector_cache
  ADD COLUMN IF NOT EXISTS step_embedding vector(1536);

-- HNSW index for cosine similarity search on step_embedding.
-- ef_construction=128, m=16 are pgvector defaults — good for < 1M rows.
-- Must stay in RAM for sub-millisecond queries; size Postgres RAM accordingly.
CREATE INDEX IF NOT EXISTS idx_selector_cache_step_vec
  ON selector_cache
  USING hnsw (step_embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 128);

-- ─── 3. API KEYS TABLE ───────────────────────────────────────────────────────
-- Supports multiple scoped keys per tenant (read_only / execute / admin).
-- Only SHA-256(raw_key) is stored — the raw key is shown exactly once at creation.
-- Key format: kzn_live_<32-random-hex>  (detectable by GitHub secret scanning)

CREATE TABLE IF NOT EXISTS api_keys (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key_hash      TEXT NOT NULL UNIQUE,    -- SHA-256(raw_key), hex-encoded
  key_prefix    TEXT NOT NULL,           -- first 12 chars of raw key for display (kzn_live_xxxx)
  scope         key_scope NOT NULL DEFAULT 'execute',
  description   TEXT,                    -- human label, e.g. "CI pipeline key"
  expires_at    TIMESTAMPTZ,             -- NULL = never expires
  last_used_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_api_keys_tenant
  ON api_keys (tenant_id);

-- RLS: tenants can only see their own API keys
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON api_keys
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- ─── 4. DEV TENANT SEED ──────────────────────────────────────────────────────
-- Provides a stable tenant_id for local development and Postman testing.
-- This is idempotent — safe to run repeatedly.

INSERT INTO tenants (id, name, slug, plan_tier)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'Dev Tenant',
  'dev',
  'enterprise'
)
ON CONFLICT (id) DO NOTHING;
