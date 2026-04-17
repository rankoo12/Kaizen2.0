-- Migration: 018_combobox_search_archetype
-- Adds the search_input_combobox archetype for elements with role="combobox"
-- such as Google's <textarea role="combobox" aria-label="Search">.
--
-- The combobox role is assigned by browsers/page authors to autocomplete search
-- widgets that own a suggestion listbox (aria-controls). Without this archetype,
-- such elements fall through L0 to the LLM resolver.

INSERT INTO element_archetypes (name, role, name_patterns, action_hint, confidence)
VALUES (
  'search_input_combobox',
  'combobox',
  ARRAY['search', 'search...', 'search*'],
  'type',
  0.92
)
ON CONFLICT (name) DO UPDATE
  SET name_patterns = EXCLUDED.name_patterns,
      action_hint   = EXCLUDED.action_hint,
      confidence    = EXCLUDED.confidence;
