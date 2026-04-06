-- Phase 4: Manual seed data for the shared selector pool.
-- Spec ref: kaizen-phase4-spec.md §6
--
-- These rows are inserted WITHOUT step_embedding / element_embedding because
-- embeddings require real OpenAI API calls. Consequently these rows will NOT
-- trigger L4 vector-similarity hits. They serve as structural scaffolding only —
-- correct hashes, valid selectors, proper attribution.
--
-- Run `npm run brain:seed` from a Windows terminal with DNS access to generate
-- proper embeddings and replace/supplement these rows with verified selectors.
--
-- content_hash = encode(sha256(lower(trim('<step text>'))::bytea), 'hex')
-- which matches: createHash('sha256').update(text.trim().toLowerCase()).digest('hex')

-- ─── GitHub Login (https://github.com/login) ─────────────────────────────────

INSERT INTO selector_cache
  (tenant_id, content_hash, domain, selectors, confidence_score, is_shared, attribution)
VALUES
  (NULL,
   encode(sha256(lower(trim('type in the username or email field'))::bytea), 'hex'),
   'github.com',
   '[{"selector":"#login_field","strategy":"css","priority":1},{"selector":"input[name=\"login\"]","strategy":"css","priority":2}]',
   0.95,
   true,
   '{"source":"seed","contributors":[],"seededAt":"2026-04-06T00:00:00Z"}')
ON CONFLICT DO NOTHING;

INSERT INTO selector_cache
  (tenant_id, content_hash, domain, selectors, confidence_score, is_shared, attribution)
VALUES
  (NULL,
   encode(sha256(lower(trim('type in the password field'))::bytea), 'hex'),
   'github.com',
   '[{"selector":"#password","strategy":"css","priority":1},{"selector":"input[type=\"password\"]","strategy":"css","priority":2}]',
   0.95,
   true,
   '{"source":"seed","contributors":[],"seededAt":"2026-04-06T00:00:00Z"}')
ON CONFLICT DO NOTHING;

INSERT INTO selector_cache
  (tenant_id, content_hash, domain, selectors, confidence_score, is_shared, attribution)
VALUES
  (NULL,
   encode(sha256(lower(trim('click the sign in button'))::bytea), 'hex'),
   'github.com',
   '[{"selector":"input[type=\"submit\"][value=\"Sign in\"]","strategy":"css","priority":1},{"selector":".js-sign-in-button","strategy":"css","priority":2}]',
   0.90,
   true,
   '{"source":"seed","contributors":[],"seededAt":"2026-04-06T00:00:00Z"}')
ON CONFLICT DO NOTHING;

INSERT INTO selector_cache
  (tenant_id, content_hash, domain, selectors, confidence_score, is_shared, attribution)
VALUES
  (NULL,
   encode(sha256(lower(trim('click the sign in link'))::bytea), 'hex'),
   'github.com',
   '[{"selector":"a[href=\"/login\"]","strategy":"css","priority":1}]',
   0.90,
   true,
   '{"source":"seed","contributors":[],"seededAt":"2026-04-06T00:00:00Z"}')
ON CONFLICT DO NOTHING;

INSERT INTO selector_cache
  (tenant_id, content_hash, domain, selectors, confidence_score, is_shared, attribution)
VALUES
  (NULL,
   encode(sha256(lower(trim('click the sign up button'))::bytea), 'hex'),
   'github.com',
   '[{"selector":"a[href=\"/signup\"]","strategy":"css","priority":1},{"selector":".js-signup-button","strategy":"css","priority":2}]',
   0.85,
   true,
   '{"source":"seed","contributors":[],"seededAt":"2026-04-06T00:00:00Z"}')
ON CONFLICT DO NOTHING;

-- ─── Salesforce Login (https://login.salesforce.com) ─────────────────────────

INSERT INTO selector_cache
  (tenant_id, content_hash, domain, selectors, confidence_score, is_shared, attribution)
VALUES
  (NULL,
   encode(sha256(lower(trim('type in the email field'))::bytea), 'hex'),
   'login.salesforce.com',
   '[{"selector":"#username","strategy":"css","priority":1},{"selector":"input[name=\"username\"]","strategy":"css","priority":2}]',
   0.95,
   true,
   '{"source":"seed","contributors":[],"seededAt":"2026-04-06T00:00:00Z"}')
ON CONFLICT DO NOTHING;

INSERT INTO selector_cache
  (tenant_id, content_hash, domain, selectors, confidence_score, is_shared, attribution)
VALUES
  (NULL,
   encode(sha256(lower(trim('type in the password field'))::bytea), 'hex'),
   'login.salesforce.com',
   '[{"selector":"#password","strategy":"css","priority":1},{"selector":"input[type=\"password\"]","strategy":"css","priority":2}]',
   0.95,
   true,
   '{"source":"seed","contributors":[],"seededAt":"2026-04-06T00:00:00Z"}')
ON CONFLICT DO NOTHING;

INSERT INTO selector_cache
  (tenant_id, content_hash, domain, selectors, confidence_score, is_shared, attribution)
VALUES
  (NULL,
   encode(sha256(lower(trim('click the log in button'))::bytea), 'hex'),
   'login.salesforce.com',
   '[{"selector":"#Login","strategy":"css","priority":1},{"selector":"input[type=\"submit\"]","strategy":"css","priority":2}]',
   0.95,
   true,
   '{"source":"seed","contributors":[],"seededAt":"2026-04-06T00:00:00Z"}')
ON CONFLICT DO NOTHING;

-- ─── Google Accounts (https://accounts.google.com) ───────────────────────────

INSERT INTO selector_cache
  (tenant_id, content_hash, domain, selectors, confidence_score, is_shared, attribution)
VALUES
  (NULL,
   encode(sha256(lower(trim('type in the email field'))::bytea), 'hex'),
   'accounts.google.com',
   '[{"selector":"#identifierId","strategy":"css","priority":1},{"selector":"input[type=\"email\"]","strategy":"css","priority":2}]',
   0.95,
   true,
   '{"source":"seed","contributors":[],"seededAt":"2026-04-06T00:00:00Z"}')
ON CONFLICT DO NOTHING;

INSERT INTO selector_cache
  (tenant_id, content_hash, domain, selectors, confidence_score, is_shared, attribution)
VALUES
  (NULL,
   encode(sha256(lower(trim('click the next button'))::bytea), 'hex'),
   'accounts.google.com',
   '[{"selector":"#identifierNext button","strategy":"css","priority":1},{"selector":"[data-action=\"next\"]","strategy":"css","priority":2}]',
   0.85,
   true,
   '{"source":"seed","contributors":[],"seededAt":"2026-04-06T00:00:00Z"}')
ON CONFLICT DO NOTHING;

INSERT INTO selector_cache
  (tenant_id, content_hash, domain, selectors, confidence_score, is_shared, attribution)
VALUES
  (NULL,
   encode(sha256(lower(trim('type in the password field'))::bytea), 'hex'),
   'accounts.google.com',
   '[{"selector":"input[type=\"password\"]","strategy":"css","priority":1},{"selector":"#password input","strategy":"css","priority":2}]',
   0.90,
   true,
   '{"source":"seed","contributors":[],"seededAt":"2026-04-06T00:00:00Z"}')
ON CONFLICT DO NOTHING;

-- ─── Slack (https://slack.com/signin) ────────────────────────────────────────

INSERT INTO selector_cache
  (tenant_id, content_hash, domain, selectors, confidence_score, is_shared, attribution)
VALUES
  (NULL,
   encode(sha256(lower(trim('type in the email field'))::bytea), 'hex'),
   'app.slack.com',
   '[{"selector":"#email","strategy":"css","priority":1},{"selector":"input[type=\"email\"]","strategy":"css","priority":2}]',
   0.90,
   true,
   '{"source":"seed","contributors":[],"seededAt":"2026-04-06T00:00:00Z"}')
ON CONFLICT DO NOTHING;

INSERT INTO selector_cache
  (tenant_id, content_hash, domain, selectors, confidence_score, is_shared, attribution)
VALUES
  (NULL,
   encode(sha256(lower(trim('click the continue button'))::bytea), 'hex'),
   'app.slack.com',
   '[{"selector":"[data-qa=\"submit_team_domain_button\"]","strategy":"css","priority":1},{"selector":"button[type=\"submit\"]","strategy":"css","priority":2}]',
   0.85,
   true,
   '{"source":"seed","contributors":[],"seededAt":"2026-04-06T00:00:00Z"}')
ON CONFLICT DO NOTHING;

-- ─── LinkedIn (https://www.linkedin.com/login) ───────────────────────────────

INSERT INTO selector_cache
  (tenant_id, content_hash, domain, selectors, confidence_score, is_shared, attribution)
VALUES
  (NULL,
   encode(sha256(lower(trim('type in the email field'))::bytea), 'hex'),
   'linkedin.com',
   '[{"selector":"#username","strategy":"css","priority":1},{"selector":"input[name=\"session_key\"]","strategy":"css","priority":2}]',
   0.95,
   true,
   '{"source":"seed","contributors":[],"seededAt":"2026-04-06T00:00:00Z"}')
ON CONFLICT DO NOTHING;

INSERT INTO selector_cache
  (tenant_id, content_hash, domain, selectors, confidence_score, is_shared, attribution)
VALUES
  (NULL,
   encode(sha256(lower(trim('type in the password field'))::bytea), 'hex'),
   'linkedin.com',
   '[{"selector":"#password","strategy":"css","priority":1},{"selector":"input[name=\"session_password\"]","strategy":"css","priority":2}]',
   0.95,
   true,
   '{"source":"seed","contributors":[],"seededAt":"2026-04-06T00:00:00Z"}')
ON CONFLICT DO NOTHING;

INSERT INTO selector_cache
  (tenant_id, content_hash, domain, selectors, confidence_score, is_shared, attribution)
VALUES
  (NULL,
   encode(sha256(lower(trim('click the sign in button'))::bytea), 'hex'),
   'linkedin.com',
   '[{"selector":"[data-litms-control-urn=\"login-submit\"]","strategy":"css","priority":1},{"selector":"button[type=\"submit\"]","strategy":"css","priority":2}]',
   0.85,
   true,
   '{"source":"seed","contributors":[],"seededAt":"2026-04-06T00:00:00Z"}')
ON CONFLICT DO NOTHING;

-- ─── Twitter / X (https://twitter.com/login) ─────────────────────────────────

INSERT INTO selector_cache
  (tenant_id, content_hash, domain, selectors, confidence_score, is_shared, attribution)
VALUES
  (NULL,
   encode(sha256(lower(trim('type in the phone, email, or username field'))::bytea), 'hex'),
   'twitter.com',
   '[{"selector":"input[name=\"text\"]","strategy":"css","priority":1},{"selector":"input[autocomplete=\"username\"]","strategy":"css","priority":2}]',
   0.90,
   true,
   '{"source":"seed","contributors":[],"seededAt":"2026-04-06T00:00:00Z"}')
ON CONFLICT DO NOTHING;

INSERT INTO selector_cache
  (tenant_id, content_hash, domain, selectors, confidence_score, is_shared, attribution)
VALUES
  (NULL,
   encode(sha256(lower(trim('click the next button'))::bytea), 'hex'),
   'twitter.com',
   '[{"selector":"[data-testid=\"LoginForm_Login_Button\"]","strategy":"css","priority":1},{"selector":"div[role=\"button\"]","strategy":"css","priority":2}]',
   0.80,
   true,
   '{"source":"seed","contributors":[],"seededAt":"2026-04-06T00:00:00Z"}')
ON CONFLICT DO NOTHING;

INSERT INTO selector_cache
  (tenant_id, content_hash, domain, selectors, confidence_score, is_shared, attribution)
VALUES
  (NULL,
   encode(sha256(lower(trim('type in the password field'))::bytea), 'hex'),
   'twitter.com',
   '[{"selector":"input[name=\"password\"]","strategy":"css","priority":1},{"selector":"input[type=\"password\"]","strategy":"css","priority":2}]',
   0.95,
   true,
   '{"source":"seed","contributors":[],"seededAt":"2026-04-06T00:00:00Z"}')
ON CONFLICT DO NOTHING;

INSERT INTO selector_cache
  (tenant_id, content_hash, domain, selectors, confidence_score, is_shared, attribution)
VALUES
  (NULL,
   encode(sha256(lower(trim('click the log in button'))::bytea), 'hex'),
   'twitter.com',
   '[{"selector":"[data-testid=\"LoginForm_Login_Button\"]","strategy":"css","priority":1},{"selector":"[role=\"button\"][tabindex=\"0\"]","strategy":"css","priority":2}]',
   0.80,
   true,
   '{"source":"seed","contributors":[],"seededAt":"2026-04-06T00:00:00Z"}')
ON CONFLICT DO NOTHING;
