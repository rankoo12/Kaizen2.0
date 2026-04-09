import type { StepAST, SelectorSet, ResolutionContext } from '../../types';

/**
 * Spec ref: Section 6.3 — IElementResolver
 *
 * Resolves a compiled step to an ordered set of selectors.
 *
 * Cache hierarchy (checked in order by CompositeElementResolver):
 *  L1   — Redis hot cache keyed by targetHash (TTL: 1 hour)
 *  L2   — Postgres selector_cache exact targetHash lookup
 *  L3   — pgvector step_embedding cosine similarity > 0.92 (tenant scope)
 *  L4   — pgvector step_embedding cosine similarity > 0.92 (shared pool)
 *  L2.5 — pgvector element_embedding similarity (inside LLMElementResolver, after DOM prune)
 *         catches same-element / different-value steps (e.g. type "hello" vs "test" in same field)
 *  L5   — LLM call via ILLMGateway (DOM prune → prompt → validate → persist)
 *
 * Registered implementations (DI container):
 *  - CachedElementResolver   — L1 → L2 → L3 → L4 lookup only
 *  - LLMElementResolver      — L2.5 → L5 (prune + element-embed + LLM) with cache write-back
 *  - CompositeElementResolver — CachedElementResolver with LLMElementResolver fallback
 */
export interface IElementResolver {
  /**
   * Resolve a compiled step to an ordered set of selectors.
   * Returns immediately on cache hit; calls LLM on miss and persists the result.
   */
  resolve(step: StepAST, context: ResolutionContext): Promise<SelectorSet>;

  /**
   * Report a successful selector use. Updates confidence score and outcome_window.
   * @param targetHash step.targetHash — shared across all steps targeting the same element.
   */
  recordSuccess(targetHash: string, domain: string, selectorUsed: string): Promise<void>;

  /**
   * Report a selector failure. Triggers score decay; may mark entry as Degraded.
   * @param targetHash step.targetHash — shared across all steps targeting the same element.
   */
  recordFailure(targetHash: string, domain: string, selectorAttempted: string): Promise<void>;
}
