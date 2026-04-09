-- Migration 008: resolution tracking + target_hash in step_results
--
-- target_hash  : SHA-256(action + ':' + targetDescription) — matches selector_cache.content_hash
--                Needed so the verdict endpoint can correctly pin/evict the right cache row.
--                Previously, step_results.content_hash held the compilation hash (not the target hash),
--                so the 'passed' pin and 'failed' eviction queries were silently hitting nothing.
--
-- resolution_source : where the selector came from
--                     redis | db_exact | pgvector_step | pgvector_element | llm
--
-- similarity_score  : cosine similarity (0–1) when a vector search was used; NULL otherwise

ALTER TABLE step_results ADD COLUMN IF NOT EXISTS target_hash        TEXT;
ALTER TABLE step_results ADD COLUMN IF NOT EXISTS resolution_source  TEXT;
ALTER TABLE step_results ADD COLUMN IF NOT EXISTS similarity_score   FLOAT;
