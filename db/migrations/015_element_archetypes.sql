-- Migration 015: Element Archetype Library
--
-- Stores universal UI element patterns that resolve via ARIA selectors
-- on any website without embeddings or LLM calls.
--
-- name          : unique slug, e.g. 'login_button'
-- role          : ARIA role to match (exact), e.g. 'button'
-- name_patterns : normalised name variants (lowercase, trimmed) that identify
--                 this archetype, e.g. ARRAY['login', 'log in', 'sign in']
-- action_hint   : if set, only match steps of this action type.
--                 NULL means valid for any action.
-- confidence    : confidence score assigned to ARIA selectors returned by this
--                 archetype. Slightly below 1.0 (0.95) to allow human verdicts
--                 to override pinned entries.

CREATE TABLE IF NOT EXISTS element_archetypes (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT        NOT NULL UNIQUE,
  role           TEXT        NOT NULL,
  name_patterns  TEXT[]      NOT NULL,
  action_hint    TEXT,
  confidence     NUMERIC(3,2) NOT NULL DEFAULT 0.95,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fast lookup by role (the first filter applied in the resolver)
CREATE INDEX IF NOT EXISTS idx_element_archetypes_role
  ON element_archetypes (role);
