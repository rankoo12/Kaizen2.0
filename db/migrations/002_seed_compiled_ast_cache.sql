-- =============================================================================
-- Kaizen — Compiled AST Cache Seed
-- Migration: 002_seed_compiled_ast_cache
-- Spec ref: docs/kaizen-spec-v2.md §6.1 — LearnedCompiler
--
-- Pre-seeds the compiled_ast_cache table with structural patterns covering
-- the most common natural-language test step phrasings. This prevents cold-start
-- LLM calls for standard actions — any test suite using these phrases pays
-- zero compilation latency and zero LLM tokens from the first run onward.
--
-- Hash computation: encode(sha256(lower(trim(raw_text))::bytea), 'hex')
-- This matches Node.js: createHash('sha256').update(text.trim().toLowerCase()).digest('hex')
--
-- ast_json stores only { action, targetDescription, value, url }.
-- rawText and contentHash are NOT stored here — they are derived by the compiler
-- from the calling context and the table's primary key respectively.
-- =============================================================================

-- ─── PRESS KEY ────────────────────────────────────────────────────────────────
-- Most valuable seeds: press_key actions are fully deterministic. No element
-- resolution needed, no ambiguity, universal across every test suite.

INSERT INTO compiled_ast_cache (content_hash, ast_json) VALUES
  (encode(sha256(lower(trim('press enter'))::bytea), 'hex'),        '{"action":"press_key","value":"Enter","targetDescription":null,"url":null}'),
  (encode(sha256(lower(trim('hit enter'))::bytea), 'hex'),          '{"action":"press_key","value":"Enter","targetDescription":null,"url":null}'),
  (encode(sha256(lower(trim('press the enter key'))::bytea), 'hex'),'{"action":"press_key","value":"Enter","targetDescription":null,"url":null}'),
  (encode(sha256(lower(trim('submit the form'))::bytea), 'hex'),    '{"action":"press_key","value":"Enter","targetDescription":null,"url":null}'),
  (encode(sha256(lower(trim('press tab'))::bytea), 'hex'),          '{"action":"press_key","value":"Tab","targetDescription":null,"url":null}'),
  (encode(sha256(lower(trim('hit tab'))::bytea), 'hex'),            '{"action":"press_key","value":"Tab","targetDescription":null,"url":null}'),
  (encode(sha256(lower(trim('press the tab key'))::bytea), 'hex'),  '{"action":"press_key","value":"Tab","targetDescription":null,"url":null}'),
  (encode(sha256(lower(trim('press escape'))::bytea), 'hex'),       '{"action":"press_key","value":"Escape","targetDescription":null,"url":null}'),
  (encode(sha256(lower(trim('press esc'))::bytea), 'hex'),          '{"action":"press_key","value":"Escape","targetDescription":null,"url":null}'),
  (encode(sha256(lower(trim('hit escape'))::bytea), 'hex'),         '{"action":"press_key","value":"Escape","targetDescription":null,"url":null}'),
  (encode(sha256(lower(trim('close with escape'))::bytea), 'hex'),  '{"action":"press_key","value":"Escape","targetDescription":null,"url":null}'),
  (encode(sha256(lower(trim('press space'))::bytea), 'hex'),        '{"action":"press_key","value":"Space","targetDescription":null,"url":null}'),
  (encode(sha256(lower(trim('press the space bar'))::bytea), 'hex'),'{"action":"press_key","value":"Space","targetDescription":null,"url":null}'),
  (encode(sha256(lower(trim('press spacebar'))::bytea), 'hex'),     '{"action":"press_key","value":"Space","targetDescription":null,"url":null}'),
  (encode(sha256(lower(trim('press backspace'))::bytea), 'hex'),    '{"action":"press_key","value":"Backspace","targetDescription":null,"url":null}'),
  (encode(sha256(lower(trim('press delete'))::bytea), 'hex'),       '{"action":"press_key","value":"Delete","targetDescription":null,"url":null}'),
  (encode(sha256(lower(trim('press arrow up'))::bytea), 'hex'),     '{"action":"press_key","value":"ArrowUp","targetDescription":null,"url":null}'),
  (encode(sha256(lower(trim('press up'))::bytea), 'hex'),           '{"action":"press_key","value":"ArrowUp","targetDescription":null,"url":null}'),
  (encode(sha256(lower(trim('press arrow down'))::bytea), 'hex'),   '{"action":"press_key","value":"ArrowDown","targetDescription":null,"url":null}'),
  (encode(sha256(lower(trim('press down'))::bytea), 'hex'),         '{"action":"press_key","value":"ArrowDown","targetDescription":null,"url":null}'),
  (encode(sha256(lower(trim('press arrow left'))::bytea), 'hex'),   '{"action":"press_key","value":"ArrowLeft","targetDescription":null,"url":null}'),
  (encode(sha256(lower(trim('press arrow right'))::bytea), 'hex'),  '{"action":"press_key","value":"ArrowRight","targetDescription":null,"url":null}')
