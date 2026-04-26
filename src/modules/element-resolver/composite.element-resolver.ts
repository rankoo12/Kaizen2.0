import type { IElementResolver } from './interfaces';
import type { StepAST, SelectorSet, ResolutionContext } from '../../types';
import type { ILLMGateway } from '../llm-gateway/interfaces';
import type { IObservability } from '../observability/interfaces';

/**
 * Spec ref: Section 6.3 — CompositeElementResolver
 * Updated: Smart Brain Layer 0 — accepts an ordered resolver chain (first non-empty wins).
 * Updated 2026-04-24: computes step_embedding once per step and passes it down via
 * ResolutionContext so every cache layer can run the semantic guard without paying
 * for a second OpenAI embedding call. See spec-element-resolver-cache-semantic-guard.md.
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
    private readonly llmGateway?: ILLMGateway,
  ) {}

  async resolve(step: StepAST, context: ResolutionContext): Promise<SelectorSet> {
    const span = this.observability.startSpan('composite_resolver.resolve', {
      tenantId: context.tenantId,
    });

    try {
      // Lazy: only pay for the embedding when we pass L0 without a hit.
      // L0 ArchetypeElementResolver does not need step_embedding; if it hits
      // we return immediately and skip the OpenAI call entirely.
      let enrichedContext: ResolutionContext = context;
      let embeddingComputed = false;

      for (let idx = 0; idx < this.resolvers.length; idx++) {
        // Compute step embedding lazily, before the first resolver that might need it.
        // Index 0 is the archetype resolver (doesn't use it); from index 1 onward the
        // cache layers consume context.stepEmbedding for both pgvector search and the
        // semantic guard. Skip embedding entirely when targetDescription is null.
        if (!embeddingComputed && idx > 0 && step.targetDescription && this.llmGateway) {
          try {
            const textToEmbed = step.targetDescription?.trim() ? step.targetDescription.trim() : step.action;
            const vec = await this.llmGateway.generateEmbedding(textToEmbed);
            enrichedContext = { ...context, stepEmbedding: vec };
          } catch (e: any) {
            this.observability.log('warn', 'composite_resolver.embedding_failed', { error: e.message });
          }
          embeddingComputed = true;
        }

        const result = await this.resolvers[idx].resolve(step, enrichedContext);
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
