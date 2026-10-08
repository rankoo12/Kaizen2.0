-- 044: run video artifact
-- Spec: docs/specs/tests-ux/spec-run-video.md §3
--
-- Stored key of the run's recorded browser video ({tenantId}/{runId}/video.webm,
-- GCS or local per media service config). NULL = no video: runs from before this
-- migration, Test Writer proving runs (recording gated off), RUN_VIDEO=off, or a
-- best-effort capture/upload that failed without affecting the run.

ALTER TABLE runs ADD COLUMN IF NOT EXISTS video_key TEXT;
