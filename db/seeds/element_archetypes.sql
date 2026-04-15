-- Seed: Element Archetype Library
-- Spec ref: Smart Brain Layer 0 — spec-smart-brain-layer0.md
--
-- Pre-seeded archetypes for universal UI element patterns.
-- Idempotent — safe to run multiple times (ON CONFLICT DO NOTHING).
--
-- name_patterns values are normalised: lowercase, trimmed, internal whitespace collapsed.
-- The resolver normalises the candidate accessible name before comparison.

INSERT INTO element_archetypes (name, role, name_patterns, action_hint, confidence)
VALUES

-- ── Authentication ───────────────────────────────────────────────────────────
('login_button',   'button',   ARRAY['login', 'log in', 'log into', 'sign in', 'sign into'],
  'click', 0.95),

('logout_button',  'button',   ARRAY['log out', 'logout', 'sign out', 'signout'],
  'click', 0.95),

('signup_button',  'button',   ARRAY['sign up', 'signup', 'create account', 'register',
                                     'get started', 'join', 'join now', 'create free account'],
  'click', 0.95),

-- ── Form fields ──────────────────────────────────────────────────────────────
('email_input',    'textbox',  ARRAY['email', 'email address', 'e-mail', 'e-mail address',
                                     'work email', 'username or email', 'email or username',
                                     'email / username'],
  'type', 0.95),

('password_input', 'textbox',  ARRAY['password', 'current password', 'enter password',
                                     'your password'],
  'type', 0.95),

('search_input',   'searchbox', ARRAY['search', 'search...', 'search for anything',
                                      'what are you looking for'],
  'type', 0.95),

('search_input_textbox', 'textbox', ARRAY['search', 'search...'],
  'type', 0.92),

-- ── Navigation ───────────────────────────────────────────────────────────────
('submit_button',  'button',   ARRAY['submit', 'continue', 'next', 'confirm', 'save',
                                     'save changes', 'apply', 'done', 'update', 'finish'],
  'click', 0.90)

ON CONFLICT (name) DO NOTHING;
