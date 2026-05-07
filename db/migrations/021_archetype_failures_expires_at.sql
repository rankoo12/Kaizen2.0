-- Migration: archetype_failures.expires_at
-- Spec: docs/specs/smart-brain/spec-archetype-cooldown-permanence.md §4.1
--
-- Adds an explicit expiry column so the resolver can distinguish between:
--   - rolling auto-rehab (worker-side / non-user failures): expires_at = now() + 24h
--   - permanent block (user verdict=fail): expires_at = NULL
--
-- The 24-hour rolling cooldown was previously expressed in code as
--   created_at > now() - INTERVAL '24 hours'
-- which auto-rehabilitated user-marked-fail rows after 24h, even though a
-- human verdict is ground truth and should never expire.

ALTER TABLE archetype_failures
  ADD COLUMN IF NOT EXISTS expires_at timestamptz NULL;

-- Backfill: every existing row was written under the old "created_at +
-- 24 hours" convention. Honor that for in-flight rows so we don't either
-- (a) suddenly turn rolling cooldowns into permanent blocks, or
-- (b) instantly expire rows that should still be active.
UPDATE archetype_failures
   SET expires_at = created_at + interval '24 hours'
 WHERE expires_at IS NULL;

-- Index the new column so the resolver's "where expires_at IS NULL OR
-- expires_at > now()" query stays fast as the table grows.
CREATE INDEX IF NOT EXISTS archetype_failures_expires_at_idx
  ON archetype_failures (expires_at);
