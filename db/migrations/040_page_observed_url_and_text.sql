-- 040_page_observed_url_and_text.sql — two things recon saw and then threw away.
--
-- Spec: docs/specs/test-writer/spec-oracle-delta-and-fidelity.md §2, §4
--
-- url_observed — the URL as the site actually wrote it. url_normalized strips
-- the trailing slash so a page has ONE identity, which is right for identity
-- and wrong for navigation: the-internet serves /add_remove_elements/ (200) and
-- 404s on /add_remove_elements. We crawled the stripped form, lost a whole
-- page, and reported the site's own link as broken. Identity keeps the
-- normalized form; anything that NAVIGATES uses this one.
--
-- page_text — the first stretch of what a visitor actually reads. A page whose
-- only content is text (a 404 page, an error demo, a frameset) has no citable
-- controls, so WRITE was handed an empty grounding set and the plan was
-- rejected — even though "navigate there and verify the text is shown" is a
-- perfectly good test.

BEGIN;

ALTER TABLE site_pages ADD COLUMN IF NOT EXISTS url_observed TEXT;
ALTER TABLE site_pages ADD COLUMN IF NOT EXISTS page_text TEXT;

COMMIT;
