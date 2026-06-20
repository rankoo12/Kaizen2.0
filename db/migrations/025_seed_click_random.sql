-- =============================================================================
-- Kaizen — Compiled AST Cache Seed: click_random
-- Migration: 025_seed_click_random
-- Spec ref: docs/specs/workers/spec-engine-capabilities-assert-random-capture.md §2
--
-- Deterministically maps the common "random item" phrasings to the click_random
-- action so they don't depend on the LLM classifying them correctly (which was
-- unreliable for "add a random product to the cart" — it compiled to plain
-- click and resolved to a Search link).
--
-- targetDescription is the element to CLICK:
--   * "select/open a random product"            → "a product link"
--   * "add a random product to the cart" + kin  → "add to cart button"
--     (clicking the button adds the item; the product NAME is captured from the
--      button's product card automatically into {{selectedItem}}).
--
-- Hash: encode(sha256(lower(trim(raw_text))::bytea), 'hex') — matches the compiler.
-- =============================================================================

-- Re-point any previously-cached (mis-compiled) rows for these phrasings, then
-- ensure the correct rows exist.
DELETE FROM compiled_ast_cache WHERE content_hash IN (
  encode(sha256(lower(trim('add a random product to the cart'))::bytea), 'hex'),
  encode(sha256(lower(trim('add a random product to cart'))::bytea), 'hex'),
  encode(sha256(lower(trim('add a random item to the cart'))::bytea), 'hex'),
  encode(sha256(lower(trim('select a random product and add to cart'))::bytea), 'hex'),
  encode(sha256(lower(trim('select a random product and add it to the cart'))::bytea), 'hex'),
  encode(sha256(lower(trim('select a random product'))::bytea), 'hex'),
  encode(sha256(lower(trim('pick a random product'))::bytea), 'hex'),
  encode(sha256(lower(trim('choose a random product'))::bytea), 'hex'),
  encode(sha256(lower(trim('open a random product'))::bytea), 'hex')
);

INSERT INTO compiled_ast_cache (content_hash, ast_json) VALUES
  (encode(sha256(lower(trim('add a random product to the cart'))::bytea), 'hex'),            '{"action":"click_random","targetDescription":"add to cart button","value":null,"url":null}'),
  (encode(sha256(lower(trim('add a random product to cart'))::bytea), 'hex'),                '{"action":"click_random","targetDescription":"add to cart button","value":null,"url":null}'),
  (encode(sha256(lower(trim('add a random item to the cart'))::bytea), 'hex'),               '{"action":"click_random","targetDescription":"add to cart button","value":null,"url":null}'),
  (encode(sha256(lower(trim('select a random product and add to cart'))::bytea), 'hex'),     '{"action":"click_random","targetDescription":"add to cart button","value":null,"url":null}'),
  (encode(sha256(lower(trim('select a random product and add it to the cart'))::bytea), 'hex'),'{"action":"click_random","targetDescription":"add to cart button","value":null,"url":null}'),
  (encode(sha256(lower(trim('select a random product'))::bytea), 'hex'),                     '{"action":"click_random","targetDescription":"a product link","value":null,"url":null}'),
  (encode(sha256(lower(trim('pick a random product'))::bytea), 'hex'),                       '{"action":"click_random","targetDescription":"a product link","value":null,"url":null}'),
  (encode(sha256(lower(trim('choose a random product'))::bytea), 'hex'),                     '{"action":"click_random","targetDescription":"a product link","value":null,"url":null}'),
  (encode(sha256(lower(trim('open a random product'))::bytea), 'hex'),                       '{"action":"click_random","targetDescription":"a product link","value":null,"url":null}')
ON CONFLICT (content_hash) DO UPDATE SET ast_json = EXCLUDED.ast_json;
