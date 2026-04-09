-- =============================================================================
-- Kaizen — Platform Admin Layer
-- Migration: 012_platform_admins
-- Spec ref: docs/spec-identity.md §4 (Platform Admin Layer)
--
-- Changes:
--   1. Create platform_admins table
--   2. Create platform_audit_log table
-- =============================================================================

BEGIN;

-- ─── 1. PLATFORM ADMINS ──────────────────────────────────────────────────────
-- Separate identity plane — not a tenant membership, not a user role.
-- Only Kaizen operators hold rows in this table.

CREATE TABLE IF NOT EXISTS platform_admins (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,                         -- scrypt: "salt:hash" (hex)
  display_name  TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── 2. PLATFORM AUDIT LOG ───────────────────────────────────────────────────
-- Every platform admin action is recorded here — immutable append-only.
-- There is no silent impersonation: every access is traceable.

CREATE TABLE IF NOT EXISTS platform_audit_log (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id         UUID NOT NULL REFERENCES platform_admins(id),
  action           TEXT NOT NULL,                      -- e.g. 'impersonate_user', 'suspend_tenant'
  target_type      TEXT NOT NULL,                      -- 'user' | 'tenant'
  target_id        UUID NOT NULL,
  impersonated_as  UUID REFERENCES users(id),          -- set during impersonation sessions
  metadata         JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enforce append-only — same pattern as billing_events
CREATE RULE no_update_audit AS ON UPDATE TO platform_audit_log DO INSTEAD NOTHING;
CREATE RULE no_delete_audit AS ON DELETE TO platform_audit_log DO INSTEAD NOTHING;

CREATE INDEX IF NOT EXISTS platform_audit_admin_idx
  ON platform_audit_log (admin_id, created_at DESC);

CREATE INDEX IF NOT EXISTS platform_audit_target_idx
  ON platform_audit_log (target_type, target_id, created_at DESC);

COMMIT;
