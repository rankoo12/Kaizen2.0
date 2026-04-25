/**
 * Spec ref: docs/specs/smart-brain/spec-element-resolver-cache-semantic-guard.md
 *
 * Rejects a cache hit whose stored semantic fingerprint disagrees with the
 * current step's intent vector. Defends against the failure mode where a
 * (content_hash, domain, tenant_id) row points at the wrong element — the
 * selector validates against the live DOM, the click succeeds, but the test
 * drifts to an unrelated page and every subsequent step runs in a broken state.
 *
 * We accept the hit if EITHER of the row's stored vectors is close enough:
 *   - step_embedding    → past intent matches current intent
 *   - element_embedding → element identity matches the description
 * These are complementary signals; requiring both would over-reject rows
 * that were originally written by a slightly different phrasing of the same
 * intent.
 */

export const SEMANTIC_GUARD_THRESHOLD = 0.80;

export type GuardResult = {
  passed: boolean;
  /** Best cosine similarity across the two stored vectors, or null when no comparison could be made. */
  bestSimilarity: number | null;
};

/**
 * @param stepEmbedding       Current step's intent vector (from ResolutionContext).
 *                            Undefined → guard cannot evaluate → pass.
 * @param rowStepEmbedding    Row's stored step_embedding (null on legacy rows).
 * @param rowElementEmbedding Row's stored element_embedding (null on legacy rows).
 */
export function semanticGuardPasses(
  stepEmbedding: number[] | undefined,
  rowStepEmbedding: number[] | null,
  rowElementEmbedding: number[] | null,
): GuardResult {
  if (!stepEmbedding) return { passed: true, bestSimilarity: null };
  if (!rowStepEmbedding && !rowElementEmbedding) return { passed: true, bestSimilarity: null };

  const sims: number[] = [];
  if (rowStepEmbedding && rowStepEmbedding.length === stepEmbedding.length) {
    sims.push(cosine(stepEmbedding, rowStepEmbedding));
  }
  if (rowElementEmbedding && rowElementEmbedding.length === stepEmbedding.length) {
    sims.push(cosine(stepEmbedding, rowElementEmbedding));
  }

  // Both stored vectors had mismatched dimensions — cannot meaningfully compare.
  if (sims.length === 0) return { passed: true, bestSimilarity: null };

  const best = Math.max(...sims);
  return { passed: best >= SEMANTIC_GUARD_THRESHOLD, bestSimilarity: best };
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
