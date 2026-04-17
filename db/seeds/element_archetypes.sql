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
('login_button',   'button',   ARRAY['login', 'log in', 'log into', 'sign in', 'sign into',
                                     'sign in with email', 'sign in with google', 'sign in with github',
                                     'sign in with microsoft', 'sign in with apple',
                                     'log in with email', 'log in with google',
                                     'continue with email', 'continue with google', 'continue with github'],
  'click', 0.95),

('logout_button',  'button',   ARRAY['log out', 'logout', 'sign out', 'signout'],
  'click', 0.95),

('signup_button',  'button',   ARRAY['sign up', 'signup', 'create account', 'register',
                                     'get started', 'join', 'join now', 'create free account'],
  'click', 0.95),

-- ── Form fields ──────────────────────────────────────────────────────────────
('email_input',    'textbox',  ARRAY['email', 'email address', 'e-mail', 'e-mail address',
                                     'work email', 'username or email', 'email or username',
                                     'email / username',
                                     'enter your email address', 'enter email address',
                                     'your email address', 'enter your email', 'type your email'],
  'type', 0.95),

('password_input', 'textbox',  ARRAY['password', 'current password', 'enter password',
                                     'your password'],
  'type', 0.95),

('search_input',   'searchbox', ARRAY['search', 'search...', 'search for anything',
                                      'what are you looking for', 'search*'],
  'type', 0.95),

('search_input_textbox', 'textbox', ARRAY['search', 'search...', 'search*'],
  'type', 0.92),

-- Combobox search: elements like Google's <textarea role="combobox" aria-label="Search">
-- The combobox role is used for autocomplete search widgets that own a suggestion listbox.
('search_input_combobox', 'combobox', ARRAY['search', 'search...', 'search*'],
  'type', 0.92),

-- ── Navigation ───────────────────────────────────────────────────────────────
('submit_button',  'button',   ARRAY['submit', 'continue', 'next', 'confirm', 'save',
                                     'save changes', 'apply', 'done', 'update', 'finish'],
  'click', 0.90)

ON CONFLICT (name) DO UPDATE
  SET name_patterns = EXCLUDED.name_patterns,
      action_hint   = EXCLUDED.action_hint,
      confidence    = EXCLUDED.confidence;
