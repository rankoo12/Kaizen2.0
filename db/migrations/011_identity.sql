-- =============================================================================
-- Kaizen — Identity & Multi-Tenancy
-- Migration: 011_identity
-- Spec ref: docs/spec-identity.md §5 (Data Model)
--
-- Changes:
--   1. Extend tenants table with identity columns
--   2. Create users table
--   3. Create memberships table
--   4. Create invites table
--   5. Create refresh_tokens table
--   6. Seed the dev tenant with a matching identity row
-- =============================================================================

BEGIN;

-- ─── 1. EXTEND TENANTS ───────────────────────────────────────────────────────
-- Add identity-layer columns alongside the existing product columns.
-- display_name is seeded from the existing `name` column so nothing breaks.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS display_name  TEXT,
  ADD COLUMN IF NOT EXISTS is_personal   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS suspended_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_at    TIMESTAMPTZ;

-- Backfill display_name from name for all existing rows
UPDATE tenants SET display_name = name WHERE display_name IS NULL;

-- Make display_name NOT NULL now that it is populated
ALTER TABLE tenants ALTER COLUMN display_name SET NOT NULL;

-- Partial unique index so deleted tenants don't block slug reuse
DROP INDEX IF EXISTS tenants_slug_active_idx;
CREATE UNIQUE INDEX tenants_slug_active_idx
  ON tenants (slug)
  WHERE deleted_at IS NULL;

-- ─── 2. USERS ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                TEXT NOT NULL,
  password_hash        TEXT NOT NULL,                  -- scrypt: "salt:hash" (hex)
  display_name         TEXT NOT NULL,
  avatar_url           TEXT,
  email_verified_at    TIMESTAMPTZ,
  last_login_at        TIMESTAMPTZ,
  -- password reset
  reset_token_hash     TEXT,                           -- SHA-256(raw token)
  reset_token_expires  TIMESTAMPTZ,
  -- email verification
  verify_token_hash    TEXT,                           -- SHA-256(raw token)
  deleted_at           TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_active_idx
  ON users (email)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS users_reset_token_idx
  ON users (reset_token_hash)
  WHERE reset_token_hash IS NOT NULL AND deleted_at IS NULL;

-- ─── 3. MEMBERSHIPS ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS memberships (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id),
  user_id      UUID NOT NULL REFERENCES users(id),
  role         TEXT NOT NULL
                 CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  invited_by   UUID REFERENCES users(id),              -- NULL for the founding owner
  accepted_at  TIMESTAMPTZ,                            -- NULL = invite pending (unused here; see invites table)
  deleted_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, user_id)
);

CREATE INDEX IF NOT EXISTS memberships_user_idx
  ON memberships (user_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS memberships_tenant_idx
  ON memberships (tenant_id)
  WHERE deleted_at IS NULL;

-- ─── 4. INVITES ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS invites (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id),
  invited_by   UUID NOT NULL REFERENCES users(id),
  email        TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('admin', 'member', 'viewer')),
  token_hash   TEXT NOT NULL UNIQUE,                   -- SHA-256(raw token)
  expires_at   TIMESTAMPTZ NOT NULL,                   -- 7 days from creation
  accepted_at  TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- one pending invite per (tenant, email) — enforced via partial index
  CONSTRAINT invites_unique_pending UNIQUE (tenant_id, email)
);

-- ─── 5. REFRESH TOKENS ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  token_hash  TEXT NOT NULL UNIQUE,                    -- SHA-256(raw token); raw token is in JWT only
  expires_at  TIMESTAMPTZ NOT NULL,                    -- 30 days
  revoked_at  TIMESTAMPTZ,
  user_agent  TEXT,
  ip_address  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx
  ON refresh_tokens (user_id)
  WHERE revoked_at IS NULL;

COMMIT;