ON CONFLICT DO NOTHING;

-- ─── WAIT ─────────────────────────────────────────────────────────────────────

INSERT INTO compiled_ast_cache (content_hash, ast_json) VALUES
  (encode(sha256(lower(trim('wait for page to load'))::bytea), 'hex'),         '{"action":"wait","value":"2000","targetDescription":null,"url":null}'),
  (encode(sha256(lower(trim('wait for the page to load'))::bytea), 'hex'),     '{"action":"wait","value":"2000","targetDescription":null,"url":null}'),
  (encode(sha256(lower(trim('wait for page load'))::bytea), 'hex'),            '{"action":"wait","value":"2000","targetDescription":null,"url":null}'),
  (encode(sha256(lower(trim('wait 1 second'))::bytea), 'hex'),                 '{"action":"wait","value":"1000","targetDescription":null,"url":null}'),
  (encode(sha256(lower(trim('wait one second'))::bytea), 'hex'),               '{"action":"wait","value":"1000","targetDescription":null,"url":null}'),
  (encode(sha256(lower(trim('wait 2 seconds'))::bytea), 'hex'),                '{"action":"wait","value":"2000","targetDescription":null,"url":null}'),
  (encode(sha256(lower(trim('wait two seconds'))::bytea), 'hex'),              '{"action":"wait","value":"2000","targetDescription":null,"url":null}'),
  (encode(sha256(lower(trim('wait 3 seconds'))::bytea), 'hex'),                '{"action":"wait","value":"3000","targetDescription":null,"url":null}'),
  (encode(sha256(lower(trim('wait three seconds'))::bytea), 'hex'),            '{"action":"wait","value":"3000","targetDescription":null,"url":null}'),
  (encode(sha256(lower(trim('wait 500ms'))::bytea), 'hex'),                    '{"action":"wait","value":"500","targetDescription":null,"url":null}'),
  (encode(sha256(lower(trim('pause for a moment'))::bytea), 'hex'),            '{"action":"wait","value":"1000","targetDescription":null,"url":null}')
ON CONFLICT DO NOTHING;

-- ─── SCROLL ───────────────────────────────────────────────────────────────────

