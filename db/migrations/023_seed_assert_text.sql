-- =============================================================================
-- Kaizen — Compiled AST Cache Seed: assert_text
-- Migration: 023_seed_assert_text
-- Spec ref: docs/specs/workers/spec-engine-capabilities-assert-random-capture.md §1.4
--
-- Seeds common content-assertion phrasings that map to the new "assert_text"
-- action. assert_text verifies an element's TEXT contains an expected value
-- (case-insensitive, whitespace-normalised containment) — unlike assert_visible
-- which only checks presence.
--
-- Only fully-generic, value-free phrasings are seeded here. Assertions whose
-- expected value is data-specific (e.g. "verify the header shows test@x.com")
-- carry a unique value and are left to the L3 LLM fallback, which writes them
-- back to this cache on first use.
--
-- Hash computation matches the compiler:
--   encode(sha256(lower(trim(raw_text))::bytea), 'hex')
-- =============================================================================

INSERT INTO compiled_ast_cache (content_hash, ast_json) VALUES
  (encode(sha256(lower(trim('verify the success message is shown'))::bytea), 'hex'),       '{"action":"assert_text","targetDescription":"the success message","value":"success","url":null}'),
  (encode(sha256(lower(trim('verify the success message appears'))::bytea), 'hex'),        '{"action":"assert_text","targetDescription":"the success message","value":"success","url":null}'),
  (encode(sha256(lower(trim('validate the success message'))::bytea), 'hex'),              '{"action":"assert_text","targetDescription":"the success message","value":"success","url":null}'),
  (encode(sha256(lower(trim('verify the welcome message is shown'))::bytea), 'hex'),       '{"action":"assert_text","targetDescription":"the welcome message","value":"welcome","url":null}'),
  (encode(sha256(lower(trim('verify the error message is shown'))::bytea), 'hex'),         '{"action":"assert_text","targetDescription":"the error message","value":"error","url":null}')
ON CONFLICT DO NOTHING;
