import type { StepAST, SelectorSet, ResolutionContext } from '../../types';

/**
 * Spec ref: Section 6.3 — IElementResolver
 *
 * Resolves a compiled step to an ordered set of selectors.
 *
 * Cache hierarchy (checked in order by CompositeElementResolver):
 *  L1 — Redis hot cache (TTL: 1 hour)
 *  L2 — Postgres selector_cache (exact hash + domain match)
 *  L3 — Vector similarity in tenant namespace (threshold: cosine > 0.92)
 *  L4 — Vector similarity in shared pool (enterprise tenants, opt-in)
 *  L5 — LLM call via ILLMGateway (DOM prune → prompt → validate → persist)
 *
 * Registered implementations (DI container):
 *  - CachedElementResolver   — L1 → L2 → L3 → L4 lookup only
 *  - LLMElementResolver      — L5 (prune + LLM) with cache write-back
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
   */
  recordSuccess(contentHash: string, domain: string, selectorUsed: string): Promise<void>;

  /**
   * Report a selector failure. Triggers score decay; may mark entry as Degraded.
   */
  recordFailure(contentHash: string, domain: string, selectorAttempted: string): Promise<void>;
}
