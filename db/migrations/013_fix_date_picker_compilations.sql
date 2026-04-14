-- =============================================================================
-- Migration: 013_fix_date_picker_compilations
--
-- Force-correct the compiled_ast_cache entries for "select day N" patterns.
--
-- Root cause: the compiled_ast_cache uses ON CONFLICT DO NOTHING.  When an
-- early run compiled "select day 11" (and similar) as action:"click" (before
-- the compileStep prompt was tightened to require action:"select" for <select>
-- dropdowns), the wrong entry became permanent — even after the prompt was
-- fixed — because the cache is write-once.
--
-- This migration uses ON CONFLICT DO UPDATE to overwrite any stale click-action
-- entry with the correct select-action AST.  Days 1-31 are covered explicitly.
--
-- Hash computation: encode(sha256(lower(trim(text))::bytea), 'hex')
-- This matches the app's normalise() for texts that contain no quote characters.
-- =============================================================================

INSERT INTO compiled_ast_cache (content_hash, ast_json) VALUES
  (encode(sha256(lower(trim('select day 1'))::bytea),  'hex'), '{"action":"select","targetDescription":"day","value":"1","url":null}'),
  (encode(sha256(lower(trim('select day 2'))::bytea),  'hex'), '{"action":"select","targetDescription":"day","value":"2","url":null}'),
  (encode(sha256(lower(trim('select day 3'))::bytea),  'hex'), '{"action":"select","targetDescription":"day","value":"3","url":null}'),
  (encode(sha256(lower(trim('select day 4'))::bytea),  'hex'), '{"action":"select","targetDescription":"day","value":"4","url":null}'),
  (encode(sha256(lower(trim('select day 5'))::bytea),  'hex'), '{"action":"select","targetDescription":"day","value":"5","url":null}'),
  (encode(sha256(lower(trim('select day 6'))::bytea),  'hex'), '{"action":"select","targetDescription":"day","value":"6","url":null}'),
  (encode(sha256(lower(trim('select day 7'))::bytea),  'hex'), '{"action":"select","targetDescription":"day","value":"7","url":null}'),
  (encode(sha256(lower(trim('select day 8'))::bytea),  'hex'), '{"action":"select","targetDescription":"day","value":"8","url":null}'),
  (encode(sha256(lower(trim('select day 9'))::bytea),  'hex'), '{"action":"select","targetDescription":"day","value":"9","url":null}'),
  (encode(sha256(lower(trim('select day 10'))::bytea), 'hex'), '{"action":"select","targetDescription":"day","value":"10","url":null}'),
  (encode(sha256(lower(trim('select day 11'))::bytea), 'hex'), '{"action":"select","targetDescription":"day","value":"11","url":null}'),
  (encode(sha256(lower(trim('select day 12'))::bytea), 'hex'), '{"action":"select","targetDescription":"day","value":"12","url":null}'),
  (encode(sha256(lower(trim('select day 13'))::bytea), 'hex'), '{"action":"select","targetDescription":"day","value":"13","url":null}'),
  (encode(sha256(lower(trim('select day 14'))::bytea), 'hex'), '{"action":"select","targetDescription":"day","value":"14","url":null}'),
  (encode(sha256(lower(trim('select day 15'))::bytea), 'hex'), '{"action":"select","targetDescription":"day","value":"15","url":null}'),
  (encode(sha256(lower(trim('select day 16'))::bytea), 'hex'), '{"action":"select","targetDescription":"day","value":"16","url":null}'),
  (encode(sha256(lower(trim('select day 17'))::bytea), 'hex'), '{"action":"select","targetDescription":"day","value":"17","url":null}'),
  (encode(sha256(lower(trim('select day 18'))::bytea), 'hex'), '{"action":"select","targetDescription":"day","value":"18","url":null}'),
  (encode(sha256(lower(trim('select day 19'))::bytea), 'hex'), '{"action":"select","targetDescription":"day","value":"19","url":null}'),
  (encode(sha256(lower(trim('select day 20'))::bytea), 'hex'), '{"action":"select","targetDescription":"day","value":"20","url":null}'),
  (encode(sha256(lower(trim('select day 21'))::bytea), 'hex'), '{"action":"select","targetDescription":"day","value":"21","url":null}'),
  (encode(sha256(lower(trim('select day 22'))::bytea), 'hex'), '{"action":"select","targetDescription":"day","value":"22","url":null}'),
  (encode(sha256(lower(trim('select day 23'))::bytea), 'hex'), '{"action":"select","targetDescription":"day","value":"23","url":null}'),
  (encode(sha256(lower(trim('select day 24'))::bytea), 'hex'), '{"action":"select","targetDescription":"day","value":"24","url":null}'),
  (encode(sha256(lower(trim('select day 25'))::bytea), 'hex'), '{"action":"select","targetDescription":"day","value":"25","url":null}'),
  (encode(sha256(lower(trim('select day 26'))::bytea), 'hex'), '{"action":"select","targetDescription":"day","value":"26","url":null}'),
  (encode(sha256(lower(trim('select day 27'))::bytea), 'hex'), '{"action":"select","targetDescription":"day","value":"27","url":null}'),
  (encode(sha256(lower(trim('select day 28'))::bytea), 'hex'), '{"action":"select","targetDescription":"day","value":"28","url":null}'),
  (encode(sha256(lower(trim('select day 29'))::bytea), 'hex'), '{"action":"select","targetDescription":"day","value":"29","url":null}'),
  (encode(sha256(lower(trim('select day 30'))::bytea), 'hex'), '{"action":"select","targetDescription":"day","value":"30","url":null}'),
  (encode(sha256(lower(trim('select day 31'))::bytea), 'hex'), '{"action":"select","targetDescription":"day","value":"31","url":null}')
ON CONFLICT (content_hash) DO UPDATE
  SET ast_json = EXCLUDED.ast_json;
