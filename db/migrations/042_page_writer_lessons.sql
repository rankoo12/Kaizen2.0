-- 042_page_writer_lessons.sql — what validation taught about writing tests for a page.
--
-- Spec: docs/specs/test-writer/spec-close-the-gap-32.md §2.3
--
-- Every generation job starts a fresh suite, so the in-memory lesson map began
-- empty and round 1 of every run repeated the previous run's mistake ("Target
-- URL needs to start with http://" — four runs in a row). A lesson earned by a
-- validation failure belongs to the PAGE, tenant-wide, across runs: the next
-- job loads it before writing anything.
ALTER TABLE site_pages ADD COLUMN IF NOT EXISTS writer_lessons jsonb NOT NULL DEFAULT '[]'::jsonb;