INSERT INTO compiled_ast_cache (content_hash, ast_json) VALUES
  (encode(sha256(lower(trim('scroll down'))::bytea), 'hex'),                   '{"action":"scroll","targetDescription":"bottom of page","value":null,"url":null}'),
  (encode(sha256(lower(trim('scroll to bottom'))::bytea), 'hex'),              '{"action":"scroll","targetDescription":"bottom of page","value":null,"url":null}'),
  (encode(sha256(lower(trim('scroll to the bottom'))::bytea), 'hex'),          '{"action":"scroll","targetDescription":"bottom of page","value":null,"url":null}'),
  (encode(sha256(lower(trim('scroll to the bottom of the page'))::bytea), 'hex'),'{"action":"scroll","targetDescription":"bottom of page","value":null,"url":null}'),
  (encode(sha256(lower(trim('scroll up'))::bytea), 'hex'),                     '{"action":"scroll","targetDescription":"top of page","value":null,"url":null}'),
  (encode(sha256(lower(trim('scroll to top'))::bytea), 'hex'),                 '{"action":"scroll","targetDescription":"top of page","value":null,"url":null}'),
  (encode(sha256(lower(trim('scroll to the top'))::bytea), 'hex'),             '{"action":"scroll","targetDescription":"top of page","value":null,"url":null}'),
  (encode(sha256(lower(trim('scroll to the top of the page'))::bytea), 'hex'), '{"action":"scroll","targetDescription":"top of page","value":null,"url":null}')
ON CONFLICT DO NOTHING;

-- ─── COMMON CLICKS ────────────────────────────────────────────────────────────
-- Covers the universal button vocabulary shared across virtually every web app.

