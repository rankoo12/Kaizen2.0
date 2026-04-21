-- Migration: archetype_failures
-- Spec: docs/specs/smart-brain/spec-element-resolver-archetype-disambiguation.md § S3
-- Stores user-marked failures at L0 so the archetype resolver skips the same
-- (tenant, domain, target, archetype) pairing until the cooldown elapses.

CREATE TABLE IF NOT EXISTS archetype_failures (
  tenant_id       uuid NOT NULL,
  domain          text NOT NULL,
  target_hash     text NOT NULL,
  archetype_name  text NOT NULL,
  selector_used   text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, domain, target_hash, archetype_name)
);

CREATE INDEX IF NOT EXISTS archetype_failures_created_at_idx
  ON archetype_failures (created_at);
