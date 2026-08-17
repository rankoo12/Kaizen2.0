import type { IHealingStrategy } from '../interfaces';
import type { ClassifiedFailure, HealingContext, HealingAttempt } from '../../../types';
import type { ILLMGateway } from '../../llm-gateway/interfaces';
import type { IDOMPruner } from '../../dom-pruner/interfaces';
import type { IObservability } from '../../observability/interfaces';
import { tenantQuery } from '../../../db/transaction';
import { toVectorSQL } from '../../../utils/vector';
import type { Redis } from 'ioredis';

type PageLike = {
  $(selector: string): Promise<unknown | null>;
};

const BUDGET_KEY = (tenantId: string) => `healing:resolve_retry:${tenantId}`;
const MAX_PER_HOUR = 2;
const TTL_SECONDS = 3600;

/**
 * ResolveAndRetryStrategy — Priority 4
 * Spec ref: Section 10
 *
 * Triggers a fresh LLM element resolution, updates both step_embedding and
 * element_embedding in selector_cache on success, then retries the selector in DOM.
 *
 * Rate-limited: max 2 calls per tenant per hour (Redis counter).
 * Handles: ELEMENT_REMOVED, ELEMENT_MUTATED
 */
export class ResolveAndRetryStrategy implements IHealingStrategy {
  readonly name = 'ResolveAndRetryStrategy';

  constructor(
    private readonly domPruner: IDOMPruner,
    private readonly llmGateway: ILLMGateway,
    private readonly redis: Redis,
    private readonly observability: IObservability,
  ) {}

  canHandle(failure: ClassifiedFailure): boolean {
    // ELEMENT_REMOVED / ELEMENT_MUTATED are the obvious re-resolve cases.
    // TIMING and ELEMENT_OBSCURED are included because a STALE CACHED selector
    // (the site renamed/moved an element) makes page.click wait and time out —
    // and the classifier can only prove SelectorGone when the selector encodes a
    // name (aria-label=/text=). Role/CSS-id selectors (most of Kaizen's cache)
    // can't be name-matched, so a genuinely-dead selector falls through to TIMING.
    // Re-resolution is rate-limited (2/tenant/hr) and runs AFTER AdaptiveWait, so a
    // real slow-load is still handled by waiting first; this only fires as a last
    // resort — exactly when a fresh LLM resolve is the right move.
    return (
      failure.failureClass === 'ELEMENT_REMOVED' ||
      failure.failureClass === 'ELEMENT_MUTATED' ||
      failure.failureClass === 'TIMING' ||
      failure.failureClass === 'ELEMENT_OBSCURED'
    );
  }

  async heal(failure: ClassifiedFailure, context: HealingContext): Promise<HealingAttempt> {
    const start = Date.now();

    // Enforce healing budget
    const budgetKey = BUDGET_KEY(context.tenantId);
    const current = await this.redis.incr(budgetKey);
    if (current === 1) await this.redis.expire(budgetKey, TTL_SECONDS);

    if (current > MAX_PER_HOUR) {
      this.observability.increment('healing.resolve_retry_budget_exceeded', {
        tenantId: context.tenantId,
      });
      return { succeeded: false, newSelector: null, durationMs: Date.now() - start };
    }

    try {
      const page = context.page as PageLike;
      const step = failure.step;

      // Fresh DOM candidates
      const candidates = await this.domPruner.prune(context.page, step.targetDescription ?? '');
      if (candidates.length === 0) {
        return { succeeded: false, newSelector: null, durationMs: Date.now() - start };
      }

      const llmResult = await this.llmGateway.resolveElement(step, candidates, context.tenantId);

      for (const sel of llmResult.selectors) {
        try {
          const handle = await page.$(sel.selector);
          if (handle === null) continue;

          // Persist the corrected selector (+ embeddings) into selector_cache so the
          // NEXT run serves the healed selector, not the stale one that just failed.
          // Without this the row keeps its dead selector, every run re-fails and
          // re-heals, and the 2/hr rate limit soon leaves the step permanently broken.
          // NB: selector_cache.content_hash stores the step's TARGET hash (see the
          // LLM resolver's write-back INSERT) — key on targetHash, not contentHash,
          // or the UPDATE matches zero rows and the fix never persists.
          void this.persistHealedSelector(step.targetHash, context, sel, candidates, step.rawText);

          this.observability.increment('healing.resolve_retry_success', {
            tenantId: context.tenantId,
          });
          return { succeeded: true, newSelector: sel.selector, durationMs: Date.now() - start };
        } catch {
          // try next selector
        }
      }
    } catch (e: any) {
      this.observability.log('warn', 'healing.resolve_retry_error', { error: e.message });
    }

    return { succeeded: false, newSelector: null, durationMs: Date.now() - start };
  }

  private async persistHealedSelector(
    targetHash: string,
    context: HealingContext,
    healed: { selector: string; strategy: string; confidence?: number },
    candidates: Array<{ role: string; name: string; cssSelector: string; xpath: string; attributes: Record<string, string>; textContent: string }>,
    rawText: string,
  ): Promise<void> {
    try {
      const stepEmbedding = await this.llmGateway.generateEmbedding(rawText);

      const winner = candidates.find(
        (c) => c.cssSelector === healed.selector || c.xpath === healed.selector,
      ) ?? candidates[0];
      const elementText = `${winner.role}: ${winner.textContent || winner.name}`.trim();
      const elementEmbedding = await this.llmGateway.generateEmbedding(elementText);

      // Overwrite the stale selector with the healed one and restore confidence —
      // it was just validated against the live DOM (page.$ !== null), so the next
      // run should trust and serve it instead of the dead selector. GREATEST keeps
      // an already-higher confidence; the reset outcome window prevents the prior
      // failures from immediately demoting the corrected selector below the 0.4
      // serve threshold.
      const selectorsJson = JSON.stringify([
        { selector: healed.selector, strategy: healed.strategy, confidence: healed.confidence ?? 0.9 },
      ]);
      await tenantQuery(
        context.tenantId,
        `UPDATE selector_cache
         SET selectors         = $1::jsonb,
             step_embedding    = $2::vector,
             element_embedding = $3::vector,
             confidence_score  = GREATEST(confidence_score, 0.9),
             outcome_window    = '[true]'::jsonb,
             last_verified_at  = now(),
             updated_at        = now()
         WHERE content_hash = $4 AND tenant_id = $5`,
        [selectorsJson, toVectorSQL(stepEmbedding), toVectorSQL(elementEmbedding), targetHash, context.tenantId],
      );
    } catch (e: any) {
      this.observability.log('warn', 'healing.embedding_update_failed', { error: e.message });
    }
  }
}