INSERT INTO compiled_ast_cache (content_hash, ast_json) VALUES
  (encode(sha256(lower(trim('click submit'))::bytea), 'hex'),                  '{"action":"click","targetDescription":"submit button","value":null,"url":null}'),
  (encode(sha256(lower(trim('click the submit button'))::bytea), 'hex'),       '{"action":"click","targetDescription":"submit button","value":null,"url":null}'),
  (encode(sha256(lower(trim('click login'))::bytea), 'hex'),                   '{"action":"click","targetDescription":"login button","value":null,"url":null}'),
  (encode(sha256(lower(trim('click the login button'))::bytea), 'hex'),        '{"action":"click","targetDescription":"login button","value":null,"url":null}'),
  (encode(sha256(lower(trim('click log in'))::bytea), 'hex'),                  '{"action":"click","targetDescription":"log in button","value":null,"url":null}'),
  (encode(sha256(lower(trim('click the log in button'))::bytea), 'hex'),       '{"action":"click","targetDescription":"log in button","value":null,"url":null}'),
  (encode(sha256(lower(trim('click sign in'))::bytea), 'hex'),                 '{"action":"click","targetDescription":"sign in button","value":null,"url":null}'),
  (encode(sha256(lower(trim('click the sign in button'))::bytea), 'hex'),      '{"action":"click","targetDescription":"sign in button","value":null,"url":null}'),
  (encode(sha256(lower(trim('click sign up'))::bytea), 'hex'),                 '{"action":"click","targetDescription":"sign up button","value":null,"url":null}'),
  (encode(sha256(lower(trim('click the sign up button'))::bytea), 'hex'),      '{"action":"click","targetDescription":"sign up button","value":null,"url":null}'),
  (encode(sha256(lower(trim('click register'))::bytea), 'hex'),                '{"action":"click","targetDescription":"register button","value":null,"url":null}'),
  (encode(sha256(lower(trim('click create account'))::bytea), 'hex'),          '{"action":"click","targetDescription":"create account button","value":null,"url":null}'),
  (encode(sha256(lower(trim('click logout'))::bytea), 'hex'),                  '{"action":"click","targetDescription":"logout button","value":null,"url":null}'),
  (encode(sha256(lower(trim('click log out'))::bytea), 'hex'),                 '{"action":"click","targetDescription":"log out button","value":null,"url":null}'),
  (encode(sha256(lower(trim('click the logout button'))::bytea), 'hex'),       '{"action":"click","targetDescription":"logout button","value":null,"url":null}'),
  (encode(sha256(lower(trim('click continue'))::bytea), 'hex'),                '{"action":"click","targetDescription":"continue button","value":null,"url":null}'),
  (encode(sha256(lower(trim('click the continue button'))::bytea), 'hex'),     '{"action":"click","targetDescription":"continue button","value":null,"url":null}'),
  (encode(sha256(lower(trim('click next'))::bytea), 'hex'),                    '{"action":"click","targetDescription":"next button","value":null,"url":null}'),
  (encode(sha256(lower(trim('click the next button'))::bytea), 'hex'),         '{"action":"click","targetDescription":"next button","value":null,"url":null}'),
  (encode(sha256(lower(trim('click back'))::bytea), 'hex'),                    '{"action":"click","targetDescription":"back button","value":null,"url":null}'),
  (encode(sha256(lower(trim('click the back button'))::bytea), 'hex'),         '{"action":"click","targetDescription":"back button","value":null,"url":null}'),
  (encode(sha256(lower(trim('click cancel'))::bytea), 'hex'),                  '{"action":"click","targetDescription":"cancel button","value":null,"url":null}'),
  (encode(sha256(lower(trim('click the cancel button'))::bytea), 'hex'),       '{"action":"click","targetDescription":"cancel button","value":null,"url":null}'),
  (encode(sha256(lower(trim('click close'))::bytea), 'hex'),                   '{"action":"click","targetDescription":"close button","value":null,"url":null}'),
  (encode(sha256(lower(trim('click the close button'))::bytea), 'hex'),        '{"action":"click","targetDescription":"close button","value":null,"url":null}'),
  (encode(sha256(lower(trim('click save'))::bytea), 'hex'),                    '{"action":"click","targetDescription":"save button","value":null,"url":null}'),
  (encode(sha256(lower(trim('click the save button'))::bytea), 'hex'),         '{"action":"click","targetDescription":"save button","value":null,"url":null}'),
  (encode(sha256(lower(trim('click ok'))::bytea), 'hex'),                      '{"action":"click","targetDescription":"ok button","value":null,"url":null}'),
  (encode(sha256(lower(trim('click the ok button'))::bytea), 'hex'),           '{"action":"click","targetDescription":"ok button","value":null,"url":null}'),
  (encode(sha256(lower(trim('click yes'))::bytea), 'hex'),                     '{"action":"click","targetDescription":"yes button","value":null,"url":null}'),
  (encode(sha256(lower(trim('click no'))::bytea), 'hex'),                      '{"action":"click","targetDescription":"no button","value":null,"url":null}'),
  (encode(sha256(lower(trim('click confirm'))::bytea), 'hex'),                 '{"action":"click","targetDescription":"confirm button","value":null,"url":null}'),
  (encode(sha256(lower(trim('click the confirm button'))::bytea), 'hex'),      '{"action":"click","targetDescription":"confirm button","value":null,"url":null}'),
  (encode(sha256(lower(trim('click delete'))::bytea), 'hex'),                  '{"action":"click","targetDescription":"delete button","value":null,"url":null}'),
  (encode(sha256(lower(trim('click the delete button'))::bytea), 'hex'),       '{"action":"click","targetDescription":"delete button","value":null,"url":null}'),
  (encode(sha256(lower(trim('click add'))::bytea), 'hex'),                     '{"action":"click","targetDescription":"add button","value":null,"url":null}'),
  (encode(sha256(lower(trim('click search'))::bytea), 'hex'),                  '{"action":"click","targetDescription":"search button","value":null,"url":null}'),
  (encode(sha256(lower(trim('click the search button'))::bytea), 'hex'),       '{"action":"click","targetDescription":"search button","value":null,"url":null}'),
  (encode(sha256(lower(trim('click accept'))::bytea), 'hex'),                  '{"action":"click","targetDescription":"accept button","value":null,"url":null}'),
  (encode(sha256(lower(trim('accept cookies'))::bytea), 'hex'),                '{"action":"click","targetDescription":"accept cookies button","value":null,"url":null}'),
  (encode(sha256(lower(trim('click the accept cookies button'))::bytea), 'hex'),'{"action":"click","targetDescription":"accept cookies button","value":null,"url":null}'),
  (encode(sha256(lower(trim('click home'))::bytea), 'hex'),                    '{"action":"click","targetDescription":"home link","value":null,"url":null}')
ON CONFLICT DO NOTHING;
