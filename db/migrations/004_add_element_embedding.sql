-- =============================================================================
-- Kaizen v3 — Phase 3: Element Embedding Column
-- Migration: 004_add_element_embedding
-- Spec ref: docs/kaizen-spec-v3.md §Phase 3
--
-- Adds element_embedding vector to selector_cache for ElementSimilarityStrategy:
-- AX tree candidates are embedded and compared via cosine similarity (> 0.85)
-- to heal broken selectors without LLM calls.
-- =============================================================================

-- Add element_embedding column (stores AX tree candidate embedding at resolution time)
ALTER TABLE selector_cache
  ADD COLUMN IF NOT EXISTS element_embedding vector(1536);

-- HNSW index for fast cosine similarity search on element embeddings
CREATE INDEX IF NOT EXISTS idx_selector_cache_element_vec
  ON selector_cache
  USING hnsw (element_embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 128);
