import type { IElementResolver } from './interfaces';
import type { StepAST, SelectorSet, ResolutionContext } from '../../types';
import type { IObservability } from '../observability/interfaces';

/**
 * Spec ref: Section 6.3 — CompositeElementResolver
 *
 * Tries CachedElementResolver (L1–L4) first.
 * Falls through to LLMElementResolver only on a full cache miss (empty selectors).
 * Both resolvers implement IElementResolver — no implementation imports.
 */
export class CompositeElementResolver implements IElementResolver {
  constructor(
    private readonly cached: IElementResolver,
    private readonly llm: IElementResolver,
    private readonly observability: IObservability,
  ) {}

  async resolve(step: StepAST, context: ResolutionContext): Promise<SelectorSet> {
    const span = this.observability.startSpan('composite_resolver.resolve', {
      tenantId: context.tenantId,
    });

    try {
      const cacheResult = await this.cached.resolve(step, context);

      if (cacheResult.selectors.length > 0) {
        return cacheResult;
      }

      // Cache miss — escalate to LLM
      this.observability.increment('composite_resolver.llm_escalation', {
        action: step.action,
      });

      return await this.llm.resolve(step, context);
    } finally {
      span.end();
    }
  }

  async recordSuccess(contentHash: string, domain: string, selectorUsed: string): Promise<void> {
    // Delegate to both so each can update its own state
    await Promise.all([
      this.cached.recordSuccess(contentHash, domain, selectorUsed),
      this.llm.recordSuccess(contentHash, domain, selectorUsed),
    ]);
  }

  async recordFailure(contentHash: string, domain: string, selectorAttempted: string): Promise<void> {
    await Promise.all([
      this.cached.recordFailure(contentHash, domain, selectorAttempted),
      this.llm.recordFailure(contentHash, domain, selectorAttempted),
    ]);
  }
}
