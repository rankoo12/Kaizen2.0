import type { IElementResolver } from './interfaces';
import type { StepAST, SelectorSet, ResolutionContext } from '../../types';
import type { IObservability } from '../observability/interfaces';

/**
 * Spec ref: Section 6.3 — CompositeElementResolver
 * Updated: Smart Brain Layer 0 — accepts an ordered resolver chain (first non-empty wins).
 *
 * Resolution order:
 *  [0] ArchetypeElementResolver (L0) — zero-LLM, zero-vector ARIA lookup
 *  [1] CachedElementResolver   (L1–L4) — Redis + Postgres + pgvector
 *  [2] LLMElementResolver      (L5) — LLM fallback with cache write-back
 */
export class CompositeElementResolver implements IElementResolver {
  constructor(
    private readonly resolvers: IElementResolver[],
    private readonly observability: IObservability,
  ) {}

  async resolve(step: StepAST, context: ResolutionContext): Promise<SelectorSet> {
    const span = this.observability.startSpan('composite_resolver.resolve', {
      tenantId: context.tenantId,
    });

    try {
      for (const resolver of this.resolvers) {
        const result = await resolver.resolve(step, context);
        if (result.selectors.length > 0) return result;
      }

      // All resolvers missed — return empty MISS (LLMElementResolver is last and should
      // always return something, but this guards against an empty chain).
      this.observability.increment('composite_resolver.full_miss', { action: step.action });
      return { selectors: [], fromCache: false, cacheSource: null, resolutionSource: null, similarityScore: null };
    } finally {
      span.end();
    }
  }

  async recordSuccess(contentHash: string, domain: string, selectorUsed: string): Promise<void> {
    await Promise.all(this.resolvers.map((r) => r.recordSuccess(contentHash, domain, selectorUsed)));
  }

  async recordFailure(contentHash: string, domain: string, selectorAttempted: string): Promise<void> {
    await Promise.all(this.resolvers.map((r) => r.recordFailure(contentHash, domain, selectorAttempted)));
  }
}
