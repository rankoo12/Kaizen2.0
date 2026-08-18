-- 041_site_pages_reached_by.sql — how a screen without a URL is reached.
--
-- Spec: docs/specs/test-writer/spec-screen-discovery.md §1.3
--
-- A state-machine SPA switches views on click and never changes the URL. Recon
-- now records such a view as a page of its own — url_normalized carries a
-- #screen=<slug> fragment, url_observed is where a test must navigate — and
-- this column holds the clicks that get there, in order:
--   [{"role":"button","name":"Runs"}]
-- NULL for an ordinary page. The writer prepends these to every test on the
-- screen, after the navigate.

BEGIN;

ALTER TABLE site_pages ADD COLUMN IF NOT EXISTS reached_by JSONB;

COMMIT;
