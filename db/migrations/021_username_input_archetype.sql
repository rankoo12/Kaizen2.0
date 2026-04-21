-- Migration: username_input archetype
-- Spec: docs/specs/smart-brain/spec-element-resolver-archetype-disambiguation.md
-- The archetype library had email/password/full-name inputs but no pure
-- "username" archetype. On sites like saucedemo.com the username field only
-- carries placeholder="Username" + name="user-name" and would otherwise miss
-- L0 entirely and pay LLM tokens on every run.

INSERT INTO element_archetypes (name, role, name_patterns, action_hint, confidence)
VALUES (
  'username_input',
  'textbox',
  ARRAY[
    'username',
    'user name',
    'user-name',
    'login name',
    'login id',
    'user id',
    'userid',
    'account name',
    'your username',
    'enter your username',
    'enter username'
  ],
  'type',
  0.95
)
ON CONFLICT (name) DO UPDATE
  SET name_patterns = EXCLUDED.name_patterns,
      confidence    = EXCLUDED.confidence;
