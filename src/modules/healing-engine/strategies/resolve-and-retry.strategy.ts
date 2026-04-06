import type { IHealingStrategy } from '../interfaces';
import type { ClassifiedFailure, HealingContext, HealingAttempt } from '../../../types';
import type { ILLMGateway } from '../../llm-gateway/interfaces';
import type { IDOMPruner } from '../../dom-pruner/interfaces';
import type { IObservability } from '../../observability/interfaces';
import { getPool } from '../../../db/pool';
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
    return (
      failure.failureClass === 'ELEMENT_REMOVED' ||
      failure.failureClass === 'ELEMENT_MUTATED'
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

          // Update both embeddings in selector_cache
          void this.updateEmbeddings(step.contentHash, context, sel.selector, candidates, step.rawText);

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

  private async updateEmbeddings(
    contentHash: string,
    context: HealingContext,
    newSelector: string,
    candidates: Array<{ role: string; name: string; cssSelector: string; xpath: string; attributes: Record<string, string>; textContent: string }>,
    rawText: string,
  ): Promise<void> {
    try {
      const stepEmbedding = await this.llmGateway.generateEmbedding(rawText);

      const winner = candidates.find(
        (c) => c.cssSelector === newSelector || c.xpath === newSelector,
      ) ?? candidates[0];
      const elementText = `${winner.role}: ${winner.textContent || winner.name}`.trim();
      const elementEmbedding = await this.llmGateway.generateEmbedding(elementText);

      const toSQL = (v: number[]) => '[' + v.join(',') + ']';

      await getPool().query(
        `UPDATE selector_cache
         SET step_embedding    = $1::vector,
             element_embedding = $2::vector,
             updated_at        = now()
         WHERE content_hash = $3 AND tenant_id = $4`,
        [toSQL(stepEmbedding), toSQL(elementEmbedding), contentHash, context.tenantId],
      );
    } catch (e: any) {
      this.observability.log('warn', 'healing.embedding_update_failed', { error: e.message });
    }
  }
}
