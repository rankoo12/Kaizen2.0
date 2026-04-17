-- Migration: Expand archetype name_patterns for real-world site coverage
-- Spec ref: Smart Brain Layer 0 — spec-smart-brain-layer0.md
--
-- Adds patterns observed on live sites that were not in the initial seed:
--   email_input   : Slack uses "Enter your email address" (not bare "email address")
--   login_button  : Slack uses "Sign in with email", "Sign in with Google", etc.
--
-- Safe to re-run (array_append is idempotent via NOT (name_patterns @> ARRAY[...]) guard).

-- ── email_input ───────────────────────────────────────────────────────────────
UPDATE element_archetypes
SET name_patterns = array_cat(
  name_patterns,
  ARRAY[
    'enter your email address',
    'enter email address',
    'your email address',
    'enter your email',
    'type your email'
  ]::text[]
)
WHERE name = 'email_input'
  AND NOT (name_patterns @> ARRAY['enter your email address']::text[]);

-- ── login_button ──────────────────────────────────────────────────────────────
-- "Sign in with <provider>" variants: these are login entry-point buttons whose
-- accessible name includes the provider name. The resolver still returns a
-- login_button match and builds role=button[name="Sign in with email"] which
-- is the correct ARIA selector for the element.
UPDATE element_archetypes
SET name_patterns = array_cat(
  name_patterns,
  ARRAY[
    'sign in with email',
    'sign in with google',
    'sign in with github',
    'sign in with microsoft',
    'sign in with apple',
    'log in with email',
    'log in with google',
    'continue with email',
    'continue with google',
    'continue with github'
  ]::text[]
)
WHERE name = 'login_button'
  AND NOT (name_patterns @> ARRAY['sign in with email']::text[]);
