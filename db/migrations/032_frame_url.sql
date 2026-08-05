-- Migration 032: frame provenance for elements resolved inside a child iframe
--
-- Spec: docs/specs/reliability/spec-iframe-selector-caching.md (backlog B9)
--
-- Elements the LLM picks inside a child frame (overwhelmingly cookie-consent CMPs)
-- were returned session-only and never cached, so every run re-paid the model to
-- dismiss the same banner. The blocker was that a CMP iframe's src carries
-- per-session state:
--
--   https://cdn.privacy-mgmt.com/index.html?consentUUID=8f3c...&_sp=...
--
-- selector_cache.frame_url therefore stores the CANONICAL frame URL -- origin +
-- pathname, query and hash stripped -- which survives across sessions:
--
--   https://cdn.privacy-mgmt.com/index.html
--
-- step_results.frame_url records where the element was actually found for this run,
-- so the run timeline can say which frame the step acted in.
--
-- Both nullable and additive: NULL means "the main document", which is what every
-- existing row is. Safe to apply under a live stack.

ALTER TABLE selector_cache ADD COLUMN IF NOT EXISTS frame_url TEXT;
ALTER TABLE step_results   ADD COLUMN IF NOT EXISTS frame_url TEXT;

COMMENT ON COLUMN selector_cache.frame_url IS
  'Canonical (origin + pathname) URL of the iframe this selector resolves inside. NULL = main document.';

COMMENT ON COLUMN step_results.frame_url IS
  'Canonical (origin + pathname) URL of the iframe the element was found in for this run. NULL = main document.';
