-- Migration: Add wildcard pattern 'search*' to search archetypes +
--            fix query selector for search inputs
--
-- Why:
--   1. Many sites label their search input "Search <Site>" (e.g. "Search Wikipedia").
--      Exact matching against ['search', 'search...'] misses these.
--      The '*' suffix means prefix-match: normalised name must START WITH 'search'.
--   2. The DOM pruner was assigning role='textbox' to input[type="search"] instead
--      of role='searchbox' (fixed in playwright.dom-pruner.ts). After that fix,
--      Wikipedia-style inputs now flow into search_input (searchbox) instead of
--      search_input_textbox (textbox).  Both archetypes get the wildcard so the
--      transition is seamless.

UPDATE element_archetypes
SET name_patterns = array_append(name_patterns, 'search*')
WHERE name IN ('search_input', 'search_input_textbox')
  AND NOT ('search*' = ANY(name_patterns));
